<script setup lang="ts">
/**
 * 下载页: 漫画章节下载的全局任务列表。
 * 进行中看进度, 失败/中断能重试, 完成的直接跳本地阅读器。
 */
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { t } from '../i18n'
import { useLibrary } from '../stores/library'
import { readerPath } from '../services/readerRoute'
import { toast } from '../services/toast'
import { askConfirm, deleteConfirmOptions } from '../services/confirm'
import {
  clearFinished, downloadState, failedTasks, finishedTasks, queueSummary,
  initDownloads, remove, retry, cancel, pause, resume, pauseAll, resumeAll,
  type DownloadTask,
} from '../services/comicPlugin/downloadCenter'

const router = useRouter()
const library = useLibrary()

onMounted(() => {
  initDownloads()
  void library.refresh()
})

const pendingTasks = computed(() => downloadState.tasks.filter(t => t.status === 'queued'))
const runningTasks = computed(() => downloadState.tasks.filter(t => t.status === 'running'))
const pausedTasks = computed(() => downloadState.tasks.filter(t => t.status === 'paused'))
const failedList = computed(() => failedTasks.value)
const doneList = computed(() => finishedTasks.value)
const totalCount = computed(() => downloadState.tasks.length)
const activeCount = computed(() => runningTasks.value.length + pendingTasks.value.length + pausedTasks.value.length)

function percent(task: DownloadTask): number {
  if (task.status === 'done') return 100
  if (!task.total) return task.status === 'running' ? 4 : 0
  return Math.min(100, Math.round((task.loaded / task.total) * 100))
}

function statusText(task: DownloadTask): string {
  if (task.status === 'queued') return t('downloads.queued')
  if (task.status === 'paused') return t('downloads.paused')
  if (task.status === 'cancelled') return t('downloads.cancelled')
  if (task.status === 'interrupted') return t('downloads.interrupted')
  if (task.status === 'failed') return task.error || t('downloads.failedLabel')
  if (task.status === 'done') return t('downloads.doneLabel')
  if (task.phase === 'packing') return t('comics.packing')
  if (task.phase === 'importing') return t('comics.packing')
  if (task.phase === 'chapter') return t('downloads.fetching')
  return task.total ? `${task.loaded} / ${task.total}` : t('comics.downloading')
}

function openBook(task: DownloadTask) {
  const book = library.books.find(b => b.id === task.bookId)
  if (book) { void router.push(readerPath(book)); return }
  void router.push('/library')
}

/** 记录标着已完成, 但书已经被用户从藏书删掉了 —— 这时给「重新下载」而不是「打开」 */
function bookMissing(task: DownloadTask): boolean {
  return task.status === 'done' && !library.books.some(b => b.id === task.bookId)
}

function clearOnly(only: 'failed' | 'done' | 'all') {
  void clearFinished(only)
  toast(t('downloads.cleared'), 'success')
}

/** 清完成记录 + 连文件一起删 (释放空间) */
async function clearDoneWithFiles() {
  const n = doneList.value.length
  if (!n) return
  const ok = await askConfirm(t('downloads.clearWithFilesConfirm', { count: n }), deleteConfirmOptions(t('downloads.clearWithFilesTitle')))
  if (!ok) return
  await clearFinished('done', true)
  void library.refresh()
  toast(t('downloads.clearedWithFiles'), 'success')
}

function retryAll() {
  for (const task of failedList.value) retry(task.id)
}
</script>

<template>
  <div class="downloads-page">
    <header class="toolbar">
      <div class="heading">
        <h1>{{ t('downloads.title') }}</h1>
        <span class="count">{{ t('downloads.count', { count: totalCount }) }}</span>
      </div>
      <div class="spacer" />
      <button v-if="runningTasks.length" class="btn" @click="pauseAll">{{ t('downloads.pauseAll') }}</button>
      <button v-if="pausedTasks.length" class="btn" @click="resumeAll">{{ t('downloads.resumeAll') }}</button>
      <button v-if="failedList.length" class="btn" @click="retryAll">{{ t('downloads.retryAll') }}</button>
      <button v-if="failedList.length" class="btn" @click="clearOnly('failed')">{{ t('downloads.clearFailed') }}</button>
      <button v-if="doneList.length" class="btn" @click="clearOnly('done')">{{ t('downloads.clearDone') }}</button>
      <button v-if="doneList.length" class="btn btn-danger" @click="clearDoneWithFiles">{{ t('downloads.clearWithFiles') }}</button>
      <button class="btn" :disabled="!totalCount" @click="clearOnly('all')">{{ t('downloads.clearAll') }}</button>
    </header>

    <p v-if="!totalCount" class="empty-title">{{ t('downloads.emptyTitle') }}</p>
    <p v-if="!totalCount" class="hint">{{ t('downloads.emptyHint') }}</p>

    <section v-if="totalCount && queueSummary.remaining" class="queue-summary">
      <div class="queue-head">
        <span class="queue-label">{{ t('downloads.queueSummary', { remaining: queueSummary.remaining, done: queueSummary.done }) }}</span>
        <span class="queue-current" v-if="queueSummary.currentTotal">{{ queueSummary.currentLoaded }} / {{ queueSummary.currentTotal }}</span>
      </div>
      <div class="bar-track queue-bar"><div class="bar-fill" :style="{ width: queueSummary.percent + '%' }" /></div>
    </section>

    <section v-if="activeCount" class="group">
      <h2 class="group-title">{{ t('downloads.groupActive') }} <span class="badge">{{ activeCount }}</span></h2>
      <div class="task-list">
        <div v-for="task in [...runningTasks, ...pendingTasks]" :key="task.id" class="task">
          <div class="task-main">
            <div class="task-title">{{ task.comicTitle }}<span class="task-chapter">{{ task.chapterName }}</span></div>
            <div class="bar-track"><div class="bar-fill" :style="{ width: percent(task) + '%' }" /></div>
          </div>
          <div class="task-status">{{ statusText(task) }}</div>
          <div class="task-actions">
            <button class="btn btn-ghost" @click="pause(task.id)">{{ t('downloads.pause') }}</button>
            <button class="btn btn-ghost" @click="cancel(task.id)">{{ t('comics.cancel') }}</button>
          </div>
        </div>
        <div v-for="task in pausedTasks" :key="task.id" class="task paused">
          <div class="task-main">
            <div class="task-title">{{ task.comicTitle }}<span class="task-chapter">{{ task.chapterName }}</span></div>
            <div class="bar-track"><div class="bar-fill" :style="{ width: percent(task) + '%' }" /></div>
          </div>
          <div class="task-status">{{ statusText(task) }}</div>
          <div class="task-actions">
            <button class="btn btn-primary" @click="resume(task.id)">{{ t('downloads.resume') }}</button>
            <button class="btn btn-ghost" @click="cancel(task.id)">{{ t('comics.cancel') }}</button>
          </div>
        </div>
      </div>
    </section>

    <section v-if="failedList.length" class="group">
      <h2 class="group-title">{{ t('downloads.groupFailed') }} <span class="badge danger">{{ failedList.length }}</span></h2>
      <div class="task-list">
        <div v-for="task in failedList" :key="task.id" class="task failed">
          <div class="task-main">
            <div class="task-title">{{ task.comicTitle }}<span class="task-chapter">{{ task.chapterName }}</span></div>
            <div class="task-reason">{{ statusText(task) }}</div>
          </div>
          <div class="task-actions">
            <button class="btn btn-primary" @click="retry(task.id)">{{ t('downloads.retry') }}</button>
            <button class="btn btn-ghost" @click="remove(task.id)">{{ t('downloads.remove') }}</button>
          </div>
        </div>
      </div>
    </section>

    <section v-if="doneList.length" class="group">
      <h2 class="group-title">{{ t('downloads.groupDone') }} <span class="badge">{{ doneList.length }}</span></h2>
      <div class="task-list">
        <div v-for="task in doneList" :key="task.id" class="task done">
          <div class="task-main">
            <div class="task-title">{{ task.comicTitle }}<span class="task-chapter">{{ task.chapterName }}</span></div>
            <div class="task-reason" :class="{ missing: bookMissing(task) }">
              {{ bookMissing(task) ? t('downloads.fileMissing') : t('downloads.doneLabel') }}
            </div>
          </div>
          <div class="task-actions">
            <button v-if="bookMissing(task)" class="btn btn-primary" @click="retry(task.id)">{{ t('downloads.redownload') }}</button>
            <button v-else class="btn" @click="openBook(task)">{{ t('downloads.open') }}</button>
            <button class="btn btn-ghost" @click="remove(task.id)">{{ t('downloads.remove') }}</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.downloads-page {
  min-height: 100%;
  max-width: calc(var(--page-max) + 2 * var(--page-x));
  margin: 0 auto;
  padding: 0 var(--page-x) calc(var(--page-bottom) + var(--lr-safe-bottom));
}
.toolbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 0 calc(-1 * var(--page-x)) 18px;
  padding: calc(var(--page-top) + 20px) calc(var(--page-x) + var(--chrome-inset-right)) 16px var(--page-x);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
}
.heading { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.toolbar h1 { font-size: var(--page-title); font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
.count { color: var(--text-3); font-size: 13px; white-space: nowrap; }
.spacer { flex: 1; }
.toolbar .btn { padding: 0 12px; font-size: 13px; }

.empty-title { font-size: 15px; font-weight: 600; margin: 40px 0 6px; }
.hint { color: var(--text-3); font-size: 13px; line-height: 1.7; margin: 0; }

.queue-summary { margin-bottom: 22px; padding: 14px 16px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.queue-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.queue-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
.queue-current { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.queue-bar { height: 8px; }

.group { margin-bottom: 26px; }
.group-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--text-2); margin: 0 0 12px; }
.badge {
  font-size: 11px; font-weight: 600; color: var(--text-3);
  background: var(--surface-2); border-radius: 999px; padding: 1px 8px;
}
.badge.danger { color: var(--danger, #d9534f); }

.task-list { display: flex; flex-direction: column; gap: 8px; }
.task {
  display: flex; align-items: center; gap: 16px;
  padding: 12px 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.task-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.task-title { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-chapter { font-weight: 400; color: var(--text-3); font-size: 13px; margin-left: 10px; }
.task-reason { font-size: 12px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; }
.task.failed .task-reason { color: var(--danger, #d9534f); }
.task.paused .bar-fill { background: var(--text-3); }
.task-reason.missing { color: var(--danger, #d9534f); }
.task-status { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; min-width: 92px; text-align: right; }
.task-actions { display: flex; gap: 8px; flex: none; }
.task-actions .btn { padding: 0 12px; font-size: 13px; }

.bar-track { height: 6px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.bar-fill { height: 100%; background: var(--brand); border-radius: 999px; transition: width 0.25s ease; }
</style>
