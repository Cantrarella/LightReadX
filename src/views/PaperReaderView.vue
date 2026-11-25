<script setup lang="ts">
import AppSelect from '../components/AppSelect.vue'
import AppModal from '../components/AppModal.vue'
import { AutoScrollClock, ScrollAccumulator } from '../services/autoScroll'
import { AUTO_SPEED_LEVELS, AUTO_SPEED_STEPS, speedPosition, secondsAtPosition } from '../services/autoReadSpeed'
import LevelSlider from '../components/LevelSlider.vue'
import { TTS_RATE_MAX, TTS_RATE_MIN, TTS_RATE_MINOR_STOPS, TTS_RATE_STOPS, rateText } from '../services/ttsRate'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, isTauri, type BookMeta, type AnnotationRec } from '../storage'
import { HIGHLIGHT_TEXT_MAX } from '../services/annotationContext'
import { useNotesTools } from '../composables/useNotesTools'
import NotesExportDialog from '../components/NotesExportDialog.vue'
import QuoteCardDialog from '../components/QuoteCardDialog.vue'
import {
  extractParagraphsFromItems,
  extractParagraphsLooseFromItems,
  restorePlaceholders,
  type PaperParagraph,
} from '../services/paperText'
import { translatePage, cachedTranslation } from '../services/paperTranslate'
import { aiConfigured, chatStream, explainPrompt, plainAiText, readerSystemPrompt, type AiMessage } from '../services/ai'
import {
  PdfiumDoc,
  PdfEngineError,
  hitBoundary,
  rangeRects,
  rangeText,
  wordRange,
  textRuns,
} from '../services/pdfium'
import { initMupdf } from '../services/mupdf'
import { PdfRenderClient, paintRenderedPage } from '../services/pdfRender/client'
import { rasterPage } from '../services/pdfRender/raster'
import { PAGE_BITMAP_BUDGET, pageWindow } from '../services/pdfRender/budget'
import { isWasmCrash } from '../services/wasmCrash'
import { exportDiagnostics, logEvent } from '../services/diagnostics'
import { importFile } from '../services/importer'
import { detectFormat } from '../services/format'
import { FONT_FAMILIES, HIGHLIGHT_COLORS, READER_THEME_CHOICES, resolveReaderColors } from '../services/readerTheme'
import { resolvedTheme } from '../services/appearance'
import { injectFontIntoDoc, resolveFontFamily } from '../services/fonts'
import {
  INSTALL_CMD,
  babeldocStatus,
  babeldocSupported,
  babeldocUsableProvider,
  type BabeldocStatus,
} from '../services/babeldoc'
import {
  babeldocTaskActive,
  startBabeldocTask,
} from '../services/babeldocTask'
import {
  buildBabeldocContextPrompt,
  extractAbstractCandidate,
  loadPaperTranslationContext,
  PAPER_CONTEXT_REFERENCE_CHAR_LIMIT,
  PAPER_CONTEXT_SOURCE_CHAR_LIMIT,
  savePaperTranslationContext,
  type ApprovedPaperTranslationContext,
} from '../services/paperTranslationContext'
import { generatePaperTranslationContext } from '../services/paperTranslationContextGeneration'
import {
  BABELDOC_TARGET_LANGUAGES,
  loadBabeldocTargetLanguage,
  resolveBabeldocTargetLanguage,
  saveBabeldocTargetLanguage,
  type BabeldocTargetLanguageCode,
} from '../services/babeldocLanguages'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { useReadingTimer } from '../composables/useReadingTimer'
import { usePortraitView } from '../composables/usePortraitView'
import { effectivePdfLayout } from '../services/portraitLayout'
import { toast } from '../services/toast'
import { printPdf, revealStoredBook, savePdfAs } from '../services/pdfFileActions'
import {
  resetEdgeFailure,
} from '../services/tts'
import { EDGE_VOICES, edgeAvailable } from '../services/edgeTts'
import CloudTtsConfig from '../components/CloudTtsConfig.vue'
import SapiVoiceSelect from '../components/SapiVoiceSelect.vue'
import { sapiPlatform } from '../services/sapiTts'
import { KOKORO_VOICES, DEFAULT_KOKORO_SID, kokoroVoiceLabel } from '../services/kokoroVoices'
import LocalTtsPack from '../components/LocalTtsPack.vue'
import QwenVoiceRow from '../components/QwenVoiceRow.vue'
import { localVoiceOffered, localVoiceReady } from '../services/localLlm'
import {
  dispatchPdfReaderShortcut,
  getPdfShortcutHelpRows,
  shouldClearCopiedSelection,
  type PdfReaderShortcutCommandId,
} from '../services/keyboardShortcuts'
import TocList, { type TocItem } from '../components/TocList.vue'
import { t } from '../i18n'
import { useStealth } from '../composables/useStealth'
import { usePaperTts } from '../composables/usePaperTts'
import { usePdfSearch } from '../composables/usePdfSearch'
import { setWindowFullscreen, windowChrome } from '../services/windowChrome'
import { stealthBackground, stealthInkMatrix, stealthPdfColors } from '../services/stealth'
import StealthStrip from '../components/StealthStrip.vue'

const route = useRoute()
const router = useRouter()
const library = useLibrary()
const settings = useSettings()
const bookId = String(route.params.id)

const meta = ref<BookMeta>()
const loading = ref(true)
const error = ref('')
const pageCount = ref(0)
const currentPage = ref(1)
const pageInput = ref('1')
const scroller = ref<HTMLElement>()
const pagedBox = ref<HTMLElement>()
const rightPane = ref<HTMLElement>()
const thumbnailScroller = ref<HTMLElement>()
const pdfOpenInput = ref<HTMLInputElement>()
let openingPdf = false
let readerAlive = true

/** PDFium 交互引擎：几何选择、链接、目录、文本与段落提取。 */
let pdm: PdfiumDoc | null = null
/** MuPDF 只负责可见位图；交互能力继续由 PDFium 提供。 */
let renderBytes: Uint8Array | null = null
/** 页面栅格化 Worker; 起不来时为 null, 改在主线程用 renderBytes 画 */
let pageRenderer: PdfRenderClient | null = null
/** 仅记录原始 PDF 字节大小用于属性信息展示；打印与另存为时再按需读取磁盘文件，避免常驻整份 Blob */
let sourcePdfSize = 0
const sourcePdfVersion = ref('')
let mupdfDocPromise: Promise<any> | null = null
let mupdfRenderFailed = false
const pdfEngineCrashed = ref(false)

async function exportDiagnosticsFromError() {
  try {
    if (await exportDiagnostics()) toast(t('settings.diagnosticsExported'), 'success')
  } catch (e) {
    console.warn('export diagnostics failed', e)
    toast(t('settings.diagnosticsExportFailed'), 'error')
  }
}

function mupdfDoc(): Promise<any> {
  if (!mupdfDocPromise) {
    mupdfDocPromise = (async () => {
      if (!renderBytes) throw new Error('PDF render data unavailable')
      const mupdf = await initMupdf()
      const bytes = renderBytes
      renderBytes = null
      return mupdf.Document.openDocument(bytes, 'application/pdf')
    })()
  }
  return mupdfDocPromise
}
let saveTimer: ReturnType<typeof setTimeout> | undefined
let settleTimer: ReturnType<typeof setTimeout> | undefined
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | undefined
let scrollScheduled = false
let tocPositionScheduled = false

const { pingAuto: pingReadingAuto } = useReadingTimer(bookId)
// 翻页 (含自动阅读、跳转) 算作在读
// 页码变化也可能来自自动滚动, 按自动推进计; 手动滚动由 window 上的 wheel/touch 计入
watch(currentPage, () => pingReadingAuto())

const aiReady = computed(() => aiConfigured())
/** 归属: 论文/藏书 (藏书 PDF 也走本阅读器, 返回目标随归属) */
// kind 缺省是历史藏书记录；只有显式标记为 paper 才进入论文功能集。
const isPaper = computed(() => meta.value?.kind === 'paper')
const backTarget = computed(() => '/library')
const backLabel = computed(() => t('reader.backToLibrary'))
/** 幻灯片放映 (整页翻页 + 全屏); 放映时不受竖屏单页滚动约束 */
const presentationMode = ref(false)
/**
 * PDF 共用横竖屏默认预设, 手动选择逐项优先。放映临时固定单页翻页。
 */
const portraitView = usePortraitView()
const pdfEffective = computed(() => effectivePdfLayout({
  mode: presentationMode.value ? 'paged' : settings.pdfPrefs.mode,
  spreadMode: presentationMode.value ? 'single' : settings.pdfPrefs.spreadMode,
  portraitScroll: false,
  portrait: portraitView.value,
  presentation: presentationMode.value,
}))
/** 所有 PDF 共用阅读模式；v7 起默认连续滚动。 */
const mode = computed<'paged' | 'scroll'>(() => pdfEffective.value.mode)
/** 浮动条只有约 240px 宽: 七档里只给两端和中间写字, 其余只画刻度 */
const AUTO_SPEED_MAJOR: readonly string[] = ['slowest', 'medium', 'fastest']
const pdfLayout = computed(() => settings.pdf.layout)
const bookPaged = computed(() => pdfLayout.value === 'original' && mode.value === 'paged')
const spreadMode = computed(() => pdfEffective.value.spreadMode)
const scrollSpread = computed(() =>
  pdfLayout.value === 'original' && mode.value === 'scroll' && spreadMode.value !== 'single')

/* ================= 连续滚动渲染 (虚拟化: 只渲染视口附近页) ================= */

const SPREAD_GAP = 16
const NORMAL_SCROLL_PADDING = 28
/** 保留 / 预载窗口随一页位图的大小收放 (放大后一页上百 MB, 不能固定留 ±4 页) */
function renderWindow(pageNum = currentPage.value, scale = curScale.value) {
  const display = displaySizeOf(pageNum, scale)
  const outputScale = Math.min(DPR(), MAX_DIM / display.w, MAX_DIM / display.h)
  const bytes = display.w * outputScale * display.h * outputScale * 4
  return pageWindow(bytes, PAGE_BITMAP_BUDGET.desktop, scrollSpread.value ? 2 : 1)
}
/** PDF 坐标是 72 pt/in，CSS 的基准分辨率是 96 px/in。 */
const CSS_PX_PER_PT = 96 / 72
/** 必须使用完整设备像素比；截到 2 会让高 DPI 屏把位图再次放大。 */
const DPR = () => Math.max(window.devicePixelRatio || 1, 1)
/** 仅作为浏览器画布安全阈值；可覆盖桌面端 200% + 3x DPR 的常见页面。 */
const MAX_DIM = 8192

/** 页面尺寸；保留 baseDims 供译文镜像等只处理当前标准页的旧路径使用。 */
const baseDims = ref({ w: 612, h: 792 })
const pageDims = ref<Array<{ w: number; h: number }>>([])
/** 当前实际渲染缩放 */
const curScale = ref(1)
/** Sumatra 风格虚拟缩放：适合页面、适合宽度或固定百分比。 */
type PdfZoom = number | 'fit-page' | 'fit-width'
const LEGACY_ZOOM_KEY = 'lightread-paper-zoom'
const ZOOM_KEY = `lightread-pdf-zoom:${bookId}`
const restoredZoom = restoreZoom()
const zoomManual = ref(restoredZoom !== null)
const zoom = ref<PdfZoom>(restoredZoom ?? (settings.pdfPrefs.fit === 'fitW' ? 'fit-width' : 'fit-page'))
const scrollStartPadding = computed(() => typeof zoom.value === 'number' ? NORMAL_SCROLL_PADDING : 0)

function restoreZoom(): PdfZoom | null {
  const raw = localStorage.getItem(ZOOM_KEY) ?? localStorage.getItem(LEGACY_ZOOM_KEY)
  if (raw === 'fit-page' || raw === 'fit-width') return raw
  if (raw === 'fit') return 'fit-width'
  const n = raw ? parseFloat(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** UI 百分比转为 PDF 点到 CSS 像素的比例，与 SumatraPDF 的 DPI 换算一致。 */
function fixedZoomScale(value: number): number {
  return value * CSS_PX_PER_PT
}

function dimensionsOf(pageNum: number) {
  return pageDims.value[pageNum - 1] ?? baseDims.value
}

/**
 * 页面外框必须落在整数 CSS 像素上。否则 MuPDF 的整数 Pixmap 会被浏览器
 * 再插值一次；70% / 80% 等缩小档位发糊正是由此造成。
 */
function displaySizeOf(pageNum: number, scale = curScale.value) {
  const dims = dimensionsOf(pageNum)
  const w = Math.max(1, Math.round(dims.w * scale))
  const h = Math.max(1, Math.round(dims.h * scale))
  return { w, h, sx: w / dims.w, sy: h / dims.h }
}

const holderH = computed(() => displaySizeOf(currentPage.value).h)
const holderStyleFor = (pageNum: number) => {
  const size = displaySizeOf(pageNum)
  return { width: `${size.w}px`, height: `${size.h}px` }
}

/** 连续阅读也支持单页、对页与封面错位书籍视图。 */
const scrollPageGroups = computed<number[][]>(() => {
  const total = pageCount.value
  if (!total) return []
  if (!scrollSpread.value) return Array.from({ length: total }, (_, index) => [index + 1])
  const groups: number[][] = []
  let page = 1
  if (spreadMode.value === 'book') {
    groups.push([1])
    page = 2
  }
  while (page <= total) {
    groups.push(page + 1 <= total ? [page, page + 1] : [page])
    page += 2
  }
  return groups
})

const scrollGroupLayout = computed(() => {
  let top = scrollStartPadding.value
  return scrollPageGroups.value.map(pages => {
    const height = Math.max(...pages.map(page => displaySizeOf(page).h))
    const entry = { pages, top, height }
    top += height
    return entry
  })
})

const scrollPageLayout = computed(() => {
  const pages = Array.from({ length: pageCount.value }, () => ({ top: scrollStartPadding.value, height: 0 }))
  for (const group of scrollGroupLayout.value) {
    for (const page of group.pages) pages[page - 1] = { top: group.top, height: group.height }
  }
  return pages
})

const renderedScale = new Map<number, string>()
const rendering = new Set<number>()

function renderKeyFor(pageNum: number, scale: number) {
  const display = displaySizeOf(pageNum, scale)
  return `${settings.pdf.renderer}:${scale.toFixed(6)}:${DPR().toFixed(4)}:${display.w}x${display.h}`
}

function holderOf(num: number) {
  return paperRoot.value?.querySelector<HTMLElement>(`[data-page="${num}"]`) ?? null
}

function fitScale(kind: 'fit-page' | 'fit-width'): number {
  const box = scroller.value
  // 适配模式移除四周容器内边距，直接使用完整可视尺寸，避免页面外框留缝。
  const width = Math.max(box?.clientWidth ?? 800, 1)
  const height = Math.max(box?.clientHeight ?? 700, 1)
  const dims = pageDims.value.length ? pageDims.value : [baseDims.value]
  let scale = Math.min(...dims.map(page => kind === 'fit-page'
    ? height / page.h
    : width / page.w))
  if (kind === 'fit-width' && scrollSpread.value) {
    for (const group of scrollPageGroups.value) {
      const groupWidth = group.reduce((sum, page) => sum + dimensionsOf(page).w, 0)
      scale = Math.min(scale, Math.max(1, width - SPREAD_GAP * (group.length - 1)) / Math.max(1, groupWidth))
    }
  }
  return Number.isFinite(scale) ? scale : 1
}

/** 当前页所在的页组；双页按 1-2、3-4 … 配对。 */
function spreadOf(page: number): number[] {
  const clamped = Math.min(Math.max(1, page || 1), Math.max(1, pageCount.value))
  if (!bookPaged.value || spreadMode.value === 'single') return [clamped]
  if (spreadMode.value === 'book' && clamped === 1) return [1]
  const start = spreadMode.value === 'book'
    ? (clamped % 2 === 0 ? clamped : clamped - 1)
    : (clamped % 2 === 1 ? clamped : clamped - 1)
  return start + 1 <= pageCount.value ? [start, start + 1] : [start]
}

const pagedPages = computed(() => spreadOf(currentPage.value))
const atFirstPage = computed(() => pdfLayout.value === 'reflow'
  ? currentPage.value <= (reflowPages.value[0]?.page ?? 1)
  : currentPage.value <= 1)
const atLastPage = computed(() => pdfLayout.value === 'reflow'
  ? currentPage.value >= (reflowPages.value.at(-1)?.page ?? pageCount.value)
  : bookPaged.value
    ? pagedPages.value.at(-1) === pageCount.value
    : scrollSpread.value
      ? currentPage.value >= (scrollPageGroups.value.at(-1)?.[0] ?? pageCount.value)
      : currentPage.value >= pageCount.value)

/** 适宽严格铺满可视宽度，适高严格铺满可视高度；另一轴超出时交给滚动容器。 */
function pagedScale(): number {
  if (typeof zoom.value === 'number') return fixedZoomScale(zoom.value)
  const box = pagedBox.value
  const availW = Math.max(box?.clientWidth ?? 800, 1)
  const availH = Math.max(box?.clientHeight ?? 700, 1)
  const pages = pagedPages.value
  const dims = pages.map(dimensionsOf)
  const totalW = dims.reduce((sum, page) => sum + page.w, 0)
  const widthScale = Math.max(1, availW - SPREAD_GAP * (pages.length - 1)) / Math.max(1, totalW)
  if (zoom.value === 'fit-width') return widthScale
  const heightScale = Math.min(...dims.map(page => availH / Math.max(1, page.h)))
  return heightScale
}

/**
 * 整页位图 canvas：MuPDF 负责页面栅格化，按 CSS 缩放与完整 DPR 输出设备像素。
 * PDFium 仍负责所有交互几何；MuPDF 失败时无感回退 PDFium。
 */
async function renderBitmapCanvas(pageNum: number, scale: number): Promise<HTMLCanvasElement> {
  const dims = dimensionsOf(pageNum)
  const display = displaySizeOf(pageNum, scale)
  const outputScale = Math.min(DPR(), MAX_DIM / display.w, MAX_DIM / display.h)
  const targetW = Math.max(1, Math.round(display.w * outputScale))
  const targetH = Math.max(1, Math.round(display.h * outputScale))
  const canvas = document.createElement('canvas')
  canvas.style.width = `${display.w}px`
  canvas.style.height = `${display.h}px`

  if (settings.pdf.renderer === 'mupdf' && !mupdfRenderFailed) {
    const request = { page: pageNum - 1, targetW, targetH, pageW: dims.w, pageH: dims.h }
    try {
      if (pageRenderer) {
        // 栅格化在 Worker 里做, 主线程只上屏一次; 正在看的页插队, 预载页排队
        paintRenderedPage(canvas, await pageRenderer.render(request, { priority: pageNum === currentPage.value }))
        canvas.dataset.thread = 'worker'
      } else {
        const view = rasterPage(await initMupdf(), await mupdfDoc(), request)
        try {
          canvas.width = view.width
          canvas.height = view.height
          // 像素是 wasm 堆上的视图 (非共享内存)；putImageData 同步拷贝完成后再释放
          canvas.getContext('2d', { alpha: false })!
            .putImageData(new ImageData(view.pixels as Uint8ClampedArray<ArrayBuffer>, view.width, view.height), 0, 0)
        } finally {
          view.release()
        }
      }
      canvas.dataset.renderer = 'mupdf'
      return canvas
    } catch (e) {
      // 渲染途中离开了阅读页 (文档已关): 不是 MuPDF 坏了, 也不必回退, 交回空画布 (R3PRO-01)
      if (!pdm) return canvas
      mupdfRenderFailed = true
      pageRenderer?.close()
      pageRenderer = null
      console.warn('MuPDF render failed; falling back to PDFium', e)
      logEvent('warn', 'pdf', `mupdf render failed page=${pageNum} ${targetW}x${targetH}, falling back to pdfium`, e)
    }
  }

  if (!pdm) return canvas
  const img = pdm.renderToSize(pageNum - 1, targetW, targetH)
  canvas.width = img.width
  canvas.height = img.height
  canvas.getContext('2d')!.putImageData(img, 0, 0)
  canvas.dataset.renderer = 'pdfium'
  return canvas
}

/**
 * 正在画的页又被要求重画 (窗口尺寸变了) 时不能直接丢掉这次请求: 手头那次画完发现比例已过期会作废,
 * 若没人再画这一页就一直空白 (2026-11-08 Win10: 打开 PDF 同时自动进入摸鱼, 窗口在首帧渲染途中变尺寸,
 * 整页空白 50 秒以上)。记下来, 收尾后按最新比例再画一次; 比例没变则 renderedScale 命中直接返回。
 */
const renderAgain = new Set<number>()
async function renderScrollPage(num: number) {
  if (!pdm || num < 1 || num > pageCount.value) return
  if (rendering.has(num)) { renderAgain.add(num); return }
  const holder = holderOf(num)
  if (!holder) return
  const scale = curScale.value
  const renderKey = renderKeyFor(num, scale)
  if (renderedScale.get(num) === renderKey) return
  rendering.add(num)
  let stale = false
  try {
    const canvas = await renderBitmapCanvas(num, scale)
    if (scale !== curScale.value) { stale = true; return }
    holder.querySelector('.p-canvas')?.replaceChildren(canvas)
    renderedScale.set(num, renderKey)
    renderPdmLinks(holder, num)
  } finally {
    rendering.delete(num)
    if (renderAgain.delete(num) || stale) void renderScrollPage(num)
  }
}

async function renderPaged() {
  if (!pdm || !pagedBox.value || !bookPaged.value) return
  const pages = pagedPages.value
  // WebKit 的 8px 滚动条会在适宽/适高切换后改变另一轴的 client 尺寸。
  // 先让 holder 尺寸收敛，再绘制 canvas，避免短暂出现 4px 边缝。
  for (let pass = 0; pass < 3; pass++) {
    const next = pagedScale()
    if (pass > 0 && Math.abs(next - curScale.value) < 0.001) break
    curScale.value = next
    await nextTick()
  }
  // 页组切换会创建新的 holder，不能沿用连续滚动视图的 DOM 渲染缓存。
  for (const page of pages) renderedScale.delete(page)
  await nextTick()
  await Promise.all(pages.map(async page => {
    // 模式切换时，旧滚动 holder 可能仍有同页渲染任务；等它收尾后再画入新 holder。
    while (rendering.has(page)) await new Promise(resolve => setTimeout(resolve, 0))
    await renderScrollPage(page)
  }))
  // 渲染途中离开了阅读页 (R3 novice N02: 跳页后立即返回藏书)
  pagedBox.value?.scrollTo({ top: 0, left: 0 })
}

async function pagedGoto(page: number) {
  const pages = spreadOf(page)
  const next = pages[0]
  pageInput.value = String(next)
  if (next === currentPage.value && pages.every(p => holderOf(p))) {
    await renderPaged()
    return
  }
  selection.value = null
  currentPage.value = next
  await nextTick()
  await renderPaged()
}

/**
 * 页面当前按哪种阅读方式 / 页布局排好的。生效值 (mode / spreadMode) 可能因旋转屏幕、
 * 放映进出等在别处改变, syncPdfLayout 比对二者, 只在不一致时重排一次 (幂等, 可重复调用)。
 * null 表示文档尚未完成首次排版。
 */
let laidOut: { mode: 'paged' | 'scroll'; spreadMode: 'single' | 'facing' | 'book' } | null = null
function markLaidOut() {
  laidOut = { mode: mode.value, spreadMode: spreadMode.value }
}

async function syncPdfLayout() {
  if (!laidOut) return
  const next = { mode: mode.value, spreadMode: spreadMode.value }
  if (next.mode === laidOut.mode && next.spreadMode === laidOut.spreadMode) return
  const modeChanged = next.mode !== laidOut.mode
  laidOut = next
  const page = currentPage.value
  // 重排版式 (reflow) 不分翻页 / 滚动, 回到原版时按当时的生效值排
  if (pdfLayout.value !== 'original') return
  renderedScale.clear()
  await nextTick()
  if (modeChanged) {
    if (next.mode === 'paged') {
      await pagedGoto(page)
    } else {
      attachScrollListener()
      await nextTick()
      await relayout(true, page)
    }
    observeActiveViewport()
  } else if (bookPaged.value) {
    currentPage.value = spreadOf(currentPage.value)[0]
    await renderPaged()
  } else {
    await relayout(true)
  }
}

/** 竖屏锁定中改翻页 / 双页: 照常保存, 但提示横屏后才生效 */
function noteLockedChoice() {
  if (pdfEffective.value.portraitLocked) toast(t('reader.portraitLockedToast'))
}

async function switchMode(next: 'paged' | 'scroll') {
  if (settings.pdf.mode === next && mode.value === next) { settings.setPdfPreference('mode', next); return }
  stopAutoRead()
  settings.setPdfPreference('mode', next)
  if (next === 'paged' && !zoomManual.value && zoom.value === 'fit-width') {
    zoom.value = settings.pdfPrefs.fit === 'fitH' ? 'fit-page' : 'fit-width'
  }
  if (mode.value !== next) noteLockedChoice()
  await syncPdfLayout()
}

async function setSpreadMode(next: 'single' | 'facing' | 'book') {
  settings.setPdfPreference('spreadMode', next)
  if (spreadMode.value !== next) noteLockedChoice()
  await syncPdfLayout()
}

// 屏幕旋转 / 窗口缩放 / 自动适配切换: 保留手动缩放, 按生效值重排并停在当前页
watch(() => `${mode.value}:${spreadMode.value}:${settings.pdfPrefs.fit}`, () => {
  if (presentationMode.value) return
  if (!zoomManual.value) zoom.value = settings.pdfPrefs.fit === 'fitW' ? 'fit-width' : 'fit-page'
  stopAutoRead()
  void syncPdfLayout()
})

async function setPagedFit(fit: 'fitH' | 'fitW') {
  settings.setPdfPreference('fit', fit)
  await applyZoom(fit === 'fitH' ? 'fit-page' : 'fit-width')
}

/** PDFium 链接层: 内链跳转 + 外链系统浏览器 */
function renderPdmLinks(holder: HTMLElement, num: number) {
  const host = holder.querySelector<HTMLElement>('.p-links')
  if (!host || !pdm) return
  host.replaceChildren()
  const display = displaySizeOf(num)
  for (const ln of pdm.links(num - 1)) {
    const el = document.createElement('a')
    el.className = 'p-link'
    el.style.left = `${ln.x * display.sx}px`
    el.style.top = `${ln.y * display.sy}px`
    el.style.width = `${ln.w * display.sx}px`
    el.style.height = `${ln.h * display.sy}px`
    if (ln.url) {
      el.title = ln.url
      el.addEventListener('click', e => {
        e.preventDefault()
        openExternal(ln.url!)
      })
    } else if (ln.destPage != null) {
      el.addEventListener('click', e => {
        e.preventDefault()
        pushBack()
        const targetScale = displaySizeOf(ln.destPage! + 1).sy
        gotoPage(ln.destPage! + 1, false, Math.max(0, (ln.destY ?? 0) * targetScale - 60))
      })
    }
    host.append(el)
  }
}

function evictFarPages(center: number) {
  const { keep } = renderWindow(center)
  for (const num of [...renderedScale.keys()]) {
    if (Math.abs(num - center) > keep) {
      const holder = holderOf(num)
      if (holder) {
        holder.querySelector('.p-canvas')?.replaceChildren()
        holder.querySelector('.p-links')?.replaceChildren()
      }
      renderedScale.delete(num)
    }
  }
}

function pageAtScrollOffset(viewportOffset: number): number {
  const el = scroller.value
  const layout = scrollGroupLayout.value
  if (!el || !layout.length) return 1
  const anchor = el.scrollTop + viewportOffset
  let lo = 0
  let hi = layout.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const group = layout[mid]
    if (anchor > group.top + group.height) lo = mid + 1
    else hi = mid
  }
  return layout[lo]?.pages[0] ?? 1
}

function pageAtCenter(): number {
  return pageAtScrollOffset((scroller.value?.clientHeight ?? 0) / 2)
}

function updateViewport() {
  const cur = pageAtCenter()
  if (cur !== currentPage.value) currentPage.value = cur
  const activeGroup = scrollGroupLayout.value.findIndex(group => group.pages.includes(cur))
  const { ahead, behind } = renderWindow(cur)
  const nearby = scrollGroupLayout.value.slice(
    Math.max(0, activeGroup - behind),
    Math.min(scrollGroupLayout.value.length, activeGroup + ahead + 1),
  )
  // 当前页组立即渲染；相邻页组的预载放到后续宏任务里逐页进行，
  // 否则所有页面会挤在同一条微任务链里, 首页要等预载页全部栅格化后才能上屏。
  const active = scrollGroupLayout.value[activeGroup]
  if (active) for (const page of active.pages) renderScrollPage(page)
  schedulePrefetchRender(nearby.filter(group => group !== active).flatMap(group => group.pages))
  evictFarPages(cur)
}

const prefetchQueue: number[] = []
let prefetchDraining = false
function schedulePrefetchRender(pages: number[]) {
  for (const page of pages) if (!prefetchQueue.includes(page)) prefetchQueue.push(page)
  if (prefetchDraining || prefetchQueue.length === 0) return
  prefetchDraining = true
  const drain = () => {
    if (!readerAlive || prefetchQueue.length === 0) {
      prefetchDraining = false
      return
    }
    const page = prefetchQueue.shift()!
    // 用户已经滚远的页面不再预载, 交给下一次 updateViewport 决定。
    if (Math.abs(page - currentPage.value) > 8) {
      drain()
      return
    }
    // 每页之间让出主线程, 让首屏 paint / 滚动事件先执行。
    renderScrollPage(page)
      .catch(e => console.warn('prefetch render failed', e))
      .then(() => setTimeout(drain, 0))
  }
  setTimeout(drain, 0)
}

function onScroll() {
  if (scrollScheduled) return
  scrollScheduled = true
  requestAnimationFrame(() => {
    scrollScheduled = false
    updateViewport()
    updateCurrentTocPosition()
  })
}

let listenedScroller: HTMLElement | undefined
function attachScrollListener() {
  if (listenedScroller === scroller.value) return
  listenedScroller?.removeEventListener('scroll', onScroll)
  listenedScroller = scroller.value
  listenedScroller?.addEventListener('scroll', onScroll, { passive: true })
}

function observeActiveViewport() {
  if (!resizeObserver) return
  resizeObserver.disconnect()
  const viewport = pdfLayout.value === 'reflow'
    ? reflowScroller.value
    : bookPaged.value ? pagedBox.value : scroller.value
  if (viewport) resizeObserver.observe(viewport)
}

function pageTop(n: number): number {
  return scrollPageLayout.value[n - 1]?.top ?? scrollStartPadding.value
}

function scrollGoto(n: number, smooth = false, yOffsetPx = 0) {
  const clamped = Math.min(Math.max(1, n || 1), pageCount.value)
  scroller.value?.scrollTo({ top: Math.max(0, pageTop(clamped) + yOffsetPx), behavior: smooth ? 'smooth' : 'auto' })
}

function gotoPage(n: number, smooth = false, yOffsetPx = 0) {
  if (pdfLayout.value === 'reflow') reflowGoto(n, smooth)
  else if (bookPaged.value) void pagedGoto(n)
  else scrollGoto(n, smooth, yOffsetPx)
}

async function applyZoom(next: PdfZoom, remember = true) {
  zoom.value = next
  if (remember) {
    zoomManual.value = true
    localStorage.setItem(ZOOM_KEY, String(next))
  }
  // 先让适配模式的无边距样式生效，再读取 clientWidth/clientHeight 计算精确倍率。
  await nextTick()
  if (bookPaged.value) {
    renderedScale.clear()
    await renderPaged()
  } else {
    await relayout(true)
  }
}

function zoomStep(dir: 1 | -1) {
  const cur = typeof zoom.value === 'number' ? zoom.value : curScale.value / CSS_PX_PER_PT
  const fuzz = 0.0001
  const next = dir > 0
    ? SUMATRA_ZOOM_LEVELS.find(level => level > cur + fuzz) ?? SUMATRA_ZOOM_LEVELS.at(-1)!
    : [...SUMATRA_ZOOM_LEVELS].reverse().find(level => level < cur - fuzz) ?? SUMATRA_ZOOM_LEVELS[0]
  void applyZoom(next)
}

/** SumatraPDF 的离散缩放阶梯；当前整页 Canvas 的安全上限为 400%。 */
const SUMATRA_ZOOM_LEVELS = [0.0833, 0.125, 0.18, 0.25, 0.3333, 0.5, 0.6667, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const zoomMenu = ref(false)
/** 缩放菜单 3 列网格, 12 档凑满 4 行 */
const ZOOM_MENU_PRESETS = [0.125, 0.25, 0.3333, 0.5, 0.6667, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const zoomTrigger = ref<HTMLElement>()
const zoomMenuEl = ref<HTMLElement>()
const typographyTrigger = ref<HTMLElement>()
const viewPanelOpen = ref(false)
const viewTrigger = ref<HTMLElement>()
const viewPanelEl = ref<HTMLElement>()

/* ---- 桌面单行顶栏: 弹层锚在触发按钮正下方 ----
   只在打开 / 窗口尺寸变化时读一次按钮位置, fixed 定位并夹在视口内 */
const popoverAnchor = ref({ top: 0, left: 0 })
const ZOOM_MENU_WIDTH = 252
const VIEW_PANEL_WIDTH = 320
const TYPOGRAPHY_POPOVER_WIDTH = 340

function anchorPopover(trigger: HTMLElement | undefined, width: number) {
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const w = Math.min(width, window.innerWidth - 16)
  const center = rect.left + rect.width / 2
  popoverAnchor.value = {
    top: Math.round(rect.bottom + 8),
    left: Math.round(Math.min(Math.max(center - w / 2, 8), window.innerWidth - w - 8)),
  }
}

function reanchorPopovers() {
  if (zoomMenu.value) anchorPopover(zoomTrigger.value, ZOOM_MENU_WIDTH)
  else if (viewPanelOpen.value) anchorPopover(viewTrigger.value, VIEW_PANEL_WIDTH)
  else if (typographyOpen.value) anchorPopover(typographyTrigger.value, TYPOGRAPHY_POPOVER_WIDTH)
}

function closeToolbarPopovers() {
  zoomMenu.value = false
  viewPanelOpen.value = false
  typographyOpen.value = false
  moreMenu.value = false
}

async function toggleZoomMenu() {
  const opening = !zoomMenu.value
  closeToolbarPopovers()
  shortcutsOpen.value = false
  if (!opening) return
  anchorPopover(zoomTrigger.value, ZOOM_MENU_WIDTH)
  zoomMenu.value = true
  await nextTick()
  const items = zoomMenuItems()
  ;(items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
}

async function toggleViewPanel() {
  const opening = !viewPanelOpen.value
  closeToolbarPopovers()
  shortcutsOpen.value = false
  if (!opening) return
  anchorPopover(viewTrigger.value, VIEW_PANEL_WIDTH)
  viewPanelOpen.value = true
  await nextTick()
  viewPanelEl.value?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus()
}

function toggleTypographyPopover() {
  const opening = !typographyOpen.value
  closeToolbarPopovers()
  shortcutsOpen.value = false
  if (opening) anchorPopover(typographyTrigger.value, TYPOGRAPHY_POPOVER_WIDTH)
  typographyOpen.value = opening
}

function toggleMoreMenu() {
  const opening = !moreMenu.value
  closeToolbarPopovers()
  moreMenu.value = opening
}

/** 视图面板里的全屏 / 放映 / 菜单项: 先收起弹层再执行 */
function runFromToolbarPopover(action: () => unknown) {
  closeToolbarPopovers()
  void action()
}

function zoomMenuItems() {
  return Array.from(zoomMenuEl.value?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
}

function onZoomMenuKeydown(event: KeyboardEvent) {
  // 菜单内的方向键 / Esc 不交给阅读器全局快捷键 (否则会翻页)
  event.stopPropagation()
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault()
    zoomMenu.value = false
    zoomTrigger.value?.focus()
    return
  }
  const items = zoomMenuItems()
  const index = items.indexOf(document.activeElement as HTMLElement)
  const inGrid = index >= 0 && index < ZOOM_MENU_PRESETS.length
  const delta: Record<string, number> = {
    ArrowRight: 1,
    ArrowLeft: -1,
    ArrowDown: inGrid && index + 3 < ZOOM_MENU_PRESETS.length ? 3 : 1,
    ArrowUp: inGrid ? -3 : index === ZOOM_MENU_PRESETS.length ? -2 : -1,
  }
  let next = -1
  if (event.key in delta) next = Math.min(items.length - 1, Math.max(0, index + delta[event.key]))
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = items.length - 1
  if (next < 0) return
  event.preventDefault()
  items[next]?.focus()
}

function onViewPanelKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key !== 'Escape') return
  event.preventDefault()
  viewPanelOpen.value = false
  viewTrigger.value?.focus()
}

function pickZoom(z: PdfZoom) {
  zoomMenu.value = false
  zoomTrigger.value?.focus()
  void applyZoom(z)
}

/* 顶栏宽度分档: 宽度不够时右侧按钮只留图标, 再窄把听书 / 自动翻页收进「更多」 */
const topbar = ref<HTMLElement>()
const topbarWidth = ref(Number.POSITIVE_INFINITY)
const topbarCompact = computed(() => topbarWidth.value < 1220)
const topbarNarrow = computed(() => topbarWidth.value < 980)
/** 网页版在手机宽度下也用桌面界面: 放不下一行时翻页 / 缩放换到第二行 */
const topbarStacked = computed(() => topbarWidth.value < 600)
let topbarObserver: ResizeObserver | undefined
watch(topbar, el => {
  topbarObserver?.disconnect()
  topbarObserver = undefined
  if (!el || typeof ResizeObserver === 'undefined') return
  topbarObserver = new ResizeObserver(([entry]) => { topbarWidth.value = entry.contentRect.width })
  topbarObserver.observe(el)
})
onMounted(() => window.addEventListener('resize', reanchorPopovers))
onBeforeUnmount(() => {
  window.removeEventListener('resize', reanchorPopovers)
  topbarObserver?.disconnect()
})

function zoomPercentLabel(value: number) {
  const percent = value * 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, '')}%`
}

const isMacPlatform = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
const primaryShortcutLabel = isMacPlatform ? '⌘' : 'Ctrl'
const shortcutsOpen = ref(false)
const shortcutMenu = ref<HTMLElement>()
const shortcutRows = computed(() => getPdfShortcutHelpRows({
  isPaper: isPaper.value,
  pdfLayout: pdfLayout.value,
}, isMacPlatform).map(row => ({ ...row, label: t(row.labelKey) })))

function changeReaderZoom(dir: 1 | -1) {
  zoomMenu.value = false
  if (pdfLayout.value === 'reflow') {
    settings.setReaderPreference('fontSize', Math.min(36, Math.max(12, settings.readerPrefs.fontSize + dir * 2)))
  } else {
    zoomStep(dir)
  }
}

function resetReaderZoom() {
  zoomMenu.value = false
  if (pdfLayout.value === 'reflow') settings.setReaderPreference('fontSize', 18)
  else void applyZoom('fit-page')
}

async function toggleShortcutGuide() {
  shortcutsOpen.value = !shortcutsOpen.value
  closeToolbarPopovers()
  if (shortcutsOpen.value) {
    await nextTick()
    shortcutMenu.value?.focus()
  }
}

function onShortcutGuideKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === 'Escape') {
    event.preventDefault()
    shortcutsOpen.value = false
  }
}

/* ---- 文件操作 / 属性 / 全屏 / 幻灯片 ---- */
const paperRoot = ref<HTMLElement>()
const moreMenu = ref(false)
const propertiesOpen = ref(false)
const isFullscreen = ref(false)
let fullscreenWindowUnlisten: (() => void) | undefined
let presentationRestore: {
  mode: 'paged' | 'scroll'
  spreadMode: 'single' | 'facing' | 'book'
  zoom: PdfZoom
  wasFullscreen: boolean
} | null = null

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return t('reader.unknown')
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function formatPdfDate(value: string): string {
  if (!value) return ''
  const match = value.match(/D:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/)
  if (!match) return value
  const [, year, month = '01', day = '01', hour = '00', minute = '00'] = match
  return `${year}-${month}-${day} ${hour}:${minute}`
}

const propertyRows = computed(() => {
  const first = dimensionsOf(1)
  const mmW = first.w / 72 * 25.4
  const mmH = first.h / 72 * 25.4
  const value = (tag: string) => pdm?.meta(tag) || ''
  return [
    { label: t('reader.fileName'), value: meta.value?.fileName || t('reader.unknown') },
    { label: t('reader.fileSize'), value: formatBytes(sourcePdfSize) },
    { label: t('reader.pdfVersion'), value: sourcePdfVersion.value || t('reader.unknown') },
    { label: t('reader.pageCount'), value: String(pageCount.value) },
    { label: t('reader.pageSize'), value: `${mmW.toFixed(1)} × ${mmH.toFixed(1)} mm · ${Math.round(first.w)} × ${Math.round(first.h)} pt` },
    { label: t('reader.documentTitle'), value: value('Title') || meta.value?.title || t('reader.unknown') },
    { label: t('reader.documentAuthor'), value: value('Author') || meta.value?.author || t('reader.unknown') },
    { label: t('reader.subject'), value: value('Subject') },
    { label: t('reader.keywords'), value: value('Keywords') },
    { label: t('reader.creator'), value: value('Creator') },
    { label: t('reader.producer'), value: value('Producer') },
    { label: t('reader.createdAt'), value: formatPdfDate(value('CreationDate')) },
    { label: t('reader.modifiedAt'), value: formatPdfDate(value('ModDate')) },
  ].filter(row => row.value)
})

async function loadSourcePdfBlob(): Promise<Blob | null> {
  if (!bookId) return null
  const storage = await getStorage()
  const raw = await storage.getBookFile(bookId)
  return raw.slice(0, raw.size, 'application/pdf')
}

async function printDocument() {
  moreMenu.value = false
  try {
    const pdfBlob = await loadSourcePdfBlob()
    if (!pdfBlob) return
    await printPdf(pdfBlob)
    toast(t('reader.printOpened'), 'success')
  } catch {
    toast(t('reader.printFailed'), 'error')
  }
}

async function saveDocumentAs() {
  moreMenu.value = false
  try {
    const pdfBlob = await loadSourcePdfBlob()
    if (!pdfBlob) return
    const saved = await savePdfAs(pdfBlob, meta.value?.fileName || meta.value?.title || 'document.pdf')
    if (saved) toast(t('reader.savedAs'), 'success')
  } catch (error: any) {
    toast(t('reader.saveFailed', { msg: error?.message ?? error }), 'error', 5000)
  }
}

function choosePdfToOpen() {
  if (!openingPdf) pdfOpenInput.value?.click()
}

function isCurrentReaderRequest(initiatingRoute: string): boolean {
  return readerAlive && router.currentRoute.value.fullPath === initiatingRoute
}

async function onPdfOpenPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (detectFormat(file.name) !== 'pdf') {
    toast(t('reader.openPdfOnly'), 'error', 5000)
    return
  }
  if (openingPdf) return
  openingPdf = true
  const initiatingRoute = router.currentRoute.value.fullPath
  const collectionRoute = backTarget.value
  const collectionFullPath = router.resolve(collectionRoute).fullPath
  const kind = isPaper.value ? 'paper' : 'book'
  try {
    let probe: PdfiumDoc | null = null
    try {
      probe = await PdfiumDoc.open(await file.arrayBuffer())
    } finally {
      probe?.close()
    }
    if (!isCurrentReaderRequest(initiatingRoute)) return

    const result = await importFile(file, '本地导入', {
      kind,
    })
    if (!isCurrentReaderRequest(initiatingRoute)) return
    if (!result.ok || !result.bookId) throw new Error(result.error || t('reader.openPdfFailed'))
    await library.refresh()
    if (!isCurrentReaderRequest(initiatingRoute)) return
    await router.replace(collectionRoute)
    if (router.currentRoute.value.fullPath !== collectionFullPath) return
    await router.push(`/read-paper/${result.bookId}`)
  } catch (error: any) {
    if (isCurrentReaderRequest(initiatingRoute)) {
      toast(t('reader.openPdfFailedWithMessage', { msg: error?.message ?? error }), 'error', 5000)
    }
  } finally {
    openingPdf = false
  }
}

async function openDocumentFolder() {
  moreMenu.value = false
  if (!meta.value) return
  if (!isTauri()) {
    toast(t('reader.openFolderWebHint'), 'error', 5000)
    return
  }
  try {
    await revealStoredBook(meta.value)
  } catch {
    toast(t('reader.openFolderFailed'), 'error', 5000)
  }
}

function openProperties() {
  moreMenu.value = false
  propertiesOpen.value = true
}

async function setFullscreen(enabled: boolean) {
  const el = paperRoot.value as any
  try {
    // Windows 自绘窗口: 元素全屏交给 WebView2 放大窗口, 最大化时会露出桌面边和任务栏 (R3PM-01);
    // 和 EPUB 一样走窗口全屏 (先还原再全屏, 退出再最大化)
    if (windowChrome.custom) throw new Error('window fullscreen on custom chrome')
    if (enabled) {
      if (document.fullscreenElement) return
      if (el?.requestFullscreen) await el.requestFullscreen()
      else if (el?.webkitRequestFullscreen) await el.webkitRequestFullscreen()
      else throw new Error('no element fullscreen')
    } else if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      throw new Error('no document fullscreen')
    }
    isFullscreen.value = enabled
  } catch {
    // WKWebView 元素全屏不可用时退回无边框窗口全屏。
    try {
      await setWindowFullscreen(enabled)
      isFullscreen.value = enabled
    } catch { /* Web 端且元素全屏失败: 忽略 */ }
  }
}

async function toggleFullscreen() {
  if (presentationMode.value) {
    await exitPresentation()
    return
  }
  await setFullscreen(!isFullscreen.value)
}

// ---- 摸鱼模式 (桌面): 无边框 + 半透明 + 老板键; 状态与窗口命令见 composables/useStealth ----
// 页面上和全屏一样只留页面, 页面外的底色全透明; PDF 页是整张图 (纸和字画在一起), 「背景浓淡」作用于整页
const {
  available: stealthAvailable,
  active: stealth,
  intro: stealthIntro,
  bossKeyOk: stealthBossKeyOk,
  dismissIntro: dismissStealthIntro,
  set: setStealth,
  toggle: toggleStealth,
  autoEnter: autoEnterStealth,
} = useStealth({
  async beforeEnter() {
    closeToolbarPopovers()
    moreMenu.value = false
    if (presentationMode.value) await exitPresentation()
    if (isFullscreen.value) await setFullscreen(false)
  },
  bossHidden() {
    if (ttsState.value === 'playing') pauseTTS()
    if (autoReading.value) stopAutoRead()
  },
  // 记下进出前的页码: 换窗口时滚动容器先变形, 滚动位置会被夹到顶, 当前页跟着变成 1
  // (2026-11-08 Win10 第 2 轮: 对页模式第 5 页手动进入摸鱼回到首页, 退出也存成第 1 页)
  changed: () => { stealthPage = currentPage.value },
  // 去边框 / 换位置后按新尺寸重新渲染 (Win10 上自动进入时整页空白, 见 useStealth), 再回到进出前那一页
  windowChanged: () => void rerenderAfterWindowChange().then(restoreStealthPage),
})
let stealthPage = 0
function restoreStealthPage() {
  const page = stealthPage
  stealthPage = 0
  if (!page || page === currentPage.value || pdfLayout.value !== 'original') return
  logEvent('warn', 'stealth', `pdf page moved after window change: ${page} -> ${currentPage.value}, restored`)
  gotoPage(page)
}

// 摸鱼模式下 PDF 只留墨迹 (白纸透明), 纸色按「背景浓淡」另画, 墨迹按「文字浓淡」淡化
const stealthPaper = computed(() => stealthPdfColors(resolvedTheme.value).paper)
const stealthInkValues = computed(() => stealthInkMatrix(stealthPdfColors(resolvedTheme.value).ink))

async function rerenderAfterWindowChange(retry = true) {
  if (pdfLayout.value !== 'original' || loading.value || !pageCount.value) return
  renderedScale.clear()
  if (bookPaged.value) await renderPaged()
  else if (typeof zoom.value !== 'number') await relayout()
  else updateViewport()
  // 渲染途中尺寸又变时旧任务作废、不画 (renderScrollPage 比对 scale); 等手头的渲染收尾,
  // 核对当前页确实画上了, 没有就再画一次 (2026-11-08 Win10: 自动进入偶发整页空白, 退出重进才好)
  for (let i = 0; i < 60 && rendering.size; i++) await new Promise(r => setTimeout(r, 50))
  const pages = bookPaged.value ? pagedPages.value : [currentPage.value]
  const blank = pages.filter(p => !holderOf(p)?.querySelector('.p-canvas canvas'))
  if (blank.length && retry) {
    logEvent('warn', 'stealth', `pdf pages ${blank.join(',')} blank after window change, rendering again`)
    await rerenderAfterWindowChange(false)
  }
}

async function enterPresentation() {
  moreMenu.value = false
  if (presentationMode.value) return
  // 记下用户保存的设置 (而非竖屏下的生效值), 退出放映时原样恢复
  presentationRestore = {
    mode: settings.pdf.mode,
    spreadMode: settings.pdf.spreadMode,
    zoom: zoom.value,
    wasFullscreen: isFullscreen.value,
  }
  presentationMode.value = true
  // 放映不受竖屏锁定: 先按解除锁定后的生效值排好, 下面再切到整页单页
  await syncPdfLayout()
  if (pdfLayout.value === 'reflow') await switchPdfLayout('original')
  if (mode.value !== 'paged') await switchMode('paged')
  if (spreadMode.value !== 'single') await setSpreadMode('single')
  await applyZoom('fit-page', false)
  if (!isFullscreen.value) await setFullscreen(true)
}

async function exitPresentation(exitFullscreen = true) {
  if (!presentationMode.value) return
  const restore = presentationRestore
  presentationMode.value = false
  presentationRestore = null
  if (exitFullscreen && !restore?.wasFullscreen && isFullscreen.value) {
    await setFullscreen(false)
  }
  if (!restore) {
    await syncPdfLayout()
    return
  }
  stopAutoRead()
  settings.pdf.mode = restore.mode
  settings.pdf.spreadMode = restore.spreadMode
  // 竖屏锁定会在这里重新生效
  await syncPdfLayout()
  await applyZoom(restore.zoom, false)
}

function onFullscreenChange() {
  const active = Boolean(document.fullscreenElement)
  const wasFullscreen = isFullscreen.value
  isFullscreen.value = active
  if (wasFullscreen && !active && presentationMode.value) void exitPresentation(false)
}

let relayoutSession = 0

/** 重算缩放并保持当前页锚点 (页内比例) */
/** anchorPage: 从翻页切到滚动时滚动容器是新建的 (scrollTop=0), 不能按它推算页内位置, 直接停在该页页首 */
async function relayout(force = false, anchorPage?: number) {
  const el = scroller.value
  if (!el) return
  const next = typeof zoom.value === 'number' ? fixedZoomScale(zoom.value) : fitScale(zoom.value)
  if (!force && Math.abs(next - curScale.value) < 0.001) return
  const session = ++relayoutSession
  const fresh = anchorPage != null
  anchorPage ??= currentPage.value
  const anchorHeight = displaySizeOf(anchorPage).h
  const frac = !fresh && anchorHeight ? (el.scrollTop - pageTop(anchorPage)) / anchorHeight : 0
  for (let pass = 0; pass < 3; pass++) {
    const settled = typeof zoom.value === 'number' ? fixedZoomScale(zoom.value) : fitScale(zoom.value)
    if (pass > 0 && Math.abs(settled - curScale.value) < 0.001) break
    curScale.value = settled
    renderedScale.clear()
    await nextTick()
    if (session !== relayoutSession) return
  }
  scrollGoto(anchorPage, false, frac * displaySizeOf(anchorPage).h)
  updateViewport()
}

/* ================= 页码 / 进度 ================= */

watch(currentPage, cur => {
  pageInput.value = String(cur)
  progressDirty = true
  clearTimeout(settleTimer)
  settleTimer = setTimeout(onPageSettled, 600)
})

let progressDirty = false
function saveProgressNow() {
  clearTimeout(saveTimer)
  if (!progressDirty || !pageCount.value) return
  progressDirty = false
  library.saveProgress(bookId, String(currentPage.value), currentPage.value / pageCount.value)
}
function onPageSettled() {
  progressDirty = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveProgressNow, 400)
}

function jumpTo() {
  const raw = pageInput.value.trim()
  const n = Number(raw)
  if (raw && Number.isSafeInteger(n) && pageCount.value > 0) {
    const target = Math.min(Math.max(n, 1), pageCount.value)
    // 跳到当前页不会触发 currentPage 的监听: 这里直接改写输入框, 否则 0 / -1 会留在里面 (App 已于 K30 验收时修过)
    pageInput.value = String(target)
    gotoPage(target)
  } else {
    pageInput.value = String(currentPage.value)
  }
}

function prevPage() {
  if (pdfLayout.value === 'reflow') reflowStep(-1)
  else if (bookPaged.value) void pagedGoto(pagedPages.value[0] - 1)
  else if (scrollSpread.value) {
    const index = scrollPageGroups.value.findIndex(group => group.includes(currentPage.value))
    const target = scrollPageGroups.value[Math.max(0, index - 1)]?.[0]
    if (target) scrollGoto(target, true)
  } else scrollGoto(currentPage.value - 1, true)
}
function nextPage() {
  if (pdfLayout.value === 'reflow') {
    reflowStep(1)
  } else if (bookPaged.value) {
    const next = (pagedPages.value.at(-1) ?? currentPage.value) + 1
    if (next <= pageCount.value) void pagedGoto(next)
  } else if (scrollSpread.value) {
    const index = scrollPageGroups.value.findIndex(group => group.includes(currentPage.value))
    const target = scrollPageGroups.value[Math.min(scrollPageGroups.value.length - 1, index + 1)]?.[0]
    if (target) scrollGoto(target, true)
  } else {
    scrollGoto(currentPage.value + 1, true)
  }
}

/* ================= 跳转返回 (引文 / 目录跳转后回到原位) ================= */

const backStack = ref<number[]>([])
const forwardStack = ref<number[]>([])

function pushBack() {
  const position = currentNavPosition()
  if (position == null) return
  backStack.value.push(position)
  if (backStack.value.length > 20) backStack.value.shift()
  forwardStack.value = []
}

function currentNavPosition(): number | null {
  if (bookPaged.value) return -currentPage.value
  if (pdfLayout.value === 'reflow') return reflowScroller.value?.scrollTop ?? null
  return scroller.value?.scrollTop ?? null
}

function restoreNavPosition(position: number) {
  if (position < 0) gotoPage(-position)
  else if (pdfLayout.value === 'reflow') reflowScroller.value?.scrollTo({ top: position })
  else scroller.value?.scrollTo({ top: position })
}

function goBack() {
  const position = backStack.value.pop()
  const current = currentNavPosition()
  if (position == null || current == null) return
  forwardStack.value.push(current)
  restoreNavPosition(position)
}

function goForward() {
  const position = forwardStack.value.pop()
  const current = currentNavPosition()
  if (position == null || current == null) return
  backStack.value.push(current)
  restoreNavPosition(position)
}

async function openExternal(url: string) {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } catch {
    window.open(url, '_blank', 'noopener')
  }
}

/* ================= 目录 (PDF 内嵌大纲) ================= */

const tocOpen = ref(false)
const thumbnailOpen = ref(false)
const annoOpen = ref(false)
const tocItems = ref<TocItem[]>([])
const currentTocPage = ref(1)
const currentTocOffsetPt = ref(0)
const drawerOpen = computed(() => tocOpen.value || thumbnailOpen.value || annoOpen.value)

interface TocDestination {
  href: string
  page: number
  y: number
}

function tocDestinationOf(href: string): TocDestination | null {
  const [pageText, yText] = href.split('|')
  const page = Number.parseInt(pageText, 10)
  if (!Number.isFinite(page)) return null
  const parsedY = Number.parseFloat(yText ?? '')
  return { href, page, y: Number.isFinite(parsedY) ? Math.max(0, parsedY) : 0 }
}

function flattenTocDestinations(items: TocItem[]): TocDestination[] {
  const destinations: TocDestination[] = []
  for (const item of items) {
    if (item.href) {
      const destination = tocDestinationOf(item.href)
      if (destination) destinations.push(destination)
    }
    if (item.subitems?.length) destinations.push(...flattenTocDestinations(item.subitems))
  }
  return destinations
}

const tocDestinations = computed(() => flattenTocDestinations(tocItems.value))
const currentTocHref = computed(() => {
  const currentPosition = { page: currentTocPage.value, y: currentTocOffsetPt.value }
  let active: TocDestination | undefined
  for (const destination of tocDestinations.value) {
    const isReached = destination.page < currentPosition.page
      || (destination.page === currentPosition.page && destination.y <= currentPosition.y)
    if (!isReached) continue
    if (
      !active
      || destination.page > active.page
      || (destination.page === active.page && destination.y >= active.y)
    ) active = destination
  }
  return active?.href
})

function updateCurrentTocPosition() {
  if (!tocOpen.value) return
  if (pdfLayout.value === 'reflow') {
    currentTocPage.value = currentPage.value
    currentTocOffsetPt.value = 0
    return
  }
  const viewport = bookPaged.value ? pagedBox.value : scroller.value
  if (!viewport) {
    currentTocPage.value = currentPage.value
    currentTocOffsetPt.value = 0
    return
  }
  const viewportRect = viewport.getBoundingClientRect()
  const focusY = viewportRect.top + Math.min(60, viewportRect.height / 2)
  const page = bookPaged.value ? currentPage.value : pageAtScrollOffset(focusY - viewportRect.top)
  const holder = holderOf(page)
  currentTocPage.value = page
  if (!holder) {
    currentTocOffsetPt.value = 0
    return
  }
  const holderRect = holder.getBoundingClientRect()
  const offsetPx = Math.min(Math.max(0, focusY - holderRect.top), holderRect.height)
  currentTocOffsetPt.value = offsetPx / displaySizeOf(page).sy
}

function scheduleCurrentTocPositionUpdate() {
  if (tocPositionScheduled) return
  tocPositionScheduled = true
  requestAnimationFrame(() => {
    tocPositionScheduled = false
    updateCurrentTocPosition()
  })
}

type DrawerTab = 'toc' | 'thumbnails' | 'annotations'

function closeDrawer() {
  tocOpen.value = false
  thumbnailOpen.value = false
  annoOpen.value = false
}

const lastDrawerTab = ref<DrawerTab>('toc')

/** 顶栏侧栏开关: 目录 / 缩略图 / 划线想法共用一个入口, 打开时回到上次的标签 */
function toggleSidebar() {
  if (drawerOpen.value) closeDrawer()
  else setDrawerTab(lastDrawerTab.value)
}

function setDrawerTab(tab: DrawerTab) {
  lastDrawerTab.value = tab
  tocOpen.value = tab === 'toc'
  thumbnailOpen.value = tab === 'thumbnails'
  annoOpen.value = tab === 'annotations'
}

function toggleDrawerTab(tab: DrawerTab) {
  const isOpen = tab === 'toc' ? tocOpen.value : tab === 'thumbnails' ? thumbnailOpen.value : annoOpen.value
  if (isOpen) closeDrawer()
  else setDrawerTab(tab)
}

/* ================= 页面缩略图 ================= */

const THUMB_MAX_WIDTH = 210
const THUMB_MAX_HEIGHT = 260
const THUMB_CACHE_LIMIT = 56
const thumbnailRendered = new Set<number>()
const thumbnailQueued = new Set<number>()
const thumbnailLastUsed = new Map<number, number>()
const thumbnailQueue: number[] = []
let thumbnailObserver: IntersectionObserver | null = null
let thumbnailWorkerActive = false

function thumbnailSizeOf(pageNum: number) {
  const dims = dimensionsOf(pageNum)
  const scale = Math.min(THUMB_MAX_WIDTH / dims.w, THUMB_MAX_HEIGHT / dims.h)
  return {
    w: Math.max(1, Math.round(dims.w * scale)),
    h: Math.max(1, Math.round(dims.h * scale)),
  }
}

function thumbnailFrameStyle(pageNum: number) {
  const size = thumbnailSizeOf(pageNum)
  return { width: `${size.w}px`, height: `${size.h}px` }
}

function thumbnailHolderOf(pageNum: number) {
  return thumbnailScroller.value?.querySelector<HTMLElement>(`[data-thumbnail-page="${pageNum}"]`) ?? null
}

function trimThumbnailCache() {
  if (thumbnailRendered.size <= THUMB_CACHE_LIMIT) return
  const protectedStart = Math.max(1, currentPage.value - 8)
  const protectedEnd = Math.min(pageCount.value, currentPage.value + 8)
  const candidates = [...thumbnailRendered]
    .filter(page => page < protectedStart || page > protectedEnd)
    .sort((a, b) => (thumbnailLastUsed.get(a) ?? 0) - (thumbnailLastUsed.get(b) ?? 0))

  while (thumbnailRendered.size > THUMB_CACHE_LIMIT && candidates.length) {
    const page = candidates.shift()!
    const holder = thumbnailHolderOf(page)
    holder?.querySelector('.thumbnail-canvas')?.replaceChildren()
    holder?.classList.remove('thumbnail-ready')
    thumbnailRendered.delete(page)
    thumbnailLastUsed.delete(page)
    if (holder && thumbnailOpen.value) thumbnailObserver?.observe(holder)
  }
}

async function drainThumbnailQueue() {
  if (thumbnailWorkerActive) return
  thumbnailWorkerActive = true
  try {
    while (thumbnailQueue.length && pdm) {
      const pageNum = thumbnailQueue.shift()!
      thumbnailQueued.delete(pageNum)
      if (thumbnailRendered.has(pageNum)) continue
      // 每页之间让出一帧，快速滚动缩略图时不会阻塞正文与工具栏交互。
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      if (!thumbnailOpen.value || !pdm) continue
      const holder = thumbnailHolderOf(pageNum)
      const slot = holder?.querySelector<HTMLElement>('.thumbnail-canvas')
      if (!holder || !slot) continue
      try {
        const size = thumbnailSizeOf(pageNum)
        // Retina 下保留清晰度，同时限制后台缩略图的长期内存占用。
        const outputScale = Math.min(DPR(), 1.5)
        const image = pdm.renderToSize(
          pageNum - 1,
          Math.max(1, Math.round(size.w * outputScale)),
          Math.max(1, Math.round(size.h * outputScale)),
        )
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        canvas.style.width = `${size.w}px`
        canvas.style.height = `${size.h}px`
        canvas.setAttribute('aria-hidden', 'true')
        canvas.getContext('2d', { alpha: false })!.putImageData(image, 0, 0)
        slot.replaceChildren(canvas)
        holder.classList.add('thumbnail-ready')
        thumbnailRendered.add(pageNum)
        thumbnailLastUsed.set(pageNum, performance.now())
        thumbnailObserver?.unobserve(holder)
        trimThumbnailCache()
      } catch (e) {
        holder.classList.add('thumbnail-failed')
        console.warn(`thumbnail render failed for page ${pageNum}:`, e)
      }
    }
  } finally {
    thumbnailWorkerActive = false
  }
}

function queueThumbnail(pageNum: number, priority = false) {
  if (
    !pdm
    || pageNum < 1
    || pageNum > pageCount.value
    || thumbnailRendered.has(pageNum)
    || thumbnailQueued.has(pageNum)
  ) return
  thumbnailQueued.add(pageNum)
  if (priority) thumbnailQueue.unshift(pageNum)
  else thumbnailQueue.push(pageNum)
  void drainThumbnailQueue()
}

function setupThumbnailObserver() {
  thumbnailObserver?.disconnect()
  const root = thumbnailScroller.value
  if (!root || !thumbnailOpen.value) return
  thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const pageNum = Number((entry.target as HTMLElement).dataset.thumbnailPage)
      if (Number.isFinite(pageNum)) queueThumbnail(pageNum)
    }
  }, { root, rootMargin: '420px 0px', threshold: 0.01 })
  root.querySelectorAll<HTMLElement>('[data-thumbnail-page]').forEach(holder => {
    const pageNum = Number(holder.dataset.thumbnailPage)
    if (!thumbnailRendered.has(pageNum)) thumbnailObserver?.observe(holder)
  })
}

function scrollActiveThumbnailIntoView() {
  if (!thumbnailOpen.value) return
  setupThumbnailObserver()
  const holder = thumbnailHolderOf(currentPage.value)
  holder?.scrollIntoView({ block: 'nearest' })
  queueThumbnail(currentPage.value, true)
}

function thumbnailNavigate(pageNum: number) {
  thumbnailLastUsed.set(pageNum, performance.now())
  pushBack()
  gotoPage(pageNum)
}

watch(thumbnailOpen, open => {
  if (open) {
    void nextTick(scrollActiveThumbnailIntoView)
  } else {
    thumbnailObserver?.disconnect()
    thumbnailQueue.length = 0
    thumbnailQueued.clear()
  }
})

watch(currentPage, () => {
  if (thumbnailOpen.value) void nextTick(scrollActiveThumbnailIntoView)
  void nextTick(updateCurrentTocPosition)
})

watch(tocOpen, open => {
  if (open) void nextTick(updateCurrentTocPosition)
})

/** href 格式: "页码|页内纵向偏移(pt, 左上原点)" */
function buildOutline() {
  if (!pdm) return
  const map = (nodes: import('../services/pdfium').PdmOutline[]): TocItem[] =>
    nodes.map(n => ({
      label: n.title,
      href: n.page != null ? `${n.page + 1}|${n.y != null ? n.y.toFixed(1) : ''}` : undefined,
      subitems: n.children.length ? map(n.children) : null,
    }))
  try {
    tocItems.value = map(pdm.outline())
  } catch (e) {
    console.warn('outline failed:', e)
  }
}

function tocNavigate(href: string) {
  const destination = tocDestinationOf(href)
  if (!destination) return
  pushBack()
  const yOffset = Math.max(0, destination.y * displaySizeOf(destination.page).sy - 60)
  gotoPage(destination.page, false, yOffset)
}

/* ================= 划词: 高亮 / 想法 / 复制 / AI 翻译 ================= */

interface HlRect { x: number; y: number; w: number; h: number }
interface SelInfo {
  text: string
  page: number
  /** 页内坐标 (scale=1, 左上原点), 缩放无关 */
  rects: HlRect[]
  /** 工具条锚点 (视口坐标) */
  anchor: { x: number; y: number }
}

const selection = ref<SelInfo | null>(null)
const annotations = ref<AnnotationRec[]>([])
const activeAnnotation = ref<AnnotationRec | null>(null)
const noteDraft = ref('')
const popPos = ref({ x: 0, y: 0 })

const encodeLoc = (page: number, rects: HlRect[]) =>
  `p:${page}:${JSON.stringify(rects.map(r => [r.x, r.y, r.w, r.h].map(v => +v.toFixed(2))))}`

function decodeLoc(cfi: string): { page: number; rects: HlRect[] } | null {
  const m = /^p:(\d+):(.+)$/.exec(cfi)
  if (!m) return null
  try {
    const arr = JSON.parse(m[2]) as number[][]
    return { page: parseInt(m[1], 10), rects: arr.map(([x, y, w, h]) => ({ x, y, w, h })) }
  } catch {
    return null
  }
}

const highlights = computed(() => annotations.value.filter(a => a.kind !== 'bookmark'))
/** 书摘: 按页排序、复制全部、导出、金句卡片 (composables/useNotesTools 的 PDF 模式) */
const notes = reactive(useNotesTools({
  meta,
  annotations,
  getView: () => null,
  getSmartToc: () => [],
  lang: () => (settings.language === 'en' ? 'en' : 'zh'),
  pdfLoc: cfi => {
    const loc = decodeLoc(cfi)
    return loc ? { page: loc.page, y: loc.rects[0]?.y ?? 0 } : null
  },
}))
const sortedHighlights = computed(() => notes.highlightGroups.flatMap(g => g.items))
const cardCover = ref<string>()
watch(() => notes.card, async c => {
  if (c && cardCover.value === undefined) cardCover.value = (meta.value?.hasCover && (await (await getStorage()).getCoverUrl(bookId))) || ''
})

/** 按页索引的高亮矩形 (模板渲染用) */
const pageHls = computed(() => {
  const map = new Map<number, Array<{ a: AnnotationRec; r: HlRect; key: string }>>()
  for (const a of highlights.value) {
    const loc = decodeLoc(a.cfi)
    if (!loc) continue
    const list = map.get(loc.page) ?? []
    loc.rects.forEach((r, i) => list.push({ a, r, key: `${a.id}:${i}` }))
    map.set(loc.page, list)
  }
  return map
})

const hlStyle = (page: number, r: HlRect, color: string) => {
  const display = displaySizeOf(page)
  return {
    left: `${r.x * display.sx}px`,
    top: `${r.y * display.sy}px`,
    width: `${r.w * display.sx}px`,
    height: `${r.h * display.sy}px`,
    background: HIGHLIGHT_COLORS[color] ?? color,
  }
}

/* ---- PDF 全文搜索: PDFium 字符模型 → 命中区间 → 精确几何高亮 ---- */

const pdfSearch = usePdfSearch({
  getDoc: () => pdm,
  pageCount,
  currentPage,
  // 激活命中后的导航动作（翻页 / 滚动 / 清选区），渲染逻辑留在视图层
  gotoHit: async (hit) => {
    const firstRect = hit.rects[0]
    if (!firstRect) return
    selection.value = null
    if (pdfLayout.value === 'reflow') await switchPdfLayout('original')
    if (bookPaged.value) {
      await pagedGoto(hit.page)
      await nextTick()
      const box = pagedBox.value
      const holder = holderOf(hit.page)
      if (box && holder) {
        const boxRect = box.getBoundingClientRect()
        const holderRect = holder.getBoundingClientRect()
        const display = displaySizeOf(hit.page)
        box.scrollTo({
          left: Math.max(0, box.scrollLeft + holderRect.left - boxRect.left + (firstRect.x + firstRect.w / 2) * display.sx - box.clientWidth / 2),
          top: Math.max(0, box.scrollTop + holderRect.top - boxRect.top + firstRect.y * display.sy - box.clientHeight * 0.3),
        })
      }
    } else {
      currentPage.value = hit.page
      scrollGoto(
        hit.page,
        false,
        Math.max(0, firstRect.y * displaySizeOf(hit.page).sy - (scroller.value?.clientHeight ?? 0) * 0.3),
      )
      updateViewport()
    }
  },
  closeDrawer,
})
// 模板里要自动解包 ref, 解构到顶层（pdfSearchInput 用嵌套 ref 绑定避开 noUnusedLocals）
const {
  pdfSearchOpen, pdfSearchQuery, pdfSearchResults, pdfSearchActive,
  pdfSearchMatchCase, pdfSearchWholeWord,
  pdfSearchStatus, pdfSearchRectsByPage, activatePdfSearchHit, schedulePdfSearch,
  togglePdfSearchOption, onPdfSearchKeydown, openPdfSearch, closePdfSearch, disposePdfSearch,
} = pdfSearch

const pdfSearchRectStyle = (page: number, r: { x: number; y: number; w: number; h: number }) => {
  const display = displaySizeOf(page)
  return {
    left: `${r.x * display.sx}px`,
    top: `${r.y * display.sy}px`,
    width: `${r.w * display.sx}px`,
    height: `${r.h * display.sy}px`,
  }
}

/* ---- PDFium 几何选择: 引擎字符坐标 → 自算命中/选区/绘制 (原生手感) ---- */

const liveSel = ref<{ page: number; a: number; b: number } | null>(null)
let dragSel: { page: number; anchor: number; moved: boolean } | null = null
let suppressClick = false
let panDrag: {
  viewport: HTMLElement
  x: number
  y: number
  left: number
  top: number
} | null = null
let wheelPageDelta = 0
let wheelPageReset: ReturnType<typeof setTimeout> | undefined
let wheelPageLockedUntil = 0
let wheelLastTs = 0
/** 页内可滚动时, 只有停在边缘后新起的滚动才允许翻页 */
let wheelEdgeArmed = false
let touchGesture: {
  x: number
  y: number
  lastDistance: number
  pinching: boolean
  /** 触摸开始时视口是否已在页首 / 页尾 (翻页模式上下滑动翻页用) */
  atStart: boolean
  atEnd: boolean
} | null = null

const liveRects = computed(() => {
  if (!liveSel.value || !pdm) return null
  const { page, a, b } = liveSel.value
  return { page, rects: rangeRects(pdm.text(page - 1), a, b) }
})
watch(selection, v => {
  if (!v) liveSel.value = null
})

/** 视口坐标 → 某页边界索引; clampToPage 时拖出页面按页首/页尾处理 */
function boundaryAt(page: number, clientX: number, clientY: number, clampToPage = false): number {
  const holder = holderOf(page)
  if (!holder || !pdm) return -1
  const hb = holder.getBoundingClientRect()
  const display = displaySizeOf(page)
  const x = (clientX - hb.left) / display.sx
  const y = (clientY - hb.top) / display.sy
  const model = pdm.text(page - 1)
  if (clampToPage) {
    if (y < 0) return 0
    const dims = dimensionsOf(page)
    if (y > dims.h) return model.count
    const b = hitBoundary(model, Math.min(Math.max(x, 0), dims.w), y)
    return b >= 0 ? b : y < dims.h / 2 ? 0 : model.count
  }
  return hitBoundary(model, x, y)
}

function onScrollerPointerDown(e: PointerEvent) {
  if (!pdm) return
  if (e.button === 1 || e.button === 2) {
    const viewport = e.currentTarget as HTMLElement | null
    if (!viewport) return
    e.preventDefault()
    panDrag = {
      viewport,
      x: e.clientX,
      y: e.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    }
    viewport.classList.add('is-panning')
    window.addEventListener('pointermove', onPanMove)
    window.addEventListener('pointerup', onPanUp, { once: true })
    return
  }
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest?.('.p-link')) return
  const holder = (e.target as HTMLElement).closest?.('.p-holder') as HTMLElement | null
  liveSel.value = null
  selection.value = null
  if (!holder) return
  const page = Number(holder.dataset.page)
  const b = boundaryAt(page, e.clientX, e.clientY)
  if (b < 0) return
  dragSel = { page, anchor: b, moved: false }
  // 不用 pointer capture (会把 click/dblclick 兼容事件重定向到捕获元素,
  // 打断双击取词与点击高亮), 拖拽期间挂 window 监听
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp, { once: true })
}

function onPanMove(e: PointerEvent) {
  if (!panDrag) return
  e.preventDefault()
  panDrag.viewport.scrollTo({
    left: panDrag.left - (e.clientX - panDrag.x),
    top: panDrag.top - (e.clientY - panDrag.y),
  })
}

function onPanUp() {
  window.removeEventListener('pointermove', onPanMove)
  panDrag?.viewport.classList.remove('is-panning')
  panDrag = null
}

function onPdfWheel(e: WheelEvent) {
  const viewport = e.currentTarget as HTMLElement | null
  if (!viewport) return
  if (e.ctrlKey || (isMacPlatform && e.metaKey)) {
    e.preventDefault()
    zoomStep(e.deltaY < 0 ? 1 : -1)
  } else if (e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
    e.preventDefault()
    viewport.scrollLeft += e.deltaY
  } else if (e.altKey) {
    e.preventDefault()
    viewport.scrollTop += e.deltaY * 4
  } else if (bookPaged.value && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
    const now = performance.now()
    const dir: 1 | -1 = e.deltaY > 0 ? 1 : -1
    if (viewport.scrollHeight - viewport.clientHeight > 1) {
      // 单页上下滑动阅读: 页面高于视口时先交给原生滚动；停在页首/页尾后
      // 重新发起的一段滚动才翻页，避免触控板惯性把整页直接带过去。
      const fresh = now - wheelLastTs > 120
      wheelLastTs = now
      if (!atPagedEdge(viewport, dir)) {
        wheelEdgeArmed = false
        wheelPageDelta = 0
        return
      }
      if (fresh) wheelEdgeArmed = true
      if (!wheelEdgeArmed) return
      e.preventDefault()
      wheelPageDelta += e.deltaY
      if (now >= wheelPageLockedUntil && Math.abs(wheelPageDelta) >= 72) {
        wheelPageLockedUntil = now + 420
        wheelEdgeArmed = false
        wheelPageDelta = 0
        void pagedTurnFromEdge(dir)
      }
      return
    }
    // 整页/书籍视图中把触控板与滚轮的纵向意图转换为一次翻页，避免轻触连跳。
    e.preventDefault()
    clearTimeout(wheelPageReset)
    wheelPageDelta += e.deltaY
    wheelPageReset = setTimeout(() => { wheelPageDelta = 0 }, 180)
    if (now >= wheelPageLockedUntil && Math.abs(wheelPageDelta) >= 72) {
      wheelPageLockedUntil = now + 420
      if (wheelPageDelta > 0) nextPage()
      else prevPage()
      wheelPageDelta = 0
    }
  }
}

/** 翻页模式下视口是否已停在页首 (dir < 0) / 页尾 (dir > 0) */
function atPagedEdge(viewport: HTMLElement, dir: 1 | -1): boolean {
  return dir > 0
    ? viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1
    : viewport.scrollTop <= 0
}

/** 从页面边缘继续滑动时翻页: 往后落到下一页页首，往前落到上一页页尾，保持上下滑动阅读连贯 */
async function pagedTurnFromEdge(dir: 1 | -1) {
  if (!bookPaged.value) return
  if (dir > 0) {
    const next = (pagedPages.value.at(-1) ?? currentPage.value) + 1
    if (next > pageCount.value) return
    await pagedGoto(next)
    return
  }
  const prev = pagedPages.value[0] - 1
  if (prev < 1) return
  await pagedGoto(prev)
  const box = pagedBox.value
  if (box) box.scrollTo({ top: box.scrollHeight - box.clientHeight })
}

function touchDistance(touches: TouchList): number {
  if (touches.length < 2) return 0
  return Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  )
}

function onPdfTouchStart(e: TouchEvent) {
  if (e.touches.length >= 2) {
    touchGesture = {
      x: 0,
      y: 0,
      lastDistance: touchDistance(e.touches),
      pinching: true,
      atStart: false,
      atEnd: false,
    }
    return
  }
  const touch = e.touches[0]
  if (!touch) return
  const viewport = e.currentTarget as HTMLElement | null
  touchGesture = {
    x: touch.clientX,
    y: touch.clientY,
    lastDistance: 0,
    pinching: false,
    atStart: !!viewport && atPagedEdge(viewport, -1),
    atEnd: !!viewport && atPagedEdge(viewport, 1),
  }
}

function onPdfTouchMove(e: TouchEvent) {
  if (!touchGesture || e.touches.length < 2) return
  e.preventDefault()
  const distance = touchDistance(e.touches)
  if (!touchGesture.lastDistance) {
    touchGesture.lastDistance = distance
    return
  }
  const ratio = distance / touchGesture.lastDistance
  if (ratio >= 1.12) {
    zoomStep(1)
    touchGesture.lastDistance = distance
  } else if (ratio <= 0.89) {
    zoomStep(-1)
    touchGesture.lastDistance = distance
  }
}

function onPdfTouchEnd(e: TouchEvent) {
  const gesture = touchGesture
  if (!gesture) return
  if (e.touches.length) {
    if (gesture.pinching && e.touches.length === 1) touchGesture = null
    return
  }
  touchGesture = null
  if (!bookPaged.value || gesture.pinching) return
  const touch = e.changedTouches[0]
  if (!touch) return
  const dx = touch.clientX - gesture.x
  const dy = touch.clientY - gesture.y
  const horizontal = Math.abs(dx) >= 56 && Math.abs(dx) >= Math.abs(dy) * 1.2
  // 上下滑动: 触摸开始时已停在页尾再上滑翻到下一页，停在页首再下滑回上一页；
  // 页内还能滚动时交给原生滚动，不抢手势。
  const vertical = !horizontal && Math.abs(dy) >= 56 && Math.abs(dy) >= Math.abs(dx) * 1.2
  const verticalDir: 1 | -1 | 0 = !vertical ? 0
    : dy < 0 && gesture.atEnd ? 1
    : dy > 0 && gesture.atStart ? -1
    : 0
  if (!horizontal && !verticalDir) return
  liveSel.value = null
  selection.value = null
  dragSel = null
  suppressClick = true
  if (verticalDir) void pagedTurnFromEdge(verticalDir)
  else if (dx < 0) nextPage()
  else prevPage()
}

function onDragMove(e: PointerEvent) {
  if (!pdm || !dragSel) return
  const cur = boundaryAt(dragSel.page, e.clientX, e.clientY, true)
  if (cur < 0) return
  dragSel.moved = true
  const a = Math.min(dragSel.anchor, cur)
  const b = Math.max(dragSel.anchor, cur)
  liveSel.value = b > a ? { page: dragSel.page, a, b } : null
}

function onDragUp() {
  window.removeEventListener('pointermove', onDragMove)
  if (!pdm || !dragSel) return
  const drag = dragSel
  dragSel = null
  const sel = liveSel.value
  if (!drag.moved || !sel || sel.b <= sel.a) {
    liveSel.value = null
    return
  }
  suppressClick = true
  finishPdmSelection(sel.page, sel.a, sel.b)
}

/** 选区落定 → 复用既有划词工具条流程 (高亮/想法/复制/翻译) */
function finishPdmSelection(page: number, a: number, b: number) {
  if (!pdm) return
  const model = pdm.text(page - 1)
  const rects = rangeRects(model, a, b)
  const text = rangeText(model, a, b).replace(/\s+/g, ' ').trim()
  if (!rects.length || !text) {
    liveSel.value = null
    return
  }
  const holder = holderOf(page)
  const hb = holder?.getBoundingClientRect()
  const display = displaySizeOf(page)
  const last = rects[rects.length - 1]
  liveSel.value = { page, a, b }
  selection.value = {
    text,
    page,
    rects,
    anchor: hb
      ? {
          x: Math.min(hb.left + (last.x + last.w) * display.sx, window.innerWidth - 20),
          y: hb.top + (last.y + last.h) * display.sy,
        }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  }
}

function onScrollerDblClick(e: MouseEvent) {
  if (!pdm) return
  const holder = (e.target as HTMLElement).closest?.('.p-holder') as HTMLElement | null
  if (!holder) return
  const page = Number(holder.dataset.page)
  const b = boundaryAt(page, e.clientX, e.clientY)
  if (b < 0) return
  const wr = wordRange(pdm.text(page - 1), b)
  if (wr) finishPdmSelection(page, wr[0], wr[1])
}

const selBarStyle = computed(() => {
  if (!selection.value) return {}
  const { x, y } = selection.value.anchor
  const toolbarWidth = Math.min(isPaper.value && bdSupported ? 560 : 420, window.innerWidth - 24)
  const centerX = window.innerWidth <= toolbarWidth + 24
    ? window.innerWidth / 2
    : Math.min(Math.max(x, toolbarWidth / 2 + 12), window.innerWidth - toolbarWidth / 2 - 12)
  const toolbarHeight = 48
  const below = y + 12
  const top = below + toolbarHeight <= window.innerHeight - 12
    ? below
    : Math.max(12, y - toolbarHeight - 12)
  return {
    left: `${centerX}px`,
    top: `${top}px`,
  }
})

async function addHighlight(color: string, withNote = false) {
  const s = selection.value
  if (!s) return
  const storage = await getStorage()
  const rec: Omit<AnnotationRec, 'id'> = {
    bookId,
    kind: 'highlight',
    cfi: encodeLoc(s.page, s.rects),
    text: s.text.slice(0, HIGHLIGHT_TEXT_MAX),
    color,
    createdAt: Date.now(),
  }
  const id = await storage.addAnnotation(rec)
  const saved = { ...rec, id }
  annotations.value.push(saved)
  window.getSelection()?.removeAllRanges()
  const anchor = s.anchor
  selection.value = null
  if (withNote) {
    noteDraft.value = ''
    popPos.value = clampPop(anchor.x - 160, anchor.y + 10)
    activeAnnotation.value = saved
  } else {
    toast(t('reader.highlighted'), 'success')
  }
}

function clampPop(x: number, y: number) {
  return {
    x: Math.max(12, Math.min(x, window.innerWidth - 340)),
    y: Math.max(12, Math.min(y, window.innerHeight - 240)),
  }
}

async function saveNote() {
  if (!activeAnnotation.value) return
  const storage = await getStorage()
  const note = noteDraft.value.trim() || undefined
  await storage.updateAnnotation(activeAnnotation.value.id, { note })
  const item = annotations.value.find(a => a.id === activeAnnotation.value!.id)
  if (item) item.note = note
  activeAnnotation.value = null
  toast(t('reader.noteSaved'), 'success')
}

async function removeAnnotation(a: AnnotationRec) {
  const storage = await getStorage()
  await storage.deleteAnnotation(a.id)
  annotations.value = annotations.value.filter(x => x.id !== a.id)
  activeAnnotation.value = null
}

function gotoAnnotation(a: AnnotationRec) {
  const loc = decodeLoc(a.cfi)
  if (!loc) return
  pushBack()
  gotoPage(loc.page, false, Math.max(0, (loc.rects[0]?.y ?? 0) * displaySizeOf(loc.page).sy - 100))
}

function liveRectStyle(page: number, r: HlRect) {
  const display = displaySizeOf(page)
  return {
    left: `${r.x * display.sx}px`,
    top: `${r.y * display.sy}px`,
    width: `${r.w * display.sx}px`,
    height: `${r.h * display.sy}px`,
  }
}

/** 点击命中已有高亮 → 打开想法编辑 (高亮矩形不拦截事件, 以免影响划词) */
function onHolderClick(e: MouseEvent, page: number) {
  if (suppressClick) {
    suppressClick = false
    return
  }
  if (window.getSelection()?.toString()) return
  if ((e.target as HTMLElement).closest('.p-link')) return
  const holder = holderOf(page)
  if (!holder) return
  const hb = holder.getBoundingClientRect()
  const display = displaySizeOf(page)
  const px = (e.clientX - hb.left) / display.sx
  const py = (e.clientY - hb.top) / display.sy
  const hit = pageHls.value.get(page)?.find(
    ({ r }) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h,
  )
  if (hit) {
    noteDraft.value = hit.a.note ?? ''
    popPos.value = clampPop(e.clientX - 160, e.clientY + 12)
    activeAnnotation.value = hit.a
    return
  }
  if (bookPaged.value) {
    const ratio = (e.clientX - hb.left) / Math.max(1, hb.width)
    const edge = presentationMode.value ? 0.5 : 0.14
    if (ratio <= edge) prevPage()
    else if (ratio >= 1 - edge) nextPage()
  }
}

async function copySelection() {
  const copiedSelection = selection.value
  if (!copiedSelection?.text) return
  try {
    await navigator.clipboard.writeText(copiedSelection.text)
    toast(t('paper.copied'), 'success')
  } catch {
    toast(t('common.copyFailed'), 'error')
  }
  if (shouldClearCopiedSelection(selection.value, copiedSelection)) selection.value = null
}

/* ---- 划词 AI 翻译 (点击才触发, 流式输出, 可关闭即取消) ---- */

const SEL_PROMPT =
  '你是专业的学术论文翻译。把用户给出的论文片段翻译成流畅准确的简体中文: ' +
  '术语首次出现保留英文原文于括号内, 公式、变量名、引用编号原样保留。只输出译文, 不要任何解释。'

const selTr = ref<{ src: string; out: string; busy: boolean } | null>(null)
const selTrPos = ref({ x: 0, y: 0 })
let selTrSession = 0

async function translateSelection() {
  const s = selection.value
  if (!s) return
  if (!aiReady.value) {
    toast(t('paper.setupHint'), 'error', 5000)
    router.push('/settings')
    return
  }
  selTrPos.value = clampPop(s.anchor.x - 180, s.anchor.y + 10)
  window.getSelection()?.removeAllRanges()
  selection.value = null
  selTr.value = { src: s.text, out: '', busy: true }
  const session = ++selTrSession
  try {
    // 论文划词 → 学术翻译; 藏书划词 → AI 解读 (中文书场景)
    const lang = settings.language === 'en' ? 'en' : 'zh'
    const messages: AiMessage[] = isPaper.value
      ? [
          { role: 'system', content: SEL_PROMPT },
          { role: 'user', content: s.text },
        ]
      : [
          {
            role: 'system',
            content: readerSystemPrompt({ title: meta.value?.title, author: meta.value?.author }, '', lang),
          },
          { role: 'user', content: explainPrompt(s.text, lang) },
        ]
    for await (const delta of chatStream(messages)) {
      if (session !== selTrSession) return
      selTr.value.out += delta
    }
  } catch (e: any) {
    if (session === selTrSession) toast(`${t('paper.translateFailed')}: ${e?.message ?? e}`, 'error', 6000)
  } finally {
    if (session === selTrSession && selTr.value) selTr.value.busy = false
  }
}

function closeSelTr() {
  selTrSession++
  selTr.value = null
}

async function copySelTr() {
  if (!selTr.value?.out) return
  try {
    await navigator.clipboard.writeText(selTr.value.out)
    toast(t('paper.copied'), 'success')
  } catch {
    toast(t('common.copyFailed'), 'error')
  }
}

/* ================= 整页翻译面板: 版式对照连续滚动 (独立于左栏) ================= */

interface MirPageData {
  paras: PaperParagraph[]
  trs: string[]
  err?: string
}

/** 右侧视图: 版式对照 (默认) / 段落列表 */
const VIEW_KEY = 'lightread-paper-view'
const viewMode = ref<'mirror' | 'cards'>(localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'mirror')
const effectiveMode = computed(() => viewMode.value)

/** 每页的段落与译文 (提取/翻译均按需触发, 译文走 localStorage 缓存) */
const mirData = ref<Record<number, MirPageData>>({})
/** 对照视图当前页 (独立于左栏页码) */
const mirCur = ref(1)
/** 正在翻译的页码, 0 为空闲 */
const translatingPage = ref(0)
const expanded = ref<Set<number>>(new Set())
/** 已切回原文的块: "页:块id" */
const showOrig = ref<Set<string>>(new Set())
let translateSession = 0
let mirSettleTimer: ReturnType<typeof setTimeout> | undefined
let mirScrollScheduled = false

const mirScroller = ref<HTMLElement>()
const mirScale = ref(1)
const MIR_PAD = 12
const MIR_GAP = 12
const mirRendered = new Map<number, number>()
const mirRendering = new Set<number>()

const mirHolderW = computed(() => baseDims.value.w * mirScale.value)
const mirHolderH = computed(() => baseDims.value.h * mirScale.value)
const mirHolderStyle = computed(() => ({ width: `${mirHolderW.value}px`, height: `${mirHolderH.value}px` }))

const curMir = computed(() => mirData.value[mirCur.value])

const origText = (p: PaperParagraph) => restorePlaceholders(p.text, p.placeholders)
const trText = (d: MirPageData, id: number) => restorePlaceholders(d.trs[id] ?? '', d.paras[id]?.placeholders)

/**
 * 版式求解 (先算好每个块的最终几何再填充, 避免遮罩互相覆盖):
 * 按列分组 → 列内按纵向排序 → 与下一块重叠时裁掉本块底部。按 (段落数组, 缩放) 缓存。
 */
interface BlockRect {
  left: number
  top: number
  width: number
  height: number
  base: number
}
const layoutCache = new WeakMap<PaperParagraph[], { scale: number; map: Map<number, BlockRect> }>()

function solveLayout(paras: PaperParagraph[], s: number): Map<number, BlockRect> {
  const hit = layoutCache.get(paras)
  if (hit && Math.abs(hit.scale - s) < 1e-4) return hit.map
  const pageH = baseDims.value.h
  const pageW = baseDims.value.w * s
  const rects = paras
    .filter(p => p.bbox)
    .map(p => ({
      id: p.id,
      left: p.bbox!.x * s,
      top: (pageH - p.bbox!.y - p.bbox!.h) * s,
      width: p.bbox!.w * s,
      height: p.bbox!.h * s,
      base: Math.max(8, Math.min(26, (p.fontSize ?? 10) * s)),
    }))
  const groups: Record<string, typeof rects> = { L: [], R: [], full: [] }
  for (const r of rects) {
    const key = r.width > pageW * 0.6 ? 'full' : r.left + r.width / 2 < pageW / 2 ? 'L' : 'R'
    groups[key].push(r)
  }
  for (const key of ['L', 'R', 'full']) {
    const arr = groups[key].sort((a, b) => a.top - b.top)
    for (let i = 0; i < arr.length - 1; i++) {
      const cur = arr[i]
      const next = arr[i + 1]
      if (cur.top + cur.height > next.top - 2) cur.height = Math.max(10, next.top - 2 - cur.top)
    }
  }
  const map = new Map(rects.map(r => [r.id, r]))
  layoutCache.set(paras, { scale: s, map })
  return map
}

/** 按容量预计算字号: 中文按 1 字宽、拉丁按 0.52 估算, 使文本恰好放进框 */
function fitFont(text: string, w: number, h: number, base: number) {
  let eff = 0
  for (const ch of text) eff += ch.charCodeAt(0) > 0x2e00 ? 1 : 0.52
  eff = Math.max(eff, 1)
  let f = Math.min(base, Math.sqrt((w * h) / (1.36 * eff)))
  for (let i = 0; i < 10; i++) {
    const cap = Math.max(1, Math.floor(w / f)) * Math.max(1, Math.floor(h / (f * 1.34)))
    if (cap >= eff * 1.04) break
    f *= 0.95
  }
  return Math.max(7, f)
}

interface MirBlock {
  id: number
  text: string
  orig: boolean
  style: Record<string, string>
}

/** 某页已译几何段落 → 定位好的对照块 */
function blocksOf(n: number): MirBlock[] {
  const d = mirData.value[n]
  if (!d || !d.trs.some(Boolean)) return []
  const map = solveLayout(d.paras, mirScale.value)
  const out: MirBlock[] = []
  for (const p of d.paras) {
    if (!p.bbox) continue
    const tr = trText(d, p.id)
    if (!tr) continue
    const r = map.get(p.id)
    if (!r) continue
    const orig = showOrig.value.has(`${n}:${p.id}`)
    const text = orig ? origText(p) : tr
    out.push({
      id: p.id,
      text,
      orig,
      style: {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        fontSize: `${fitFont(text, r.width, r.height, r.base)}px`,
      },
    })
  }
  return out
}

/** 兜底微调: 预计算字号后仍溢出的个别块 (换行低效) 再小步递减 */
let fitQueued = false
function queueFit() {
  if (fitQueued) return
  fitQueued = true
  nextTick(() =>
    requestAnimationFrame(() => {
      fitQueued = false
      const host = mirScroller.value
      if (!host) return
      for (const el of Array.from(host.querySelectorAll<HTMLElement>('.pm-block'))) {
        let size = parseFloat(el.style.fontSize || '12')
        let guard = 6
        while (guard-- > 0 && size > 7 && el.scrollHeight > el.clientHeight + 2) {
          size *= 0.95
          el.style.fontSize = `${size}px`
        }
      }
    }),
  )
}
watch([mirData, showOrig], queueFit)

function setMode(mode: 'mirror' | 'cards') {
  viewMode.value = mode
  localStorage.setItem(VIEW_KEY, mode)
  if (mode === 'mirror') nextTick(() => mirLayoutNow())
}

function toggleBlock(n: number, id: number) {
  // 划词选择时不触发切换
  if (window.getSelection()?.toString()) return
  const key = `${n}:${id}`
  const next = new Set(showOrig.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  showOrig.value = next
}

/** 段落提取 (按页缓存), 顺带装入已缓存的译文 */
async function ensureParas(page: number): Promise<MirPageData> {
  const cur = mirData.value[page]
  if (cur) return cur
  const d: MirPageData = { paras: [], trs: [] }
  try {
    // 段落几何提取: PDFium 字符流合成 runs → 既有聚类管线
    const dims = dimensionsOf(page)
    const items = pdm ? textRuns(pdm.text(page - 1), dims.h) : []
    d.paras = extractParagraphsFromItems(items, dims.w)
    // 严格算法无结果时宽松兜底: 只要页面有文字就切得出块
    if (!d.paras.length) d.paras = extractParagraphsLooseFromItems(items)
  } catch (e: any) {
    console.error('paragraph extraction failed:', e)
    d.err = String(e?.message ?? e).slice(0, 160)
  }
  d.trs = new Array(d.paras.length).fill('')
  const cached = cachedTranslation(bookId, page, d.paras.length)
  if (cached) d.trs = cached
  mirData.value = { ...mirData.value, [page]: d }
  return d
}

/* ================= PDF 流式阅读：文本层重排为单栏正文 ================= */

interface ReflowParagraph {
  id: number
  text: string
  fontSize: number
}

interface ReflowPage {
  page: number
  paras: ReflowParagraph[]
}

const reflowScroller = ref<HTMLElement>()
const reflowPages = ref<ReflowPage[]>([])
const reflowBuilding = ref(false)
const reflowBuilt = ref(false)
const reflowProcessed = ref(0)
const reflowError = ref('')
const reflowBodyFont = ref(10)
const typographyOpen = ref(false)
let reflowBuildPromise: Promise<void> | null = null
let reflowSession = 0
let reflowScrollScheduled = false

const reflowStyle = computed<Record<string, string>>(() => {
  const colors = resolveReaderColors(settings.reader.theme, resolvedTheme.value === 'dark')
  return {
    '--reflow-bg': colors.bg,
    '--reflow-fg': colors.fg,
    '--reflow-link': colors.link,
    '--reflow-font-size': `${settings.readerPrefs.fontSize}px`,
    '--reflow-line-height': String(settings.readerPrefs.lineHeight),
    '--reflow-font-family': resolveFontFamily(settings.reader.fontFamily) || 'inherit',
    '--reflow-align': settings.reader.justify ? 'justify' : 'start',
    '--reflow-side-pad': `${Math.max(2, settings.reader.gap)}%`,
  }
})

function isReflowHeading(p: ReflowParagraph): boolean {
  return p.text.length <= 180 && p.fontSize >= reflowBodyFont.value * 1.28
}

async function ensureReflowFont() {
  const m = settings.reader.fontFamily.match(/^custom:(.+)$/)
  const font = m ? settings.customFonts.find(f => f.name === m[1]) : undefined
  if (font) await injectFontIntoDoc(document, font)
}

watch(
  () => [pdfLayout.value, settings.reader.fontFamily] as const,
  ([layout]) => {
    if (layout === 'reflow') void ensureReflowFont()
  },
)

async function buildReflow() {
  const session = ++reflowSession
  reflowBuilding.value = true
  reflowError.value = ''
  reflowProcessed.value = 0
  const pages: ReflowPage[] = []
  const sizes: number[] = []
  try {
    for (let page = 1; page <= pageCount.value; page++) {
      const data = await ensureParas(page)
      if (session !== reflowSession) return
      const paras = data.paras
        .map(p => ({
          id: p.id,
          text: origText(p),
          fontSize: p.fontSize ?? 10,
        }))
        .filter(p => p.text.trim())
      if (paras.length) {
        pages.push({ page, paras })
        sizes.push(...paras.map(p => p.fontSize).filter(Boolean))
      }
      reflowProcessed.value = page
      if (page % 4 === 0) {
        reflowPages.value = [...pages]
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    sizes.sort((a, b) => a - b)
    reflowBodyFont.value = sizes[Math.floor(sizes.length / 2)] || 10
    reflowPages.value = pages
    reflowBuilt.value = true
    await ensureReflowFont()
  } catch (e: any) {
    console.error('reflow extraction failed:', e)
    reflowError.value = String(e?.message ?? e).slice(0, 200)
  } finally {
    if (session === reflowSession) reflowBuilding.value = false
  }
}

function ensureReflow(): Promise<void> {
  if (reflowBuilt.value) return Promise.resolve()
  if (!reflowBuildPromise) {
    reflowBuildPromise = buildReflow().finally(() => {
      reflowBuildPromise = null
    })
  }
  return reflowBuildPromise
}

function reflowPageAtCenter(): number {
  const el = reflowScroller.value
  if (!el) return currentPage.value
  const anchor = el.scrollTop + el.clientHeight * 0.32
  let page = reflowPages.value[0]?.page ?? currentPage.value
  for (const section of Array.from(el.querySelectorAll<HTMLElement>('[data-reflow-page]'))) {
    if (section.offsetTop > anchor) break
    page = Number(section.dataset.reflowPage) || page
  }
  return page
}

function onReflowScroll() {
  if (reflowScrollScheduled) return
  reflowScrollScheduled = true
  requestAnimationFrame(() => {
    reflowScrollScheduled = false
    const page = reflowPageAtCenter()
    if (page !== currentPage.value) currentPage.value = page
  })
}

function reflowGoto(n: number, smooth = false) {
  const el = reflowScroller.value
  if (!el || !reflowPages.value.length) return
  const clamped = Math.min(Math.max(1, n || 1), pageCount.value)
  const target = reflowPages.value.find(p => p.page >= clamped) ?? reflowPages.value.at(-1)
  if (!target) return
  const section = el.querySelector<HTMLElement>(`[data-reflow-page="${target.page}"]`)
  if (!section) return
  el.scrollTo({ top: Math.max(0, section.offsetTop - 24), behavior: smooth ? 'smooth' : 'auto' })
  currentPage.value = target.page
}

function reflowStep(direction: -1 | 1) {
  const pages = reflowPages.value
  if (!pages.length) return
  let index = pages.findIndex(p => p.page >= currentPage.value)
  if (index < 0) index = pages.length - 1
  const target = pages[Math.min(Math.max(0, index + direction), pages.length - 1)]
  reflowGoto(target.page, true)
}

async function switchPdfLayout(next: 'original' | 'reflow') {
  if (pdfLayout.value === next) return
  const targetPage = currentPage.value
  stopAutoRead()
  selection.value = null
  closeSelTr()
  closeToolbarPopovers()
  shortcutsOpen.value = false
  backStack.value = []
  forwardStack.value = []
  settings.pdf.layout = next
  renderedScale.clear()
  await nextTick()
  if (next === 'reflow') {
    void ensureReflow().then(() => {
      if (pdfLayout.value === 'reflow') nextTick(() => reflowGoto(targetPage))
    })
    reflowGoto(targetPage)
  } else if (bookPaged.value) {
    await pagedGoto(targetPage)
  } else {
    attachScrollListener()
    scrollGoto(targetPage)
    updateViewport()
  }
  observeActiveViewport()
}

async function openOriginalPage(page: number) {
  currentPage.value = page
  await switchPdfLayout('original')
}

/* ---- 对照视图: 连续滚动 (虚拟化渲染 + 停稳翻译) ---- */

function mirHolderOf(n: number) {
  return mirScroller.value?.querySelector<HTMLElement>(`[data-mp="${n}"]`) ?? null
}

async function renderMirPage(n: number) {
  if (!pdm || n < 1 || n > pageCount.value || mirRendering.has(n)) return
  const holder = mirHolderOf(n)
  if (!holder) return
  const s = mirScale.value
  if (mirRendered.get(n) === s) return
  mirRendering.add(n)
  try {
    const canvas = await renderBitmapCanvas(n, s)
    if (s !== mirScale.value) return
    holder.querySelector('.mp-canvas')?.replaceChildren(canvas)
    mirRendered.set(n, s)
  } finally {
    mirRendering.delete(n)
  }
}

function mirEvict(center: number) {
  const { keep } = renderWindow(center, mirScale.value)
  for (const n of [...mirRendered.keys()]) {
    if (Math.abs(n - center) > keep) {
      mirHolderOf(n)?.querySelector('.mp-canvas')?.replaceChildren()
      mirRendered.delete(n)
    }
  }
}

function mirPageAtCenter(): number {
  const el = mirScroller.value
  if (!el || !mirHolderH.value) return 1
  const center = el.scrollTop + el.clientHeight / 2 - MIR_PAD
  const idx = Math.floor(center / (mirHolderH.value + MIR_GAP))
  return Math.min(Math.max(idx + 1, 1), pageCount.value)
}

function updateMirViewport() {
  const cur = mirPageAtCenter()
  if (cur !== mirCur.value) mirCur.value = cur
  for (let i = cur - 1; i <= cur + 2; i++) renderMirPage(i)
  mirEvict(cur)
}

function onMirScroll() {
  if (mirScrollScheduled) return
  mirScrollScheduled = true
  requestAnimationFrame(() => {
    mirScrollScheduled = false
    updateMirViewport()
  })
}

watch(mirCur, () => {
  expanded.value = new Set()
  clearTimeout(mirSettleTimer)
  mirSettleTimer = setTimeout(mirSettled, 600)
})

/** 对照视图滚动停稳: 提取当前页段落并翻译 (缓存优先; 面板打开即视为翻译授权) */
async function mirSettled() {
  if (!translateOpen.value) return
  const p = mirCur.value
  await ensureParas(p)
  queueFit()
  if (aiReady.value) runTranslateFor(p)
}

function mirGoto(n: number) {
  const clamped = Math.min(Math.max(1, n || 1), pageCount.value)
  mirScroller.value?.scrollTo({ top: Math.max(0, MIR_PAD + (clamped - 1) * (mirHolderH.value + MIR_GAP)) })
}

/** 重算对照缩放 (适宽), 保持当前页锚点 */
function mirLayoutNow() {
  const el = mirScroller.value
  if (!el) return
  const next = Math.min(Math.max((el.clientWidth - 40) / baseDims.value.w, 0.2), 2.5)
  const anchor = mirCur.value
  if (Math.abs(next - mirScale.value) > 1e-4) {
    mirScale.value = next
    mirRendered.clear()
  }
  nextTick(() => {
    mirGoto(anchor)
    updateMirViewport()
    queueFit()
  })
}

/** 右栏: 翻译 (版式对照 / 段落列表), 点击才展开 */
const rightTab = ref<'translate' | null>(null)
const translateOpen = computed(() => rightTab.value === 'translate')

/* ---- 分栏拖拽: 右栏宽度可调, 持久化 ---- */
const RIGHTW_KEY = 'lightread-paper-rightw'
const rightW = ref(parseFloat(localStorage.getItem(RIGHTW_KEY) ?? '') || 0)
const rightPaneStyle = computed(() =>
  rightW.value > 0 ? { flex: `0 0 ${rightW.value}px` } : { flex: '0 0 42%' },
)

function startSplit(e: PointerEvent) {
  const split = e.currentTarget as HTMLElement
  const container = split.parentElement!
  split.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    const rect = container.getBoundingClientRect()
    rightW.value = Math.min(Math.max(rect.right - ev.clientX, 300), rect.width * 0.75)
  }
  const up = () => {
    split.removeEventListener('pointermove', move)
    split.removeEventListener('pointerup', up)
    localStorage.setItem(RIGHTW_KEY, String(Math.round(rightW.value)))
  }
  split.addEventListener('pointermove', move)
  split.addEventListener('pointerup', up)
}

async function openRight(tab: 'translate') {
  if (rightTab.value === tab) return closeRight()
  const wasOpen = rightTab.value !== null
  cancelTranslate()
  rightTab.value = tab
  await nextTick()
  if (!wasOpen) {
    // 面板挂载后左栏变窄, 重排原文页
    await relayout(true)
    if (rightPane.value) resizeObserver?.observe(rightPane.value)
  }
  if (tab === 'translate') {
    // 对照视图: 独立连续滚动, 打开时跳到左栏当前页
    mirScroller.value?.addEventListener('scroll', onMirScroll, { passive: true })
    if (mirScroller.value) resizeObserver?.observe(mirScroller.value)
    mirCur.value = currentPage.value
    mirLayoutNow()
    nextTick(() => {
      mirGoto(currentPage.value)
      updateMirViewport()
      mirSettled()
    })
  }
}

function closeRight() {
  cancelTranslate()
  rightTab.value = null
  nextTick(() => void relayout(true))
}

function cancelTranslate() {
  translateSession++
  translatingPage.value = 0
}

/** 翻译某页 (缓存/已译则跳过; force 重译) */
async function runTranslateFor(page: number, force = false) {
  const d = await ensureParas(page)
  if (!d.paras.length) return
  if (!force && d.trs.some(Boolean)) return
  if (!aiReady.value) return
  const session = ++translateSession
  translatingPage.value = page
  try {
    await translatePage(
      bookId,
      page,
      d.paras.map(p => p.text),
      snapshot => {
        if (session === translateSession) {
          mirData.value = { ...mirData.value, [page]: { ...d, trs: snapshot } }
        }
      },
      () => session !== translateSession,
    )
  } catch (e: any) {
    if (session === translateSession) {
      toast(`${t('paper.translateFailed')}: ${e?.message ?? e}`, 'error', 6000)
    }
  } finally {
    if (session === translateSession) translatingPage.value = 0
  }
}

function toggleOriginal(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/* ---- BabelDOC 整本重排版翻译 ---- */
type BdPhase = 'checking' | 'notfound' | 'ready'
type BdContextSource = 'abstract' | 'selection' | 'saved' | 'manual'
const BD_CONTEXT_SOURCE_LABELS: Record<BdContextSource, string> = {
  abstract: 'paper.bdSourceAbstract',
  selection: 'paper.bdSourceSelection',
  saved: 'paper.bdSourceSaved',
  manual: 'paper.bdSourceManual',
}
const bdSupported = babeldocSupported()
const bd = ref<{
  open: boolean
  phase: BdPhase
  status?: BabeldocStatus
  pages: string
  targetLanguage: BabeldocTargetLanguageCode
}>({
  open: false,
  phase: 'checking',
  pages: '',
  targetLanguage: loadBabeldocTargetLanguage(),
})
const bdContext = ref({
  source: '',
  sourceKind: 'manual' as BdContextSource,
  english: '',
  translation: '',
  generatedFrom: '',
  busy: false,
  error: '',
  approved: false,
})
const bdProviderOk = computed(() => babeldocUsableProvider())
const bdContextReady = computed(() =>
  !isPaper.value || Boolean(bdContext.value.english.trim() && bdContext.value.translation.trim()),
)
const bdTargetLanguage = computed(() => resolveBabeldocTargetLanguage(bd.value.targetLanguage))
let bdAbstractCache: string | undefined
let bdContextGeneration = 0
let bdContextAbort: AbortController | null = null

function invalidateBdContextGeneration() {
  bdContextGeneration++
  bdContextAbort?.abort()
  bdContextAbort = null
  bdContext.value.busy = false
}

function abstractForBabeldoc(): string {
  if (bdAbstractCache !== undefined) return bdAbstractCache
  if (!pdm) return ''
  const texts: string[] = []
  for (let page = 0; page < Math.min(3, pageCount.value); page++) {
    try {
      texts.push(pdm.pageText(page))
    } catch { /* 个别页提取失败时继续尝试后续首页 */ }
  }
  bdAbstractCache = extractAbstractCandidate(texts)
  return bdAbstractCache
}

const bdContextSourceLabel = computed(() => t(BD_CONTEXT_SOURCE_LABELS[bdContext.value.sourceKind]))

function setBdContextSource(source: string, sourceKind: BdContextSource) {
  invalidateBdContextGeneration()
  bdContext.value = {
    source: source.slice(0, PAPER_CONTEXT_SOURCE_CHAR_LIMIT),
    sourceKind,
    english: '',
    translation: '',
    generatedFrom: '',
    busy: false,
    error: '',
    approved: false,
  }
}

function applySavedBdContext(saved: ApprovedPaperTranslationContext) {
  invalidateBdContextGeneration()
  bdContext.value = {
    source: saved.source,
    sourceKind: 'saved',
    english: saved.english,
    translation: saved.translation,
    generatedFrom: saved.source,
    busy: false,
    error: '',
    approved: true,
  }
}

function initializeBdContext(seed?: { text: string; kind: BdContextSource }) {
  if (!isPaper.value) return
  if (seed?.text.trim()) {
    setBdContextSource(seed.text.trim(), seed.kind)
    return
  }
  const saved = loadPaperTranslationContext(bookId, bd.value.targetLanguage)
  if (saved) {
    applySavedBdContext(saved)
    return
  }
  useAbstractForBdContext()
}

async function checkBabeldoc() {
  bd.value.phase = 'checking'
  const st = await babeldocStatus().catch(() => ({ found: false, path: '', version: '' }))
  bd.value.status = st
  bd.value.phase = st.found ? 'ready' : 'notfound'
}

async function showBabeldoc(seed?: { text: string; kind: BdContextSource }) {
  if (babeldocTaskActive()) {
    toast(t('paper.bdAlreadyRunning'))
    return
  }
  bd.value = {
    open: true,
    phase: 'checking',
    pages: '',
    targetLanguage: loadBabeldocTargetLanguage(),
  }
  const status = checkBabeldoc()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  initializeBdContext(seed)
  await status
}

function openBabeldoc() {
  void showBabeldoc()
}

function closeBabeldoc() {
  invalidateBdContextGeneration()
  bd.value.open = false
}

function useAbstractForBdContext() {
  const abstract = abstractForBabeldoc()
  setBdContextSource(abstract, 'abstract')
  if (!abstract) bdContext.value.error = t('paper.bdAbstractNotFound')
}

function onBdTargetLanguageChange() {
  bd.value.targetLanguage = saveBabeldocTargetLanguage(bd.value.targetLanguage)
  if (!isPaper.value) return
  const source = bdContext.value.source.trim()
  const sourceKind = bdContext.value.sourceKind
  const saved = loadPaperTranslationContext(bookId, bd.value.targetLanguage)
  if (saved) {
    applySavedBdContext(saved)
    return
  }
  if (!source) {
    useAbstractForBdContext()
    return
  }
  setBdContextSource(source, sourceKind === 'saved' ? 'manual' : sourceKind)
}

function onBdContextSourceInput() {
  invalidateBdContextGeneration()
  if (bdContext.value.source !== bdContext.value.generatedFrom) {
    bdContext.value.english = ''
    bdContext.value.translation = ''
  }
  bdContext.value.sourceKind = 'manual'
  bdContext.value.error = ''
  bdContext.value.approved = false
}

function markBdContextDirty() {
  invalidateBdContextGeneration()
  bdContext.value.approved = false
}

async function generateBdContext() {
  if (!meta.value || !bdContext.value.source.trim() || bdContext.value.busy) return
  if (!aiReady.value) {
    toast(t('paper.setupHint'), 'error', 5000)
    return
  }
  const source = bdContext.value.source
  const session = ++bdContextGeneration
  const controller = new AbortController()
  bdContextAbort = controller
  bdContext.value.busy = true
  bdContext.value.error = ''
  try {
    const generated = await generatePaperTranslationContext(
      meta.value.title,
      source,
      bd.value.targetLanguage,
      () => session !== bdContextGeneration || source !== bdContext.value.source,
      controller.signal,
    )
    if (session !== bdContextGeneration || source !== bdContext.value.source) return
    bdContext.value.english = generated.english
    bdContext.value.translation = generated.translation
    bdContext.value.generatedFrom = source
    bdContext.value.approved = false
  } catch (error: any) {
    if (session === bdContextGeneration) {
      bdContext.value.error = String(error?.message ?? error).slice(0, 240)
    }
  } finally {
    if (session === bdContextGeneration) {
      if (bdContextAbort === controller) bdContextAbort = null
      bdContext.value.busy = false
    }
  }
}

function useSelectionAsBdContext() {
  const selected = selection.value?.text.trim()
  if (!selected) return
  window.getSelection()?.removeAllRanges()
  selection.value = null
  void showBabeldoc({ text: selected, kind: 'selection' })
}

function startBabeldoc() {
  if (!meta.value) return
  let backgroundPrompt: string | undefined
  if (isPaper.value) {
    if (!bdContextReady.value) return
    const previousContext = loadPaperTranslationContext(bookId, bd.value.targetLanguage)
    let approved
    try {
      approved = savePaperTranslationContext(bookId, {
        source: bdContext.value.source,
        english: bdContext.value.english,
        translation: bdContext.value.translation,
        targetLanguage: bd.value.targetLanguage,
      })
    } catch {
      toast(t('paper.bdContextSaveFailed'), 'error', 6000)
      return
    }
    if (
      bd.value.targetLanguage === 'zh'
      && approved.updatedAt !== previousContext?.updatedAt
    ) {
      cancelTranslate()
      const untranslated: Record<number, MirPageData> = {}
      for (const [page, data] of Object.entries(mirData.value)) {
        untranslated[Number(page)] = {
          ...data,
          trs: new Array(data.paras.length).fill(''),
        }
      }
      mirData.value = untranslated
    }
    backgroundPrompt = buildBabeldocContextPrompt(approved)
    bdContext.value.approved = true
  }
  const started = startBabeldocTask({
    bookId,
    fileName: meta.value.fileName,
    title: meta.value.title,
    kind: isPaper.value ? 'paper' : 'book',
    targetLanguage: bd.value.targetLanguage,
    pages: bd.value.pages,
    backgroundPrompt,
  })
  if (started) closeBabeldoc()
}

function copyInstall() {
  navigator.clipboard?.writeText(INSTALL_CMD)
    .then(() => toast(t('paper.bdCopied')), () => toast(t('common.copyFailed'), 'error'))
}

/* ================= 读书功能集 (藏书 PDF): 听书 / 自动翻页 ================= */

/** 页文本 (听书 / AI 上下文) */
async function pageTextFor(n: number): Promise<string> {
  return pdm ? pdm.pageText(n - 1).replace(/\s+/g, ' ').trim() : ''
}

/* ---- 自动阅读：翻页模式按页前进，滚动模式连续下移 ---- */
const autoReading = ref(false)
const autoPanel = ref(false)
let autoPageTimer: ReturnType<typeof setInterval> | undefined
let autoScrollFrame: number | undefined
const autoClock = new AutoScrollClock()
const autoPosition = new ScrollAccumulator()
let autoPanelTimer: ReturnType<typeof setTimeout> | undefined

function cancelAutoPanelCollapse() {
  clearTimeout(autoPanelTimer)
  autoPanelTimer = undefined
}

/** 自动阅读运行时，控制条短暂展示反馈后收起到顶部状态按钮。 */
function scheduleAutoPanelCollapse(delay = 1800) {
  cancelAutoPanelCollapse()
  if (!autoReading.value || !autoPanel.value) return
  autoPanelTimer = setTimeout(() => {
    autoPanel.value = false
    autoPanelTimer = undefined
  }, delay)
}

function collapseAutoPanel() {
  cancelAutoPanelCollapse()
  autoPanel.value = false
}

function toggleAutoPanel() {
  if (autoPanel.value) {
    collapseAutoPanel()
    return
  }
  autoPanel.value = true
  ttsPanel.value = false
  if (autoReading.value) scheduleAutoPanelCollapse(4000)
}

function stepAutoScroll(now: number) {
  if (!autoReading.value || bookPaged.value) return
  const el = pdfLayout.value === 'reflow' ? reflowScroller.value : scroller.value
  if (!el) {
    stopAutoRead()
    return
  }

  const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
  if (el.scrollTop >= maxTop - 1) {
    el.scrollTop = maxTop
    stopAutoRead()
    return
  }

  // “秒/页”在连续模式中换算为每秒滚动一个页面高度的速度。
  const stepHeight = pdfLayout.value === 'reflow' ? el.clientHeight : holderH.value
  if (document.hidden) {
    autoClock.reset()
    autoPosition.reset()
  } else {
    const dy = autoClock.step(now, stepHeight / Math.max(3, settings.autoReadSeconds))
    if (dy) autoPosition.move(el, dy)
  }
  autoScrollFrame = requestAnimationFrame(stepAutoScroll)
}

function startAutoRead() {
  stopAutoRead()
  autoReading.value = true
  if (bookPaged.value) {
    autoPageTimer = setInterval(() => {
      if (atLastPage.value) {
        stopAutoRead()
        return
      }
      nextPage()
    }, settings.autoReadSeconds * 1000)
  } else {
    autoClock.reset()
    autoPosition.reset()
    autoScrollFrame = requestAnimationFrame(stepAutoScroll)
  }
  scheduleAutoPanelCollapse()
}

function stopAutoRead() {
  autoReading.value = false
  clearInterval(autoPageTimer)
  autoPageTimer = undefined
  if (autoScrollFrame != null) cancelAnimationFrame(autoScrollFrame)
  autoScrollFrame = undefined
  autoClock.reset()
  autoPosition.reset()
  cancelAutoPanelCollapse()
}

watch(() => settings.autoReadSeconds, () => {
  if (autoReading.value && bookPaged.value) startAutoRead()
})

/* ---- 听书 (Edge 在线 / 本地离线 / 系统语音) ---- */
const paperTts = usePaperTts({
  getPageText: n => pageTextFor(n),
  currentPage,
  pageCount,
  gotoPage,
  stopAutoRead,
  pingReadingAuto,
  autoPanel,
  settings,
})
// 模板里要自动解包 ref, 解构到顶层
const { ttsPanel, ttsState, ttsVoices, localInstalled, refreshLocalStatus, auditionLocal, openTTSPanel, startTTS, pauseTTS, resumeTTS, stopTTS } = paperTts

/* ================= 生命周期 ================= */

function originalViewport(): HTMLElement | undefined {
  return bookPaged.value ? pagedBox.value : scroller.value
}

function scrollViewportBy(dx: number, dy: number): boolean {
  const viewport = pdfLayout.value === 'reflow' ? reflowScroller.value : originalViewport()
  if (!viewport) return false
  const left = viewport.scrollLeft
  const top = viewport.scrollTop
  viewport.scrollBy({ left: dx, top: dy })
  return Math.abs(viewport.scrollLeft - left) > 0.5 || Math.abs(viewport.scrollTop - top) > 0.5
}

function scrollByScreen(dir: 1 | -1) {
  const viewport = pdfLayout.value === 'reflow' ? reflowScroller.value : originalViewport()
  if (!viewport) return
  const moved = scrollViewportBy(0, dir * Math.max(80, viewport.clientHeight * 0.88))
  if (bookPaged.value && !moved) void pagedTurnFromEdge(dir)
}

function cycleFitMode() {
  void applyZoom(zoom.value === 'fit-page' ? 'fit-width' : 'fit-page')
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select, [role="textbox"]')) return true
  return target instanceof HTMLElement && target.isContentEditable
}

function focusPageInput() {
  const input = paperRoot.value?.querySelector<HTMLInputElement>('.page-input')
  input?.focus()
  input?.select()
}

function runPdfShortcutCommand(command: PdfReaderShortcutCommandId) {
  switch (command) {
    case 'copy':
      void copySelection()
      break
    case 'print':
      void printDocument()
      break
    case 'saveAs':
      void saveDocumentAs()
      break
    case 'open':
      choosePdfToOpen()
      break
    case 'search':
      openPdfSearch()
      break
    case 'findNext':
    case 'findPrevious':
      if (!pdfSearchOpen.value) openPdfSearch()
      if (pdfSearchResults.value.length) {
        void activatePdfSearchHit(pdfSearchActive.value + (command === 'findPrevious' ? -1 : 1))
      }
      break
    case 'historyBack':
      goBack()
      break
    case 'historyForward':
      goForward()
      break
    case 'zoomIn':
      changeReaderZoom(1)
      break
    case 'zoomOut':
      changeReaderZoom(-1)
      break
    case 'zoomReset':
      resetReaderZoom()
      break
    case 'actualSize':
      void applyZoom(1)
      break
    case 'fitWidth':
      void applyZoom('fit-width')
      break
    case 'layoutSingle':
    case 'layoutFacing':
    case 'layoutBook': {
      const next = command === 'layoutSingle' ? 'single' : command === 'layoutFacing' ? 'facing' : 'book'
      void (async () => {
        if (pdfLayout.value === 'reflow') await switchPdfLayout('original')
        if (mode.value !== 'paged') await switchMode('paged')
        await setSpreadMode(next)
      })()
      break
    }
    case 'focusPage':
      focusPageInput()
      break
    case 'screenUp':
      scrollByScreen(-1)
      break
    case 'screenDown':
      scrollByScreen(1)
      break
    case 'closePanels':
      if (presentationMode.value) {
        void exitPresentation()
      } else if (isFullscreen.value) {
        void setFullscreen(false)
      } else if (pdfSearchOpen.value) {
        closePdfSearch()
      } else {
        selection.value = null
        liveSel.value = null
        dragSel = null
        activeAnnotation.value = null
        closeSelTr()
        closeDrawer()
        closeToolbarPopovers()
        shortcutsOpen.value = false
        stopAutoRead()
        autoPanel.value = false
      }
      break
    case 'toggleHelp':
      toggleShortcutGuide()
      break
    case 'toggleFullscreen':
      void toggleFullscreen()
      break
    case 'presentation':
      void enterPresentation()
      break
    case 'toggleToc':
      toggleDrawerTab('toc')
      break
    case 'cycleFit':
      cycleFitMode()
      break
    case 'togglePageMode':
      void switchMode(mode.value === 'paged' ? 'scroll' : 'paged')
      break
    case 'firstPage':
      gotoPage(1)
      break
    case 'lastPage':
      gotoPage(pageCount.value)
      break
    case 'nextPage':
      nextPage()
      break
    case 'previousPage':
      prevPage()
      break
    case 'pageUp':
      scrollByScreen(-1)
      break
    case 'pageDown':
      scrollByScreen(1)
      break
    case 'lineUp': {
      const moved = scrollViewportBy(0, -48)
      if (bookPaged.value && !moved) void pagedTurnFromEdge(-1)
      break
    }
    case 'lineDown': {
      const moved = scrollViewportBy(0, 48)
      if (bookPaged.value && !moved) void pagedTurnFromEdge(1)
      break
    }
    case 'lineLeft': {
      const moved = scrollViewportBy(-64, 0)
      if (bookPaged.value && !moved) prevPage()
      break
    }
    case 'lineRight': {
      const moved = scrollViewportBy(64, 0)
      if (bookPaged.value && !moved) nextPage()
      break
    }
  }
}

function handleKeydown(e: KeyboardEvent) {
  dispatchPdfReaderShortcut(e, isMacPlatform, {
    state: {
      isPaper: isPaper.value,
      pdfLayout: pdfLayout.value,
    },
    isEditableTarget: () => isEditableShortcutTarget(e.target),
    canHandleCommand: command => command !== 'copy'
      || Boolean(selection.value?.text) && !window.getSelection()?.toString(),
    runCommand: runPdfShortcutCommand,
  })
}

function resetAutoScrollClock() { autoClock.reset() }

onMounted(async () => {
  document.addEventListener('visibilitychange', resetAutoScrollClock)
  window.addEventListener('keydown', handleKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange as EventListener)
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const currentWindow = getCurrentWindow()
      isFullscreen.value = await currentWindow.isFullscreen()
      fullscreenWindowUnlisten = await currentWindow.onResized(async () => {
        const active = await currentWindow.isFullscreen()
        const wasFullscreen = isFullscreen.value
        isFullscreen.value = active
        if (wasFullscreen && !active && presentationMode.value) void exitPresentation(false)
      })
    } catch { /* 浏览器环境或窗口权限不支持时忽略 */ }
  }
  try {
    const storage = await getStorage()
    meta.value = await storage.getBook(bookId)
    if (!meta.value) {
      error.value = t('reader.bookNotFound')
      return
    }
    const storedAnnotations = await storage.listAnnotations(bookId)
    annotations.value = storedAnnotations.filter(a => decodeLoc(a.cfi))
    const blob = await storage.getBookFile(bookId)
    sourcePdfSize = blob.size
    const fileData = await blob.arrayBuffer()
    sourcePdfVersion.value = new TextDecoder('latin1')
      .decode(fileData.slice(0, 16))
      .match(/%PDF-(\d\.\d)/)?.[1] ?? ''
    // 流式阅读已下线；读取旧设置时也必须回到原版 PDF。
    settings.pdf.layout = 'original'
    pdm = await PdfiumDoc.open(fileData)
    // PDFium 已把字节拷进自己的 wasm 堆; 这份缓冲直接转移给渲染 Worker (MuPDF 在那边再拷进它的堆),
    // 主线程不再留第二份。Worker 起不来时缓冲没被转移, 留给主线程的 MuPDF。此后不要再读 fileData。
    renderBytes = null
    pageRenderer?.close()
    pageRenderer = null
    if (settings.pdf.renderer === 'mupdf') {
      pageRenderer = PdfRenderClient.create(fileData)
      if (!pageRenderer) renderBytes = new Uint8Array(fileData)
    }
    pageCount.value = pdm.pages.length
    pageDims.value = pdm.pages.map(page => ({ w: page.w, h: page.h }))
    baseDims.value = pageDims.value[0] ?? { w: 612, h: 792 }
    const saved = parseInt(meta.value.location ?? '1', 10)
    currentPage.value = Number.isFinite(saved)
      ? Math.min(Math.max(saved, 1), pageCount.value)
      : 1
    loading.value = false
    await nextTick()
    if (pdfLayout.value === 'reflow') {
      const targetPage = currentPage.value
      void ensureReflow().then(() => {
        if (pdfLayout.value === 'reflow') nextTick(() => reflowGoto(targetPage))
      })
    } else if (bookPaged.value) {
      currentPage.value = spreadOf(currentPage.value)[0]
      await nextTick()
      await renderPaged()
    } else {
      curScale.value = typeof zoom.value === 'number' ? fixedZoomScale(zoom.value) : fitScale(zoom.value)
      attachScrollListener()
      await nextTick()
      if (currentPage.value > 1) scrollGoto(currentPage.value)
      updateViewport()
    }
    markLaidOut()
    buildOutline()
    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (pdfLayout.value === 'original') {
          if (bookPaged.value) void renderPaged()
          else if (typeof zoom.value !== 'number') void relayout()
          else if (renderedScale.get(currentPage.value) !== renderKeyFor(currentPage.value, curScale.value)) {
            renderedScale.clear()
            updateViewport()
          }
        }
        if (translateOpen.value) mirLayoutNow()
      }, 200)
    })
    observeActiveViewport()
    // 设置了「打开图书时自动进入摸鱼模式」
    autoEnterStealth()
  } catch (e: any) {
    console.error(e)
    pdfEngineCrashed.value = e instanceof PdfEngineError || isWasmCrash(e)
    error.value = pdfEngineCrashed.value ? t('reader.pdfEngineCrashed') : e?.message ?? t('reader.cantOpenPdf')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', resetAutoScrollClock)
  readerAlive = false
  reflowSession++
  invalidateBdContextGeneration()
  window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange as EventListener)
  fullscreenWindowUnlisten?.()
  fullscreenWindowUnlisten = undefined
  translateSession++
  selTrSession++
  stopTTS()
  stopAutoRead()
  clearTimeout(mirSettleTimer)
  resizeObserver?.disconnect()
  listenedScroller?.removeEventListener('scroll', onScroll)
  listenedScroller = undefined
  // 翻页 / 跳页后 1 秒内离开: 还没到存进度的时候, 离开前补存 (R3 novice N01: 跳到第 3 页立即返回, 再开仍是第 5 页)
  saveProgressNow()
  clearTimeout(settleTimer)
  clearTimeout(resizeTimer)
  clearTimeout(wheelPageReset)
  disposePdfSearch()
  thumbnailObserver?.disconnect()
  thumbnailObserver = null
  thumbnailQueue.length = 0
  thumbnailQueued.clear()
  thumbnailRendered.clear()
  thumbnailLastUsed.clear()
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointermove', onPanMove)
  panDrag?.viewport.classList.remove('is-panning')
  panDrag = null
  pdm?.close()
  pdm = null
  mupdfDocPromise?.then(doc => doc?.destroy?.()).catch(() => {})
  mupdfDocPromise = null
  pageRenderer?.close()
  pageRenderer = null
  renderBytes = null
  sourcePdfSize = 0
})
</script>

<template>
  <div
    ref="paperRoot"
    class="paper"
    :class="{ 'is-fullscreen': isFullscreen, 'is-presentation': presentationMode, 'is-stealth': stealth }"
    :style="stealth ? { '--stealth-paper': stealthBackground(stealthPaper, settings.stealth.bgOpacity), '--stealth-ink': settings.stealth.textOpacity } : undefined"
  >
    <!-- 摸鱼模式: 窗口没有标题栏, 顶部细条拖动窗口; 悬停时露出浓淡与退出 -->
    <StealthStrip v-if="stealth" :intro="stealthIntro" :boss-key-ok="stealthBossKeyOk" @exit="setStealth(false)" @dismiss-intro="dismissStealthIntro" />
    <!-- 摸鱼模式的「只留墨迹」滤镜: 白纸变透明, 字按深浅留下, 纸色由页面底色另画, 背景与文字浓淡互不牵连。
         始终放在页面里: 与引用它的画布同时插入时, 个别 WebView 会把 filter:url() 当成找不到而不画 -->
    <svg class="stealth-defs" aria-hidden="true" width="0" height="0">
      <filter id="lr-stealth-ink" color-interpolation-filters="sRGB">
        <feColorMatrix type="matrix" :values="stealthInkValues" />
      </filter>
    </svg>
    <input
      ref="pdfOpenInput"
      data-reader-pdf-open
      type="file"
      accept=".pdf,application/pdf"
      hidden
      @change="onPdfOpenPicked"
    />
    <header class="paper-header">
      <!-- 桌面单行顶栏: 标题 · 翻页缩放居中 · 功能 (App 界面在 src/mobile/views/PaperReaderView.vue) -->
      <div
        ref="topbar"
        class="pdf-topbar paper-actions"
        :class="{ compact: topbarCompact, stacked: topbarStacked }"
        role="toolbar"
        :aria-label="t('reader.toolbar')"
      >
        <div class="topbar-start">
          <button type="button" class="top-icon document-back" :title="backLabel" :aria-label="backLabel" @click="router.push(backTarget)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <button
            type="button"
            class="top-icon"
            :class="{ on: drawerOpen }"
            :title="t('reader.toc')"
            :aria-label="t('reader.toc')"
            :aria-pressed="drawerOpen"
            @click="toggleSidebar"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15M6 8.5h1M6 11.5h1" /></svg>
          </button>
          <div class="paper-title topbar-title">
            <strong :title="meta?.title">{{ meta?.title }}</strong>
            <span>{{ t('reader.documentMeta', { total: pageCount, current: currentPage }) }}</span>
          </div>
        </div>

        <div class="topbar-center">
          <div class="top-cluster" role="group" :aria-label="t('reader.pageNavigation')">
            <button type="button" class="top-icon" :title="`${t('reader.prevPage')} (←)`" :aria-label="t('reader.prevPage')" :disabled="atFirstPage" @click="prevPage">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 17l-5-5 5-5" /></svg>
            </button>
            <span class="paper-pagenum">
              <input
                v-model="pageInput"
                class="page-input"
                name="page"
                inputmode="numeric"
                autocomplete="off"
                spellcheck="false"
                :aria-label="t('common.current')"
                @focus="($event.target as HTMLInputElement).select()"
                @keyup.enter="jumpTo"
                @blur="jumpTo"
              />
              <span>/ {{ pageCount }}</span>
            </span>
            <button type="button" class="top-icon" :title="`${t('reader.nextPage')} (→)`" :aria-label="t('reader.nextPage')" :disabled="atLastPage" @click="nextPage">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 7l5 5-5 5" /></svg>
            </button>
          </div>
          <div v-if="pdfLayout === 'original'" class="top-cluster" role="group" :aria-label="t('reader.zoomLevel')">
            <button
              type="button"
              class="top-icon"
              :title="`${t('reader.zoomOut')} (${primaryShortcutLabel} −)`"
              :aria-label="t('reader.zoomOut')"
              :disabled="typeof zoom === 'number' && zoom <= SUMATRA_ZOOM_LEVELS[0] + 0.0001"
              @click="zoomStep(-1)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" /></svg>
            </button>
            <span class="cluster-div" aria-hidden="true" />
            <button
              ref="zoomTrigger"
              type="button"
              class="dock-zoom"
              :class="{ open: zoomMenu }"
              :title="t('reader.zoomLevel')"
              aria-haspopup="menu"
              :aria-expanded="zoomMenu"
              @click="toggleZoomMenu"
            >
              <span>{{ zoom === 'fit-page' ? t('reader.fitPage') : zoom === 'fit-width' ? t('reader.fitWidth') : zoomPercentLabel(zoom as number) }}</span>
              <svg class="top-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <span class="cluster-div" aria-hidden="true" />
            <button
              type="button"
              class="top-icon"
              :title="`${t('reader.zoomIn')} (${primaryShortcutLabel} +)`"
              :aria-label="t('reader.zoomIn')"
              :disabled="typeof zoom === 'number' && zoom >= SUMATRA_ZOOM_LEVELS[SUMATRA_ZOOM_LEVELS.length - 1] - 0.0001"
              @click="zoomStep(1)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12" /></svg>
            </button>
          </div>
          <button
            v-else
            ref="typographyTrigger"
            type="button"
            class="dock-zoom top-cluster"
            :class="{ open: typographyOpen }"
            :title="t('reader.typography')"
            aria-haspopup="dialog"
            :aria-expanded="typographyOpen"
            @click="toggleTypographyPopover"
          >
            <span>Aa · {{ settings.readerPrefs.fontSize }}</span>
            <svg class="top-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>

        <div class="topbar-end">
          <button
            ref="viewTrigger"
            type="button"
            class="top-btn view-trigger"
            :class="{ open: viewPanelOpen }"
            :title="t('reader.viewOptions')"
            aria-haspopup="dialog"
            :aria-expanded="viewPanelOpen"
            @click="toggleViewPanel"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="7" height="14" rx="1.5" /><rect x="13.5" y="5" width="7" height="14" rx="1.5" /></svg>
            <span class="top-label">{{ t('reader.view') }}</span>
            <svg class="top-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <template v-if="!topbarNarrow">
            <button
              type="button"
              class="top-btn reader-tool"
              :class="{ active: ttsState !== 'stopped' || ttsPanel }"
              :aria-pressed="ttsState !== 'stopped' || ttsPanel"
              :title="t('tts.title')"
              @click="openTTSPanel"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3.5" y="13.5" width="4" height="6" rx="1.5" /><rect x="16.5" y="13.5" width="4" height="6" rx="1.5" /></svg>
              <span class="top-label">{{ ttsState !== 'stopped' ? t('tts.readingNow') : t('tts.title') }}</span>
            </button>
            <button
              type="button"
              class="top-btn reader-tool"
              :class="{ active: autoReading || autoPanel }"
              :aria-pressed="autoReading || autoPanel"
              :title="autoReading && !autoPanel ? t('reader.expandAutoControls') : t('reader.autoRead')"
              @click="toggleAutoPanel"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M10.5 9l4.5 3-4.5 3z" /></svg>
              <span class="top-label">{{ autoReading ? t('reader.autoReading') : t('reader.autoRead') }}</span>
            </button>
          </template>
          <span class="topbar-sep" aria-hidden="true" />
          <button
            type="button"
            class="top-icon"
            :class="{ on: pdfSearchOpen }"
            :title="`${t('reader.searchInBook')} (${primaryShortcutLabel} F)`"
            :aria-label="t('reader.searchInBook')"
            :aria-pressed="pdfSearchOpen"
            @click="pdfSearchOpen ? closePdfSearch() : openPdfSearch()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
          </button>
          <button
            v-if="isPaper"
            type="button"
            class="top-btn top-accent"
            :class="{ open: translateOpen }"
            :title="t('paper.openTranslate')"
            :disabled="!pageCount"
            @click="openRight('translate')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h9M8.5 4v1.5M6 5.5c.6 3 2.6 5.4 5.5 6.6M11 5.5c-.7 3.3-2.9 6-6.5 7.5M12.5 20l3.75-9 3.75 9M13.8 17h4.9" /></svg>
            <span>{{ t('paper.openTranslate') }}</span>
          </button>
          <div class="reader-more-wrap">
            <button
              type="button"
              class="top-icon"
              :class="{ on: moreMenu }"
              :title="t('reader.moreActions')"
              :aria-label="t('reader.moreActions')"
              aria-haspopup="menu"
              :aria-expanded="moreMenu"
              @click="toggleMoreMenu"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r=".9" /><circle cx="12" cy="12" r=".9" /><circle cx="18" cy="12" r=".9" /></svg>
            </button>
            <div v-if="moreMenu" class="reader-more-backdrop" @click="moreMenu = false" />
            <div v-if="moreMenu" class="top-menu card" role="menu" @keydown.esc.stop="moreMenu = false">
              <template v-if="topbarNarrow">
                <button type="button" role="menuitem" @click="runFromToolbarPopover(openTTSPanel)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3.5" y="13.5" width="4" height="6" rx="1.5" /><rect x="16.5" y="13.5" width="4" height="6" rx="1.5" /></svg>
                  <span>{{ ttsState !== 'stopped' ? t('tts.readingNow') : t('tts.title') }}</span>
                </button>
                <button type="button" role="menuitem" @click="runFromToolbarPopover(toggleAutoPanel)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M10.5 9l4.5 3-4.5 3z" /></svg>
                  <span>{{ autoReading ? t('reader.autoReading') : t('reader.autoRead') }}</span>
                </button>
                <span class="top-menu-div" role="separator" />
              </template>
              <template v-if="isPaper && bdSupported">
                <button type="button" role="menuitem" :title="t('paper.bdTooltip')" @click="runFromToolbarPopover(openBabeldoc)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h9M8.5 4v1.5M6 5.5c.6 3 2.6 5.4 5.5 6.6M11 5.5c-.7 3.3-2.9 6-6.5 7.5M12.5 20l3.75-9 3.75 9M13.8 17h4.9" /></svg>
                  <span>{{ t('paper.bdButton') }}</span>
                </button>
                <span class="top-menu-div" role="separator" />
              </template>
              <button type="button" role="menuitem" @click="runFromToolbarPopover(() => router.push(backTarget))">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11l-3-3M17 17H6l3 3" /></svg>
                <span>{{ t('reader.changeDocument') }}</span>
              </button>
              <button type="button" role="menuitem" @click="runFromToolbarPopover(printDocument)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V4h10v5M7 17H5a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 5 9h14a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 19 17h-2M7 14h10v6H7z" /></svg>
                <span>{{ t('reader.print') }}</span>
                <kbd aria-hidden="true">{{ primaryShortcutLabel }} P</kbd>
              </button>
              <button type="button" role="menuitem" @click="runFromToolbarPopover(saveDocumentAs)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" /></svg>
                <span>{{ t('reader.saveAs') }}</span>
                <kbd aria-hidden="true">{{ primaryShortcutLabel }} S</kbd>
              </button>
              <button type="button" role="menuitem" @click="runFromToolbarPopover(openDocumentFolder)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" /></svg>
                <span>{{ t('reader.openFolder') }}</span>
              </button>
              <button type="button" role="menuitem" @click="runFromToolbarPopover(openProperties)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></svg>
                <span>{{ t('reader.properties') }}</span>
              </button>
              <button type="button" role="menuitem" @click="runFromToolbarPopover(() => toggleDrawerTab('annotations'))">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14v10H9.5L5 19z" /></svg>
                <span>{{ t('reader.comments') }}</span>
              </button>
              <span class="top-menu-div" role="separator" />
              <button
                type="button"
                role="menuitemcheckbox"
                :aria-checked="settings.reader.portraitScroll"
                :title="t('reader.portraitScrollTitle')"
                @click="settings.reader.portraitScroll = !settings.reader.portraitScroll; moreMenu = false"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3.5" width="10" height="17" rx="2" /><path d="M11 17.5h2" /></svg>
                <span>{{ t('reader.portraitScrollMenu') }}</span>
                <svg v-if="settings.reader.portraitScroll" class="top-menu-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              </button>
              <button type="button" role="menuitem" @click="runFromToolbarPopover(toggleShortcutGuide)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6.5" width="18" height="11" rx="2" /><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8" /></svg>
                <span>{{ t('reader.keyboardShortcuts') }}</span>
                <kbd aria-hidden="true">?</kbd>
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- 桌面顶栏弹层: fixed 定位在触发按钮正下方 (popoverAnchor) -->
    <div v-if="zoomMenu && pdfLayout === 'original'" class="zoom-backdrop" @click="zoomMenu = false" />
    <div
      v-if="zoomMenu && pdfLayout === 'original'"
      ref="zoomMenuEl"
      class="zoom-menu toolbar-popover card"
      role="menu"
      :aria-label="t('reader.zoomLevel')"
      :style="{ top: `${popoverAnchor.top}px`, left: `${popoverAnchor.left}px`, width: `${ZOOM_MENU_WIDTH}px` }"
      @keydown="onZoomMenuKeydown"
    >
      <div class="popover-heading">{{ t('reader.zoomLevel') }}</div>
      <div class="zoom-grid">
        <button
          v-for="p in ZOOM_MENU_PRESETS"
          :key="p"
          type="button"
          role="menuitemradio"
          tabindex="-1"
          class="zoom-item"
          :class="{ active: typeof zoom === 'number' && Math.abs((zoom as number) - p) < 0.001 }"
          :aria-checked="typeof zoom === 'number' && Math.abs((zoom as number) - p) < 0.001"
          @click="pickZoom(p)"
        >{{ zoomPercentLabel(p) }}</button>
      </div>
      <span class="popover-divider" role="separator" />
      <button
        type="button"
        role="menuitemradio"
        tabindex="-1"
        class="zoom-item zoom-fit"
        :class="{ active: zoom === 'fit-page' }"
        :aria-checked="zoom === 'fit-page'"
        @click="pickZoom('fit-page')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3.5" width="10" height="17" rx="1.5" /><path d="M12 7v10M10 9l2-2 2 2M10 15l2 2 2-2" /></svg>
        <span>{{ t('reader.fitPage') }}</span>
        <svg v-if="zoom === 'fit-page'" class="zoom-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </button>
      <button
        type="button"
        role="menuitemradio"
        tabindex="-1"
        class="zoom-item zoom-fit"
        :class="{ active: zoom === 'fit-width' }"
        :aria-checked="zoom === 'fit-width'"
        @click="pickZoom('fit-width')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="12" rx="1.5" /><path d="M7 12h10M9 10l-2 2 2 2M15 10l2 2-2 2" /></svg>
        <span>{{ t('reader.fitWidth') }}</span>
        <svg v-if="zoom === 'fit-width'" class="zoom-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </button>
      <p class="zoom-hint">
        <span>{{ t('reader.zoomWheelHint', { key: primaryShortcutLabel }) }}</span>
        <span><kbd>{{ primaryShortcutLabel }}</kbd> <kbd>0</kbd> {{ t('reader.zoomResetHint') }}</span>
      </p>
    </div>

    <div v-if="viewPanelOpen" class="zoom-backdrop" @click="viewPanelOpen = false" />
    <section
      v-if="viewPanelOpen"
      ref="viewPanelEl"
      class="view-panel toolbar-popover card"
      role="dialog"
      :aria-label="t('reader.viewOptions')"
      :style="{ top: `${popoverAnchor.top}px`, left: `${popoverAnchor.left}px`, width: `${VIEW_PANEL_WIDTH}px` }"
      @keydown="onViewPanelKeydown"
    >
      <div class="view-section" role="group" :aria-label="t('reader.mode')">
        <h3>{{ t('reader.mode') }}</h3>
        <div class="view-choices two">
          <button type="button" class="view-choice" :class="{ active: mode === 'scroll' }" :aria-pressed="mode === 'scroll'" @click="switchMode('scroll')">
            <svg viewBox="0 0 44 30" aria-hidden="true"><rect class="fill" x="14" y="-6" width="16" height="16" rx="1.5" /><rect class="fill" x="14" y="13" width="16" height="16" rx="1.5" /><path d="M38 6v18M36 21l2 3 2-3" /></svg>
            <span>{{ t('reader.scrolled') }}</span>
          </button>
          <button type="button" class="view-choice" :class="{ active: mode === 'paged' }" :aria-pressed="mode === 'paged'" @click="switchMode('paged')">
            <svg viewBox="0 0 44 30" aria-hidden="true"><rect class="fill" x="13" y="3" width="18" height="24" rx="1.5" /><path d="M6 15h3M7.5 13.5 6 15l1.5 1.5M38 15h-3M36.5 13.5 38 15l-1.5 1.5" /></svg>
            <span>{{ t('reader.paginated') }}</span>
          </button>
        </div>
      </div>
      <!-- 竖屏锁定单页滚动时对页 / 书籍视图不生效 -->
      <div v-if="!pdfEffective.portraitLocked" class="view-section" role="group" :aria-label="t('reader.pageView')">
        <h3>{{ t('reader.pageView') }}</h3>
        <div class="view-choices three">
          <button type="button" class="view-choice" :class="{ active: spreadMode === 'single' }" :aria-pressed="spreadMode === 'single'" @click="setSpreadMode('single')">
            <svg viewBox="0 0 44 30" aria-hidden="true"><rect class="fill" x="13" y="3" width="18" height="24" rx="1.5" /></svg>
            <span>{{ t('reader.singlePage') }}</span>
          </button>
          <button type="button" class="view-choice" :class="{ active: spreadMode === 'facing' }" :aria-pressed="spreadMode === 'facing'" @click="setSpreadMode('facing')">
            <svg viewBox="0 0 44 30" aria-hidden="true"><rect class="fill" x="4" y="3" width="17" height="24" rx="1.5" /><rect class="fill" x="23" y="3" width="17" height="24" rx="1.5" /></svg>
            <span>{{ t('reader.facingPages') }}</span>
          </button>
          <button type="button" class="view-choice" :class="{ active: spreadMode === 'book' }" :aria-pressed="spreadMode === 'book'" @click="setSpreadMode('book')">
            <svg viewBox="0 0 44 30" aria-hidden="true"><path class="fill" d="M22 6c-5-3-11-3-17-1.5v21.5c6-1.5 12-1.5 17 1.5zM22 6c5-3 11-3 17-1.5v21.5c-6-1.5-12-1.5-17 1.5z" /></svg>
            <span>{{ t('reader.bookView') }}</span>
          </button>
        </div>
      </div>
      <div class="view-section" role="group" :aria-label="t('reader.pageFit')">
        <h3>{{ t('reader.pageFit') }}</h3>
        <div class="view-segment">
          <button type="button" :class="{ active: zoom === 'fit-page' }" :aria-pressed="zoom === 'fit-page'" @click="setPagedFit('fitH')">{{ t('reader.fitHeight') }}</button>
          <button type="button" :class="{ active: zoom === 'fit-width' }" :aria-pressed="zoom === 'fit-width'" @click="setPagedFit('fitW')">{{ t('reader.fitWidth') }}</button>
        </div>
      </div>
      <div class="view-actions">
        <button type="button" :aria-label="`${t('reader.fullscreen')} (F)`" @click="runFromToolbarPopover(toggleFullscreen)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /></svg>
          <span>{{ t('reader.fullscreen') }}</span>
          <kbd aria-hidden="true">F</kbd>
        </button>
        <button type="button" :aria-label="`${t('reader.slideshow')} (F5)`" @click="runFromToolbarPopover(enterPresentation)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="11" rx="1.5" /><path d="M12 15.5V20M8.5 20h7M10.5 8.2v4.6l3.8-2.3z" /></svg>
          <span>{{ t('reader.slideshow') }}</span>
          <kbd aria-hidden="true">F5</kbd>
        </button>
        <button v-if="stealthAvailable" type="button" :title="t('stealth.enterHint')" @click="runFromToolbarPopover(toggleStealth)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 7c3.2 0 5.9 1.5 7.5 3.7L22 9v6l-1.5-1.7C18.9 15.5 16.2 17 13 17c-4.3 0-8-2.1-10-5 2-2.9 5.7-5 10-5z" /><circle cx="7.5" cy="12" r=".9" /></svg>
          <span>{{ t('stealth.enter') }}</span>
        </button>
      </div>
    </section>

    <button
      v-if="isFullscreen && !presentationMode && !tocOpen"
      class="fullscreen-toc-toggle"
      :title="t('reader.toc')"
      :aria-label="t('reader.toc')"
      @click="setDrawerTab('toc')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h9" /></svg>
      <span>{{ t('reader.toc') }}</span>
    </button>

    <button
      v-if="isFullscreen"
      class="fullscreen-exit"
      :title="presentationMode ? t('reader.exitSlideshow') : t('reader.exitFullscreen')"
      :aria-label="presentationMode ? t('reader.exitSlideshow') : t('reader.exitFullscreen')"
      @click="presentationMode ? exitPresentation() : setFullscreen(false)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
      <span>{{ presentationMode ? t('reader.exitSlideshow') : t('reader.exitFullscreen') }}</span>
    </button>

    <div v-if="presentationMode" class="presentation-controls" aria-live="polite">
      <button :disabled="atFirstPage" :aria-label="t('reader.prevPage')" @click="prevPage">‹</button>
      <span>{{ currentPage }} / {{ pageCount }}</span>
      <button :disabled="atLastPage" :aria-label="t('reader.nextPage')" @click="nextPage">›</button>
    </div>

    <!-- 文件属性: AppModal 负责 Esc / 焦点回到入口 / 内容区滚动, 底部按钮始终可见 -->
    <AppModal v-if="propertiesOpen" :title="t('reader.propertiesTitle')" description="PDF" @close="propertiesOpen = false">
      <div class="document-dialog">
        <dl class="document-props">
          <template v-for="row in propertyRows" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </template>
        </dl>
        <footer class="document-props-actions">
          <button class="btn btn-sm" @click="propertiesOpen = false">{{ t('common.done') }}</button>
        </footer>
      </div>
    </AppModal>

    <!-- BabelDOC 整本重排版翻译面板 -->
    <div v-if="bd.open" class="bd-mask" @click.self="closeBabeldoc">
      <div class="bd-panel">
        <h3>{{ t('paper.bdTitle') }}</h3>
        <p class="bd-sub">{{ t('paper.bdDesc') }}</p>

        <p v-if="bd.phase === 'checking'" class="bd-line">{{ t('paper.bdChecking') }}</p>

        <template v-else-if="bd.phase === 'notfound'">
          <p class="bd-line">{{ t('paper.bdNotFound') }}</p>
          <div class="bd-cmd">
            <code>{{ INSTALL_CMD }}</code>
            <button class="btn btn-sm" @click="copyInstall">{{ t('paper.bdCopy') }}</button>
          </div>
          <p class="bd-hint">{{ t('paper.bdInstallHint') }}</p>
          <div class="bd-actions">
            <button class="btn btn-sm" @click="checkBabeldoc">{{ t('paper.bdRecheck') }}</button>
          </div>
        </template>

        <template v-else-if="bd.phase === 'ready'">
          <p class="bd-ok">✓ {{ bd.status?.version || 'babeldoc' }}</p>
          <p v-if="!bdProviderOk" class="bd-warn">{{ t('paper.bdTrialUnsupported') }}</p>
          <label class="bd-field">
            {{ t('paper.bdTargetLanguage') }}
            <AppSelect v-model="bd.targetLanguage" class="input" :aria-label="t('paper.bdTargetLanguage')" @change="onBdTargetLanguageChange">
              <option
                v-for="language in BABELDOC_TARGET_LANGUAGES"
                :key="language.code"
                :value="language.code"
              >
                {{ t(language.labelKey) }}
              </option>
            </AppSelect>
          </label>
          <section v-if="isPaper" class="bd-context">
            <div class="bd-context-head">
              <div>
                <strong>{{ t('paper.bdContextTitle') }}</strong>
                <span class="bd-context-source">{{ bdContextSourceLabel }}</span>
              </div>
              <span v-if="bdContext.approved" class="bd-approved">✓ {{ t('paper.bdContextApproved') }}</span>
            </div>
            <p class="bd-hint">{{ t('paper.bdContextDesc') }}</p>
            <div class="bd-context-tools">
              <button class="btn btn-sm" type="button" @click="useAbstractForBdContext">
                {{ t('paper.bdUseAbstract') }}
              </button>
            </div>
            <label class="bd-context-field">
              <span>{{ t('paper.bdContextSource') }}</span>
              <textarea
                v-model="bdContext.source"
                class="input"
                rows="4"
                :maxlength="PAPER_CONTEXT_SOURCE_CHAR_LIMIT"
                :placeholder="t('paper.bdContextSourcePh')"
                @input="onBdContextSourceInput"
              />
            </label>
            <p v-if="bdContext.error" class="bd-warn">{{ bdContext.error }}</p>
            <div class="bd-context-tools bd-context-generate">
              <button
                class="btn btn-sm"
                type="button"
                :disabled="!aiReady || !bdContext.source.trim() || bdContext.busy"
                @click="generateBdContext"
              >
                {{ bdContext.busy ? t('paper.bdGeneratingContext') : t('paper.bdGenerateContext') }}
              </button>
            </div>
            <div v-if="bdContext.english || bdContext.translation" class="bd-context-review">
              <p class="bd-hint">{{ t('paper.bdContextReviewHint') }}</p>
              <label class="bd-context-field">
                <span>{{ t('paper.bdEnglishContext') }}</span>
                <textarea v-model="bdContext.english" class="input" rows="5" :maxlength="PAPER_CONTEXT_REFERENCE_CHAR_LIMIT" @input="markBdContextDirty" />
              </label>
              <label class="bd-context-field">
                <span>{{ t('paper.bdTargetContext', { language: t(bdTargetLanguage.labelKey) }) }}</span>
                <textarea v-model="bdContext.translation" class="input" rows="5" :maxlength="PAPER_CONTEXT_REFERENCE_CHAR_LIMIT" @input="markBdContextDirty" />
              </label>
            </div>
          </section>
          <label class="bd-field">
            {{ t('paper.bdPages') }}
            <input v-model="bd.pages" class="input" :placeholder="t('paper.bdPagesPh')" />
          </label>
          <p class="bd-hint">{{ t('paper.bdTimeHint') }}</p>
          <div class="bd-actions">
            <button
              class="btn btn-sm btn-primary"
              :disabled="!bdProviderOk || !aiReady || bdContext.busy || !bdContextReady"
              @click="startBabeldoc"
            >
              {{ isPaper ? t('paper.bdConfirmStart') : t('paper.bdStart') }}
            </button>
          </div>
        </template>

      </div>
    </div>

    <div v-if="loading" class="paper-state">{{ t('reader.opening') }}</div>
    <div v-else-if="error" class="paper-state">
      <p>{{ error }}</p>
      <button v-if="pdfEngineCrashed" class="btn" @click="exportDiagnosticsFromError">{{ t('settings.diagnosticsExport') }}</button>
      <button class="btn" @click="router.push(backTarget)">{{ backLabel }}</button>
    </div>

    <div v-else class="paper-split">
      <!-- 目录 / 缩略图 / 标注复用稳定侧栏，切换内容时正文宽度不反复跳动。 -->
      <aside
        v-show="drawerOpen"
        class="side-drawer"
        :class="{ 'fullscreen-toc-drawer': isFullscreen && tocOpen && !presentationMode }"
      >
        <div class="drawer-head">
          <div class="drawer-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              :class="{ active: tocOpen }"
              :aria-selected="tocOpen"
              @click="setDrawerTab('toc')"
            >{{ t('reader.toc') }}</button>
            <button
              v-if="!isFullscreen"
              type="button"
              role="tab"
              :class="{ active: thumbnailOpen }"
              :aria-selected="thumbnailOpen"
              @click="setDrawerTab('thumbnails')"
            >{{ t('reader.thumbnails') }}</button>
            <button
              v-if="!isFullscreen"
              type="button"
              role="tab"
              :class="{ active: annoOpen }"
              :aria-selected="annoOpen"
              @click="setDrawerTab('annotations')"
            >{{ t('reader.highlightsTab') }}</button>
          </div>
          <button class="icon-btn" :title="t('common.close')" @click="closeDrawer" :aria-label="t('common.close')"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
        </div>
        <div v-show="tocOpen" class="drawer-body">
          <TocList
            v-if="tocItems.length"
            :items="tocItems"
            :current-href="currentTocHref"
            @navigate="tocNavigate"
          />
          <p v-else class="drawer-empty">{{ t('paper.noOutline') }}</p>
        </div>
        <div
          v-show="thumbnailOpen"
          ref="thumbnailScroller"
          class="drawer-body thumbnail-drawer"
          role="tabpanel"
        >
          <button
            v-for="pageNum in pageCount"
            :key="pageNum"
            type="button"
            class="thumbnail-item"
            :class="{ active: currentPage === pageNum }"
            :data-thumbnail-page="pageNum"
            :aria-current="currentPage === pageNum ? 'page' : undefined"
            :aria-label="t('reader.thumbnailPage', { page: pageNum })"
            @click="thumbnailNavigate(pageNum)"
          >
            <span class="thumbnail-sheet" :style="thumbnailFrameStyle(pageNum)">
              <span class="thumbnail-skeleton" aria-hidden="true" />
              <span class="thumbnail-canvas" />
            </span>
            <span class="thumbnail-number">{{ pageNum }}</span>
          </button>
        </div>
        <div v-show="annoOpen" class="drawer-body">
          <p class="drawer-count">{{ t('reader.highlightsTab') }} · {{ highlights.length }}</p>
          <div v-for="a in sortedHighlights" :key="a.id" class="anno-item" @click="gotoAnnotation(a)">
            <span class="anno-dot" :style="{ background: HIGHLIGHT_COLORS[a.color] ?? a.color }" />
            <div class="anno-main">
              <p class="anno-text">{{ a.text }}</p>
              <p v-if="a.note" class="anno-note">{{ a.note }}</p>
              <span class="anno-page">P{{ decodeLoc(a.cfi)?.page }}</span>
            </div>
            <button class="icon-btn anno-act" :title="t('notes.copyOne')" :aria-label="t('notes.copyOne')" @click.stop="notes.copyOne(a)"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 3h9a2 2 0 0 1 2 2v11h-2V5H8V3zM5 7h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v11h9V9H5z"/></svg></button>
            <button class="icon-btn anno-act" :title="t('notes.makeCard')" :aria-label="t('notes.makeCard')" @click.stop="notes.cardFromAnnotation(a)"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h12V5H6zm2.6 3.2c.5-.6 1.3-1 2.1-1.1l.3 1.3c-.5.1-.9.4-1.1.8.9.2 1.5 1 1.5 1.9a2 2 0 0 1-2.1 2c-1.2 0-2-1-2-2.3 0-1 .4-1.9 1.3-2.6zm5 0c.5-.6 1.3-1 2.1-1.1l.3 1.3c-.5.1-.9.4-1.1.8.9.2 1.5 1 1.5 1.9a2 2 0 0 1-2.1 2c-1.2 0-2-1-2-2.3 0-1 .4-1.9 1.3-2.6zM8 15h8v2H8v-2z"/></svg></button>
            <button class="icon-btn anno-del" :title="t('reader.deleteHighlight')" @click.stop="removeAnnotation(a)" :aria-label="t('reader.deleteHighlight')"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
          </div>
          <p v-if="!highlights.length" class="drawer-empty">{{ t('reader.highlightEmptyHint') }}</p>
          <div v-if="highlights.length" class="anno-foot">
            <button class="btn btn-sm btn-primary anno-copy-all" @click="notes.copyAll()">{{ t('notes.copyAll', { n: highlights.length }) }}</button>
            <button class="btn btn-sm" @click="notes.openExport()">{{ t('notes.export') }}</button>
          </div>
        </div>
      </aside>

      <!-- 左: 原文 PDF 连续滚动 (划词 / 高亮 / 链接跳转) + 底部悬浮工具条 -->
      <div class="pane-left-wrap">
        <section v-if="pdfSearchOpen" class="pdf-search card" role="search">
          <svg class="pdf-search-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 1 0 4.55 13.46l3.75 3.75a1 1 0 0 0 1.4-1.42l-3.74-3.74A7.5 7.5 0 0 0 10.5 3zM5 10.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z"/></svg>
          <input
            ref="pdfSearch.pdfSearchInput"
            v-model="pdfSearchQuery"
            class="pdf-search-input"
            type="search"
            :placeholder="t('reader.searchPdfPlaceholder')"
            @input="schedulePdfSearch"
            @keydown="onPdfSearchKeydown"
          />
          <button
            type="button"
            class="pdf-search-option"
            :class="{ active: pdfSearchMatchCase }"
            :title="t('reader.matchCase')"
            :aria-pressed="pdfSearchMatchCase"
            @click="togglePdfSearchOption('case')"
          >Aa</button>
          <button
            type="button"
            class="pdf-search-option pdf-search-whole"
            :class="{ active: pdfSearchWholeWord }"
            :title="t('reader.wholeWord')"
            :aria-pressed="pdfSearchWholeWord"
            @click="togglePdfSearchOption('word')"
          >ab</button>
          <span class="pdf-search-status">{{ pdfSearchStatus }}</span>
          <button
            type="button"
            :title="t('reader.previousResult')"
            :disabled="!pdfSearchResults.length"
            @click="activatePdfSearchHit(pdfSearchActive - 1)"
          >↑</button>
          <button
            type="button"
            :title="t('reader.nextResult')"
            :disabled="!pdfSearchResults.length"
            @click="activatePdfSearchHit(pdfSearchActive + 1)"
          >↓</button>
          <button type="button" :title="t('reader.closeSearch')" @click="closePdfSearch">×</button>
        </section>

        <!-- 流式阅读：复用 PDF 文本层与阅读偏好，按原页保留跳转锚点。 -->
        <div
          v-if="pdfLayout === 'reflow'"
          ref="reflowScroller"
          class="reflow-scroll"
          :style="reflowStyle"
          @scroll.passive="onReflowScroll"
        >
          <div v-if="reflowBuilding" class="reflow-progress">
            {{ t('reader.reflowBuilding', { current: reflowProcessed, total: pageCount }) }}
          </div>
          <article v-if="reflowPages.length" class="reflow-article">
            <section
              v-for="page in reflowPages"
              :key="page.page"
              class="reflow-page"
              :data-reflow-page="page.page"
            >
              <button class="reflow-page-link" @click="openOriginalPage(page.page)">
                {{ t('reader.originalPage', { page: page.page }) }}
              </button>
              <template v-for="p in page.paras" :key="p.id">
                <h2 v-if="isReflowHeading(p)" class="reflow-heading">{{ p.text }}</h2>
                <p v-else>{{ p.text }}</p>
              </template>
            </section>
          </article>
          <div v-else-if="reflowBuilt || reflowError" class="reflow-empty">
            <strong>{{ t('reader.reflowNoText') }}</strong>
            <span>{{ t('reader.reflowNoTextHint') }}</span>
            <small v-if="reflowError">{{ reflowError }}</small>
            <button class="btn btn-sm" @click="switchPdfLayout('original')">{{ t('reader.originalPdf') }}</button>
          </div>
        </div>

        <!-- 藏书默认翻页适高；双页时显示当前 1-2 / 3-4 页组。 -->
        <div
          v-else-if="bookPaged"
          ref="pagedBox"
          class="paged-box"
          :class="{ 'is-fit-width': zoom === 'fit-width', 'is-fit-height': zoom === 'fit-page' }"
          @pointerdown="onScrollerPointerDown"
          @dblclick="onScrollerDblClick"
          @wheel="onPdfWheel"
          @touchstart="onPdfTouchStart"
          @touchmove="onPdfTouchMove"
          @touchend="onPdfTouchEnd"
          @scroll.passive="scheduleCurrentTocPositionUpdate"
          @contextmenu.prevent
        >
          <div class="spread-host">
            <div
              v-for="n in pagedPages"
              :key="n"
              class="p-holder"
              :data-page="n"
              :style="holderStyleFor(n)"
              @click="onHolderClick($event, n)"
            >
              <span class="p-num">{{ n }}</span>
              <div class="p-canvas" />
              <div class="p-search">
                <div
                  v-for="match in pdfSearchRectsByPage.get(n) ?? []"
                  :key="match.key"
                  class="p-search-rect"
                  :class="{ active: match.active }"
                  :style="pdfSearchRectStyle(n, match.rect)"
                />
              </div>
              <div class="p-hl">
                <div v-for="h in pageHls.get(n) ?? []" :key="h.key" class="p-hl-rect" :style="hlStyle(n, h.r, h.a.color)" />
              </div>
              <div v-if="liveRects && liveRects.page === n" class="p-sel">
                <div
                  v-for="(r, i) in liveRects.rects"
                  :key="i"
                  class="p-sel-rect"
                  :style="liveRectStyle(n, r)"
                />
              </div>
              <div class="p-links" />
            </div>
          </div>
        </div>

        <div
          v-else
          ref="scroller"
          class="pane pane-left"
          :class="{ 'is-fit-width': zoom === 'fit-width', 'is-fit-height': zoom === 'fit-page' }"
          @pointerdown="onScrollerPointerDown"
          @dblclick="onScrollerDblClick"
          @wheel="onPdfWheel"
          @touchstart="onPdfTouchStart"
          @touchmove="onPdfTouchMove"
          @touchend="onPdfTouchEnd"
          @contextmenu.prevent
        >
          <div v-for="group in scrollPageGroups" :key="group.join('-')" class="scroll-spread-host">
            <div
              v-for="n in group"
              :key="n"
              class="p-holder"
              :data-page="n"
              :style="holderStyleFor(n)"
              @click="onHolderClick($event, n)"
            >
              <span class="p-num">{{ n }}</span>
              <div class="p-canvas" />
              <div class="p-search">
                <div
                  v-for="match in pdfSearchRectsByPage.get(n) ?? []"
                  :key="match.key"
                  class="p-search-rect"
                  :class="{ active: match.active }"
                  :style="pdfSearchRectStyle(n, match.rect)"
                />
              </div>
              <div class="p-hl">
                <div v-for="h in pageHls.get(n) ?? []" :key="h.key" class="p-hl-rect" :style="hlStyle(n, h.r, h.a.color)" />
              </div>
              <!-- PDFium 几何选区 -->
              <div v-if="liveRects && liveRects.page === n" class="p-sel">
                <div
                  v-for="(r, i) in liveRects.rects"
                  :key="i"
                  class="p-sel-rect"
                  :style="liveRectStyle(n, r)"
                />
              </div>
              <div class="p-links" />
            </div>
          </div>
        </div>

        <div v-if="shortcutsOpen" class="zoom-backdrop" @click="shortcutsOpen = false" />
        <section
          v-if="shortcutsOpen"
          ref="shortcutMenu"
          class="shortcut-menu card"
          role="dialog"
          tabindex="0"
          :aria-label="t('reader.keyboardShortcuts')"
          @keydown="onShortcutGuideKeydown"
        >
          <header class="shortcut-head">
            <strong>{{ t('reader.keyboardShortcuts') }}</strong>
            <button class="icon-btn" :aria-label="t('common.close')" @click="shortcutsOpen = false">×</button>
          </header>
          <div v-for="row in shortcutRows" :key="row.id" class="shortcut-row">
            <span class="shortcut-keys">
              <template v-for="(combo, comboIndex) in row.shortcuts" :key="combo.join('-')">
                <span v-if="comboIndex" class="shortcut-or">/</span>
                <span class="shortcut-combo">
                  <template v-for="(key, keyIndex) in combo" :key="key">
                    <span v-if="keyIndex" class="shortcut-plus">+</span>
                    <kbd>{{ key }}</kbd>
                  </template>
                </span>
              </template>
            </span>
            <span>{{ row.label }}</span>
          </div>
        </section>

        <div v-if="typographyOpen && pdfLayout === 'reflow'" class="zoom-backdrop" @click="typographyOpen = false" />
        <div
          v-if="typographyOpen && pdfLayout === 'reflow'"
          class="reflow-settings toolbar-popover card"
          role="dialog"
          :aria-label="t('reader.typography')"
          :style="{ top: `${popoverAnchor.top}px`, left: `${popoverAnchor.left}px` }"
          @keydown.esc.stop="typographyOpen = false; typographyTrigger?.focus()"
        >
          <label>
            <span>{{ t('reader.fontSize') }}</span>
            <input :value="settings.readerPrefs.fontSize" @input="settings.setReaderPreference('fontSize', Number(($event.target as HTMLInputElement).value))" type="range" min="12" max="36" step="1" />
            <strong>{{ settings.readerPrefs.fontSize }}</strong>
          </label>
          <label>
            <span>{{ t('reader.lineHeight') }}</span>
            <input :value="settings.readerPrefs.lineHeight" @input="settings.setReaderPreference('lineHeight', Number(($event.target as HTMLInputElement).value))" type="range" min="1.2" max="2.6" step="0.1" />
            <strong>{{ settings.readerPrefs.lineHeight.toFixed(1) }}</strong>
          </label>
          <label>
            <span>{{ t('reader.font') }}</span>
            <AppSelect v-model="settings.reader.fontFamily" class="input" :aria-label="t('reader.font')">
              <option v-for="font in FONT_FAMILIES" :key="font.value" :value="font.value">{{ t(font.labelKey) }}</option>
              <option v-for="font in settings.customFonts" :key="font.file" :value="`custom:${font.name}`">{{ font.name }}</option>
            </AppSelect>
          </label>
          <div class="reflow-theme-row">
            <span>{{ t('reader.theme') }}</span>
            <button
              v-for="choice in READER_THEME_CHOICES"
              :key="choice.name"
              :class="{ active: settings.reader.theme === choice.name }"
              :style="{ background: choice.bg, color: choice.fg }"
              :title="choice.name === 'auto' ? t('reader.themeAuto') : choice.name"
              @click="settings.reader.theme = choice.name"
            >Aa</button>
          </div>
        </div>
      </div>

      <!-- 分栏拖拽把手 -->
      <div v-if="rightTab" class="splitter" @pointerdown.prevent="startSplit" />

      <!-- 右: 翻译 (版式对照 / 段落列表) / AI 辅读
           标签切换在顶栏 (再点当前项即关闭), 面板内不再重复一排标签 -->
      <div v-if="rightTab" ref="rightPane" class="pane-right" :style="rightPaneStyle">
        <div v-if="!aiReady" class="rt-body">
          <div class="chat-head ai-top">
            <strong>{{ t('paper.translationTitle') }}</strong>
            <span style="flex: 1" />
            <button class="icon-btn" :title="t('common.close')" @click="closeRight" :aria-label="t('common.close')"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
          </div>
          <div class="pt-setup">
            <p>{{ t('paper.setupHint') }}</p>
            <button class="btn btn-sm btn-primary" @click="router.push('/settings')">{{ t('ai.goSettings') }}</button>
          </div>
        </div>

        <!-- 翻译: 版式对照连续滚动 (独立于左栏) / 段落列表 -->
        <template v-else>
          <div class="rt-body rt-translate">
            <div class="pt-head">
              <span class="pt-page">P{{ mirCur }} / {{ pageCount }}</span>
              <span style="flex: 1" />
              <span class="pm-switch">
                <button :class="{ active: viewMode === 'mirror' }" @click="setMode('mirror')">{{ t('paper.viewMirror') }}</button>
                <button :class="{ active: viewMode === 'cards' }" @click="setMode('cards')">{{ t('paper.viewCards') }}</button>
              </span>
              <button v-if="translatingPage" class="pt-act" @click="cancelTranslate">{{ t('paper.cancelTranslate') }}</button>
              <button v-else class="pt-act" @click="runTranslateFor(mirCur, true)">{{ t('paper.retranslate') }}</button>
              <span v-if="translatingPage" class="pt-busy">{{ t('paper.translating') }} P{{ translatingPage }}</span>
              <button class="icon-btn" :title="t('common.close')" @click="closeRight" :aria-label="t('common.close')"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
            </div>
            <p v-if="curMir && !curMir.paras.length" class="pt-empty">
              {{ t('paper.noText') }}
              <span v-if="curMir.err" class="pt-errdetail">{{ curMir.err }}</span>
            </p>

            <!-- 版式对照: 原页做底, 译文按原位铺回; 滚到哪页停稳即翻译哪页 -->
            <div v-show="effectiveMode === 'mirror'" ref="mirScroller" class="mp-scroll" :title="t('paper.blockHint')">
              <div v-for="n in pageCount" :key="n" class="mp-holder" :data-mp="n" :style="mirHolderStyle">
                <span class="p-num">{{ n }}</span>
                <div class="mp-canvas" />
                <div
                  v-for="blk in blocksOf(n)"
                  :key="blk.id"
                  class="pm-block"
                  :class="{ 'pm-original': blk.orig }"
                  :style="blk.style"
                  @click="toggleBlock(n, blk.id)"
                >{{ blk.text }}</div>
              </div>
            </div>

            <!-- 段落列表 (对照视图当前页) -->
            <div v-show="effectiveMode === 'cards'" class="cards-scroll">
              <div v-for="p in curMir?.paras ?? []" :key="p.id" class="pt-card">
                <div class="pt-zh">
                  <template v-if="curMir && trText(curMir, p.id)">{{ trText(curMir, p.id) }}</template>
                  <span v-else-if="translatingPage === mirCur" class="pt-pending">{{ t('paper.translating') }}</span>
                  <span v-else class="pt-pending">{{ origText(p).slice(0, 120) }}</span>
                </div>
                <button class="pt-toggle" @click="toggleOriginal(p.id)">
                  {{ expanded.has(p.id) ? t('paper.hideOriginal') : t('paper.showOriginal') }}
                </button>
                <p v-if="expanded.has(p.id)" class="pt-en">{{ origText(p) }}</p>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 划词浮条: 高亮 / 想法 / 复制 / AI 翻译 -->
    <div
      v-if="selection"
      class="sel-bar"
      :style="selBarStyle"
      role="toolbar"
      :aria-label="t('reader.selectionActions')"
      @mousedown.prevent
    >
      <div class="sel-colors" role="group" :aria-label="t('reader.highlight')">
        <button
          v-for="(hex, name) in HIGHLIGHT_COLORS"
          :key="name"
          type="button"
          class="sel-color"
          :title="`${t('reader.highlight')} · ${t(`reader.highlightColor.${name}`)}`"
          :aria-label="`${t('reader.highlight')} · ${t(`reader.highlightColor.${name}`)}`"
          @click="addHighlight(name as string)"
        >
          <span class="sel-color-dot" :style="{ background: hex }" />
        </button>
      </div>
      <span class="sel-sep" />
      <button type="button" class="sel-act" @click="addHighlight('yellow', true)">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.25 3.75h11.5v9H9l-3.25 2.7v-2.7h-1.5z" /><path d="M10 6.25v4M8 8.25h4" /></svg>
        <span>{{ t('reader.writeNote') }}</span>
      </button>
      <button type="button" class="sel-act sel-act-ai" @click="translateSelection">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10.2 2.75c.45 3.2 1.85 4.6 5.05 5.05-3.2.45-4.6 1.85-5.05 5.05-.45-3.2-1.85-4.6-5.05-5.05 3.2-.45 4.6-1.85 5.05-5.05Z" /><path d="M15.15 12.65c.2 1.45.85 2.1 2.3 2.3-1.45.2-2.1.85-2.3 2.3-.2-1.45-.85-2.1-2.3-2.3 1.45-.2 2.1-.85 2.3-2.3Z" /></svg>
        <span>{{ isPaper ? t('paper.selTranslateBtn') : t('ai.explain') }}</span>
      </button>
      <button v-if="isPaper && bdSupported" type="button" class="sel-act" @click="useSelectionAsBdContext">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.25h12v11.5H4z" /><path d="M7 7.25h6M7 10h6M7 12.75h3.5" /></svg>
        <span>{{ t('paper.bdUseSelection') }}</span>
      </button>
      <button type="button" class="sel-act" @click="copySelection">
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.25" y="6.25" width="9.5" height="9.5" rx="1.75" /><path d="M13.75 6.25v-1.5a1.5 1.5 0 0 0-1.5-1.5h-7.5a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h1.5" /></svg>
        <span>{{ t('paper.copy') }}</span>
      </button>
      <button type="button" class="sel-act" @click="notes.cardFromSelection(selection!.text, t('notes.page', { n: selection!.page })); selection = null">
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.25" y="3.25" width="11.5" height="13.5" rx="1.75" /><path d="M7 12.75h6M7.5 7.5c.6-.8 1.3-1 1.8-1M10.5 7.5c.6-.8 1.3-1 1.8-1" /></svg>
        <span>{{ t('notes.makeCard') }}</span>
      </button>
      <span class="sel-sep sel-sep-end" />
      <button type="button" class="sel-close" :aria-label="t('common.close')" :title="t('common.close')" @click="selection = null">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.75 5.75 8.5 8.5M14.25 5.75l-8.5 8.5" /></svg>
      </button>
    </div>

    <!-- 划词翻译浮卡 (流式) -->
    <div v-if="selTr" class="sel-tr card" :style="{ left: `${selTrPos.x}px`, top: `${selTrPos.y}px` }">
      <div class="sel-tr-head">
        <strong>{{ isPaper ? t('paper.selTranslate') : t('ai.explain') }}</strong>
        <span v-if="selTr.busy" class="pt-busy">{{ t(isPaper ? 'paper.translating' : 'ai.explaining') }}</span>
        <span style="flex: 1" />
        <button class="icon-btn" :title="t('paper.copy')" :aria-label="t('paper.copy')" :disabled="!selTr.out" @click="copySelTr">⧉</button>
        <button class="icon-btn" :title="t('common.close')" :aria-label="t('common.close')" @click="closeSelTr"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
      </div>
      <p class="sel-tr-src">{{ selTr.src }}</p>
      <p class="sel-tr-out">{{ selTr.out ? plainAiText(selTr.out) : '…' }}</p>
    </div>

    <!-- 高亮想法编辑浮层 -->
    <div v-if="activeAnnotation" class="anno-pop card" :style="{ left: `${popPos.x}px`, top: `${popPos.y}px` }">
      <p class="quote">{{ activeAnnotation.text }}</p>
      <textarea
        v-model="noteDraft"
        class="note-input input"
        rows="3"
        :placeholder="t('reader.notePlaceholder')"
      />
      <div class="pop-actions">
        <button class="btn btn-sm btn-danger" @click="removeAnnotation(activeAnnotation)">{{ t('reader.deleteHighlight') }}</button>
        <button class="btn btn-sm" @click="notes.copyOne(activeAnnotation)">{{ t('notes.copyOne') }}</button>
        <button class="btn btn-sm" @click="notes.cardFromAnnotation(activeAnnotation); activeAnnotation = null">{{ t('notes.makeCard') }}</button>
        <span style="flex: 1" />
        <button class="btn btn-sm" @click="activeAnnotation = null">{{ t('common.cancel') }}</button>
        <button class="btn btn-sm btn-primary" @click="saveNote">{{ t('reader.saveNote') }}</button>
      </div>
    </div>

    <NotesExportDialog
      v-if="notes.exportOpen && meta"
      :book="notes.book"
      :items="notes.noteItems"
      :lang="settings.language === 'en' ? 'en' : 'zh'"
      @close="notes.exportOpen = false"
    />
    <QuoteCardDialog v-if="notes.card && cardCover !== undefined" :data="notes.card" :cover-url="cardCover || undefined" @close="notes.card = null" />

    <!-- 引文/目录跳转后返回原位 -->
    <button v-if="backStack.length" class="back-pill card" @click="goBack">
      ↩ {{ t('paper.jumpBack') }}
    </button>

    <!-- 听书控制条 (藏书 PDF) -->
    <div v-if="ttsPanel" class="tts-panel card">
      <div class="tts-row">
        <button
          class="btn btn-sm btn-primary"
          @click="ttsState === 'playing' ? pauseTTS() : ttsState === 'paused' ? resumeTTS() : startTTS()"
        >
          <template v-if="ttsState === 'playing'"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 8 5zm8 0a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 16 5z"/></svg>{{ t('common.pause') }}</template>
          <template v-else><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8.5 5.2a1 1 0 0 1 1.02.03l9 5.95a1 1 0 0 1 0 1.66l-9 5.95A1 1 0 0 1 8 17.95V6.05a1 1 0 0 1 .5-.85z"/></svg>{{ ttsState === 'paused' ? t('common.resume') : t('tts.startReading') }}</template>
        </button>
        <button class="btn btn-sm" :disabled="ttsState === 'stopped'" @click="stopTTS"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>{{ t('common.stop') }}</button>
        <button class="icon-btn" :title="t('common.close')" @click="ttsPanel = false; stopTTS()" :aria-label="t('common.close')"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
      </div>
      <div class="tts-row">
        <label>{{ t('tts.rate') }}</label>
        <LevelSlider
          v-model="settings.ttsRate"
          :min="TTS_RATE_MIN"
          :max="TTS_RATE_MAX"
          :step="0.05"
          :stops="TTS_RATE_STOPS.map(v => ({ value: v, label: v === 1 ? t('tts.rateNormal') : rateText(v), minor: TTS_RATE_MINOR_STOPS.includes(v) }))"
          :label="t('tts.rate')"
        />
        <span class="tts-value">{{ rateText(settings.ttsRate) }}</span>
      </div>
      <div v-if="edgeAvailable()" class="tts-row">
        <label>{{ t('tts.engine') }}</label>
        <div class="seg" style="flex: 1">
          <button :class="{ active: settings.ttsEngine === 'edge' }" @click="settings.ttsEngine = 'edge'; resetEdgeFailure()">{{ t('tts.engineEdge') }}</button>
          <button :class="{ active: settings.ttsEngine === 'local' }" :title="t('tts.engineLocalTitle')" @click="settings.ttsEngine = 'local'; resetEdgeFailure(); refreshLocalStatus()">{{ t('tts.engineLocal') }}</button>
          <button v-if="localVoiceOffered()" :class="{ active: settings.ttsEngine === 'qwen' }" :title="t('tts.engineQwenTitle')" @click="settings.ttsEngine = 'qwen'; resetEdgeFailure()">{{ t('tts.engineQwen') }}</button>
          <button :class="{ active: settings.ttsEngine === 'system' }" @click="settings.ttsEngine = 'system'">{{ t('tts.engineSystem') }}</button>
          <button :class="{ active: settings.ttsEngine === 'cloud' }" :title="t('tts.engineCloudTitle')" @click="settings.ttsEngine = 'cloud'; resetEdgeFailure()">{{ t('tts.engineCloud') }}</button>
          <button v-if="sapiPlatform()" :class="{ active: settings.ttsEngine === 'sapi' }" :title="t('tts.engineSapiTitle')" @click="settings.ttsEngine = 'sapi'; resetEdgeFailure()">{{ t('tts.engineSapi') }}</button>
        </div>
      </div>
      <div v-if="edgeAvailable() && settings.ttsEngine === 'edge'" class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <AppSelect v-model="settings.edgeVoice" class="input" :aria-label="t('tts.voice')">
          <option v-for="v in EDGE_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
        </AppSelect>
      </div>
      <div v-else-if="edgeAvailable() && settings.ttsEngine === 'cloud'" class="tts-row">
        <CloudTtsConfig :busy="ttsState !== 'stopped'" />
      </div>
      <div v-else-if="edgeAvailable() && settings.ttsEngine === 'sapi' && sapiPlatform()" class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <SapiVoiceSelect :busy="ttsState !== 'stopped'" />
      </div>
      <div v-else-if="edgeAvailable() && settings.ttsEngine === 'qwen'" class="tts-row">
        <QwenVoiceRow />
      </div>
      <div v-else-if="edgeAvailable() && settings.ttsEngine === 'local'" class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <template v-if="localInstalled">
          <AppSelect v-model="settings.localVoiceId" class="input" :aria-label="t('tts.voice')">
            <option v-for="v in KOKORO_VOICES" :key="v.sid" :value="v.sid">{{ kokoroVoiceLabel(v, settings.language === 'en' ? 'en' : 'zh') }}{{ v.sid === DEFAULT_KOKORO_SID ? t('tts.voiceDefault') : '' }}</option>
          </AppSelect>
          <button class="btn btn-sm" :disabled="ttsState !== 'stopped'" @click="auditionLocal">{{ t('tts.audition') }}</button>
        </template>
        <LocalTtsPack v-else />
      </div>
      <div v-else class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <AppSelect v-model="settings.ttsVoice" class="input" :aria-label="t('tts.voice')">
          <option value="">{{ t('tts.autoVoice') }}</option>
          <option v-for="v in ttsVoices" :key="v.name" :value="v.name">{{ v.name }} ({{ v.lang }})</option>
        </AppSelect>
      </div>
      <p v-if="edgeAvailable() && settings.ttsEngine === 'local'" class="tts-local-hint">{{ t('tts.hintLocal') }}</p>
      <p v-else-if="edgeAvailable() && settings.ttsEngine === 'qwen'" class="tts-local-hint">{{ t(localVoiceReady() ? 'tts.hintQwen' : 'tts.hintQwenFallback') }}</p>
    </div>

    <!-- 自动翻页控制条：运行后自动收起到顶部状态按钮，避免遮挡正文。 -->
    <Transition name="auto-float">
      <section
        v-if="autoPanel"
        class="auto-panel card"
        :aria-label="t('reader.autoRead')"
        @pointerenter="cancelAutoPanelCollapse"
        @pointerleave="scheduleAutoPanelCollapse(1800)"
        @focusin="cancelAutoPanelCollapse"
        @focusout="scheduleAutoPanelCollapse(1800)"
      >
        <button class="btn btn-sm auto-toggle" :class="{ 'btn-active': autoReading }" @click="autoReading ? stopAutoRead() : startAutoRead()">
          <template v-if="autoReading"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 8 5zm8 0a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 16 5z"/></svg>{{ t('common.pause') }}</template>
          <template v-else><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8.5 5.2a1 1 0 0 1 1.02.03l9 5.95a1 1 0 0 1 0 1.66l-9 5.95A1 1 0 0 1 8 17.95V6.05a1 1 0 0 1 .5-.85z"/></svg>{{ t('common.start') }}</template>
        </button>
        <label>{{ t('reader.speed') }}</label>
        <LevelSlider
          class="auto-speed-slider"
          :model-value="speedPosition(settings.autoReadSeconds)"
          :min="1"
          :max="AUTO_SPEED_STEPS"
          :step="1"
          :stops="AUTO_SPEED_LEVELS.map(l => ({ value: l.position, label: t(l.key), minor: !AUTO_SPEED_MAJOR.includes(l.level) }))"
          :label="t('reader.speed')"
          @update:model-value="settings.autoReadSeconds = secondsAtPosition($event)"
        />
        <span class="auto-seconds">{{ Math.round(settings.autoReadSeconds) }} {{ t(mode === 'paged' ? 'readingMode.secondsPage' : 'readingMode.secondsScreen') }}</span>
        <button class="icon-btn auto-collapse" :title="t('reader.collapseControls')" @click="collapseAutoPanel">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="m5.5 7.5 4.5 4.5 4.5-4.5" /></svg>
        </button>
        <button class="icon-btn" :title="t('common.stop')" @click="autoPanel = false; stopAutoRead()" :aria-label="t('common.stop')"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
      </section>
    </Transition>
  </div>
</template>

<style scoped src="../styles/views/paper-reader.css"></style>
