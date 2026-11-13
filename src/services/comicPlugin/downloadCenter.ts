/**
 * 漫画下载中心: 一张全局任务表, 页面切走 / 重进都还在, 失败和中断都能重试。
 *
 * 之前下载进度只存在详情页组件的局部 reactive 里 —— 一离开那个页面就没了,
 * 用户既看不到进度也不知道下载到底跑没跑完。这里把它做成单例:
 * 任务落 localStorage (只存元信息, 图片字节始终在内存里随任务走),
 * 重启后未完成的任务标成「已中断」, 可以一键重下。
 */
import { computed, reactive } from 'vue'
import { cancelDownload, downloadChapterAsCbz, safeFileName, type DownloadPhase } from './download'
import { chapterKey, chapterRequestId } from './normalize'
import { getStorage } from '../../storage'
import type { BookMeta } from '../../storage/types'
import type { ComicChapter } from './types'

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

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
  createdAt: number
  updatedAt: number
}

const STORAGE_KEY = 'lightread.comicDownloads.v1'
/** 同时跑几个章节: 每个任务有自己的插件宿主, 2 个足够, 再多会互相抢带宽 */
const MAX_PARALLEL = 2

export const downloadState = reactive({
  tasks: [] as DownloadTask[],
  /** 页面里改任务时用来触发一次落盘 */
  dirty: 0,
})

const running = new Set<string>()
let pumpScheduled = false

function load(): DownloadTask[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((t: DownloadTask) => t && t.id).map((t: DownloadTask) => (
      // 上次退出时还在跑的, 现在肯定已经停了
      t.status === 'running' || t.status === 'queued'
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

export const activeTasks = computed(() => downloadState.tasks.filter(t => t.status === 'queued' || t.status === 'running'))
export const activeCount = computed(() => activeTasks.value.length)
export const failedTasks = computed(() => downloadState.tasks.filter(t => t.status === 'failed' || t.status === 'interrupted'))
export const finishedTasks = computed(() => downloadState.tasks.filter(t => t.status === 'done'))

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
      onProgress: progress => patch(task.id, {
        phase: progress.phase,
        loaded: progress.loaded,
        total: progress.total,
        error: progress.message,
      }),
    })
    if (result.ok) {
      patch(task.id, {
        status: 'done', phase: 'done', error: undefined,
        bookId: result.bookId, loaded: task.total || task.loaded,
      })
    } else if (result.error === 'cancelled') {
      patch(task.id, { status: 'cancelled', error: undefined })
    } else {
      patch(task.id, { status: 'failed', error: result.error ?? 'unknown' })
    }
  } catch (e: any) {
    patch(task.id, { status: 'failed', error: e?.message ?? String(e) })
  } finally {
    running.delete(task.id)
    schedule()
  }
}

export function cancel(id: string) {
  cancelDownload(id)
  const task = downloadState.tasks.find(t => t.id === id)
  if (task && task.status === 'queued') patch(id, { status: 'cancelled' })
}

export function retry(id: string) {
  const task = downloadState.tasks.find(t => t.id === id)
  if (!task) return
  patch(id, { status: 'queued', phase: 'chapter', loaded: 0, total: 0, error: undefined })
  schedule()
}

export function remove(id: string) {
  const index = downloadState.tasks.findIndex(t => t.id === id)
  if (index < 0) return
  if (downloadState.tasks[index].status === 'running') cancelDownload(id)
  downloadState.tasks.splice(index, 1)
  persist()
}

/**
 * 清掉已结束的记录, 进行中和排队的一律保留。
 * only: 'failed' 只清失败/中断; 'done' 只清已完成; 'all' 全清 (含已取消)。
 * 只动记录, 不动已入库的文件。
 */
export function clearFinished(only: 'failed' | 'done' | 'all' = 'all') {
  const keep = downloadState.tasks.filter(t => {
    if (t.status === 'running' || t.status === 'queued') return true
    if (only === 'failed') return t.status !== 'failed' && t.status !== 'interrupted'
    if (only === 'done') return t.status !== 'done'
    return false
  })
  downloadState.tasks = keep
  persist()
}
