<script setup lang="ts">
/**
 * 漫画源唯一入口: 浏览(插件首页 tab / 云收藏) → 搜索 → Breeze 风格详情
 * → 在线阅读 / 章节下载入库。原「发现」页已并入这里的浏览面板。
 * UI 沿用藏书页与漫画页的卡片、按钮、工具栏语言, 不另起一套视觉。
 */
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from '../services/toast'
import { t } from '../i18n'
import {
  chapterRequestId, coverUrl, getPlugin, openPlugin, search, detail,
  type ComicPluginHost,
} from '../services/comicPlugin'
import { bytesToObjectUrl } from '../services/comicPlugin/download'
import { cancel as cancelTask, enqueue, findTask, initDownloads, resume } from '../services/comicPlugin/downloadCenter'
import type { DetailChip, DetailMetaGroup } from '../services/comicPlugin/normalize'
import ComicDiscoverPanel from '../components/ComicDiscoverPanel.vue'
import { useLibrary } from '../stores/library'
import { readerPath } from '../services/readerRoute'
import type {
  ComicChapter, ComicPaging, ComicSearchItem, ComicInfo,
} from '../services/comicPlugin/types'

const route = useRoute()
const router = useRouter()
const library = useLibrary()
const uuid = String(route.params.uuid ?? '')
const plugin = getPlugin(uuid)
/** 设置页「查看云端收藏」会带 ?tab=cloudFavorite 落到对应 tab */
const initialTab = String(route.query.tab ?? '')

const view = ref<'browse' | 'search' | 'detail'>('browse')
const keyword = ref('')
const searchInput = ref<HTMLInputElement>()
const page = ref(1)
const items = ref<ComicSearchItem[]>([])
const paging = ref<ComicPaging | undefined>()
const searching = ref(false)
const searchError = ref('')
const covers = reactive<Record<string, string>>({})

const comicId = ref('')
const info = ref<ComicInfo | undefined>()
const chapters = ref<ComicChapter[]>([])
const titleMeta = ref<DetailChip[]>([])
const metadata = ref<DetailMetaGroup[]>([])
const recommend = ref<ComicSearchItem[]>([])
const stats = reactive({ views: 0, likes: 0, comments: 0 })
const loadingDetail = ref(false)
const detailError = ref('')

let coverHost: ComicPluginHost | null = null
let coverSeq = 0

onBeforeUnmount(() => {
  coverObserver?.disconnect()
  coverObserver = null
  coverHost?.dispose()
  coverHost = null
  for (const url of Object.values(covers)) URL.revokeObjectURL(url)
})

/** 封面也走插件的 fetchImageBytes (带防盗链头), 一个长驻宿主并发拉取 */
/** 一次最多预取多少张封面: 搜索结果动辄 80 条, 全量同步拉会把插件宿主占满 */
const COVER_LIMIT = 12
const COVER_WORKERS = 3

/** 单张封面: 供滚动懒加载使用 */
async function loadOneCover(item: ComicSearchItem) {
  const url = coverUrl(item.cover)
  if (!url || covers[item.id]) return
  if (!coverHost) coverHost = await openPlugin(uuid)
  const bytes = await coverHost.callBytes('fetchImageBytes', { url }, { timeoutMs: 20_000 })
  if (bytes?.length) covers[item.id] = bytesToObjectUrl(bytes, url)
}

// 滚动到哪补到哪: 首屏预取 COVER_LIMIT 张, 其余等卡片进入视口再拉,
// 既不会出现大片占位图, 也不会因为一次拉几十上百张把界面拖死
let coverObserver: IntersectionObserver | null = null
const coverInFlight = new Set<string>()
let coverItems: ComicSearchItem[] = []

function watchCovers(list: ComicSearchItem[]) {
  coverItems = list
  if (typeof IntersectionObserver === 'undefined') return
  coverObserver?.disconnect()
  coverObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const id = (entry.target as HTMLElement).dataset.coverId
      const item = id ? coverItems.find(i => i.id === id) : undefined
      if (!item || covers[item.id] || coverInFlight.has(item.id)) continue
      coverInFlight.add(item.id)
      coverObserver?.unobserve(entry.target)
      void loadOneCover(item).catch(() => { /* 失败留占位图 */ })
        .finally(() => coverInFlight.delete(item.id))
    }
  }, { rootMargin: '300px' })
  void nextTick(() => {
    document.querySelectorAll<HTMLElement>('.result-card[data-cover-id]')
      .forEach(el => coverObserver?.observe(el))
  })
}

async function loadCovers(list: ComicSearchItem[]) {
  const seq = ++coverSeq
  if (!coverHost) coverHost = await openPlugin(uuid)
  const host = coverHost
  if (seq !== coverSeq) return
  const queue = list.filter(item => {
    const url = coverUrl(item.cover)
    return url && !covers[item.id]
  }).slice(0, COVER_LIMIT)
  let cursor = 0
  const worker = async () => {
    while (seq === coverSeq && cursor < queue.length) {
      const item = queue[cursor++]
      const url = coverUrl(item.cover)
      try {
        const bytes = await host.callBytes('fetchImageBytes', { url }, { timeoutMs: 20_000 })
        if (seq === coverSeq && bytes?.length) covers[item.id] = bytesToObjectUrl(bytes, url)
      } catch { /* 单张封面失败用占位图 */ }
    }
  }
  await Promise.all(Array.from({ length: COVER_WORKERS }, () => worker()))
  if (seq === coverSeq) watchCovers(list)
}

async function doSearch(reset = true) {
  const kw = keyword.value.trim()
  if (!kw || searching.value) return
  coverSeq++            // 停掉上一批还在跑的封面任务, 别和新结果抢宿主
  view.value = 'search'
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
  // 把当前详情写进地址栏: 切到别的页面再回来(或刷新)能直接复原这一部
  void router.replace({
    path: route.path,
    query: { ...route.query, comicId: item.id, title: item.title || '', keyword: undefined },
  })
  info.value = undefined
  chapters.value = []
  titleMeta.value = []
  metadata.value = []
  recommend.value = []
  stats.views = stats.likes = stats.comments = 0
  detailError.value = ''
  loadingDetail.value = true
  try {
    const result = await detail(uuid, item.id)
    info.value = result.info
    chapters.value = [...result.chapters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    titleMeta.value = result.titleMeta
    metadata.value = result.metadata
    recommend.value = result.recommend
    stats.views = result.totalViews
    stats.likes = result.totalLikes
    stats.comments = result.totalComments
    // 从列表 / 云收藏点进来时卡片可能没带封面, 详情的 cover.url 才是准的
    const infoCover = coverUrl(result.info?.cover) || coverUrl(item.cover)
    if (infoCover && !covers[item.id]) {
      const host = await openPlugin(uuid)
      try {
        const bytes = await host.callBytes('fetchImageBytes', { url: infoCover }, { timeoutMs: 30_000 })
        if (bytes?.length) covers[item.id] = bytesToObjectUrl(bytes, infoCover)
      } catch { /* 忽略封面失败 */ } finally { host.dispose() }
    }
    if (recommend.value.length) void loadCovers(recommend.value)
  } catch (e: any) {
    detailError.value = e?.message ?? String(e)
  } finally {
    loadingDetail.value = false
  }
}

function backToBrowse() {
  view.value = 'browse'
  // 从设置页 / 外部链接带参数进来时, 返回后清掉 query, 避免刷新又跳回详情
  if (route.query.comicId || route.query.keyword || route.query.tab) {
    void router.replace({ path: route.path })
  }
}

/** 浏览面板点漫画 → 详情; 点搜索词 / 空态引导 → 搜索视图 */
function onPanelComic(payload: { comicId: string; title?: string }) {
  void openDetail({ id: payload.comicId, title: payload.title ?? '' } as ComicSearchItem)
}
function onPanelSearch(payload: { keyword: string }) {
  keyword.value = payload.keyword
  view.value = 'search'
  if (payload.keyword.trim()) void doSearch()
  else searchInput.value?.focus()
}
/** 详情里的作者 / 标签 chip 触发站内搜索 (Breeze 的 onTap.openSearch) */
function onChipSearch(chip: DetailChip) {
  if (!chip.keyword) return
  keyword.value = chip.keyword
  void doSearch()
}
function startReading() {
  const first = chapters.value[0]
  if (first) void openReader(first)
}
function goSettings() {
  void router.push(`/comics/settings/${encodeURIComponent(uuid)}`)
}

/** 外部链接可带 comicId 直达详情 / keyword 自动搜索 / tab 定位云端收藏 */
onMounted(() => {
  initDownloads()
  if (!plugin) return
  const comicIdParam = String(route.query.comicId ?? '')
  if (comicIdParam) {
    void openDetail({ id: comicIdParam, title: String(route.query.title ?? '') } as ComicSearchItem)
    return
  }
  const keywordParam = String(route.query.keyword ?? '')
  if (keywordParam) {
    keyword.value = keywordParam
    void doSearch()
  }
  // 其余情况保持 browse, 由 ComicDiscoverPanel 自己拉首页 tab
})

function taskOf(chapter: ComicChapter) {
  return findTask(uuid, comicId.value, chapter)
}

/** 下载统一交给全局下载中心: 进度不随页面销毁, 侧栏「下载」也能看到 */
async function download(chapter: ComicChapter) {
  const { task, skipped } = await enqueue({
    uuid,
    comicId: comicId.value,
    chapter,
    comicTitle: info.value?.title || comicId.value,
    cover: coverUrl(info.value?.cover),
  })
  // 已入库的章节: 不重复下载, 提示里带「打开」直接读
  if (skipped) {
    toast(t('comics.downloadExists'), 'info', 4000, { label: t('downloads.open'), run: () => { void openDownloaded(chapter) } })
    return
  }
  if (task.status === 'done') toast(t('comics.downloadSuccess'), 'success')
}

/** 已入库的章节直接打开; 书被从藏书删了就提示, 让用户重新下载 */
async function openDownloaded(chapter: ComicChapter) {
  const task = taskOf(chapter)
  if (!task?.bookId) return
  if (!library.books.length) await library.refresh()
  const book = library.books.find(b => b.id === task.bookId)
  if (book) { void router.push(readerPath(book)); return }
  toast(t('downloads.fileMissing'), 'error')
}

/** 章节行下载按钮: 已入库就直接读, 否则进下载队列 */
function onChapterAction(chapter: ComicChapter) {
  const task = taskOf(chapter)
  if (task?.status === 'done') { void openDownloaded(chapter); return }
  if (task?.status === 'paused') { resume(task.id); return }
  void download(chapter)
}

function cancel(chapter: ComicChapter) {
  const task = taskOf(chapter)
  if (task) cancelTask(task.id)
}

function downloadLabel(chapter: ComicChapter): string {
  const task = taskOf(chapter)
  if (!task) return t('comics.download')
  if (task.status === 'done') return t('downloads.groupDone')
  if (task.status === 'paused') return t('downloads.paused')
  if (task.status === 'failed' || task.status === 'interrupted') return t('downloads.retry')
  if (task.phase === 'images' && task.total) return `${task.loaded}/${task.total}`
  if (task.phase === 'packing' || task.phase === 'importing') return t('comics.packing')
  return t('comics.downloading')
}

// ---- 在线阅读: 跳到独立阅读器页面 (沉浸式外壳, 缩放/章节/进度都在那边) ----
function openReader(chapter: ComicChapter) {
  void router.push({
    path: `/read/comic/${encodeURIComponent(uuid)}/${encodeURIComponent(comicId.value)}/${encodeURIComponent(chapterRequestId(chapter))}`,
    query: {
      title: info.value?.title || comicId.value,
      back: route.fullPath,
    },
  })
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
      <div v-if="view !== 'detail'" class="search-field">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16.5 16.5 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input ref="searchInput" v-model="keyword" class="search" type="search" :placeholder="t('comics.searchOnline')" @keyup.enter="doSearch()" />
      </div>
      <button v-if="view !== 'detail'" class="btn btn-primary" :disabled="searching || !keyword.trim()" @click="doSearch()">{{ t('comics.search') }}</button>
      <button v-if="view !== 'browse'" class="btn" @click="backToBrowse">{{ t('comics.backToBrowse') }}</button>
      <button class="btn" @click="goSettings">{{ t('comics.pluginSettings') }}</button>
    </header>

    <p v-if="!plugin" class="error-text">{{ t('comics.sourceMissing') }}</p>

    <!-- 浏览: 插件首页 tab / 云收藏 / 功能页 (原「发现」页并入, 只留一个入口) -->
    <div v-if="plugin" v-show="view === 'browse'" class="browse-panel">
      <ComicDiscoverPanel
        :uuid="uuid" :initial-tab="initialTab"
        @open-comic="onPanelComic" @open-search="onPanelSearch"
      />
    </div>

    <!-- 搜索结果 -->
    <template v-if="plugin && view === 'search'">
      <h2 class="section-title">{{ t('comics.searchResults') }}</h2>
      <p v-if="searchError" class="error-text">{{ searchError }}</p>
      <p v-if="searching" class="hint loading-hint">{{ t('comics.searching') }}</p>
      <div v-if="items.length" class="result-grid">
        <button v-for="item in items" :key="item.id" type="button" class="result-card" :data-cover-id="item.id" @click="openDetail(item)">
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
        <p class="empty-title">{{ t('comics.noSearchResult') }}</p>
        <p class="hint">{{ t('comics.searchHint') }}</p>
      </div>
      <div v-if="paging && page < paging.pages" class="load-more">
        <button class="btn" :disabled="searching" @click="loadMore">{{ t('comics.loadMore') }}</button>
      </div>
    </template>

    <!-- Breeze 风格详情: 封面 / 元信息 / 分组标签 / 章节 / 相关推荐; 不含点赞收藏按钮 -->
    <template v-if="plugin && view === 'detail'">
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
          <p v-if="info.creator?.name" class="detail-creator">{{ info.creator.name }}</p>
          <!-- titleMeta: 浏览 / 更新时间 / 章节数 / 总页数 / 车号 -->
          <div v-if="titleMeta.length" class="title-meta">
            <button
              v-for="(chip, i) in titleMeta" :key="`tm-${i}`" type="button"
              class="meta-pill" :class="{ clickable: !!chip.keyword }"
              :disabled="!chip.keyword" @click="onChipSearch(chip)"
            >{{ chip.label }}</button>
          </div>
          <!-- 只展示数字, 不摆点赞 / 评论 / 收藏按钮 -->
          <div class="detail-stats">
            <span v-if="stats.likes">{{ t('comics.totalLikes') }} {{ stats.likes }}</span>
            <span v-if="stats.comments">{{ t('comics.totalComments') }} {{ stats.comments }}</span>
            <span v-if="stats.views">{{ t('comics.totalViews') }} {{ stats.views }}</span>
          </div>
          <p v-if="info.description" class="detail-desc">{{ info.description }}</p>
          <div class="detail-start">
            <button class="btn btn-primary" :disabled="!chapters.length" @click="startReading">{{ t('comics.startReading') }}</button>
            <span class="hint">{{ t('comics.chapterCount', { count: chapters.length }) }}</span>
          </div>
        </div>
      </div>

      <!-- metadata: 作者 / 标签 / 作品 / 角色, chip 可触发站内搜索 -->
      <section v-if="metadata.length" class="meta-groups">
        <div v-for="group in metadata" :key="group.key" class="meta-group">
          <span class="meta-group-name">{{ group.name }}</span>
          <div class="chip-row">
            <button
              v-for="(chip, i) in group.chips" :key="`${group.key}-${i}`" type="button"
              class="chip" :class="{ clickable: !!chip.keyword }"
              :disabled="!chip.keyword" @click="onChipSearch(chip)"
            >{{ chip.label }}</button>
          </div>
        </div>
      </section>

      <h2 class="section-title">{{ t('comics.detailChapters') }}</h2>
      <div v-if="chapters.length" class="chapter-list">
        <div v-for="chapter in chapters" :key="chapterRequestId(chapter)" class="chapter-row">
          <span class="chapter-order">{{ chapter.order ?? '' }}</span>
          <span class="chapter-name" :title="chapter.name">{{ chapter.name }}</span>
          <div class="spacer" />
          <button class="btn" @click="openReader(chapter)">{{ t('comics.readOnline') }}</button>
          <button
            class="btn btn-primary"
            :disabled="taskOf(chapter)?.status === 'queued' || taskOf(chapter)?.status === 'running'"
            @click="onChapterAction(chapter)"
          >
            {{ downloadLabel(chapter) }}
          </button>
          <button
            v-if="taskOf(chapter)?.status === 'queued' || taskOf(chapter)?.status === 'running' || taskOf(chapter)?.status === 'paused'"
            class="btn btn-ghost"
            :title="t('comics.cancel')"
            @click="cancel(chapter)"
          >×</button>
        </div>
      </div>
      <div v-else-if="!loadingDetail && !detailError" class="empty">
        <p class="empty-title">{{ t('comics.noChapters') }}</p>
      </div>

      <template v-if="recommend.length">
        <h2 class="section-title">{{ t('comics.detailRecommend') }}</h2>
        <div class="result-grid">
          <button v-for="item in recommend" :key="item.id" type="button" class="result-card" @click="openDetail(item)">
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
      </template>
    </template>

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
  /* 自定义标题栏下多留一段, 避免标题和搜索框贴着窗口上沿 */
  padding: calc(var(--page-top) + 20px) calc(var(--page-x) + var(--chrome-inset-right)) 16px var(--page-x);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  border-bottom: 1px solid transparent;
}
.heading { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.toolbar h1 { font-size: var(--page-title); font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
.spacer { flex: 1; }
.count { color: var(--text-3); font-size: 13px; white-space: nowrap; }
.back-btn { padding-left: 8px; }
.search-field { position: relative; display: flex; align-items: center; width: 340px; max-width: 100%; }
.search-icon { position: absolute; left: 12px; color: var(--text-3); pointer-events: none; }
/* 输入框和右侧按钮统一用 --control-h, 高度对齐; 原来没给高度, 比按钮矮一截显得不协调 */
.search {
  width: 100%; height: var(--control-h);
  padding: 0 30px 0 34px;
  border-color: transparent; border-radius: var(--radius-pill);
  background: var(--surface-2); font-size: 13px;
}
.search::-webkit-search-cancel-button { -webkit-appearance: none; }
/* 顶栏按钮收一点, 别压过搜索框 */
.toolbar .btn { padding: 0 12px; font-size: 13px; }
.hint { color: var(--text-3); font-size: 13px; line-height: 1.6; margin: 0; }
.loading-hint { padding: 12px 0; }
.section-title { font-size: 15px; font-weight: 600; margin: 4px 0 14px; color: var(--text-2); }
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

.browse-panel { margin-top: 4px; }
.detail-head { display: flex; gap: 22px; margin: 8px 0 20px; }
.detail-cover { width: 176px; flex: none; }
.detail-meta { min-width: 0; flex: 1; }
.detail-meta h2 { font-size: 22px; margin: 0 0 8px; }
.detail-creator { font-size: 13px; color: var(--text-3); margin: 0 0 10px; }
.detail-desc { font-size: 13px; line-height: 1.7; color: var(--text-2); margin: 0 0 10px; max-height: 8.5em; overflow: hidden; }
.title-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
.meta-pill {
  border: 1px solid var(--line); background: var(--surface-2); color: var(--text-2);
  border-radius: 6px; padding: 3px 9px; font-size: 12px; cursor: default;
}
.meta-pill.clickable { cursor: pointer; }
.meta-pill.clickable:hover { color: var(--text); border-color: var(--accent, currentColor); }
.detail-stats { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-3); margin: 0 0 10px; }
.detail-start { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.meta-groups {
  border: 1px solid var(--line); border-radius: var(--radius-lg, 14px);
  padding: 12px 16px; margin: 0 0 20px; background: var(--surface-1);
}
.meta-group { display: flex; gap: 12px; align-items: flex-start; padding: 6px 0; }
.meta-group-name { flex: none; width: 48px; font-size: 12px; color: var(--text-3); padding-top: 6px; }
.chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  border: 1px solid var(--line); background: var(--surface-2); color: var(--text-2);
  border-radius: 999px; padding: 5px 12px; font-size: 12px; cursor: default;
}
.chip.clickable { cursor: pointer; }
.chip.clickable:hover { color: var(--text); border-color: var(--accent, currentColor); }
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
</style>
