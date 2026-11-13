/**
 * 漫画章节下载: 插件逐页取图 → fflate 打包 CBZ → 走现有 importFile 入库。
 *
 * 入库后就和手动导入的漫画完全同一条路 (books/<id>.cbz), 阅读进度 / WebDAV 同步 /
 * 封面 / 藏书过滤全部沿用, 不需要另建一套存储。
 */
import { zipSync } from 'fflate'
import { importFile } from '../importer'
import { openPlugin, downloadConcurrency } from './index'
import { chapterRequestId, normalizeChapter, pageFileName } from './normalize'
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
}

export interface DownloadResult {
  ok: boolean
  fileName: string
  bookId?: string
  error?: string
}

const activeGroups = new Map<string, Set<string>>()

/** 请求取消正在进行的下载 (插件会在每张图之前查询 runtime.is_task_group_cancelled) */
export function cancelDownload(key: string): void {
  activeGroups.get(key)?.add(key)
}

export function isDownloadCancelled(key: string): boolean {
  return activeGroups.get(key)?.has(key) ?? false
}

function safeFileName(name: string): string {
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

    const concurrency = await downloadConcurrency(host)
    const images: Array<Uint8Array | undefined> = new Array(pages.length)
    let cursor = 0
    let loaded = 0
    let failure: string | undefined

    const worker = async () => {
      while (!group.has(key) && !failure) {
        const index = cursor++
        if (index >= pages.length) return
        try {
          const bytes = await host!.callBytes(
            'fetchImageBytes',
            { url: pages[index].url, taskGroupKey: key },
            { timeoutMs: 60_000 },
          )
          if (!bytes?.length) throw new Error('图片内容为空')
          images[index] = bytes
        } catch (err) {
          failure = `第 ${index + 1} 页下载失败: ${(err as Error)?.message ?? err}`
          return
        }
        loaded++
        report('images', loaded, pages.length)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, () => worker()))

    if (group.has(key)) {
      report('cancelled', loaded, pages.length)
      return { ok: false, fileName: '', error: 'cancelled' }
    }
    if (failure) throw new Error(failure)

    report('packing', pages.length, pages.length)
    const entries: Record<string, Uint8Array> = {}
    for (let i = 0; i < pages.length; i++) {
      const bytes = images[i]
      if (bytes) entries[pageFileName(pages[i], i, pages.length)] = bytes
    }
    // 图片本身已是 JPEG/PNG/WebP, 存储模式即可, 再 deflate 纯浪费 CPU
    const zipped = zipSync(entries, { level: 0 })

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
      description: `${uuid} · ${comicId}`,
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
  }
}

/** 把下载好的字节转成可直接给 <img> 用的 Blob URL (在线阅读复用) */
export function bytesToObjectUrl(bytes: Uint8Array, url: string): string {
  return URL.createObjectURL(toBlob(bytes, imageMime(url)))
}
