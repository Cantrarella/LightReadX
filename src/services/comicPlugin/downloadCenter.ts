/**
 * 漫画下载中心: 一张全局任务表, 页面切走 / 重进都还在, 失败和中断都能重试。
 *
 * 之前下载进度只存在详情页组件的局部 reactive 里 —— 一离开那个页面就没了,
 * 用户既看不到进度也不知道下载到底跑没跑完。这里把它做成单例:
 * 任务落 localStorage (只存元信息, 图片字节始终在内存里随任务走),
 * 重启后未完成的任务标成「已中断」, 可以一键重下。
 */
import { computed, reactive } from 'vue'
import {
  cancelDownload, downloadChapterAsCbz, pauseDownload, clearPauseFlag,
  safeFileName, type DownloadPhase,
} from './download'
import { cacheDropTask } from './downloadCache'
import { notifyDownloadDone } from './notify'
import { chapterKey, chapterRequestId } from './normalize'
import { getStorage } from '../../storage'
import { useSettings } from '../../stores/settings'
import { useLibrary } from '../../stores/library'
import type { BookMeta } from '../../storage/types'
import type { ComicChapter } from './types'

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface DownloadTask {
  id: string
  uuid: string
  comicId: string
  chapterId: string
  comicTitle: string
  chapterName: string
  cover?: string
  status: TaskStatus
  phase: DownloadPhase
  loaded: number
  total: number
  error?: string
  bookId?: string
  /** 整章失败自动重试的次数 (超过上限才标 failed) */
  attempts?: number
  createdAt: number
  updatedAt: number
}

const STORAGE_KEY = 'lightread.comicDownloads.v1'
/** 同时跑几个章节: 每个任务有自己的插件宿主, 2 个足够, 再多会互相抢带宽 */
const MAX_PARALLEL = 2
/** 整章失败自动重试的总次数 (超过才标 failed, 防止无限重下) */
const MAX_AUTO_RETRIES = 2
/** 单页下载失败的重试次数 (指数退避) */
const PAGE_RETRIES = 3

export const downloadState = reactive({
  tasks: [] as DownloadTask[],
  /** 页面里改任务时用来触发一次落盘 */
  dirty: 0,
})

const running = new Set<string>()
let pumpScheduled = false

/** 读取漫画下载偏好 (并发 / 休息防封), 供下载循环使用 */
function downloadPrefs() {
  try {
    const s = useSettings()
    const cd = s.comicDownload
    return {
      concurrency: Math.min(16, Math.max(1, Number(cd?.concurrency) || 8)),
      rest: !!cd?.rest,
      restEvery: Math.max(1, Number(cd?.restEvery) || 30),
      restFor: Math.max(1, Number(cd?.restFor) || 10),
    }
  } catch {
    return { concurrency: 8, rest: false, restEvery: 30, restFor: 10 }
  }
}

function load(): DownloadTask[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((t: DownloadTask) => t && t.id).map((t: DownloadTask) => (
      // 上次退出时还在跑/暂停/排队的, 现在肯定已经停了
      t.status === 'running' || t.status === 'queued' || t.status === 'paused'
        ? { ...t, status: 'interrupted' as TaskStatus, error: t.error }
        : t
    ))
  } catch {
    return []
  }
}

export function initDownloads() {
  if (downloadState.tasks.length) return
  downloadState.tasks = load()
}

let saveTimer: number | undefined
function persist() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      // 只留最近 200 条, 免得 localStorage 越滚越大
      localStorage.setItem(STORAGE_KEY, JSON.stringify(downloadState.tasks.slice(0, 200)))
    } catch { /* 空间满了不影响运行 */ }
  }, 300)
}

export function taskId(uuid: string, comicId: string, chapter: ComicChapter | string): string {
  const chapterId = typeof chapter === 'string' ? chapter : chapterRequestId(chapter)
  return `${uuid}:${comicId}:${chapterId}`
}

export function findTask(uuid: string, comicId: string, chapter: ComicChapter | string): DownloadTask | undefined {
  const id = taskId(uuid, comicId, chapter)
  return downloadState.tasks.find(t => t.id === id)
}

/**
 * 在藏书里找这一章已入库的书, 找到就说明不用再下。
 * 主键是 description 里的完整章节 key; 旧版本下载只写了 `uuid · comicId` (没有章节),
 * 所以再用文件名兜底一次, 老记录也能认出来。查库失败不阻断下载。
 */
export async function findDownloadedBook(
  uuid: string,
  comicId: string,
  chapterId: string,
  fileName?: string,
): Promise<BookMeta | undefined> {
  try {
    const books = await (await getStorage()).listBooks()
    const key = chapterKey(uuid, comicId, chapterId)
    const byKey = books.find(b => b.description === key)
    if (byKey) return byKey
    if (!fileName) return undefined
    return books.find(b => b.source === '漫画源下载' && b.fileName === fileName)
  } catch {
    return undefined
  }
}

export const activeTasks = computed(() => downloadState.tasks.filter(t => t.status === 'queued' || t.status === 'running' || t.status === 'paused'))
export const activeCount = computed(() => activeTasks.value.length)
export const failedTasks = computed(() => downloadState.tasks.filter(t => t.status === 'failed' || t.status === 'interrupted'))
export const finishedTasks = computed(() => downloadState.tasks.filter(t => t.status === 'done'))

/** 队列总进度: 供下载页顶部展示「还剩几章 / 整体进度」 */
export const queueSummary = computed(() => {
  const tasks = downloadState.tasks
  const running = tasks.filter(t => t.status === 'running')
  const queued = tasks.filter(t => t.status === 'queued')
  const paused = tasks.filter(t => t.status === 'paused')
  const done = tasks.filter(t => t.status === 'done')
  const failed = tasks.filter(t => t.status === 'failed' || t.status === 'interrupted')

  // 整体完成度: 已完成章数 / 所有任务章数 (没任务的空队列记 0)
  const total = tasks.length
  const remaining = queued.length + paused.length
  const activeChapter = running.length

  // 当前正在跑的任务里, 页级进度 (取第一个 running 的 loaded/total)
  const cur = running[0]
  const currentLoaded = cur?.loaded ?? 0
  const currentTotal = cur?.total ?? 0

  return {
    total,
    remaining,
    activeChapter,
    done: done.length,
    failed: failed.length,
    currentLoaded,
    currentTotal,
    percent: total ? Math.round((done.length / total) * 100) : 0,
  }
})

function patch(id: string, changes: Partial<DownloadTask>) {
  const task = downloadState.tasks.find(t => t.id === id)
  if (!task) return
  Object.assign(task, changes, { updatedAt: Date.now() })
  downloadState.dirty++
  persist()
}

/**
 * 加入队列。已存在则复用 (失败/中断的会重排)。
 *
 * 先查藏书: 这一章已经入库就直接标 done 并指到已有的书 (skipped = true), 不重复下载。
 * 任务表去重挡不住「清掉下载记录后再下」, 那会在藏书里多出一本同名书。
 * 反过来, 记录标着 done 但书已被删掉时会重新下载, 相当于自愈。
 */
export async function enqueue(input: {
  uuid: string
  comicId: string
  chapter: ComicChapter
  comicTitle: string
  cover?: string
}): Promise<{ task: DownloadTask; skipped: boolean }> {
  initDownloads()
  const chapterId = chapterRequestId(input.chapter)
  const id = taskId(input.uuid, input.comicId, input.chapter)
  const existing = downloadState.tasks.find(t => t.id === id)
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    return { task: existing, skipped: false }
  }

  const build = (): DownloadTask => ({
    id,
    uuid: input.uuid,
    comicId: input.comicId,
    chapterId,
    comicTitle: input.comicTitle,
    chapterName: input.chapter.name || chapterId,
    cover: input.cover,
    status: 'queued',
    phase: 'chapter',
    loaded: 0,
    total: 0,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  })

  const fileName = safeFileName(`${input.comicTitle} - ${input.chapter.name || chapterId}.cbz`)
  const downloaded = await findDownloadedBook(input.uuid, input.comicId, chapterId, fileName)
  if (downloaded) {
    const task = existing ?? build()
    Object.assign(task, {
      status: 'done' as TaskStatus, phase: 'done' as DownloadPhase,
      bookId: downloaded.id, error: undefined, updatedAt: Date.now(),
    })
    if (!existing) downloadState.tasks.unshift(task)
    persist()
    return { task, skipped: true }
  }

  const task = existing ?? build()
  Object.assign(task, {
    status: 'queued' as TaskStatus, phase: 'chapter' as DownloadPhase,
    loaded: 0, total: 0, error: undefined, bookId: undefined, updatedAt: Date.now(),
  })
  if (!existing) downloadState.tasks.unshift(task)
  persist()
  schedule()
  return { task, skipped: false }
}

function schedule() {
  if (pumpScheduled) return
  pumpScheduled = true
  void Promise.resolve().then(() => { pumpScheduled = false; pump() })
}

function pump() {
  while (running.size < MAX_PARALLEL) {
    const next = downloadState.tasks.find(t => t.status === 'queued')
    if (!next) return
    void run(next)
  }
}

async function run(task: DownloadTask) {
  running.add(task.id)
  patch(task.id, { status: 'running', phase: 'chapter', loaded: 0, total: 0, error: undefined })
  try {
    const chapter = {
      id: task.chapterId,
      requestId: task.chapterId,
      name: task.chapterName,
    } as ComicChapter
    const result = await downloadChapterAsCbz(task.uuid, task.comicId, chapter, {
      taskGroupKey: task.id,
      cacheKey: task.id,
      maxPageRetries: PAGE_RETRIES,
      concurrency: downloadPrefs().concurrency,
      restEvery: downloadPrefs().rest ? downloadPrefs().restEvery : 0,
      restFor: downloadPrefs().rest ? downloadPrefs().restFor * 1000 : 0,
      onProgress: progress => patch(task.id, {
        phase: progress.phase,
        loaded: progress.loaded,
        total: progress.total,
        error: progress.message,
      }),
    })
    if (result.ok) {
      patch(task.id, {
        status: 'done', phase: 'done', error: undefined, attempts: 0,
        bookId: result.bookId, loaded: task.total || task.loaded,
      })
      // 完成, 清掉断点缓存
      void cacheDropTask(task.id)
      // 入库后立即刷新书库, 让下载页的「打开」按钮识别到新书 (否则误判为「已移除」, 2026-11-14 用户反馈)
      void useLibrary().refresh().catch(() => { /* 刷新失败不影响下载完成标记 */ })
      // 完成通知 (队列里还有其他待跑的就提示「继续」, 全跑完就提示「全部完成」)
      const stillActive = downloadState.tasks.some(t => t.status === 'queued' || t.status === 'running' || t.status === 'paused')
      void notifyDownloadDone(
        task.comicTitle,
        stillActive ? task.chapterName : `${task.chapterName} · 全部下载完成`,
      )
    } else if (result.error === 'paused') {
      // 暂停: 保留已下进度, 标 paused, 不重排
      patch(task.id, { status: 'paused', error: undefined })
    } else if (result.error === 'cancelled') {
      patch(task.id, { status: 'cancelled', error: undefined })
      void cacheDropTask(task.id)
    } else {
      // 失败: 先自动重试 (指数退避重排), 超过次数才标 failed
      const attempts = (task.attempts ?? 0) + 1
      if (attempts <= MAX_AUTO_RETRIES) {
        patch(task.id, { status: 'queued', attempts, error: result.error ?? 'unknown' })
      } else {
        patch(task.id, { status: 'failed', attempts, error: result.error ?? 'unknown' })
      }
    }
  } catch (e: any) {
    const attempts = (task.attempts ?? 0) + 1
    if (attempts <= MAX_AUTO_RETRIES) {
      patch(task.id, { status: 'queued', attempts, error: e?.message ?? String(e) })
    } else {
      patch(task.id, { status: 'failed', attempts, error: e?.message ?? String(e) })
    }
  } finally {
    running.delete(task.id)
    schedule()
  }
}

export function cancel(id: string) {
  cancelDownload(id)
  const task = downloadState.tasks.find(t => t.id === id)
  if (task && task.status === 'queued') patch(id, { status: 'cancelled' })
  if (task && task.status === 'paused') {
    patch(id, { status: 'cancelled' })
    void cacheDropTask(id)
  }
}

/** 暂停一个正在跑的任务 (已下字节保留, 恢复接着下) */
export function pause(id: string) {
  const task = downloadState.tasks.find(t => t.id === id)
  if (!task) return
  if (task.status === 'queued') {
    patch(id, { status: 'paused' })
  } else if (task.status === 'running') {
    pauseDownload(id)
  }
}

export function resume(id: string) {
  const task = downloadState.tasks.find(t => t.id === id)
  if (!task || task.status !== 'paused') return
  clearPauseFlag(id)
  patch(id, { status: 'queued', phase: 'chapter', error: undefined })
  schedule()
}

export function pauseAll() {
  for (const task of downloadState.tasks) {
    if (task.status === 'queued') patch(task.id, { status: 'paused' })
    else if (task.status === 'running') pauseDownload(task.id)
  }
}

export function resumeAll() {
  for (const task of downloadState.tasks) {
    if (task.status === 'paused') {
      clearPauseFlag(task.id)
      patch(task.id, { status: 'queued', phase: 'chapter', error: undefined })
    }
  }
  schedule()
}

export function retry(id: string) {
  const task = downloadState.tasks.find(t => t.id === id)
  if (!task) return
  clearPauseFlag(id)
  patch(id, { status: 'queued', phase: 'chapter', loaded: 0, total: 0, error: undefined, attempts: 0 })
  schedule()
}

export function remove(id: string) {
  const index = downloadState.tasks.findIndex(t => t.id === id)
  if (index < 0) return
  const status = downloadState.tasks[index].status
  if (status === 'running') cancelDownload(id)
  if (status === 'running' || status === 'paused') clearPauseFlag(id)
  downloadState.tasks.splice(index, 1)
  persist()
  void cacheDropTask(id)
}

/**
 * 清掉已结束的记录, 进行中和排队的一律保留。
 * only: 'failed' 只清失败/中断; 'done' 只清已完成; 'all' 全清 (含已取消)。
 * 只动记录, 不动已入库的文件。
 */
/**
 * 清掉已结束的记录, 进行中和排队的一律保留。
 * only: 'failed' 只清失败/中断; 'done' 只清已完成; 'all' 全清 (含已取消)。
 * withFiles: 同时把已完成记录对应的 CBZ 文件从藏书里删掉 (释放空间)。
 * 只动记录, 不动已入库的文件 (除非 withFiles)。
 */
export async function clearFinished(only: 'failed' | 'done' | 'all' = 'all', withFiles = false) {
  const doneToDelete = withFiles
    ? downloadState.tasks.filter(t => t.status === 'done' && t.bookId)
    : []
  const keep = downloadState.tasks.filter(t => {
    if (t.status === 'running' || t.status === 'queued' || t.status === 'paused') return true
    if (only === 'failed') return t.status !== 'failed' && t.status !== 'interrupted'
    if (only === 'done') return t.status !== 'done'
    return false
  })
  downloadState.tasks = keep
  persist()

  // 连文件一起删 (在记录清掉之后, 避免 UI 还在引用)
  if (doneToDelete.length) {
    try {
      const storage = await getStorage()
      for (const t of doneToDelete) {
        if (t.bookId) await storage.deleteBook(t.bookId).catch(() => { /* 已删过就跳过 */ })
      }
    } catch { /* 删除文件失败不阻断 */ }
  }
}
