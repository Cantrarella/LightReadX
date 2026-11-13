<script setup lang="ts">
/**
 * 漫画源: 搜索 → 详情/章节 → 在线阅读 / 下载入库。
 * UI 沿用藏书页与漫画页的卡片、按钮、工具栏语言, 不另起一套视觉。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { toast } from '../services/toast'
import { t } from '../i18n'
import {
  chapterRequestId, coverUrl, getPlugin, openPlugin, search, detail,
  type ComicPluginHost,
} from '../services/comicPlugin'
import {
  bytesToObjectUrl, cancelDownload, downloadChapterAsCbz, type DownloadProgress,
} from '../services/comicPlugin/download'
import { normalizeChapter } from '../services/comicPlugin/normalize'
import type {
  ComicChapter, ComicChapterResult, ComicPaging, ComicSearchItem, ComicInfo, ComicPage,
} from '../services/comicPlugin/types'

const route = useRoute()
const router = useRouter()
const library = useLibrary()
const uuid = String(route.params.uuid ?? '')
const plugin = getPlugin(uuid)

const view = ref<'search' | 'detail'>('search')
const keyword = ref('')
const page = ref(1)
const items = ref<ComicSearchItem[]>([])
const paging = ref<ComicPaging | undefined>()
const searching = ref(false)
const searchError = ref('')
const covers = reactive<Record<string, string>>({})

const comicId = ref('')
const info = ref<ComicInfo | undefined>()
const chapters = ref<ComicChapter[]>([])
const loadingDetail = ref(false)
const detailError = ref('')
const downloads = reactive<Record<string, DownloadProgress>>({})

let coverHost: ComicPluginHost | null = null
let coverSeq = 0

onBeforeUnmount(() => {
  closeReader()
  coverHost?.dispose()
  coverHost = null
  for (const url of Object.values(covers)) URL.revokeObjectURL(url)
})

/** 封面也走插件的 fetchImageBytes (带防盗链头), 一个长驻宿主并发拉取 */
async function loadCovers(list: ComicSearchItem[]) {
  const seq = ++coverSeq
  if (!coverHost) coverHost = await openPlugin(uuid)
  const host = coverHost
  if (seq !== coverSeq) return
  const queue = list.filter(item => {
    const url = coverUrl(item.cover)
    return url && !covers[item.id]
  })
  let cursor = 0
  const worker = async () => {
    while (seq === coverSeq && cursor < queue.length) {
      const item = queue[cursor++]
      const url = coverUrl(item.cover)
      try {
        const bytes = await host.callBytes('fetchImageBytes', { url }, { timeoutMs: 30_000 })
        if (seq === coverSeq && bytes?.length) covers[item.id] = bytesToObjectUrl(bytes, url)
      } catch { /* 单张封面失败用占位图 */ }
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()))
}

async function doSearch(reset = true) {
  const kw = keyword.value.trim()
  if (!kw || searching.value) return
  if (reset) { page.value = 1; items.value = []; paging.value = undefined }
  searching.value = true
  searchError.value = ''
  try {
    const result = await search(uuid, kw, page.value)
    items.value = reset ? result.items : [...items.value, ...result.items]
    paging.value = result.paging
    void loadCovers(result.items)
  } catch (e: any) {
    searchError.value = e?.message ?? String(e)
  } finally {
    searching.value = false
  }
}

function loadMore() {
  if (!paging.value || page.value >= paging.value.pages || searching.value) return
  page.value++
  void doSearch(false)
}

async function openDetail(item: ComicSearchItem) {
  view.value = 'detail'
  comicId.value = item.id
  info.value = undefined
  chapters.value = []
  detailError.value = ''
  loadingDetail.value = true
  try {
    const result = await detail(uuid, item.id)
    info.value = result.info
    chapters.value = [...result.chapters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const infoCover = coverUrl(result.info?.cover)
    if (infoCover && !covers[item.id]) {
      const host = await openPlugin(uuid)
      try {
        const bytes = await host.callBytes('fetchImageBytes', { url: infoCover }, { timeoutMs: 30_000 })
        if (bytes?.length) covers[item.id] = bytesToObjectUrl(bytes, infoCover)
      } catch { /* 忽略封面失败 */ } finally { host.dispose() }
    }
  } catch (e: any) {
    detailError.value = e?.message ?? String(e)
  } finally {
    loadingDetail.value = false
  }
}

function backToSearch() {
  view.value = 'search'
  closeReader()
}

function taskKey(chapter: ComicChapter) {
  return `${uuid}:${comicId.value}:${chapterRequestId(chapter)}`
}

async function download(chapter: ComicChapter) {
  const key = chapterRequestId(chapter)
  if (downloads[key]) return
  downloads[key] = { phase: 'chapter', loaded: 0, total: 0 }
  const result = await downloadChapterAsCbz(uuid, comicId.value, chapter, {
    taskGroupKey: taskKey(chapter),
    onProgress: progress => { downloads[key] = { ...progress } },
  })
  delete downloads[key]
  if (result.ok) {
    await library.refresh()
    toast(t('comics.downloadSuccess'), 'success')
  } else if (result.error !== 'cancelled') {
    toast(result.error ?? t('common.unknownError'), 'error', 6000)
  }
}

function cancel(chapter: ComicChapter) {
  cancelDownload(taskKey(chapter))
}

function downloadLabel(chapter: ComicChapter): string {
  const progress = downloads[chapterRequestId(chapter)]
  if (!progress) return t('comics.download')
  if (progress.phase === 'images') return `${progress.loaded}/${progress.total}`
  if (progress.phase === 'packing' || progress.phase === 'importing') return t('comics.packing')
  return t('comics.downloading')
}

// ---- 在线阅读 ----
const reader = reactive({
  open: false,
  loading: false,
  chapterName: '',
  pages: [] as ComicPage[],
  urls: {} as Record<number, string>,
  errors: {} as Record<number, boolean>,
})
const readerScroll = ref<HTMLElement>()
const currentChapter = ref<ComicChapter | undefined>()
let readerHost: ComicPluginHost | null = null
let observer: IntersectionObserver | null = null
const loadingPages = new Set<number>()
const readerKey = computed(() => currentChapter.value ? taskKey(currentChapter.value) : 'reader')

function ensurePage(index: number) {
  const pageInfo = reader.pages[index]
  if (!pageInfo || reader.urls[index] || loadingPages.has(index) || !readerHost) return
  loadingPages.add(index)
  readerHost.callBytes(
    'fetchImageBytes',
    { url: pageInfo.url, taskGroupKey: readerKey.value },
    { timeoutMs: 60_000 },
  ).then(bytes => {
    if (bytes?.length) reader.urls[index] = bytesToObjectUrl(bytes, pageInfo.url)
    else reader.errors[index] = true
  }).catch(() => { reader.errors[index] = true })
    .finally(() => loadingPages.delete(index))
}

function setupObserver() {
  observer?.disconnect()
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const index = Number((entry.target as HTMLElement).dataset.pageIndex)
      ensurePage(index)
      observer?.unobserve(entry.target)
    }
  }, { root: readerScroll.value ?? null, rootMargin: '900px 0px' })
  readerScroll.value?.querySelectorAll<HTMLElement>('[data-page-index]').forEach(el => observer?.observe(el))
}

async function openReader(chapter: ComicChapter) {
  closeReader()
  currentChapter.value = chapter
  reader.open = true
  reader.loading = true
  reader.chapterName = chapter.name
  try {
    readerHost = await openPlugin(uuid, { cancelledGroups: new Set() })
    const raw = await readerHost.call<ComicChapterResult>(
      'getChapter',
      { comicId: comicId.value, chapterId: chapterRequestId(chapter) },
      { timeoutMs: 60_000 },
    )
    const content = normalizeChapter(raw)
    reader.pages = content.pages
    reader.chapterName = content.chapterName || chapter.name
    if (!reader.pages.length) throw new Error(t('comics.noPages'))
    await nextTick()
    setupObserver()
    for (let i = 0; i < Math.min(3, reader.pages.length); i++) ensurePage(i)
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
    closeReader()
  } finally {
    reader.loading = false
  }
}

function closeReader() {
  observer?.disconnect()
  observer = null
  for (const url of Object.values(reader.urls)) URL.revokeObjectURL(url)
  reader.urls = {}
  reader.errors = {}
  reader.pages = []
  reader.open = false
  reader.loading = false
  loadingPages.clear()
  readerHost?.dispose()
  readerHost = null
}

const chapterIndex = computed(() => chapters.value.findIndex(
  c => chapterRequestId(c) === (currentChapter.value ? chapterRequestId(currentChapter.value) : ''),
))

function switchChapter(offset: number) {
  const next = chapters.value[chapterIndex.value + offset]
  if (next) void openReader(next)
}
</script>

<template>
  <div class="comic-source">
    <header class="toolbar">
      <button class="btn btn-ghost back-btn" @click="router.push('/comics')">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m15 18-6-6 6-6"/></svg>
        {{ t('nav.comics') }}
      </button>
      <div class="heading">
        <h1>{{ plugin?.name ?? t('comics.sources') }}</h1>
      </div>
      <div class="spacer" />
      <div v-if="view === 'search'" class="search-field">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16.5 16.5 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input v-model="keyword" class="search" type="search" :placeholder="t('comics.searchOnline')" @keyup.enter="doSearch()" />
      </div>
      <button v-if="view === 'search'" class="btn btn-primary" :disabled="searching || !keyword.trim()" @click="doSearch()">{{ t('comics.search') }}</button>
      <button v-else class="btn" @click="backToSearch">{{ t('comics.backToSearch') }}</button>
    </header>

    <p v-if="!plugin" class="error-text">{{ t('comics.sourceMissing') }}</p>

    <!-- 搜索结果 -->
    <template v-else-if="view === 'search'">
      <p v-if="searchError" class="error-text">{{ searchError }}</p>
      <p v-if="searching" class="hint loading-hint">{{ t('comics.searching') }}</p>
      <div v-if="items.length" class="result-grid">
        <button v-for="item in items" :key="item.id" type="button" class="result-card" @click="openDetail(item)">
          <div class="result-cover">
            <img v-if="covers[item.id]" :src="covers[item.id]" alt="" loading="lazy" />
            <div v-else class="cover-placeholder" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
            </div>
          </div>
          <div class="result-title">{{ item.title }}</div>
          <div class="result-subtitle">{{ item.subtitle || item.updatedAt || '' }}</div>
        </button>
      </div>
      <div v-else-if="!searching && !searchError" class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4" stroke-linecap="round"/></svg>
        </div>
        <p class="empty-title">{{ keyword ? t('comics.noSearchResult') : t('comics.searchHintTitle') }}</p>
        <p class="hint">{{ t('comics.searchHint') }}</p>
      </div>
      <div v-if="paging && page < paging.pages" class="load-more">
        <button class="btn" :disabled="searching" @click="loadMore">{{ t('comics.loadMore') }}</button>
      </div>
    </template>

    <!-- 详情与章节 -->
    <template v-else>
      <p v-if="detailError" class="error-text">{{ detailError }}</p>
      <p v-if="loadingDetail" class="hint loading-hint">{{ t('comics.loadingDetail') }}</p>
      <div v-if="info" class="detail-head">
        <div class="detail-cover">
          <img v-if="covers[comicId]" :src="covers[comicId]" alt="" />
          <div v-else class="cover-placeholder" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
          </div>
        </div>
        <div class="detail-meta">
          <h2>{{ info.title }}</h2>
          <p class="detail-creator">{{ info.creator?.name || '' }}</p>
          <p class="detail-desc">{{ info.description || '' }}</p>
          <p class="hint">{{ t('comics.chapterCount', { count: chapters.length }) }}</p>
        </div>
      </div>

      <div v-if="chapters.length" class="chapter-list">
        <div v-for="chapter in chapters" :key="chapterRequestId(chapter)" class="chapter-row">
          <span class="chapter-order">{{ chapter.order ?? '' }}</span>
          <span class="chapter-name" :title="chapter.name">{{ chapter.name }}</span>
          <div class="spacer" />
          <button class="btn" @click="openReader(chapter)">{{ t('comics.readOnline') }}</button>
          <button class="btn btn-primary" :disabled="!!downloads[chapterRequestId(chapter)]" @click="download(chapter)">
            {{ downloadLabel(chapter) }}
          </button>
          <button v-if="downloads[chapterRequestId(chapter)]" class="btn btn-ghost" :title="t('comics.cancel')" @click="cancel(chapter)">×</button>
        </div>
      </div>
      <div v-else-if="!loadingDetail && !detailError" class="empty">
        <p class="empty-title">{{ t('comics.noChapters') }}</p>
      </div>
    </template>

    <!-- 在线阅读 -->
    <div v-if="reader.open" class="reader-overlay">
      <header class="reader-bar">
        <button class="btn btn-ghost" @click="closeReader">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>
          {{ t('comics.closeReader') }}
        </button>
        <span class="reader-title">{{ reader.chapterName }}</span>
        <div class="spacer" />
        <span class="count">{{ Object.keys(reader.urls).length }}/{{ reader.pages.length }}</span>
      </header>
      <div ref="readerScroll" class="reader-scroll">
        <p v-if="reader.loading" class="hint loading-hint">{{ t('comics.loadingChapter') }}</p>
        <div
          v-for="(pageInfo, index) in reader.pages"
          :key="pageInfo.id || index"
          class="reader-page"
          :data-page-index="index"
        >
          <img v-if="reader.urls[index]" :src="reader.urls[index]" :alt="`${index + 1}`" />
          <div v-else class="reader-placeholder">
            <span v-if="reader.errors[index]">✕ {{ t('comics.imageFailed') }}</span>
            <span v-else>{{ index + 1 }}</span>
          </div>
        </div>
        <div v-if="!reader.loading && reader.pages.length" class="reader-nav">
          <button class="btn" :disabled="chapterIndex <= 0" @click="switchChapter(-1)">{{ t('comics.prevChapter') }}</button>
          <button class="btn" :disabled="chapterIndex < 0 || chapterIndex >= chapters.length - 1" @click="switchChapter(1)">{{ t('comics.nextChapter') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.comic-source {
  min-height: 100%;
  max-width: calc(var(--page-max) + 2 * var(--page-x));
  margin: 0 auto;
  padding: 0 var(--page-x) calc(var(--page-bottom) + var(--lr-safe-bottom));
  position: relative;
}
.toolbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 0 calc(-1 * var(--page-x)) 18px;
  padding: var(--page-top) calc(var(--page-x) + var(--chrome-inset-right)) 12px var(--page-x);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  border-bottom: 1px solid transparent;
}
.heading { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.toolbar h1 { font-size: var(--page-title); font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
.spacer { flex: 1; }
.count { color: var(--text-3); font-size: 13px; white-space: nowrap; }
.back-btn { padding-left: 8px; }
.search-field { position: relative; display: flex; align-items: center; width: 260px; max-width: 100%; }
.search-icon { position: absolute; left: 12px; color: var(--text-3); pointer-events: none; }
.search { width: 100%; padding-left: 34px; padding-right: 30px; border-color: transparent; border-radius: var(--radius-pill); background: var(--surface-2); }
.hint { color: var(--text-3); font-size: 13px; line-height: 1.6; margin: 0; }
.loading-hint { padding: 12px 0; }
.error-text { color: var(--danger, #d9534f); font-size: 13px; padding: 10px 0; }

.result-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 22px 16px; }
.result-card {
  display: flex; flex-direction: column; gap: 6px; text-align: left;
  padding: 0; border: 0; background: none; color: inherit; cursor: pointer; min-width: 0;
}
.result-cover, .detail-cover {
  aspect-ratio: 3 / 4; border-radius: 10px; overflow: hidden;
  background: var(--surface-2); border: 1px solid var(--line);
}
.result-cover img, .detail-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover-placeholder { width: 100%; height: 100%; display: grid; place-items: center; color: var(--text-3); }
.cover-placeholder svg { width: 38%; height: 38%; }
.result-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-subtitle { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-card:hover .result-title { color: var(--accent, currentColor); }

.empty {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: 40px 16px; border: 1px dashed var(--line);
  border-radius: var(--radius-lg, 14px); background: var(--surface-1);
}
.empty-icon { color: var(--text-3); width: 38px; height: 38px; margin-bottom: 12px; }
.empty-icon svg { width: 100%; height: 100%; }
.empty-title { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
.load-more { display: flex; justify-content: center; padding: 22px 0; }

.detail-head { display: flex; gap: 20px; margin: 8px 0 22px; }
.detail-cover { width: 132px; flex: none; }
.detail-meta { min-width: 0; }
.detail-meta h2 { font-size: 20px; margin: 0 0 6px; }
.detail-creator { font-size: 13px; color: var(--text-3); margin: 0 0 10px; }
.detail-desc { font-size: 13px; line-height: 1.7; color: var(--text-2); margin: 0 0 10px; max-height: 6.8em; overflow: hidden; }
.chapter-list { border: 1px solid var(--line); border-radius: var(--radius-lg, 14px); overflow: hidden; }
.chapter-row {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  border-bottom: 1px solid var(--line); background: var(--surface-1);
}
.chapter-row:last-child { border-bottom: 0; }
.chapter-order { width: 34px; flex: none; color: var(--text-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.chapter-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.chapter-row .btn { flex: none; white-space: nowrap; }

/* ---- 在线阅读 ---- */
.reader-overlay {
  position: fixed; inset: 0; z-index: 100;
  display: flex; flex-direction: column; background: var(--bg);
}
.reader-bar {
  display: flex; align-items: center; gap: 10px; padding: 10px 16px;
  border-bottom: 1px solid var(--line); background: var(--surface-1); flex: none;
}
.reader-title { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reader-scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; align-items: center; padding: 12px 0 40px; }
.reader-page { width: min(100%, 900px); min-height: 180px; display: flex; justify-content: center; }
.reader-page img { display: block; width: 100%; height: auto; }
.reader-placeholder {
  width: 100%; min-height: 180px; display: grid; place-items: center;
  color: var(--text-3); font-size: 13px; background: var(--surface-2);
}
.reader-nav { display: flex; gap: 12px; padding: 24px 0 8px; }
</style>
