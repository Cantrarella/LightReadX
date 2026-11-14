/**
 * 漫画章节下载: 插件逐页取图 → fflate 打包 CBZ → 走现有 importFile 入库。
 *
 * 入库后就和手动导入的漫画完全同一条路 (books/<id>.cbz), 阅读进度 / WebDAV 同步 /
 * 封面 / 藏书过滤全部沿用, 不需要另建一套存储。
 */
import { zipSync } from 'fflate'
import { importFile } from '../importer'
import { openPlugin, downloadConcurrency } from './index'
import { chapterKey, chapterRequestId, normalizeChapter, pageFileName } from './normalize'
import { cacheGetPage, cachePutPage } from './downloadCache'
import type { ComicChapter, ComicChapterResult } from './types'

export type DownloadPhase = 'chapter' | 'images' | 'packing' | 'importing' | 'done' | 'cancelled' | 'error'

export interface DownloadProgress {
  phase: DownloadPhase
  loaded: number
  total: number
  message?: string
}

export interface DownloadOptions {
  taskGroupKey?: string
  onProgress?: (progress: DownloadProgress) => void
  /** 断点缓存的键前缀 (通常用任务 id); 不传则不做断点续传 */
  cacheKey?: string
  /** 单页下载失败的最大重试次数 (默认 3, 指数退避) */
  maxPageRetries?: number
  /** 单章内并发下载页数 (覆盖插件默认); 不传则用插件声明值 */
  concurrency?: number
  /** 休息/防封: 每下 restEvery 张停 restFor 毫秒; 0 或省略则不休 */
  restEvery?: number
  restFor?: number
}

export interface DownloadResult {
  ok: boolean
  fileName: string
  bookId?: string
  error?: string
}

const activeGroups = new Map<string, Set<string>>()

/** 暂停标志: key -> 是否已请求暂停。取消/暂停共用同一套信号, 插件每张图之前查询 */
const pausedGroups = new Map<string, boolean>()

/** 请求取消正在进行的下载 (插件会在每张图之前查询 runtime.is_task_group_cancelled) */
export function cancelDownload(key: string): void {
  activeGroups.get(key)?.add(key)
}

export function isDownloadCancelled(key: string): boolean {
  return activeGroups.get(key)?.has(key) ?? false
}

/** 请求暂停 (不丢已下字节, 只停住推进; 恢复时接着下) */
export function pauseDownload(key: string): void {
  pausedGroups.set(key, true)
}

export function isDownloadPaused(key: string): boolean {
  return pausedGroups.get(key) ?? false
}

export function clearPauseFlag(key: string): void {
  pausedGroups.delete(key)
}

/** 导出给下载中心: 查重时要算出同一个文件名做兜底匹配 */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'comic.cbz'
}

function imageMime(url: string): string {
  const ext = /\.([a-z0-9]+)(?:$|\?)/i.exec(url.split('?')[0])?.[1]?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'avif') return 'image/avif'
  return 'image/jpeg'
}

/** TS 6 的 Uint8Array<ArrayBufferLike> 不能直接当 BlobPart, 先复制成确定的 ArrayBuffer */
function toBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return new Blob([copy.buffer as ArrayBuffer], { type })
}

let zipWorker: Worker | null = null
let zipSeq = 0

/** 打包交给 Worker, 大章节也不会把界面卡住; Worker 起不来就退回主线程 */
function packAsync(entries: Array<{ name: string; bytes: Uint8Array }>): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') {
    const map: Record<string, Uint8Array> = {}
    for (const entry of entries) map[entry.name] = entry.bytes
    return Promise.resolve(zipSync(map, { level: 0 }))
  }
  try {
    if (!zipWorker) {
      zipWorker = new Worker(new URL('./zipWorker.ts', import.meta.url), { type: 'module' })
    }
    const worker = zipWorker
    const id = ++zipSeq
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        if (event.data?.id !== id) return
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        if (event.data.error) reject(new Error(event.data.error))
        else resolve(event.data.zipped as Uint8Array)
      }
      const onError = (event: ErrorEvent) => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        reject(event.error ?? new Error(event.message))
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.postMessage({
        id,
        entries: entries.map(e => ({ name: e.name, bytes: e.bytes })),
      }, entries.map(e => e.bytes.buffer as ArrayBuffer))
    })
  } catch {
    const map: Record<string, Uint8Array> = {}
    for (const entry of entries) map[entry.name] = entry.bytes
    return Promise.resolve(zipSync(map, { level: 0 }))
  }
}

/** 指数退避等待: 重试间隔 0.5s / 1s / 2s ... */
function backoff(attempt: number): Promise<void> {
  const ms = Math.min(8000, 500 * 2 ** attempt)
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 下载单章并入库; 返回的 bookId 可直接跳阅读器 */
export async function downloadChapterAsCbz(
  uuid: string,
  comicId: string,
  target: ComicChapter,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const key = options.taskGroupKey ?? `${uuid}:${comicId}:${chapterRequestId(target)}`
  const group = new Set<string>()
  activeGroups.set(key, group)
  clearPauseFlag(key)
  const cacheKey = options.cacheKey
  const maxRetries = options.maxPageRetries ?? 3
  const report = (phase: DownloadPhase, loaded = 0, total = 0, message?: string) =>
    options.onProgress?.({ phase, loaded, total, message })

  let host: Awaited<ReturnType<typeof openPlugin>> | undefined
  try {
    host = await openPlugin(uuid, { cancelledGroups: group })
    report('chapter')

    const raw = await host.call<ComicChapterResult>(
      'getChapter',
      { comicId, chapterId: chapterRequestId(target) },
      { timeoutMs: 60_000 },
    )
    const content = normalizeChapter(raw)
    const pages = content.pages
    if (!pages.length) throw new Error('该章节没有图片')

    const concurrency = options.concurrency ?? (await downloadConcurrency(host))
    const restEvery = options.restEvery ?? 0
    const restFor = options.restFor ?? 0
    const images: Array<Uint8Array | undefined> = new Array(pages.length)
    let cursor = 0
    let loaded = 0
    let failure: string | undefined

    // 断点续传: 先把上次已落盘的页从 DB 读回来, 这些页直接跳过
    if (cacheKey) {
      report('images', 0, pages.length)
      for (let i = 0; i < pages.length; i++) {
        if (group.has(key) || isDownloadPaused(key)) break
        const cached = await cacheGetPage(cacheKey, i)
        if (cached?.length) {
          images[i] = cached
          loaded++
          if (i + 1 > cursor) cursor = i + 1
          report('images', loaded, pages.length)
        } else {
          break
        }
      }
    }

    const worker = async () => {
      while (!group.has(key) && !isDownloadPaused(key) && !failure) {
        const index = cursor++
        if (index >= pages.length) return
        // 休息防封: 每下 restEvery 张停一会儿 (在下这张之前检查)
        if (restEvery > 0 && index > 0 && index % restEvery === 0) {
          report('images', loaded, pages.length, `防封休息 ${Math.round(restFor / 1000)}s…`)
          await new Promise<void>(resolve => {
            const started = Date.now()
            const timer = setInterval(() => {
              if (group.has(key) || isDownloadPaused(key) || Date.now() - started >= restFor) {
                clearInterval(timer)
                resolve()
              }
            }, 200)
          })
          if (group.has(key) || isDownloadPaused(key)) return
        }
        let bytes: Uint8Array | undefined
        let lastError: unknown
        // 单页自动重试 (指数退避), 超过次数才记失败
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (group.has(key) || isDownloadPaused(key)) return
          if (attempt > 0) await backoff(attempt - 1)
          try {
            bytes = await host!.callBytes(
              'fetchImageBytes',
              { url: pages[index].url, taskGroupKey: key },
              { timeoutMs: 60_000 },
            )
            if (!bytes?.length) throw new Error('图片内容为空')
            break
          } catch (err) {
            lastError = err
            if (attempt === maxRetries) break
          }
        }
        if (bytes?.length) {
          images[index] = bytes
          // 每页成功即落盘, 供断点续传; await 保证暂停/退出时字节已写入 DB
          if (cacheKey) await cachePutPage(cacheKey, index, bytes)
          loaded++
          report('images', loaded, pages.length)
        } else if (!isDownloadPaused(key)) {
          failure = `第 ${index + 1} 页下载失败: ${(lastError as Error)?.message ?? lastError}`
          return
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, () => worker()))

    if (isDownloadPaused(key)) {
      report('cancelled', loaded, pages.length, 'paused')
      return { ok: false, fileName: '', error: 'paused' }
    }
    if (group.has(key)) {
      report('cancelled', loaded, pages.length)
      return { ok: false, fileName: '', error: 'cancelled' }
    }
    if (failure) throw new Error(failure)

    report('packing', pages.length, pages.length)
    const entries: Array<{ name: string; bytes: Uint8Array }> = []
    for (let i = 0; i < pages.length; i++) {
      const bytes = images[i]
      if (bytes) entries.push({ name: pageFileName(pages[i], i, pages.length), bytes })
    }
    const zipped = await packAsync(entries)

    const title = (content.title || comicId).trim()
    const chapterName = (content.chapterName || target.name || chapterRequestId(target)).trim()
    const fileName = safeFileName(`${title} - ${chapterName}.cbz`)
    const file = new File([toBlob(zipped, 'application/x-cbz')], fileName, {
      type: 'application/x-cbz',
    })

    report('importing', pages.length, pages.length)
    const result = await importFile(file, '漫画源下载', {
      title: `${title} - ${chapterName}`,
      author: '',
      description: chapterKey(uuid, comicId, chapterRequestId(target)),
    })
    if (!result.ok) throw new Error(result.error ?? '入库失败')

    report('done', pages.length, pages.length)
    return { ok: true, fileName, bookId: result.bookId }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    report('error', 0, 0, message)
    return { ok: false, fileName: '', error: message }
  } finally {
    host?.dispose()
    activeGroups.delete(key)
    clearPauseFlag(key)
  }
}

/** 把下载好的字节转成可直接给 <img> 用的 Blob URL (在线阅读复用) */
export function bytesToObjectUrl(bytes: Uint8Array, url: string): string {
  return URL.createObjectURL(toBlob(bytes, imageMime(url)))
}
