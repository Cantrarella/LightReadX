/**
 * usePdfSearch — PDF 全文搜索（PDFium 字符模型 → 命中区间 → 几何高亮）
 *
 * 把 PaperReaderView 里的全文搜索逻辑抽成独立 composable。
 * 搜索算法（字符归一化 / 匹配 / 整词过滤）与 PDFium 文档解耦：
 * 只通过 `getDoc` 拿到文档、用 services/pdfium 的 rangeRects 算几何，
 * 翻页/滚动等渲染导航通过 `gotoHit` 回调注入，由视图层实现。
 *
 * 视图层只负责：
 *   - 实现 gotoHit（翻页 / 定位到命中的具体滚动逻辑）
 *   - pdfSearchRectStyle（依赖 displaySizeOf 的像素换算）
 */
import { ref, computed, nextTick, type Ref } from 'vue'
import { PdfiumDoc, rangeRects } from '../services/pdfium'

export interface PdfSearchHit {
  page: number
  a: number
  b: number
  rects: { x: number; y: number; w: number; h: number }[]
}

const PDF_SEARCH_LIMIT = 2000

export interface PdfSearchOptions {
  /** 拿到当前 PDFium 文档（可能未加载完成，为 null） */
  getDoc: () => PdfiumDoc | null
  /** 总页数 */
  pageCount: Ref<number>
  /** 当前页（用于命中后定位到「当前页之后最近的一个命中」） */
  currentPage: Ref<number>
  /** 激活某个命中后的导航动作（翻页/滚动/清选区），由视图层实现 */
  gotoHit: (hit: PdfSearchHit) => Promise<void>
  /** 关闭侧栏抽屉（打开搜索框时要收起其他抽屉） */
  closeDrawer: () => void
}

export function usePdfSearch(opts: PdfSearchOptions) {
  const { getDoc, pageCount, currentPage, gotoHit, closeDrawer } = opts

  const pdfSearchInput = ref<HTMLInputElement>()
  const pdfSearchOpen = ref(false)
  const pdfSearchQuery = ref('')
  const pdfSearchResults = ref<PdfSearchHit[]>([])
  const pdfSearchActive = ref(-1)
  const pdfSearchRunning = ref(false)
  const pdfSearchProgress = ref(0)
  const pdfSearchDoneQuery = ref('')
  const pdfSearchMatchCase = ref(false)
  const pdfSearchWholeWord = ref(false)
  let pdfSearchSession = 0
  let pdfSearchTimer: ReturnType<typeof setTimeout> | undefined

  const pdfSearchStatus = computed(() => {
    if (pdfSearchRunning.value) return `${Math.round(pdfSearchProgress.value * 100)}%`
    if (!pdfSearchDoneQuery.value) return ''
    if (!pdfSearchResults.value.length) return '0 / 0'
    return `${pdfSearchActive.value + 1} / ${pdfSearchResults.value.length}${pdfSearchResults.value.length >= PDF_SEARCH_LIMIT ? '+' : ''}`
  })

  const pdfSearchRectsByPage = computed(() => {
    const byPage = new Map<number, Array<{ key: string; rect: { x: number; y: number; w: number; h: number }; active: boolean }>>()
    if (!pdfSearchOpen.value) return byPage
    pdfSearchResults.value.forEach((hit, hitIndex) => {
      const list = byPage.get(hit.page) ?? []
      hit.rects.forEach((rect, rectIndex) => {
        list.push({ key: `${hitIndex}:${rectIndex}`, rect, active: hitIndex === pdfSearchActive.value })
      })
      byPage.set(hit.page, list)
    })
    return byPage
  })

  function appendSearchUnits(
    units: string[],
    indexes: number[] | null,
    value: string,
    sourceIndex: number,
  ) {
    const normalized = pdfSearchMatchCase.value
      ? value.normalize('NFKC')
      : value.normalize('NFKC').toLocaleLowerCase()
    for (const ch of normalized) {
      if (/\s/u.test(ch)) {
        if (units.length && units.at(-1) !== ' ') {
          units.push(' ')
          indexes?.push(sourceIndex)
        }
      } else {
        units.push(ch)
        indexes?.push(sourceIndex)
      }
    }
  }

  function querySearchUnits(value: string): string[] {
    const units: string[] = []
    appendSearchUnits(units, null, value.trim(), 0)
    if (units.at(-1) === ' ') units.pop()
    return units
  }

  function modelSearchUnits(model: ReturnType<PdfiumDoc['text']>) {
    const units: string[] = []
    const indexes: number[] = []
    for (let i = 0; i < model.count; i++) {
      const code = model.codes[i]
      if (!code || code === 13) continue
      appendSearchUnits(units, indexes, String.fromCodePoint(code), i)
    }
    return { units, indexes }
  }

  function pageSearchHits(page: number, needle: string[]): PdfSearchHit[] {
    const doc = getDoc()
    if (!doc || !needle.length) return []
    const model = doc.text(page - 1)
    const { units, indexes } = modelSearchUnits(model)
    const hits: PdfSearchHit[] = []
    const lastStart = units.length - needle.length
    for (let start = 0; start <= lastStart; start++) {
      let matched = true
      for (let j = 0; j < needle.length; j++) {
        if (units[start + j] !== needle[j]) {
          matched = false
          break
        }
      }
      if (!matched) continue
      const a = indexes[start]
      const b = indexes[start + needle.length - 1] + 1
      if (pdfSearchWholeWord.value) {
        const before = a > 0 ? String.fromCodePoint(model.codes[a - 1] ?? 0) : ''
        const after = b < model.count ? String.fromCodePoint(model.codes[b] ?? 0) : ''
        if (isSearchWordChar(before) || isSearchWordChar(after)) continue
      }
      const rects = rangeRects(model, a, b)
      if (rects.length) hits.push({ page, a, b, rects })
      start += Math.max(0, needle.length - 1)
    }
    return hits
  }

  function isSearchWordChar(value: string) {
    return value ? /[\p{L}\p{N}_]/u.test(value) : false
  }

  function togglePdfSearchOption(option: 'case' | 'word') {
    if (option === 'case') pdfSearchMatchCase.value = !pdfSearchMatchCase.value
    else pdfSearchWholeWord.value = !pdfSearchWholeWord.value
    schedulePdfSearch()
  }

  async function activatePdfSearchHit(index: number) {
    const count = pdfSearchResults.value.length
    if (!count) {
      pdfSearchActive.value = -1
      return
    }
    const normalizedIndex = ((index % count) + count) % count
    pdfSearchActive.value = normalizedIndex
    const hit = pdfSearchResults.value[normalizedIndex]
    if (!hit.rects.length) return
    await gotoHit(hit)
  }

  async function runPdfSearch() {
    clearTimeout(pdfSearchTimer)
    const query = pdfSearchQuery.value.trim()
    const needle = querySearchUnits(query)
    const session = ++pdfSearchSession
    pdfSearchResults.value = []
    pdfSearchActive.value = -1
    pdfSearchProgress.value = 0
    pdfSearchDoneQuery.value = ''
    const doc = getDoc()
    if (!doc || !needle.length) {
      pdfSearchRunning.value = false
      return
    }

    pdfSearchRunning.value = true
    const hits: PdfSearchHit[] = []
    try {
      for (let page = 1; page <= pageCount.value && hits.length < PDF_SEARCH_LIMIT; page++) {
        if (session !== pdfSearchSession) return
        try {
          const remaining = PDF_SEARCH_LIMIT - hits.length
          hits.push(...pageSearchHits(page, needle).slice(0, remaining))
        } catch (e) {
          console.warn(`PDF search skipped page ${page}`, e)
        }
        pdfSearchProgress.value = page / Math.max(1, pageCount.value)
        if (page % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (session !== pdfSearchSession) return
      pdfSearchResults.value = hits
      pdfSearchDoneQuery.value = query
      if (hits.length) {
        const index = hits.findIndex(hit => hit.page >= currentPage.value)
        await activatePdfSearchHit(index >= 0 ? index : 0)
      }
    } finally {
      if (session === pdfSearchSession) pdfSearchRunning.value = false
    }
  }

  function schedulePdfSearch() {
    clearTimeout(pdfSearchTimer)
    pdfSearchSession++
    if (!pdfSearchQuery.value.trim()) {
      pdfSearchResults.value = []
      pdfSearchActive.value = -1
      pdfSearchDoneQuery.value = ''
      pdfSearchRunning.value = false
      return
    }
    pdfSearchTimer = setTimeout(() => void runPdfSearch(), 180)
  }

  async function onPdfSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePdfSearch()
      return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    const query = pdfSearchQuery.value.trim()
    if (pdfSearchDoneQuery.value !== query) {
      await runPdfSearch()
    } else {
      await activatePdfSearchHit(pdfSearchActive.value + (e.shiftKey ? -1 : 1))
    }
  }

  function openPdfSearch() {
    pdfSearchOpen.value = true
    closeDrawer()
    nextTick(() => {
      pdfSearchInput.value?.focus()
      pdfSearchInput.value?.select()
    })
  }

  function closePdfSearch() {
    clearTimeout(pdfSearchTimer)
    pdfSearchSession++
    pdfSearchOpen.value = false
    pdfSearchRunning.value = false
  }

  /** 组件卸载时收尾：清定时器、作废进行中的搜索会话、复位面板 */
  function disposePdfSearch() {
    clearTimeout(pdfSearchTimer)
    pdfSearchSession++
    pdfSearchOpen.value = false
    pdfSearchRunning.value = false
  }

  return {
    pdfSearchInput,
    pdfSearchOpen,
    pdfSearchQuery,
    pdfSearchResults,
    pdfSearchActive,
    pdfSearchRunning,
    pdfSearchProgress,
    pdfSearchDoneQuery,
    pdfSearchMatchCase,
    pdfSearchWholeWord,
    pdfSearchStatus,
    pdfSearchRectsByPage,
    activatePdfSearchHit,
    runPdfSearch,
    schedulePdfSearch,
    togglePdfSearchOption,
    onPdfSearchKeydown,
    openPdfSearch,
    closePdfSearch,
    disposePdfSearch,
  }
}
