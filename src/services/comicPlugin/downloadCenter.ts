/**
 * 漫画下载中心: 一张全局任务表, 页面切走 / 重进都还在, 失败和中断都能重试。
 *
 * 之前下载进度只存在详情页组件的局部 reactive 里 —— 一离开那个页面就没了,
 * 用户既看不到进度也不知道下载到底跑没跑完。这里把它做成单例:
 * 任务落 localStorage (只存元信息, 图片字节始终在内存里随任务走),
 * 重启后未完成的任务标成「已中断」, 可以一键重下。
 */
import { computed, reactive } from 'vue'
import { cancelDownload, downloadChapterAsCbz, type DownloadPhase } from './download'
import { chapterRequestId } from './normalize'
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

/** 加入队列; 已存在则复用 (失败/中断的会重排) */
export function enqueue(input: {
  uuid: string
  comicId: string
  chapter: ComicChapter
  comicTitle: string
  cover?: string
}): DownloadTask {
  initDownloads()
  const id = taskId(input.uuid, input.comicId, input.chapter)
  const existing = downloadState.tasks.find(t => t.id === id)
  if (existing) {
    if (existing.status === 'queued' || existing.status === 'running' || existing.status === 'done') return existing
    Object.assign(existing, {
      status: 'queued' as TaskStatus, phase: 'chapter' as DownloadPhase,
      loaded: 0, total: 0, error: undefined, updatedAt: Date.now(),
    })
    persist()
    schedule()
    return existing
  }
  const task: DownloadTask = {
    id,
    uuid: input.uuid,
    comicId: input.comicId,
    chapterId: chapterRequestId(input.chapter),
    comicTitle: input.comicTitle,
    chapterName: input.chapter.name || chapterRequestId(input.chapter),
    cover: input.cover,
    status: 'queued',
    phase: 'chapter',
    loaded: 0,
    total: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  downloadState.tasks.unshift(task)
  persist()
  schedule()
  return task
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

/** 清掉所有已结束 (完成 / 失败 / 取消 / 中断) 的记录 */
export function clearFinished(only: 'failed' | 'all' = 'all') {
  const keep = downloadState.tasks.filter(t => {
    if (t.status === 'running' || t.status === 'queued') return true
    if (only === 'failed') return t.status === 'done'
    return false
  })
  downloadState.tasks = keep
  persist()
}
