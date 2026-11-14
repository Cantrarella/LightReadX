<script setup lang="ts">
/**
 * 漫画阅读器: 在线 (插件抓图) 与本地 (CBZ/CBR) 共用。
 *
 * 在线走插件 fetchImageBytes 抓图 (处理防盗链), 本地走 comicLocal 解包图片;
 * 两者都转 object URL 交给 <img>, 共享同一套外壳 (顶栏/底栏自动隐藏、缩放、
 * 单页/长条、章节抽屉、页码进度) 与书签/背景音/全屏/阅读模式。
 * 大图很占内存, 所以按"离当前页的距离"做 LRU 回收。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { t } from '../i18n'
import { toast } from '../services/toast'
import { getStorage, isTauri, type AnnotationRec } from '../storage'
import { useSettings } from '../stores/settings'
import { useAmbient } from '../services/ambient'
import AmbientPanel from '../components/AmbientPanel.vue'
import { setWindowFullscreen } from '../services/windowChrome'
import { loadLocalComic } from '../services/comicLocal'
import {
  chapterRequestId, normalizeChapter, normalizeDetail, openPlugin,
  type ComicPluginHost,
} from '../services/comicPlugin'
import { bytesToObjectUrl } from '../services/comicPlugin/download'
import { cacheGet, cachePut } from '../services/comicPlugin/imageCache'
import type { ComicChapter, ComicChapterResult, ComicDetailResult, ComicPage } from '../services/comicPlugin/types'

const route = useRoute()
const router = useRouter()
const settings = useSettings()

/** 本地漫画模式: /read/comic-local/:id 无 uuid/comicId/chapterId 三段 */
const isLocal = computed(() => route.path.startsWith('/read/comic-local'))
const bookId = computed(() => String(route.params.id ?? ''))

const uuid = computed(() => isLocal.value ? '' : String(route.params.uuid ?? ''))
const comicId = computed(() => isLocal.value ? '' : String(route.params.comicId ?? ''))
const chapterId = computed(() => isLocal.value ? '' : String(route.params.chapterId ?? ''))

/** 顶栏/底栏 自动隐藏 */
const barsVisible = ref(true)
let barsTimer: number | undefined
function showBars(autoHide = false) {
  window.clearTimeout(barsTimer)
  barsVisible.value = true
  if (autoHide) barsTimer = window.setTimeout(() => { barsVisible.value = false }, 2600)
}
function hideBars() { window.clearTimeout(barsTimer); barsVisible.value = false }
/** 目录打开时把工具栏收掉, 免得压住抽屉 */
function toggleToc() {
  tocOpen.value = !tocOpen.value
  if (tocOpen.value) hideBars()
  else showBars(true)
}

const loading = ref(true)
const bootError = ref('')
const comicTitle = ref(String(route.query.title ?? ''))
const chapters = ref<ComicChapter[]>([])
const chapterName = ref('')
const pages = ref<ComicPage[]>([])
const pageIndex = ref(0)
const zoom = ref(1)
const mode = ref<'single' | 'long'>('single')
const tocOpen = ref(false)
const urls = reactive<Record<number, string>>({})
const errors = reactive<Record<number, boolean>>({})

const scrollEl = ref<HTMLElement>()

let host: ComicPluginHost | null = null
let observer: IntersectionObserver | null = null
const inflight = new Set<number>()
/** 最多同时留多少张解码后的图, 超了按离当前页的距离回收 */
const MAX_CACHED = 14

// ---- 书签 (本地漫画按 bookId+页索引存, 在线按 comicId+章节+页存) ----
const annotations = ref<AnnotationRec[]>([])
const bookmarkKey = computed(() => {
  const page = pageIndex.value
  return isLocal.value
    ? `page:${bookId.value}:${page}`
    : `page:${comicId.value}:${chapterId.value}:${page}`
})
const isBookmarked = computed(() => annotations.value.some(a => a.cfi === bookmarkKey.value))

async function loadBookmarks() {
  try {
    const storage = await getStorage()
    const targetId = isLocal.value ? bookId.value : comicId.value
    if (!targetId) { annotations.value = []; return }
    annotations.value = (await storage.listAnnotations(targetId)).filter(a => a.kind === 'bookmark')
  } catch { annotations.value = [] }
}

async function toggleBookmark() {
  const key = bookmarkKey.value
  if (!key) return
  const storage = await getStorage()
  const targetId = isLocal.value ? bookId.value : comicId.value
  if (!targetId) return
  const existing = annotations.value.find(a => a.cfi === key)
  if (existing) {
    await storage.deleteAnnotation(existing.id)
    annotations.value = annotations.value.filter(a => a.id !== existing.id)
    toast(t('reader.bookmarkRemoved'))
    return
  }
  const rec: Omit<AnnotationRec, 'id'> = {
    bookId: targetId,
    kind: 'bookmark',
    cfi: key,
    text: `${comicTitle.value || t('reader.position')} · ${pageIndex.value + 1}`,
    color: 'bookmark',
    createdAt: Date.now(),
  }
  const id = await storage.addAnnotation(rec)
  annotations.value.push({ ...rec, id })
  toast(t('reader.bookmarkAdded'), 'success')
}

// ---- 背景音 ----
const ambient = useAmbient()
const ambientPanel = ref(false)
function toggleAmbientPanel() {
  ambientPanel.value = !ambientPanel.value
  if (ambientPanel.value) hideBars()
}

// ---- 一键全屏 ----
const isFullscreen = ref(false)
async function toggleFullscreen() {
  try {
    if (isTauri()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const next = !(await getCurrentWindow().isFullscreen())
      await setWindowFullscreen(next)
      isFullscreen.value = next
    } else if (document.fullscreenElement) {
      await document.exitFullscreen()
      isFullscreen.value = false
    } else {
      await document.documentElement.requestFullscreen()
      isFullscreen.value = true
    }
    if (isFullscreen.value) setTimeout(hideBars, 400)
  } catch { /* 平台拒绝全屏时忽略 */ }
}
function syncFullscreenState() {
  if (!isTauri()) isFullscreen.value = !!document.fullscreenElement
}

// ---- 阅读模式面板 (漫画专属, 先做骨架 + 常用项) ----
const readerModeOpen = ref(false)
function toggleReaderMode() {
  readerModeOpen.value = !readerModeOpen.value
  if (readerModeOpen.value) hideBars()
}

const total = computed(() => pages.value.length)
const chapterIndex = computed(() => chapters.value.findIndex(c => chapterRequestId(c) === chapterId.value))
const currentChapter = computed(() => chapters.value[chapterIndex.value])
const progressText = computed(() => `${Math.min(pageIndex.value + 1, Math.max(total.value, 1))} / ${Math.max(total.value, 1)}`)
const stageStyle = computed(() => mode.value === 'single'
  ? { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom.value})` }
  : {})
const pageWidth = computed(() => `min(100%, ${Math.round(900 * zoom.value)}px)`)

// ---- 缩放 / 拖拽 ----
const pan = reactive({ x: 0, y: 0 })
let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null

function clampZoom(value: number) {
  return Math.min(4, Math.max(0.5, Math.round(value * 100) / 100))
}
function setZoom(value: number) {
  zoom.value = clampZoom(value)
  if (zoom.value <= 1) { pan.x = 0; pan.y = 0 }
}
function zoomBy(delta: number) { setZoom(zoom.value + delta) }
function resetZoom() { setZoom(1) }

/** 单页模式: 滚轮直接缩放 (模板上已 preventDefault) */
function onWheel(event: WheelEvent) {
  // 触控板一次会连发几十个事件, 按绝对值收敛一下步长
  const step = Math.abs(event.deltaY) > 40 ? 0.15 : 0.05
  zoomBy(event.deltaY < 0 ? step : -step)
}

/** 长条模式: 普通滚轮留给纵向滚动, Ctrl + 滚轮才缩放 */
function onLongWheel(event: WheelEvent) {
  if (!event.ctrlKey) return
  event.preventDefault()
  const step = Math.abs(event.deltaY) > 40 ? 0.15 : 0.05
  zoomBy(event.deltaY < 0 ? step : -step)
}

function onPointerDown(event: PointerEvent) {
  if (mode.value !== 'single' || zoom.value <= 1) return
  drag = { x: event.clientX, y: event.clientY, ox: pan.x, oy: pan.y, moved: false }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}
function onPointerMove(event: PointerEvent) {
  if (!drag) return
  const dx = event.clientX - drag.x
  const dy = event.clientY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
  pan.x = drag.ox + dx
  pan.y = drag.oy + dy
}
function onPointerUp() {
  // 拖动过就不算点击翻页
  if (drag?.moved) { drag = null; return }
  drag = null
}

/** 单页模式点左右半屏翻页 (放大后不响应, 免得和拖拽抢); 从右到左时点左侧翻下一页 */
function onStageClick(event: MouseEvent) {
  if (mode.value !== 'single' || zoom.value > 1) return
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const onLeft = event.clientX - box.left < box.width / 2
  const next = settings.comicReader.direction === 'rtl' ? (onLeft ? 1 : -1) : (onLeft ? -1 : 1)
  goPage(next)
}

// ---- 取图 ----
function evict(budget = MAX_CACHED) {
  const keys = Object.keys(urls).map(Number)
  if (keys.length <= budget) return
  const current = pageIndex.value
  keys.sort((a, b) => Math.abs(b - current) - Math.abs(a - current))
  for (const index of keys.slice(0, keys.length - budget)) {
    URL.revokeObjectURL(urls[index])
    delete urls[index]
    delete errors[index]
  }
}

async function loadPage(index: number, force = false) {
  const page = pages.value[index]
  if (!page || !host) return
  if (!force && (urls[index] || inflight.has(index))) return
  if (force) { delete errors[index]; if (urls[index]) { URL.revokeObjectURL(urls[index]); delete urls[index] } }
  inflight.add(index)
  try {
    // 先看本地缓存: 同一话重看不用再走一遍插件抓图
    const cached = await cacheGet(page.url)
    if (cached?.length) {
      urls[index] = bytesToObjectUrl(cached, page.url)
      delete errors[index]
      evict()
      return
    }
    const bytes = await host.callBytes('fetchImageBytes', { url: page.url }, { timeoutMs: 60_000 })
    if (!bytes?.length) throw new Error('empty')
    urls[index] = bytesToObjectUrl(bytes, page.url)
    delete errors[index]
    void cachePut(page.url, bytes)
    evict()
  } catch {
    errors[index] = true
  } finally {
    inflight.delete(index)
  }
}

/** 单页模式: 当前页 + 左右各一页 */
function preloadAround(index: number) {
  for (const i of [index, index + 1, index - 1]) {
    if (i >= 0 && i < pages.value.length) void loadPage(i)
  }
}

function retry(index: number) { void loadPage(index, true) }

// ---- 章节 ----
function setupObserver() {
  observer?.disconnect()
  observer = null
  if (!scrollEl.value) return
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const index = Number((entry.target as HTMLElement).dataset.pageIndex)
      void loadPage(index)
      observer?.unobserve(entry.target)
    }
  }, { root: scrollEl.value, rootMargin: '900px 0px' })
  scrollEl.value.querySelectorAll<HTMLElement>('[data-page-index]').forEach(el => observer?.observe(el))
}

function clearPages() {
  observer?.disconnect()
  observer = null
  for (const url of Object.values(urls)) URL.revokeObjectURL(url)
  for (const key of Object.keys(urls)) delete urls[Number(key)]
  for (const key of Object.keys(errors)) delete errors[Number(key)]
  inflight.clear()
  pages.value = []
  pageIndex.value = 0
  pan.x = 0
  pan.y = 0
}

const PROGRESS_KEY = 'lightread.comic.reader.v1'
function readProgress(): Record<string, { chapterId: string; page: number }> {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}') } catch { return {} }
}
function saveProgress() {
  const all = readProgress()
  if (isLocal.value) {
    if (!bookId.value) return
    all[`local:${bookId.value}`] = { chapterId: '', page: pageIndex.value }
  } else {
    if (!comicId.value || !chapterId.value) return
    all[`${uuid.value}:${comicId.value}`] = { chapterId: chapterId.value, page: pageIndex.value }
  }
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(all)) } catch { /* 空间满了就算了 */ }
}

async function loadChapter(id: string) {
  if (!host || !id) return
  loading.value = true
  clearPages()
  chapterName.value = ''
  try {
    const raw = await host.call<ComicChapterResult>(
      'getChapter',
      { comicId: comicId.value, chapterId: id },
      { timeoutMs: 60_000 },
    )
    const content = normalizeChapter(raw)
    chapterName.value = content.chapterName || currentChapter.value?.name || ''
    pages.value = content.pages
    if (!pages.value.length) throw new Error(t('comics.noPages'))

    // 续读: 同一话上次看到第几页
    const saved = readProgress()[`${uuid.value}:${comicId.value}`]
    const start = saved && saved.chapterId === id ? Math.min(saved.page, pages.value.length - 1) : 0
    pageIndex.value = start

    await new Promise(resolve => requestAnimationFrame(resolve))
    if (mode.value === 'long') setupObserver()
    else preloadAround(start)
  } catch (e: any) {
    bootError.value = e?.message ?? t('common.unknownError')
    toast(bootError.value, 'error', 6000)
  } finally {
    loading.value = false
    showBars(true)
  }
}

async function boot() {
  loading.value = true
  bootError.value = ''
  if (isLocal.value) { await bootLocal(); return }
  try {
    host = await openPlugin(uuid.value)
    const raw = await host.call<ComicDetailResult>('getComicDetail', { comicId: comicId.value }, { timeoutMs: 45_000 })
    const info = normalizeDetail(raw)
    chapters.value = [...info.chapters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    comicTitle.value = info.info?.title || comicTitle.value
    if (!chapters.value.length) throw new Error(t('comics.noChapters'))
    const target = chapterId.value || chapterRequestId(chapters.value[0])
    if (target !== chapterId.value) {
      void router.replace({ path: `/read/comic/${uuid.value}/${comicId.value}/${encodeURIComponent(target)}`, query: route.query })
      return
    }
    await loadChapter(target)
  } catch (e: any) {
    bootError.value = e?.message ?? t('common.unknownError')
    loading.value = false
    toast(bootError.value, 'error', 6000)
  }
}

/** 本地漫画: 解包 CBZ/CBR, 把每张图直接塞进 urls 交给渲染 (不走插件) */
async function bootLocal() {
  try {
    const local = await loadLocalComic(bookId.value)
    comicTitle.value = local.title || comicTitle.value
    chapterName.value = ''
    // pages 只用于 total / 长度, 实际图片已在 urls 里
    pages.value = local.pages.map((p, i) => ({ id: p.id, url: `local:${i}` }))
    for (let i = 0; i < local.pages.length; i++) {
      urls[i] = local.pages[i].url
    }
    if (!pages.value.length) throw new Error(t('comics.noPages'))

    // 续读: 本地书按 bookId 记进度
    const saved = readProgress()[`local:${bookId.value}`]
    const start = saved ? Math.min(saved.page, pages.value.length - 1) : 0
    pageIndex.value = start

    await new Promise(resolve => requestAnimationFrame(resolve))
    if (mode.value === 'long') setupObserver()
  } catch (e: any) {
    bootError.value = e?.message ?? t('common.unknownError')
    toast(bootError.value, 'error', 6000)
  } finally {
    loading.value = false
    showBars(true)
  }
}

// ---- 导航 ----
function goPage(delta: number) {
  const next = pageIndex.value + delta
  if (next >= 0 && next < pages.value.length) {
    setPage(next)
    return
  }
  // 到头了: 在线翻章节; 本地书没有章节, 到头就停
  if (isLocal.value) return
  if (delta > 0) switchChapter(1)
  else switchChapter(-1)
}

function setPage(index: number) {
  pageIndex.value = index
  saveProgress()
  preloadAround(index)
  if (mode.value === 'single') {
    pan.x = 0
    pan.y = 0
  }
}

function switchChapter(offset: number) {
  const target = chapters.value[chapterIndex.value + offset]
  if (!target) return
  tocOpen.value = false
  void router.replace({
    path: `/read/comic/${uuid.value}/${comicId.value}/${encodeURIComponent(chapterRequestId(target))}`,
    query: route.query,
  })
}

function openChapter(chapter: ComicChapter) {
  if (chapterRequestId(chapter) === chapterId.value) { tocOpen.value = false; return }
  tocOpen.value = false
  void router.replace({
    path: `/read/comic/${uuid.value}/${comicId.value}/${encodeURIComponent(chapterRequestId(chapter))}`,
    query: route.query,
  })
}

function exit() {
  const back = String(route.query.back ?? '')
  if (back) { void router.push(back); return }
  if (isLocal.value) { void router.push('/comics'); return }
  void router.push(`/comics/source/${encodeURIComponent(uuid.value)}?comicId=${encodeURIComponent(comicId.value)}&title=${encodeURIComponent(comicTitle.value)}`)
}

function onKey(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement) return
  const rtl = settings.comicReader.direction === 'rtl'
  switch (event.key) {
    case 'Escape': exit(); break
    case 'ArrowRight': goPage(rtl ? -1 : 1); break
    case 'ArrowLeft': goPage(rtl ? 1 : -1); break
    case 'ArrowDown': if (mode.value === 'single') goPage(rtl ? -1 : 1); break
    case 'ArrowUp': if (mode.value === 'single') goPage(rtl ? 1 : -1); break
    case '+': case '=': zoomBy(0.25); break
    case '-': zoomBy(-0.25); break
    case '0': resetZoom(); break
    case 'm': toggleMode(); break
    default: return
  }
  event.preventDefault()
}

function toggleMode() {
  mode.value = mode.value === 'single' ? 'long' : 'single'
  pan.x = 0
  pan.y = 0
  zoom.value = 1
  if (mode.value === 'long') {
    requestAnimationFrame(() => {
      setupObserver()
      // 切到长条模式时停在当前页
      const el = scrollEl.value?.querySelector<HTMLElement>(`[data-page-index="${pageIndex.value}"]`)
      el?.scrollIntoView({ block: 'start' })
    })
  } else {
    observer?.disconnect()
    observer = null
    preloadAround(pageIndex.value)
  }
}

/** 长条模式滚动时把最靠近顶部视口的页记成当前页 */
function onScroll() {
  if (mode.value !== 'long' || !scrollEl.value) return
  const rows = scrollEl.value.querySelectorAll<HTMLElement>('[data-page-index]')
  const top = scrollEl.value.scrollTop
  let best = pageIndex.value
  for (const row of rows) {
    if (row.offsetTop - 40 <= top) best = Number(row.dataset.pageIndex)
    else break
  }
  if (best !== pageIndex.value) { pageIndex.value = best; saveProgress() }
}

watch(chapterId, id => { if (id && host) void loadChapter(id) })

onMounted(() => {
  void boot()
  void loadBookmarks()
  window.addEventListener('keydown', onKey)
  document.addEventListener('fullscreenchange', syncFullscreenState)
  showBars(true)
})
onBeforeUnmount(() => {
  window.clearTimeout(barsTimer)
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('fullscreenchange', syncFullscreenState)
  ambient.stop()
  clearPages()
  host?.dispose()
  host = null
})
</script>

<template>
  <div class="comic-reader" @mousemove="barsVisible || showBars(true)">
    <div v-if="!barsVisible" class="bar-peek top" @mouseenter="showBars()" />
    <div v-if="!barsVisible" class="bar-peek bottom" @mouseenter="showBars()" />

    <header class="bar top" :class="{ hidden: !barsVisible }" @mouseenter="showBars()">
      <button class="icon-btn" :title="t('comics.readerExit')" @click="exit">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <div class="book-title">
        <strong>{{ comicTitle }}</strong>
        <span v-if="chapterName" class="chapter">{{ chapterName }}</span>
      </div>
      <div class="bar-spacer" />
      <span class="counter">{{ progressText }}</span>
      <button class="icon-btn" :title="t('comics.readerZoomOut')" @click="zoomBy(-0.25)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M5 11h14v2H5z"/></svg>
      </button>
      <button class="zoom-label" :title="t('comics.readerFit')" @click="resetZoom">{{ Math.round(zoom * 100) }}%</button>
      <button class="icon-btn" :title="t('comics.readerZoomIn')" @click="zoomBy(0.25)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>
      </button>
      <button class="icon-btn" :title="mode === 'single' ? t('comics.readerLong') : t('comics.readerSingle')" @click="toggleMode">
        <svg v-if="mode === 'single'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 5h16v6H4zM4 13h16v6H4z"/></svg>
        <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v14h10V5H7z"/></svg>
      </button>
      <button class="icon-btn" :class="{ 'auto-on': tocOpen }" v-if="!isLocal" :title="t('comics.readerToc')" @click="toggleToc">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 6a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 12a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 18a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1z"/></svg>
      </button>
      <button class="icon-btn" :class="{ 'auto-on': isBookmarked }" :title="isBookmarked ? t('reader.removeBookmark') : t('reader.addBookmark')" @click="toggleBookmark">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path v-if="isBookmarked" fill="currentColor" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1z"/>
          <path v-else fill="currentColor" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1zm1 2v13.48l4.5-2.55a1 1 0 0 1 .99 0l4.51 2.55V5H7z"/>
        </svg>
      </button>
      <button class="icon-btn" :class="{ 'auto-on': ambientPanel || ambient.state.playing }" :title="t('ambient.title')" @click="toggleAmbientPanel">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v16a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1zM8 7a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zM4 10a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zm16 0a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1z"/></svg>
      </button>
      <button class="icon-btn" :class="{ 'auto-on': readerModeOpen }" :title="t('comics.readerMode')" @click="toggleReaderMode">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm-1.8 4.4 5.4 3.1a.6.6 0 0 1 0 1l-5.4 3.1a.6.6 0 0 1-.9-.5V8.9a.6.6 0 0 1 .9-.5z"/></svg>
      </button>
      <button class="icon-btn" :class="{ 'auto-on': isFullscreen }" :title="isFullscreen ? t('reader.exitFullscreen') : t('reader.fullscreen')" @click="toggleFullscreen">
        <svg v-if="!isFullscreen" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 9a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h3a1 1 0 0 1 0 2H5v3a1 1 0 0 1-1 1zm16 0a1 1 0 0 1-1-1V5h-3a1 1 0 1 1 0-2h3a2 2 0 0 1 2 2v3a1 1 0 0 1-1 1zM4 15a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H5a2 2 0 0 1-2-2v-3a1 1 0 0 1 1-1zm16 0a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2h-3a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1z"/></svg>
        <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 3a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2H4a1 1 0 0 1 0-2h3V4a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2h-3a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1zM4 15h3a2 2 0 0 1 2 2v3a1 1 0 1 1-2 0v-3H4a1 1 0 0 1 0-2zm13 0h3a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3a2 2 0 0 1 2-2z"/></svg>
      </button>
    </header>

    <!-- 单页 -->
    <div
      v-if="mode === 'single'"
      class="stage"
      :class="{ zoomable: zoom > 1 }"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @click="onStageClick"
      @dblclick="zoom > 1 ? resetZoom() : setZoom(2)"
    >
      <p v-if="loading" class="stage-hint">{{ t('comics.loadingChapter') }}</p>
      <p v-else-if="bootError" class="stage-hint error">{{ bootError }}</p>
      <div v-else class="page-box" :style="stageStyle">
        <img
          v-if="urls[pageIndex]"
          :src="urls[pageIndex]"
          :alt="String(pageIndex + 1)"
          draggable="false"
        />
        <div v-else-if="errors[pageIndex]" class="page-fallback">
          <span>{{ t('comics.imageFailed') }}</span>
          <button class="btn btn-sm" @click.stop="retry(pageIndex)">{{ t('comics.readerRetry') }}</button>
        </div>
        <div v-else class="page-fallback">{{ t('comics.loadingChapter') }}</div>
      </div>
    </div>

    <!-- 长条 -->
    <div v-else ref="scrollEl" class="long-strip" @scroll.passive="onScroll" @wheel="onLongWheel">
      <div
        v-for="(page, index) in pages"
        :key="page.id || index"
        class="long-page"
        :data-page-index="index"
        :style="{ width: pageWidth }"
      >
        <img v-if="urls[index]" :src="urls[index]" :alt="String(index + 1)" draggable="false" />
        <div v-else-if="errors[index]" class="page-fallback">
          <span>{{ t('comics.imageFailed') }} #{{ index + 1 }}</span>
          <button class="btn btn-sm" @click="retry(index)">{{ t('comics.readerRetry') }}</button>
        </div>
        <div v-else class="page-fallback">{{ index + 1 }}</div>
      </div>
      <div v-if="!pages.length" class="stage-hint">{{ loading ? t('comics.loadingChapter') : bootError }}</div>
    </div>

    <footer class="bar bottom" :class="{ hidden: !barsVisible }" @mouseenter="showBars()">
      <button v-if="!isLocal" class="btn btn-ghost" :disabled="chapterIndex <= 0" @click="switchChapter(-1)">{{ t('comics.prevChapter') }}</button>
      <div class="progress-row">
        <button class="icon-btn" :disabled="pageIndex <= 0" @click="setPage(pageIndex - 1)">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M15 6l-6 6 6 6z"/></svg>
        </button>
        <input
          class="progress-slider"
          type="range"
          min="0"
          :max="Math.max(total - 1, 0)"
          :value="pageIndex"
          :disabled="total <= 1"
          @input="setPage(Number(($event.target as HTMLInputElement).value))"
        />
        <button class="icon-btn" :disabled="pageIndex >= total - 1" @click="setPage(pageIndex + 1)">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 6l6 6-6 6z"/></svg>
        </button>
      </div>
      <button v-if="!isLocal" class="btn btn-ghost" :disabled="chapterIndex < 0 || chapterIndex >= chapters.length - 1" @click="switchChapter(1)">{{ t('comics.nextChapter') }}</button>
    </footer>

    <!-- 全屏时右上角悬浮退出按钮 -->
    <button v-if="isFullscreen && !barsVisible" class="icon-btn fs-exit" :title="t('reader.exitFullscreen')" @click="toggleFullscreen">
      <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 3a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2H4a1 1 0 0 1 0-2h3V4a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2h-3a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1zM4 15h3a2 2 0 0 1 2 2v3a1 1 0 1 1-2 0v-3H4a1 1 0 0 1 0-2zm13 0h3a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3a2 2 0 0 1 2-2z"/></svg>
    </button>

    <!-- 章节目录 -->
    <aside v-if="tocOpen" class="toc">
      <div class="toc-head">
        <span>{{ t('comics.readerToc') }}</span>
        <button class="icon-btn" @click="toggleToc">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="toc-list">
        <button
          v-for="chapter in chapters"
          :key="chapterRequestId(chapter)"
          class="toc-row"
          :class="{ active: chapterRequestId(chapter) === chapterId }"
          @click="openChapter(chapter)"
        >
          <span class="toc-order">{{ chapter.order ?? '' }}</span>
          <span class="toc-name">{{ chapter.name }}</span>
        </button>
      </div>
    </aside>

    <!-- 背景音面板 (复用全局单例 useAmbient) -->
    <AmbientPanel v-if="ambientPanel" @close="ambientPanel = false" />

    <!-- 阅读模式面板 (漫画专属, 骨架 + 常用项) -->
    <aside v-if="readerModeOpen" class="reader-mode" role="dialog" :aria-label="t('comics.readerMode')">
      <div class="rm-head">
        <strong>{{ t('comics.readerMode') }}</strong>
        <button class="icon-btn" @click="readerModeOpen = false">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
        </button>
      </div>

      <div class="rm-section">
        <span class="rm-title">{{ t('comics.readerDirection') }}</span>
        <div class="rm-segmented">
          <button :class="{ active: settings.comicReader.direction === 'ltr' }" @click="settings.comicReader.direction = 'ltr'">{{ t('comics.readerDirectionLtr') }}</button>
          <button :class="{ active: settings.comicReader.direction === 'rtl' }" @click="settings.comicReader.direction = 'rtl'">{{ t('comics.readerDirectionRtl') }}</button>
        </div>
      </div>

      <label class="rm-toggle">
        <span class="rm-toggle-text">
          <span>{{ t('comics.readerTrimMargins') }}</span>
          <span class="rm-desc">{{ t('comics.readerTrimMarginsDesc') }}</span>
        </span>
        <span class="rm-switch">
          <input type="checkbox" role="switch" v-model="settings.comicReader.trimMargins" />
          <span class="rm-switch-track" aria-hidden="true"></span>
        </span>
      </label>

      <label class="rm-toggle">
        <span class="rm-toggle-text">
          <span>{{ t('comics.readerSplitDouble') }}</span>
          <span class="rm-desc">{{ t('comics.readerSplitDoubleDesc') }}</span>
        </span>
        <span class="rm-switch">
          <input type="checkbox" role="switch" v-model="settings.comicReader.splitDoublePage" />
          <span class="rm-switch-track" aria-hidden="true"></span>
        </span>
      </label>

      <p class="rm-hint">{{ t('comics.readerModeHint') }}</p>
    </aside>
  </div>
</template>

<style scoped>
.comic-reader {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  user-select: none;
}

/* ---- 顶/底栏 (对齐 ReaderView 的外壳) ---- */
.bar {
  position: absolute; left: 0; right: 0; z-index: 10;
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  transition: transform 0.25s, opacity 0.25s;
}
.bar.top { top: 0; padding-top: calc(8px + var(--lr-safe-top)); }
.bar.bottom {
  bottom: 0; top: auto;
  border-bottom: none; border-top: 1px solid var(--border);
  padding-bottom: calc(8px + var(--lr-safe-bottom));
  gap: 12px;
}
.bar.hidden { opacity: 0; pointer-events: none; }
.bar.top.hidden { transform: translateY(-100%); }
.bar.bottom.hidden { transform: translateY(100%); }

.bar-peek { position: absolute; left: 0; right: 0; height: 14px; z-index: 9; }
.bar-peek.top { top: 0; }
.bar-peek.bottom { bottom: 0; }

.book-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.book-title strong { font-size: var(--fs-base); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40vw; }
.book-title .chapter { font-size: var(--fs-xs); color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 26vw; }
.bar-spacer { flex: 1; }
.counter { font-size: var(--fs-xs); color: var(--text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }

.icon-btn {
  width: var(--control-h-sm, 30px); height: var(--control-h-sm, 30px);
  border: none; background: none; border-radius: var(--radius-sm);
  color: var(--text-2); display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.icon-btn:hover:not(:disabled) { background: var(--bg); color: var(--brand); }
.icon-btn:disabled { opacity: 0.35; cursor: default; }
.icon-btn.auto-on { color: var(--brand); }
.zoom-label {
  min-width: 48px; height: var(--control-h-sm, 30px);
  border: none; background: none; color: var(--text-2);
  font-size: var(--fs-xs); font-variant-numeric: tabular-nums; cursor: pointer; border-radius: var(--radius-sm);
}
.zoom-label:hover { background: var(--bg); color: var(--text); }

/* ---- 单页 ---- */
.stage {
  flex: 1;
  min-height: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
  padding: calc(44px + var(--lr-safe-top)) 12px calc(52px + var(--lr-safe-bottom));
  padding-top: calc(8px + var(--lr-safe-top));
  cursor: pointer;
}
.stage.zoomable { cursor: grab; }
.stage.zoomable:active { cursor: grabbing; }
.page-box { transition: transform 0.12s ease-out; transform-origin: center center; will-change: transform; }
.page-box img {
  display: block;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  width: auto; height: auto;
  object-fit: contain;
  border-radius: var(--radius-xs);
  pointer-events: none;
}
.stage-hint { color: var(--text-3); font-size: var(--fs-sm); }
.stage-hint.error { color: var(--danger, #d9534f); }
.page-fallback {
  width: min(70vw, 520px); min-height: 220px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  background: var(--surface-2); color: var(--text-3); font-size: var(--fs-sm); border-radius: var(--radius-lg);
}

/* ---- 长条 ---- */
.long-strip {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex; flex-direction: column; align-items: center;
  gap: 8px;
  padding: calc(48px + var(--lr-safe-top)) 0 calc(56px + var(--lr-safe-bottom));
}
.long-page { width: min(100%, 900px); }
.long-page img { display: block; width: 100%; height: auto; }

/* ---- 底栏进度 ---- */
.progress-row { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
.progress-slider { flex: 1; accent-color: var(--brand); height: 4px; cursor: pointer; }
.progress-slider:disabled { opacity: 0.4; }

/* ---- 目录抽屉 ---- */
.toc {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 20;
  width: min(340px, 80vw);
  display: flex; flex-direction: column;
  background: var(--card);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
}
.toc-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; font-size: var(--fs-sm); font-weight: 600;
  border-bottom: 1px solid var(--border);
}
.toc-list { flex: 1; overflow-y: auto; padding: 6px; }
.toc-row {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border: 0; background: none; border-radius: var(--radius-sm);
  color: var(--text-2); font-size: var(--fs-sm); text-align: left; cursor: pointer;
}
.toc-row:hover { background: var(--bg); color: var(--text); }
.toc-row.active { background: var(--brand-soft); color: var(--brand); font-weight: 600; }
.toc-order { color: var(--text-3); min-width: 22px; font-variant-numeric: tabular-nums; }
.toc-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- 全屏退出悬浮按钮 ---- */
.fs-exit {
  position: absolute; top: 10px; right: 12px; z-index: 30;
  background: var(--card); border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}

/* ---- 阅读模式面板 (漫画专属) ---- */
.reader-mode {
  position: absolute; top: calc(48px + var(--lr-safe-top)); right: 12px; z-index: 25;
  width: min(360px, calc(100% - 24px));
  max-height: calc(100% - 72px - var(--lr-safe-top) - var(--lr-safe-bottom));
  overflow-y: auto;
  display: flex; flex-direction: column; gap: 14px;
  padding: 14px 16px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 12px);
  box-shadow: var(--shadow-lg);
  color: var(--text);
}
.rm-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: var(--fs-base); font-weight: 600;
}
.rm-section { display: flex; flex-direction: column; gap: 8px; }
.rm-title { font-size: var(--fs-xs); color: var(--text-3); }
.rm-segmented { display: flex; gap: 6px; }
.rm-segmented button {
  flex: 1; padding: 8px 10px; font-size: var(--fs-sm); cursor: pointer;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface-1); color: var(--text-2);
}
.rm-segmented button.active {
  border-color: var(--brand); background: var(--brand-soft); color: var(--brand); font-weight: 600;
}
.rm-toggle {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  cursor: pointer;
}
.rm-toggle-text { display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-sm); color: var(--text-2); }
.rm-desc { font-size: var(--fs-xs); color: var(--text-3); line-height: 1.4; }
.rm-switch { position: relative; flex: none; width: 36px; height: 20px; }
.rm-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.rm-switch-track {
  position: absolute; inset: 0; border-radius: var(--radius-pill);
  background: var(--surface-3); transition: background var(--dur) var(--ease); pointer-events: none;
}
.rm-switch-track::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--card); box-shadow: var(--shadow-sm);
  transition: transform var(--dur) var(--ease);
}
.rm-switch input:checked + .rm-switch-track { background: var(--brand); }
.rm-switch input:checked + .rm-switch-track::after { transform: translateX(16px); }
.rm-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-3); line-height: 1.5; border-top: 1px solid var(--border); padding-top: 10px; }
</style>
