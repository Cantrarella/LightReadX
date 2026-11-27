<script setup lang="ts">
import { askConfirm, deleteConfirmOptions } from '../services/confirm'
import AppSelect from '../components/AppSelect.vue'
import { vAutofocus } from '../directives/autofocus'
import AppModal from '../components/AppModal.vue'
import { shortAuthor, shortTitle } from '../services/displayTitle'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { importFiles, type NativeImportFile, type LazyImportFile } from '../services/importer'
import { IMPORT_FORMATS, planFolderPick, type FolderPlan } from '../services/folderPick'
import { canPickFolder, loadFolderFile, scanNativePaths, scanFromFileList, scanNativeFolder, useNativeFolderPicker, type FolderFile, type FolderScan } from '../services/folderSource'
import { nativeDragging, nativeDropQueue } from '../services/nativeDrop'
import { importFromUrl } from '../services/urlImport'
import { canScanLibraryLoose, importLibraryLooseFiles } from '../services/libraryScan'
import { sendBookToDevices } from '../services/transfer'
import { exportBooksToFolder, exportSingleBook } from '../services/bookExport'
import { canConvertToEpub } from '../services/format'
import { MQ, useMediaQuery } from '../composables/useMediaQuery'
import { ACCEPT_READABLE } from '../services/plainText'
import { toast } from '../services/toast'
import { formatReadingTime } from '../composables/useReadingTimer'
import { readerPath } from '../services/readerRoute'
import { isComicFormat } from '../services/comicFormat'
import { loadDaily, localDay, onReadingLogChange } from '../services/readingLog'
import { weekStartOf } from '../services/readingStats'
import BookCard from '../components/BookCard.vue'
import LibraryUploadDialog from '../components/LibraryUploadDialog.vue'
import FolderPickDialog from '../components/FolderPickDialog.vue'
import { addFolderBooklists } from '../services/folderBooklists'
import BooklistWantedPanel from '../components/BooklistWantedPanel.vue'
import BooklistShareDialog from '../components/BooklistShareDialog.vue'
import BooklistImportDialog from '../components/BooklistImportDialog.vue'
import type { BookMeta } from '../storage'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'

type PaperState = 'unread' | 'reading' | 'done'
function paperState(book: { progress?: number; lastReadAt?: number }): PaperState {
  if ((book.progress ?? 0) >= 0.999) return 'done'
  return book.progress || book.lastReadAt ? 'reading' : 'unread'
}

const router = useRouter()
const route = useRoute()
const library = useLibrary()

/** /papers 路由复用本视图, 只显示论文 */
const paperMode = computed(() => false)
const pageKind = computed<'book' | 'paper'>(() => (paperMode.value ? 'paper' : 'book'))

// 路由切换 (藏书 ↔ 论文) 时重置筛选与选择状态
watch(paperMode, () => {
  manageMode.value = false
  selectedIds.value = new Set()
  tagFilter.value = ''
  activeBooklistId.value = ''
  keyword.value = ''
  paperStatus.value = ''
})

const keyword = ref('')
/** 手机论文页的阅读状态筛选 */
const paperStatus = ref<'' | PaperState>('')
const sortBy = ref<'recent' | 'added' | 'title' | 'author'>('recent')
const fileInput = ref<HTMLInputElement>()
const dragging = ref(false)
const importing = ref(false)
const importState = ref({ done: 0, total: 0, current: '' })
const showCloudUpload = ref(false)
const cloudBookIds = ref<string[]>([])

function uploadBooks(ids: string[] = []) {
  cloudBookIds.value = ids
  importMenu.value = false
  showCloudUpload.value = true
}

// 格式转换: MOBI / AZW3 / FB2 / TXT 等 → EPUB, 作为新书加入, 原书保留
const converting = ref<{ done: number; total: number; current: string; pct: number } | null>(null)
const convertPercent = computed(() => {
  const c = converting.value
  return c ? Math.round(((c.done + c.pct / 100) / Math.max(c.total, 1)) * 100) : 0
})

async function convertBooks(ids: string[]) {
  if (converting.value) {
    toast(t('convert.busy'))
    return
  }
  const books = ids
    .map(id => library.books.find(book => book.id === id))
    .filter((book): book is BookMeta => !!book)
  const targets = books.filter(book => canConvertToEpub(book.format))
  const skipped = books.length - targets.length
  if (!targets.length) {
    toast(t('convert.noneConvertible'), 'info', 5000)
    return
  }
  converting.value = { done: 0, total: targets.length, current: targets[0].title, pct: 0 }
  const created: Array<{ bookId: string; annotations: number }> = []
  try {
    const { convertLibraryBook, convertErrorText } = await import('../services/convertLibraryBook')
    for (const [index, book] of targets.entries()) {
      converting.value = { done: index, total: targets.length, current: book.title, pct: 0 }
      try {
        created.push(await convertLibraryBook(book.id, p => {
          if (converting.value) converting.value.pct = Math.floor(p.fraction * 100)
        }))
      } catch (error) {
        toast(t('convert.failed', { name: book.title, msg: convertErrorText(error) }), 'error', 8000)
      }
    }
  } catch (error: any) {
    toast(error?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    converting.value = null
    await library.refresh()
  }
  if (created.length === 1 && targets.length === 1) {
    const { bookId, annotations } = created[0]
    toast(t(annotations ? 'convert.successNotes' : 'convert.success'), 'success', 8000, {
      label: t('convert.open'),
      run: () => router.push(readerPath({ id: bookId, format: 'epub' })),
    })
  } else if (created.length) {
    toast(t('convert.successBatch', { count: created.length }), 'success', 5000)
  }
  if (skipped) toast(t('convert.skipped', { count: skipped }), 'info', 5000)
}

// 批量管理
const manageMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const tagFilter = ref('')
const showTagModal = ref(false)
const tagDraft = ref('')

// 书单
const activeBooklistId = ref('')
const showBooklistCreate = ref(false)
const showBooklistManage = ref(false)
const showBooklistPicker = ref(false)
const booklistDraft = ref('')
const pickerBookIds = ref<string[]>([])
const pickerDraft = ref('')
const booklistRenames = ref<Record<string, string>>({})
const showBooklistShare = ref(false)
const showBooklistImport = ref(false)
/** 当前书单的待找条目 (还不在藏书里的书) */
const activeWanted = computed(() =>
  activeBooklistId.value ? library.booklistWanted[activeBooklistId.value] ?? [] : [])
/** 书单只有待找条目时不显示「空书单」「无结果」 */
const showOnlyWanted = computed(() =>
  !!activeBooklist.value && !!activeWanted.value.length && !keyword.value.trim() && !tagFilter.value)
// 书源页「全部加入我的书单」→「查看」: /library?booklist=<id> (路由按 fullPath 重建视图, 不清查询参数)
watch(() => [route.query.booklist, library.loaded] as const, ([id]) => {
  if (typeof id === 'string' && id && !paperMode.value && library.booklists.some(item => item.id === id)) {
    activeBooklistId.value = id
  }
}, { immediate: true })

// 顶部「今日阅读」入口 (藏书模式), 记录变化时实时刷新
const todaySeconds = ref(0)
const weekSeconds = ref(0)
let stopReadingLog: (() => void) | undefined
async function refreshToday() {
  try {
    const daily = await loadDaily()
    const today = localDay()
    const monday = weekStartOf(today)
    todaySeconds.value = daily[today]?.seconds ?? 0
    weekSeconds.value = Object.entries(daily)
      .filter(([day]) => day >= monday && day <= today)
      .reduce((sum, [, entry]) => sum + (entry?.seconds ?? 0), 0)
  } catch {
    todaySeconds.value = 0
    weekSeconds.value = 0
  }
}
/** 本周: 不足 1 小时按分钟, 否则按小时 (一位小数) */
const weekStat = computed(() => weekSeconds.value < 3570
  ? { value: String(Math.round(weekSeconds.value / 60)), unit: t('library.statMinutes') }
  : { value: (weekSeconds.value / 3600).toFixed(1).replace(/\.0$/, ''), unit: t('library.statHours') })
const todayMinutes = computed(() => Math.round(todaySeconds.value / 60))
const settings = useSettings()
const goalMinutes = computed(() => Math.max(0, Math.round(settings.dailyGoalMinutes || 0)))
const todayRatio = computed(() => (goalMinutes.value > 0 ? Math.min(1, todaySeconds.value / (goalMinutes.value * 60)) : 0))
const todayDone = computed(() => goalMinutes.value > 0 && todayRatio.value >= 1)
const TODAY_RING_C = 2 * Math.PI * 5.5

onMounted(() => {
  library.refresh()
  window.addEventListener('keydown', onGlobalKeydown)
  void refreshToday()
  stopReadingLog = onReadingLogChange(() => void refreshToday())
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  stopReadingLog?.()
})

/** Esc 逐层关闭: 弹窗 → 导入菜单 → 管理模式 */
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (showCloudUpload.value) return // 上传对话框自己处理关闭及忙碌状态
  if (showBooklistShare.value || showBooklistImport.value) {
    showBooklistShare.value = false
    showBooklistImport.value = false
    e.preventDefault()
    return
  }
  if (addSheet.value || menuBookId.value || batchMoreSheet.value || booklistSheet.value) return // AppModal 自己处理 Esc
  if (showTagManage.value) showTagManage.value = false
  else if (showUrlModal.value) { if (!urlImporting.value) showUrlModal.value = false }
  else if (showTagModal.value) showTagModal.value = false
  else if (showBooklistManage.value) showBooklistManage.value = false
  else if (showBooklistPicker.value) showBooklistPicker.value = false
  else if (showBooklistCreate.value) showBooklistCreate.value = false
  else if (importMenu.value) importMenu.value = false
  else if (manageMode.value) toggleManage()
  else return
  e.preventDefault()
}

const totalReadingTime = computed(() => {
  const total = kindBooks.value.reduce((sum, b) => sum + (b.readingSeconds ?? 0), 0)
  return total >= 60 ? formatReadingTime(total) : ''
})

const allTags = computed(() => {
  const tags = new Set<string>()
  for (const book of kindBooks.value) for (const t of book.tags) tags.add(t)
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh'))
})

const anyConvertible = computed(() => kindBooks.value.some(book => canConvertToEpub(book.format)))
const kindBooks = computed(() =>
  library.books.filter(b => !isComicFormat(b.format)))

const activeBooklist = computed(() =>
  library.booklists.find(item => item.id === activeBooklistId.value))

const filtered = computed(() => {
  let list = kindBooks.value
  if (!paperMode.value && activeBooklistId.value) {
    const ids = new Set(library.booklistBookIds[activeBooklistId.value] ?? [])
    list = list.filter(book => ids.has(book.id))
  }
  if (tagFilter.value) list = list.filter(b => b.tags.includes(tagFilter.value))
  if (paperMode.value && paperStatus.value) list = list.filter(b => paperState(b) === paperStatus.value)
  const kw = keyword.value.trim().toLowerCase()
  if (kw) {
    list = list.filter(b =>
      b.title.toLowerCase().includes(kw)
      || b.author.toLowerCase().includes(kw)
      || b.tags.some(t => t.toLowerCase().includes(kw)))
  }
  const sorted = [...list]
  switch (sortBy.value) {
    case 'recent':
      sorted.sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt))
      break
    case 'added':
      sorted.sort((a, b) => b.addedAt - a.addedAt)
      break
    case 'title':
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
      break
    case 'author':
      sorted.sort((a, b) => a.author.localeCompare(b.author, 'zh'))
      break
  }
  // 置顶的书永远排最前 (按置顶时间新→旧)
  return [
    ...sorted.filter(b => b.pinnedAt).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)),
    ...sorted.filter(b => !b.pinnedAt),
  ]
})

async function handleFiles(files: FileList | Array<File | LazyImportFile | NativeImportFile>, folder?: { name: string; entries: FolderFile[] }) {
  if (!files.length || importing.value) return
  const kind = pageKind.value
  const booklistId = kind === 'book' ? activeBooklistId.value : ''
  importing.value = true
  try {
    const results = await importFiles(files, '本地导入', (done, total, current) => {
      importState.value = { done, total, current }
    }, { kind })
    await library.refresh()
    const ids = results.filter(r => r.ok && r.bookId).map(r => r.bookId!)
    if (booklistId && ids.length) await library.addBooksToBooklist(booklistId, ids)
    if (kind === 'book' && folder) await addFolderBooklists(library, folder.name, folder.entries, results)
    if (ids.length) toast(t(kind === 'paper' ? 'library.importPapersSuccess' : 'library.importSuccess', { count: ids.length }), 'success')
    for (const f of results.filter(r => !r.ok)) toast(`${f.fileName}: ${f.error}`, 'error', 5000)
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    importing.value = false
  }
}

async function chooseFiles() {
  importMenu.value = false
  if (importing.value || scanningDrop.value || folderPick.value) return
  if (!useNativeFolderPicker() || !folderSupported) { fileInput.value?.click(); return }
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const paths = await open({ multiple: true, directory: false })
    if (paths) nativeDropQueue.value = [...nativeDropQueue.value, Array.isArray(paths) ? paths : [paths]]
  } catch (error) {
    toast(t('library.dropFailed', { msg: String(error) }), 'error', 6000)
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) handleFiles(input.files)
  input.value = ''
}

// 选择文件夹: 递归找出书, 同一本书多种格式只留最推荐的, 先确认再导入
const folderInput = ref<HTMLInputElement>()
/** 以触屏为主的设备: 文案不提「拖入」 */
const touchPrimary = useMediaQuery(MQ.touch)
const folderSupported = canPickFolder()
const folderPick = ref<{ scanning: boolean; scan?: FolderScan; plan?: FolderPlan<FolderFile> } | null>(null)

async function chooseFolder() {
  importMenu.value = false
  if (importing.value || scanningDrop.value || folderPick.value) return
  if (!useNativeFolderPicker()) { folderInput.value?.click(); return }
  try {
    const scan = await scanNativeFolder(name => { folderPick.value = { scanning: true, scan: { name, entries: [], truncated: false } } })
    if (scan) showFolderPlan(scan); else folderPick.value = null
  } catch (e: any) {
    folderPick.value = null
    toast(t('folder.scanFailed', { msg: e?.message ?? String(e) }), 'error', 6000)
  }
}

function onFolderPick(e: Event) {
  const input = e.target as HTMLInputElement
  const scan = input.files ? scanFromFileList(input.files) : null
  input.value = ''
  if (scan) showFolderPlan(scan)
}

function showFolderPlan(scan: FolderScan) {
  reportScanErrors(scan)
  const kind = pageKind.value
  // 藏书里已有同名文件的不再导入 (导入流程本身不做内容去重)
  const existing = library.books.filter(b => (b.kind ?? 'book') === kind).map(b => b.fileName)
  folderPick.value = { scanning: false, scan, plan: planFolderPick(scan.entries, { formats: IMPORT_FORMATS, existingFileNames: existing }) }
}

function confirmFolderImport(createBooklists: boolean) {
  const selected = folderPick.value?.plan?.selected ?? []
  const name = folderPick.value?.scan?.name ?? ''
  folderPick.value = null
  if (selected.length) void handleFiles(selected.map(importEntry), createBooklists ? { name, entries: selected } : undefined)
}

function importEntry(entry: FolderFile): File | LazyImportFile | NativeImportFile {
  return entry.file ?? (entry.absPath ? { name: entry.name, absPath: entry.absPath } : { name: entry.name, load: () => loadFolderFile(entry) })
}

function reportScanErrors(scan: FolderScan) {
  if (scan.errors?.length) toast(t('folder.scanFailed', { msg: scan.errors.join('\n') }), 'error', 6000)
}

const scanningDrop = ref(false)
// A second drop waits for the current import/confirmation instead of silently disappearing.
watch([nativeDropQueue, importing, folderPick, scanningDrop], async () => {
  if (importing.value || folderPick.value || scanningDrop.value || !nativeDropQueue.value.length) return
  const [paths, ...rest] = nativeDropQueue.value
  scanningDrop.value = true
  nativeDropQueue.value = rest
  try {
    const scan = await scanNativePaths(paths!)
    if (scan.hasDirectories || scan.truncated) showFolderPlan(scan)
    else {
      reportScanErrors(scan)
      await handleFiles(scan.entries.map(importEntry))
    }
  } catch (error) {
    toast(t('folder.scanFailed', { msg: String(error) }), 'error', 6000)
  } finally {
    scanningDrop.value = false
  }
}, { immediate: true })

function onDragOver() {
  // Native drops do not reliably deliver a DOM drop/leave to clear this flag.
  // Desktop hover feedback is owned exclusively by the Tauri event listener.
  if (!useNativeFolderPicker() || !folderSupported) dragging.value = true
}

function onDrop(e: DragEvent) {
  dragging.value = false
  if (useNativeFolderPicker() && folderSupported) return
  if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files)
}

function openBook(book: BookMeta) {
  // PDF 统一走论文阅读器 (可选 MuPDF/PDFium 渲染 + PDFium 交互几何), 藏书与论文共用
  router.push(readerPath(book))
}

async function removeBook(book: BookMeta) {
  const confirmation = paperMode.value
    ? 'library.deletePaperConfirm'
    : book.format === 'pdf'
      ? 'library.deletePdfConfirm'
      : 'library.deleteConfirm'
  if (!(await askConfirm(t(confirmation, { title: book.title }), deleteConfirmOptions()))) return
  try {
    await library.removeBook(book.id)
    toast(t('library.deleted'), 'success')
  } catch (error: any) {
    toast(t('library.deleteFailed', { msg: error?.message ?? error }), 'error', 6000)
  }
}

// ---- URL 导入 ----
const showUrlModal = ref(false)
const urlDraft = ref('')
const urlImporting = ref('')

async function doUrlImport() {
  const url = urlDraft.value.trim()
  if (!url || urlImporting.value) return
  if (!/^https?:\/\//i.test(url)) {
    toast(t('library.urlInvalid'), 'error')
    return
  }
  urlImporting.value = t('common.connecting')
  const kind = pageKind.value
  const booklistId = kind === 'book' ? activeBooklistId.value : ''
  try {
    const result = await importFromUrl(url, p => {
      urlImporting.value = p.fraction != null
        ? t('library.urlDownloading', { pct: (p.fraction * 100).toFixed(0), mb: p.receivedMB })
        : t('library.urlDownloadingMB', { mb: p.receivedMB })
    }, { kind })
    if (!result.ok) throw new Error(result.error)
    await library.refresh()
    if (booklistId && result.bookId) await library.addBooksToBooklist(booklistId, [result.bookId])
    showUrlModal.value = false
    urlDraft.value = ''
    toast(t('library.importSuccess', { count: 1 }), 'success')
  } catch (e: any) {
    toast(t('library.urlImportFailed', { msg: e?.message ?? e }), 'error', 6000)
  } finally {
    urlImporting.value = ''
  }
}

// ---- 导入菜单 ----
const importMenu = ref(false)

// ---- 扫描书库目录散文件 (桌面端) ----
const scanLibrarySupported = canScanLibraryLoose()
const scanningLibrary = ref(false)

async function scanLibraryLoose() {
  importMenu.value = false
  if (importing.value || scanningLibrary.value) return
  scanningLibrary.value = true
  try {
    const res = await importLibraryLooseFiles()
    await library.refresh()
    if (res.imported > 0) {
      const extra = res.failed.length ? t('library.scanLooseFailed', { n: res.failed.length }) : ''
      toast(`${t('library.scanLooseImported', { n: res.imported })}${extra}`, res.failed.length ? 'error' : 'success', 5000)
    } else if (res.failed.length) {
      toast(t('library.scanLooseFailed', { n: res.failed.length }), 'error', 5000)
    } else {
      toast(t('library.scanLooseEmpty'), 'info')
    }
  } catch (e: any) {
    toast(t('library.scanLooseError', { msg: e?.message ?? String(e) }), 'error', 6000)
  } finally {
    scanningLibrary.value = false
  }
}

// ---- 批量管理 ----
function toggleManage() {
  manageMode.value = !manageMode.value
  selectedIds.value = new Set()
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function selectAll() {
  selectedIds.value = selectedIds.value.size === filtered.value.length
    ? new Set()
    : new Set(filtered.value.map(b => b.id))
}

async function batchDelete() {
  const count = selectedIds.value.size
  const includesPdf = [...selectedIds.value].some(id => library.books.some(book => book.id === id && book.format === 'pdf'))
  const confirmation = paperMode.value
    ? 'library.batchDeletePapersConfirm'
    : includesPdf
      ? 'library.batchDeleteWithAgentConfirm'
      : 'library.batchDeleteConfirm'
  if (!count || !(await askConfirm(t(confirmation, { count }), deleteConfirmOptions(t('library.batchDeleteTitle', { count }))))) return
  let deleted = 0
  try {
    for (const id of selectedIds.value) {
      await library.removeBook(id)
      deleted += 1
    }
    selectedIds.value = new Set()
    toast(t('library.batchDeleted', { count }), 'success')
  } catch (error: any) {
    selectedIds.value = new Set([...selectedIds.value].filter(id => library.books.some(book => book.id === id)))
    toast(t('library.batchDeleteFailed', { deleted, msg: error?.message ?? error }), 'error', 7000)
  }
}

async function batchTag() {
  const tags = tagDraft.value.split(/[,，、]/).map(t => t.trim()).filter(Boolean)
  const storage = await (await import('../storage')).getStorage()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    const merged = [...new Set([...book.tags, ...tags])]
    await storage.updateBook(id, { tags: merged })
    book.tags = merged
  }
  showTagModal.value = false
  tagDraft.value = ''
  toast(t('library.tagsAdded', { count: selectedIds.value.size }), 'success')
}

async function togglePin(book: BookMeta) {
  const storage = await (await import('../storage')).getStorage()
  const pinnedAt = book.pinnedAt ? 0 : Date.now()
  await storage.updateBook(book.id, { pinnedAt })
  book.pinnedAt = pinnedAt || undefined
  toast(pinnedAt ? t('library.pinned') : t('library.unpinned'), 'success')
}

async function batchPin(pin: boolean) {
  const storage = await (await import('../storage')).getStorage()
  let stamp = Date.now()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    const pinnedAt = pin ? stamp-- : 0
    await storage.updateBook(id, { pinnedAt })
    book.pinnedAt = pinnedAt || undefined
  }
  toast(pin ? t('library.pinned') : t('library.unpinned'), 'success')
}

/** 私密: 只留在本机, 不参与多端同步 (见 services/sync/engine.ts) */
async function batchPrivate(on: boolean) {
  await setPrivate([...selectedIds.value], on)
}

async function exportBook(book: BookMeta) {
  try {
    const ok = await exportSingleBook(book)
    if (ok) toast(t('library.exportDone'), 'success')
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    toast(t('library.exportFailed', { msg }), 'error', 6000)
  }
}

async function batchExport() {
  if (!selectedBooks.value.length) return
  try {
    const res = await exportBooksToFolder(selectedBooks.value)
    if (!res) return
    if (res.failed) {
      toast(t('library.batchExportPartial', { exported: res.exported, failed: res.failed, msg: res.firstError ?? '' }), 'error', 7000)
    } else {
      toast(t('library.batchExportDone', { count: res.exported }), 'success')
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    toast(t('library.exportFailed', { msg }), 'error', 6000)
  }
}
async function setPrivate(ids: string[], on: boolean) {
  const storage = await (await import('../storage')).getStorage()
  for (const id of ids) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    await storage.updateBook(id, { noSync: on })
    book.noSync = on || undefined
  }
  toast(on ? t('library.privateOn') : t('library.privateOff'), 'success')
}

// ---- 书单 ----
function booklistCount(id: string) {
  const ids = new Set(library.booklistBookIds[id] ?? [])
  return library.books.filter(
    book => (book.kind ?? 'book') === 'book' && ids.has(book.id)).length
}

function isBooklistNameTaken(name: string, ignoreId = '') {
  const normalized = name.trim().toLocaleLowerCase()
  return library.booklists.some(
    item => item.id !== ignoreId && item.name.trim().toLocaleLowerCase() === normalized)
}

function openCreateBooklist() {
  booklistDraft.value = ''
  showBooklistCreate.value = true
}

async function createBooklist() {
  const name = booklistDraft.value.trim()
  if (!name) return
  if (isBooklistNameTaken(name)) {
    toast(t('library.booklistNameExists'), 'error')
    return
  }
  const id = await library.createBooklist(name)
  activeBooklistId.value = id
  showBooklistCreate.value = false
  booklistDraft.value = ''
  toast(t('library.booklistCreated', { name }), 'success')
}

function openBooklistManage() {
  booklistRenames.value = Object.fromEntries(
    library.booklists.map(item => [item.id, item.name]))
  showBooklistManage.value = true
}

async function renameBooklist(id: string) {
  const name = booklistRenames.value[id]?.trim()
  const current = library.booklists.find(item => item.id === id)
  if (!name || !current || name === current.name) return
  if (isBooklistNameTaken(name, id)) {
    toast(t('library.booklistNameExists'), 'error')
    return
  }
  await library.renameBooklist(id, name)
  booklistRenames.value[id] = name
  toast(t('library.booklistRenamed'), 'success')
}

async function deleteBooklist(id: string) {
  const item = library.booklists.find(booklist => booklist.id === id)
  if (!item || !(await askConfirm(t('library.deleteBooklistConfirm', { name: item.name }), deleteConfirmOptions()))) return
  await library.deleteBooklist(id)
  if (activeBooklistId.value === id) activeBooklistId.value = ''
  delete booklistRenames.value[id]
  toast(t('library.booklistDeleted'), 'success')
}

function openBooklistPicker(ids: string[]) {
  if (!ids.length) return
  pickerBookIds.value = [...new Set(ids)]
  pickerDraft.value = ''
  showBooklistPicker.value = true
}

async function addPickerBooks(booklistId: string) {
  const item = library.booklists.find(booklist => booklist.id === booklistId)
  if (!item) return
  await library.addBooksToBooklist(booklistId, pickerBookIds.value)
  toast(t('library.addedToBooklist', {
    count: pickerBookIds.value.length,
    name: item.name,
  }), 'success')
  showBooklistPicker.value = false
}

async function createBooklistAndAdd() {
  const name = pickerDraft.value.trim()
  if (!name) return
  if (isBooklistNameTaken(name)) {
    toast(t('library.booklistNameExists'), 'error')
    return
  }
  const id = await library.createBooklist(name)
  await library.addBooksToBooklist(id, pickerBookIds.value)
  toast(t('library.addedToBooklist', {
    count: pickerBookIds.value.length,
    name,
  }), 'success')
  showBooklistPicker.value = false
  pickerDraft.value = ''
}

async function removeSelectedFromBooklist() {
  if (!activeBooklist.value || !selectedIds.value.size) return
  const count = selectedIds.value.size
  await library.removeBooksFromBooklist(
    activeBooklist.value.id, [...selectedIds.value])
  selectedIds.value = new Set()
  toast(t('library.removedFromBooklist', {
    count,
    name: activeBooklist.value.name,
  }), 'success')
}

// ---- 分类 (标签) 管理: 重命名 / 删除 ----
const showTagManage = ref(false)
const tagRenames = ref<Record<string, string>>({})

function openTagManage() {
  tagRenames.value = Object.fromEntries(allTags.value.map(tag => [tag, tag]))
  showTagManage.value = true
}

function tagCount(tag: string) {
  return library.books.filter(b => b.tags.includes(tag)).length
}

async function renameTag(oldName: string) {
  const newName = tagRenames.value[oldName]?.trim()
  if (!newName || newName === oldName) return
  const storage = await (await import('../storage')).getStorage()
  for (const book of library.books) {
    if (!book.tags.includes(oldName)) continue
    const tags = [...new Set(book.tags.map(x => (x === oldName ? newName : x)))]
    await storage.updateBook(book.id, { tags })
    book.tags = tags
  }
  if (tagFilter.value === oldName) tagFilter.value = newName
  delete tagRenames.value[oldName]
  tagRenames.value[newName] = newName
  toast(t('library.tagRenamed'), 'success')
}

async function deleteTag(tag: string) {
  if (!(await askConfirm(t('library.deleteTagConfirm', { tag }), deleteConfirmOptions()))) return
  const storage = await (await import('../storage')).getStorage()
  for (const book of library.books) {
    if (!book.tags.includes(tag)) continue
    const tags = book.tags.filter(x => x !== tag)
    await storage.updateBook(book.id, { tags })
    book.tags = tags
  }
  if (tagFilter.value === tag) tagFilter.value = ''
  delete tagRenames.value[tag]
  toast(t('library.tagDeleted'), 'success')
}

// ---- 手机藏书页 (≤720px): 继续阅读 / 列表标题 / 底部面板 / 选择栏; 桌面布局不变 ----
const phone = useMediaQuery(MQ.phone)
const addSheet = ref(false)
const menuBookId = ref('')
const batchMoreSheet = ref(false)
const booklistSheet = ref(false)
/** 桌面书单「⋯」菜单 */
const booklistMenu = ref(false)
const menuBook = computed(() => library.books.find(book => book.id === menuBookId.value))

/** 最近打开的书; 搜索 / 筛选 / 书单 / 选择时不显示 */
const resumeBook = computed(() => {
  if (manageMode.value) return undefined
  if (keyword.value.trim() || tagFilter.value || activeBooklistId.value || paperStatus.value) return undefined
  let last: BookMeta | undefined
  for (const book of kindBooks.value) if (book.lastReadAt && (!last || book.lastReadAt > (last.lastReadAt ?? 0))) last = book
  return last
})
const resumePercent = computed(() => Math.min(100, Math.max(0, Math.round((resumeBook.value?.progress ?? 0) * 100))))
function agoText(at: number) {
  const minutes = Math.floor((Date.now() - at) / 60000)
  if (minutes < 1) return t('library.agoJustNow')
  if (minutes < 60) return t('library.agoMinutes', { n: minutes })
  if (minutes < 1440) return t('library.agoHours', { n: Math.floor(minutes / 60) })
  return t('library.agoDays', { n: Math.floor(minutes / 1440) })
}

/** 论文页码: PDF 阅读器存 location=当前页, progress=当前页/总页数 */
function paperPages(book: BookMeta): { current: number; total: number } | undefined {
  const current = parseInt(book.location ?? '', 10)
  if (!current || !book.progress) return undefined
  return { current, total: Math.max(current, Math.round(current / book.progress)) }
}
function paperProgressText(book: BookMeta) {
  const pages = paperPages(book)
  if (pages) return t('library.paperPages', pages)
  return book.progress ? t('library.readPercent', { pct: Math.round(book.progress * 100) }) : t('library.unread')
}
const PAPER_STATES: PaperState[] = ['reading', 'unread', 'done']
const paperStateCounts = computed(() => {
  const counts: Record<PaperState, number> = { reading: 0, unread: 0, done: 0 }
  for (const book of kindBooks.value) counts[paperState(book)]++
  return counts
})
const PAPER_STATE_LABEL: Record<PaperState, string> = { reading: 'library.paperReading', unread: 'library.paperUnread', done: 'library.paperDone' }

/** 论文行长按进入选择 (书卡的长按在 BookCard 里) */
let pressTimer = 0
let pressPoint: { x: number; y: number } | null = null
let pressFired = false
function rowPressStart(book: BookMeta, event: PointerEvent) {
  if (manageMode.value || event.button > 0) return
  pressFired = false
  pressPoint = { x: event.clientX, y: event.clientY }
  clearTimeout(pressTimer)
  pressTimer = window.setTimeout(() => {
    pressFired = true
    onLongPress(book)
  }, 500)
}
function rowPressMove(event: PointerEvent) {
  if (pressPoint && Math.hypot(event.clientX - pressPoint.x, event.clientY - pressPoint.y) > 10) rowPressEnd()
}
function rowPressEnd() {
  clearTimeout(pressTimer)
  pressPoint = null
}
function onPaperRowClick(book: BookMeta) {
  if (pressFired) {
    pressFired = false
    return
  }
  if (manageMode.value) toggleSelect(book.id)
  else openBook(book)
}

const listScope = computed(() => {
  const count = t(paperMode.value ? 'library.paperCount' : 'library.bookCount', { count: filtered.value.length })
  const status = paperMode.value && paperStatus.value ? t(PAPER_STATE_LABEL[paperStatus.value]) : ''
  const scope = keyword.value.trim() ? t('library.searchResults') : activeBooklist.value?.name ?? (tagFilter.value || status)
  return t('library.listScope', { scope: scope || t('library.filterAll'), count })
})

/** 长按封面: 进入选择并选中这本 */
function onLongPress(book: BookMeta) {
  navigator.vibrate?.(12)
  manageMode.value = true
  selectedIds.value = new Set([book.id])
}
const selectedBooks = computed(() => library.books.filter(book => selectedIds.value.has(book.id)))
const allSelectedPinned = computed(() => !!selectedBooks.value.length && selectedBooks.value.every(book => book.pinnedAt))
const allSelectedPrivate = computed(() => !!selectedBooks.value.length && selectedBooks.value.every(book => book.noSync))

/* 先关面板再执行: AppModal 卸载前会拦下路由跳转, 也会让其它弹窗处于 inert */
async function bookMenuAction(run: (book: BookMeta) => unknown) {
  const book = menuBook.value
  menuBookId.value = ''
  await nextTick()
  if (book) await run(book)
}
async function batchMoreAction(run: () => unknown) {
  batchMoreSheet.value = false
  await nextTick()
  await run()
}
async function addAction(run: () => unknown) {
  addSheet.value = false
  await nextTick()
  await run()
}
async function booklistAction(run: () => unknown) {
  booklistSheet.value = false
  await nextTick()
  await run()
}

async function batchClearTags() {
  const storage = await (await import('../storage')).getStorage()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    await storage.updateBook(id, { tags: [] })
    book.tags = []
  }
  showTagModal.value = false
  toast(t('library.tagsCleared'), 'success')
}
</script>

<template>
  <div
    class="library"
    :class="{ dragging: dragging || nativeDragging }"
    @dragover.prevent="onDragOver"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
    @click="importMenu = false; booklistMenu = false"
  >
    <header v-show="!(phone && manageMode)" class="toolbar">
      <div class="heading">
        <h1>{{ paperMode ? t('nav.papers') : t('library.title') }}</h1>
        <span v-if="library.loaded && phone" class="count">
          {{ t(paperMode ? 'library.paperCount' : 'library.bookCount', { count: kindBooks.length }) }}<template v-if="totalReadingTime && !phone"> · {{ t('library.totalReading', { time: totalReadingTime }) }}</template>
        </span>
        <router-link
          v-if="!paperMode && (phone || !resumeBook)"
          to="/stats"
          class="today-link hit"
          :class="{ done: todayDone }"
          :title="t('stats.libraryTodayTitle', { m: todayMinutes })"
          :aria-label="t('stats.libraryTodayTitle', { m: todayMinutes })"
        >
          <svg v-if="goalMinutes > 0" class="today-ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" class="today-ring-track" />
            <circle
              cx="7"
              cy="7"
              r="5.5"
              class="today-ring-fill"
              :stroke-dasharray="TODAY_RING_C"
              :stroke-dashoffset="TODAY_RING_C * (1 - todayRatio)"
            />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 13a1.5 1.5 0 0 1 3 0v5.5a1.5 1.5 0 0 1-3 0V13zm6.5-5a1.5 1.5 0 0 1 3 0v10.5a1.5 1.5 0 0 1-3 0V8zM17 4.5a1.5 1.5 0 0 1 3 0v14a1.5 1.5 0 0 1-3 0v-14z"/></svg>
          <span class="hide-narrow">{{ goalMinutes > 0 && !todayDone ? t('stats.libraryTodayGoal', { m: todayMinutes, goal: goalMinutes }) : t('stats.libraryToday', { m: todayMinutes }) }}</span>
          <span class="only-narrow">{{ goalMinutes > 0 && !todayDone ? t('stats.libraryTodayGoalShort', { m: todayMinutes, goal: goalMinutes }) : t('stats.libraryTodayShort', { m: todayMinutes }) }}</span>
        </router-link>
      </div>
      <div class="spacer" />
      <div class="search-field">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 0 1 5.96 12.06l4.24 4.24a1 1 0 0 1-1.42 1.4l-4.24-4.23A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/></svg>
        <input
          v-model="keyword"
          class="input search"
          type="search"
          :placeholder="t(paperMode ? 'library.searchPapersPlaceholder' : 'library.searchPlaceholder')"
          :aria-label="t('common.search')"
          autocomplete="off"
          spellcheck="false"
        />
        <button v-if="keyword" type="button" class="search-clear" :aria-label="t('common.clear')" @click="keyword = ''">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.6 12l-5.3 5.3a1 1 0 1 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3z"/></svg>
        </button>
      </div>
      <!-- 手机: 圆形「＋」, 添加方式在底部面板里 -->
      <button
        v-if="phone"
        class="add-fab"
        :disabled="importing"
        :title="t(paperMode ? 'library.importPapers' : 'library.import')"
        :aria-label="t(paperMode ? 'library.importPapers' : 'library.import')"
        aria-haspopup="dialog"
        @click.stop="addSheet = true"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
      </button>
      <div v-else class="import-group">
        <button
          class="btn btn-primary import-main"
          :disabled="importing"
          :aria-label="t(paperMode ? 'library.importPapers' : 'library.import')"
          @click="chooseFiles()"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          <span class="hide-narrow">{{ t(paperMode ? 'library.importPapers' : 'library.import') }}</span>
          <span class="only-narrow">{{ t('library.importShort') }}</span>
        </button>
        <button
          class="btn btn-primary import-caret"
          :title="t('library.moreImport')"
          :aria-label="t('library.moreImport')"
          aria-haspopup="menu"
          :aria-expanded="importMenu"
          @click.stop="importMenu = !importMenu"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42z"/></svg>
        </button>
        <div v-if="importMenu" class="import-menu card" role="menu">
          <button role="menuitem" @click="importMenu = false; chooseFiles()">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 6a3 3 0 0 1 3-3h3.6a3 3 0 0 1 2.1.9L14.4 5.6a1 1 0 0 0 .7.3H17a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6zm3-1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8.9a1 1 0 0 0-1-1h-1.9a3 3 0 0 1-2.1-.9L11.3 5.3a1 1 0 0 0-.7-.3H7z"/></svg>
            {{ t('library.importLocal') }}
          </button>
          <button v-if="folderSupported" role="menuitem" class="import-folder" @click="chooseFolder()">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 11h8M8 15h5"/></svg>
            {{ t('folder.choose') }}
          </button>
          <button v-if="scanLibrarySupported" role="menuitem" :disabled="scanningLibrary" @click="scanLibraryLoose()">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 21l-4.35-4.35M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z"/></svg>
            {{ scanningLibrary ? t('library.scanLooseRunning') : t('library.scanLoose') }}
          </button>
          <button role="menuitem" @click="importMenu = false; showUrlModal = true">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10.6 13.4a1 1 0 0 1 0-1.4l2.8-2.8a1 1 0 0 1 1.4 1.4l-2.8 2.8a1 1 0 0 1-1.4 0zM7 17a3 3 0 0 1 0-4.24l2.12-2.12a1 1 0 1 1 1.42 1.42L8.4 14.17a1 1 0 0 0 1.42 1.42l2.12-2.12a1 1 0 1 1 1.41 1.41L11.24 17A3 3 0 0 1 7 17zm10-10a3 3 0 0 1 0 4.24l-2.12 2.12a1 1 0 1 1-1.42-1.42l2.12-2.11a1 1 0 0 0-1.42-1.42l-2.12 2.12a1 1 0 0 1-1.41-1.41L12.76 7A3 3 0 0 1 17 7z"/></svg>
            {{ t('library.urlImportTitle') }}
          </button>
          <button role="menuitem" @click="uploadBooks()">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 18H5a4 4 0 0 1-.6-8 7 7 0 0 1 13.4-2 5 5 0 0 1 1.2 10h-2M12 20V10m-4 4 4-4 4 4"/></svg>
            {{ t('library.uploadToCloud') }}
          </button>
          <!-- 互传入口 (手机底部标签栏没有「互传」); 设置里关闭互传时隐藏 -->
          <button v-if="settings.features.transfer" role="menuitem" @click="importMenu = false; router.push('/transfer')">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16.3 3.3a1 1 0 0 1 1.4 0l3 3a1 1 0 0 1 0 1.4l-3 3a1 1 0 1 1-1.4-1.4L17.58 8H5a1 1 0 0 1 0-2h12.59l-1.3-1.3a1 1 0 0 1 0-1.4zM7.7 13.3a1 1 0 0 1 0 1.4L6.42 16H19a1 1 0 1 1 0 2H6.41l1.3 1.3a1 1 0 1 1-1.42 1.4l-3-3a1 1 0 0 1 0-1.4l3-3a1 1 0 0 1 1.42 0z"/></svg>
            {{ t('transfer.libraryEntry') }}
          </button>
        </div>
      </div>
      <!-- 手机端换行点: 标题+今日+添加 一行, 搜索一行 (排序 / 选择在书格上方的列表标题里) -->
      <span class="row-break" aria-hidden="true" />
      <input ref="fileInput" type="file" multiple :accept="ACCEPT_READABLE" hidden @change="onPick" />
      <!-- 选文件夹: 不带 multiple, e2e 的 input[type=file][multiple] 仍只指向上面的文件输入框 -->
      <input v-if="folderSupported" ref="folderInput" type="file" webkitdirectory hidden data-folder-input @change="onFolderPick" />
    </header>
    <!-- 手机端的格式说明在添加面板里 -->
    <p v-if="!phone && activeBooklist" class="add-books-hint">{{ t('library.addIntoBooklist', { name: activeBooklist.name }) }}</p>

    <!-- 手机: 继续阅读 (最近打开的书) -->
    <section v-if="resumeBook" class="resume card" role="button" tabindex="0" :aria-label="`${t('library.continueReading')}: ${resumeBook.title}`" @click="openBook(resumeBook)" @keydown.enter.prevent="openBook(resumeBook)">
      <div class="resume-cover" aria-hidden="true">
        <img v-if="library.coverUrls[resumeBook.id]" :src="library.coverUrls[resumeBook.id]" alt="" decoding="async" />
        <span v-else class="resume-cover-title">{{ shortTitle(resumeBook.title) }}</span>
      </div>
      <div class="resume-info">
        <span class="resume-eyebrow">{{ t('library.continueReadingAgo', { time: agoText(resumeBook.lastReadAt!) }) }}</span>
        <span class="resume-title">{{ shortTitle(resumeBook.title) }}</span>
        <span class="resume-author">{{ (paperMode ? resumeBook.author : shortAuthor(resumeBook.author)) || t('common.anonymous') }}</span>
        <span class="resume-foot">
          <span class="resume-track" aria-hidden="true"><span class="resume-fill" :style="{ width: `${Math.max(resumePercent, 2)}%` }" /></span>
          <span class="resume-pct">{{ paperMode ? paperProgressText(resumeBook) : `${resumePercent}%` }}</span>
          <span class="resume-go" aria-hidden="true">{{ t('library.continue') }}</span>
        </span>
      </div>
      <!-- 桌面: 今日 / 本周时长并入继续阅读卡 (页头不再单独放今日入口) -->
      <div v-if="!phone && !paperMode" class="resume-stats">
        <router-link to="/stats" class="resume-stat" :title="t('stats.libraryTodayTitle', { m: todayMinutes })" @click.stop @keydown.enter.stop>
          <b>{{ todayMinutes }}<small>{{ goalMinutes > 0 ? t('library.statGoalMinutes', { goal: goalMinutes }) : t('library.statMinutes') }}</small></b>
          <span :class="{ done: todayDone }">{{ t('library.statToday') }}</span>
        </router-link>
        <router-link to="/stats" class="resume-stat" @click.stop @keydown.enter.stop>
          <b>{{ weekStat.value }}<small>{{ weekStat.unit }}</small></b>
          <span>{{ t('library.statWeek') }}</span>
        </router-link>
      </div>
    </section>

    <!-- 书架标题行 (桌面): 左侧书单 / 论文筛选, 右侧排序与管理; 手机上 display: contents, 布局不变 -->
    <div class="shelf-head" :class="{ desktop: !phone }">
    <!-- 书单: 一级内容分组，可与标签和搜索组合筛选; 手机上只有建过书单才出现, 操作在添加面板 / 列表标题里 -->
    <section v-if="!paperMode && (!phone || library.booklists.length)" class="booklist-section">
      <div class="booklist-row">
        <button
          class="booklist-chip"
          :class="{ active: !activeBooklistId }"
          @click="activeBooklistId = ''"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5A.5.5 0 0 0 6 5.5V16.05c.16-.03.32-.05.5-.05H18V5H6.5zM6 18.5a.5.5 0 0 0 .5.5H18v-1H6.5a.5.5 0 0 0-.5.5z"/></svg>
          <span>{{ t('library.allBooks') }}</span>
          <span class="booklist-count">{{ kindBooks.length }}</span>
        </button>
        <button
          v-for="item in library.booklists"
          :key="item.id"
          class="booklist-chip"
          :class="{ active: activeBooklistId === item.id }"
          @click="activeBooklistId = item.id"
        >
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5 4a2 2 0 0 1 2-2h9a3 3 0 0 1 3 3v15a1 1 0 0 1-1.45.9L12 18.12 6.45 20.9A1 1 0 0 1 5 20V4zm2 0v14.38l4.55-2.28a1 1 0 0 1 .9 0L17 18.38V5a1 1 0 0 0-1-1H7z"/></svg>
          <span>{{ item.name }}</span>
          <span class="booklist-count">{{ booklistCount(item.id) }}</span>
        </button>
        <button class="booklist-add-chip" :title="t('library.newBooklist')" :aria-label="t('library.newBooklist')" @click="openCreateBooklist">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
        </button>
        <!-- 桌面: 书单的其余操作收进「⋯」 -->
        <div v-if="!phone" class="booklist-heading" @click.stop>
          <button
            class="booklist-more"
            :class="{ open: booklistMenu }"
            :title="t('library.booklistActions')"
            :aria-label="t('library.booklistActions')"
            aria-haspopup="menu"
            :aria-expanded="booklistMenu"
            @click="booklistMenu = !booklistMenu"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>
          </button>
          <div v-if="booklistMenu" class="booklist-menu" role="menu" @keydown.esc="booklistMenu = false">
            <button role="menuitem" @click="booklistMenu = false; showBooklistImport = true">{{ t('booklist.import') }}</button>
            <button v-if="library.booklists.length" role="menuitem" @click="booklistMenu = false; openBooklistManage()">{{ t('library.manageBooklists') }}</button>
            <template v-if="activeBooklist">
              <hr />
              <button v-if="booklistCount(activeBooklist.id)" role="menuitem" @click="booklistMenu = false; uploadBooks(library.booklistBookIds[activeBooklist.id] ?? [])">{{ t('library.uploadBooklist') }}</button>
              <button role="menuitem" @click="booklistMenu = false; showBooklistShare = true">{{ t('booklist.share') }}</button>
            </template>
          </div>
        </div>
      </div>
    </section>

    <!-- 手机论文页: 阅读状态 + 标签合成一行可横滑的筛选 -->
    <div v-if="paperMode && kindBooks.length && !(phone && manageMode)" class="paper-chips" role="group" :aria-label="t('library.paperFilter')">
      <button class="paper-chip" :class="{ active: !paperStatus && !tagFilter }" :aria-pressed="!paperStatus && !tagFilter" @click="paperStatus = ''; tagFilter = ''">
        {{ t('library.filterAll') }}<span class="paper-chip-n">{{ kindBooks.length }}</span>
      </button>
      <button
        v-for="state in PAPER_STATES"
        :key="state"
        class="paper-chip"
        :class="{ active: paperStatus === state }"
        :aria-pressed="paperStatus === state"
        @click="paperStatus = paperStatus === state ? '' : state"
      >{{ t(PAPER_STATE_LABEL[state]) }}<span class="paper-chip-n">{{ paperStateCounts[state] }}</span></button>
      <button
        v-for="tag in allTags"
        :key="tag"
        class="paper-chip"
        :class="{ active: tagFilter === tag }"
        :aria-pressed="tagFilter === tag"
        @click="tagFilter = tagFilter === tag ? '' : tag"
      >{{ tag }}</button>
      <button v-if="allTags.length" class="paper-chip ghost" @click="openTagManage">{{ t('library.manageTags') }}</button>
    </div>
    <div v-if="!phone && library.loaded && kindBooks.length" class="shelf-tools">
      <AppSelect v-model="sortBy" class="input sort" :aria-label="t('common.sortBy')">
        <option value="recent">{{ t('library.sortRecent') }}</option>
        <option value="added">{{ t('library.sortAdded') }}</option>
        <option value="title">{{ t(paperMode ? 'library.sortPaperTitle' : 'library.sortTitle') }}</option>
        <option value="author">{{ t('library.sortAuthor') }}</option>
      </AppSelect>
      <button class="btn btn-sm" :class="manageMode ? 'btn-primary' : 'btn-ghost'" :aria-pressed="manageMode" @click="toggleManage">
        {{ manageMode ? t('common.done') : t('library.manage') }}
      </button>
    </div>
    </div>

    <!-- 标签筛选 -->
    <div v-if="allTags.length && !paperMode" class="tag-row">
      <button class="tag-chip" :class="{ active: !tagFilter }" :aria-pressed="!tagFilter" @click="tagFilter = ''">{{ t('library.filterAll') }}</button>
      <button
        v-for="tag in allTags"
        :key="tag"
        class="tag-chip"
        :class="{ active: tagFilter === tag }"
        :aria-pressed="tagFilter === tag"
        @click="tagFilter = tagFilter === tag ? '' : tag"
      >{{ tag }}</button>
      <button class="tag-chip tag-manage" :title="t('library.manageTags')" @click="openTagManage">
        <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16.9 3.1a2.5 2.5 0 0 1 3.54 0l.46.46a2.5 2.5 0 0 1 0 3.54L9.83 18.17a2 2 0 0 1-.9.52l-3.67 1a1 1 0 0 1-1.23-1.23l1-3.67a2 2 0 0 1 .52-.9L16.9 3.1zm2.12 1.42a.5.5 0 0 0-.7 0l-1.1 1.08 1.17 1.18 1.09-1.1a.5.5 0 0 0 0-.7l-.46-.46zM16.97 8.2 15.8 7.03 7 15.84l-.59 2.16 2.16-.59 8.4-9.2z"/></svg>
        {{ t('library.manageTags') }}
      </button>
    </div>

    <div v-if="converting" class="import-bar card convert-bar" role="status">
      <div class="import-text">
        {{ converting.total > 1
          ? t('convert.progressBatch', { done: converting.done + 1, total: converting.total, name: converting.current, pct: converting.pct })
          : t('convert.progress', { name: converting.current, pct: converting.pct }) }}
      </div>
      <div class="import-track" role="progressbar" :aria-valuenow="convertPercent" aria-valuemin="0" aria-valuemax="100" :aria-label="t('book.convertToEpub')">
        <div class="import-fill" :style="{ width: `${convertPercent}%` }" />
      </div>
    </div>

    <p v-if="scanningDrop && !importing" role="status">{{ t('folder.scanning') }}</p>
    <div v-if="importing" class="import-bar card" role="status" aria-live="polite">
      <div class="import-text">
        {{ t('library.importing', { name: importState.current, done: Math.min(importState.done + 1, importState.total), total: importState.total }) }}
      </div>
      <div class="import-track">
        <div class="import-fill" :style="{ width: `${(importState.done / Math.max(importState.total, 1)) * 100}%` }" />
      </div>
    </div>

    <!-- 手机: 列表标题 (范围 · 数量 / 排序 / 选择) -->
    <div v-if="phone && library.loaded && kindBooks.length && !manageMode" class="list-head">
      <span class="list-scope">{{ listScope }}</span>
      <AppSelect v-model="sortBy" class="list-sort" :aria-label="t('common.sortBy')">
        <option value="recent">{{ t('library.sortRecent') }}</option>
        <option value="added">{{ t('library.sortAdded') }}</option>
        <option value="title">{{ t(paperMode ? 'library.sortPaperTitle' : 'library.sortTitle') }}</option>
        <option value="author">{{ t('library.sortAuthor') }}</option>
      </AppSelect>
      <button v-if="activeBooklist" class="list-icon-btn" :title="t('library.booklistActions')" :aria-label="t('library.booklistActions')" @click="booklistSheet = true">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>
      </button>
      <button class="list-text-btn" @click="toggleManage">{{ t('library.select') }}</button>
    </div>

    <!-- 手机选择模式: 顶部「取消 · 已选 N 本 · 全选」 -->
    <div v-if="phone && manageMode" class="phone-selectbar">
      <button class="list-text-btn" @click="toggleManage">{{ t('common.cancel') }}</button>
      <span class="phone-selectbar-label">{{ selectedIds.size ? t('library.selectedCount', { count: selectedIds.size }) : t('library.selectBooks') }}</span>
      <button class="list-text-btn" @click="selectAll">
        {{ selectedIds.size === filtered.length && filtered.length ? t('library.deselectAll') : t('library.selectAll') }}
      </button>
    </div>

    <div v-if="!library.loaded" class="grid" aria-busy="true" :aria-label="t('library.loading')">
      <div v-for="i in 12" :key="i" class="skeleton-card">
        <div class="skeleton skeleton-cover" />
        <div class="skeleton skeleton-line" />
        <div class="skeleton skeleton-line short" />
      </div>
    </div>

    <div v-else-if="!kindBooks.length" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg v-if="paperMode" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6M9 9h1"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 11h5"/></svg>
      </div>
      <p class="empty-title">{{ t(paperMode ? 'library.papersEmptyTitle' : 'library.emptyTitle') }}</p>
      <p class="hint">
        <template v-if="paperMode">{{ t('library.papersEmptyHint') }}</template>
        <template v-else>{{ t(touchPrimary ? 'library.emptyHintTouch' : 'library.emptyHint') }}<br />{{ t('library.supportedFormats') }}</template>
      </p>
      <div class="empty-actions">
        <button class="btn btn-primary" @click="chooseFiles()">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t(paperMode ? 'library.importPapers' : 'library.import') }}
        </button>
        <button v-if="folderSupported" class="btn" @click="chooseFolder()">{{ t('folder.choose') }}</button>
        <router-link to="/catalogs" class="btn">{{ t(paperMode ? 'library.browsePapers' : 'library.browseCatalogs') }}</router-link>
      </div>
    </div>

    <div
      v-else-if="activeBooklist && !filtered.length && !keyword.trim() && !tagFilter && !activeWanted.length"
      class="empty booklist-empty"
    >
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-3.5L5 21V4a1 1 0 0 1 1-1z"/></svg>
      </div>
      <p class="empty-title">{{ t('library.emptyBooklist') }}</p>
      <p class="hint">{{ t('library.emptyBooklistHint') }}</p>
      <div class="empty-actions">
        <button class="btn btn-primary" @click="activeBooklistId = ''; manageMode = true">
          {{ t('library.chooseBooks') }}
        </button>
      </div>
    </div>

    <div v-else-if="!filtered.length && !showOnlyWanted" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </div>
      <p class="empty-title">{{ t('reader.noResults') }}</p>
      <div class="empty-actions">
        <button class="btn" @click="keyword = ''; tagFilter = ''; paperStatus = ''">{{ t('common.clear') }}</button>
      </div>
    </div>

    <!-- 手机论文页: 列表 (论文首页缩略图大同小异, 标题长, 列表更好扫) -->
    <ul v-else-if="filtered.length && phone && paperMode" class="paper-list card" :class="{ selecting: manageMode }">
      <li
        v-for="book in filtered"
        :key="book.id"
        class="paper-row"
        :class="{ selected: selectedIds.has(book.id) }"
        role="button"
        tabindex="0"
        :aria-pressed="manageMode ? selectedIds.has(book.id) : undefined"
        :aria-label="book.title"
        @click="onPaperRowClick(book)"
        @keydown.enter.prevent="onPaperRowClick(book)"
        @pointerdown="rowPressStart(book, $event)"
        @pointermove="rowPressMove"
        @pointerup="rowPressEnd"
        @pointercancel="rowPressEnd"
        @contextmenu.prevent
      >
        <span v-if="manageMode" class="paper-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/></svg>
        </span>
        <span class="paper-thumb" aria-hidden="true">
          <img v-if="library.coverUrls[book.id]" :src="library.coverUrls[book.id]" alt="" loading="lazy" decoding="async" />
          <template v-else><b /><i /><i class="short" /><i /><i /><i /></template>
        </span>
        <span class="paper-text">
          <span class="paper-title">
            <svg v-if="book.pinnedAt" class="paper-pin" viewBox="0 0 24 24" width="12" height="12" :aria-label="t('library.pin')"><path fill="currentColor" d="M14.6 2.6a2 2 0 0 1 2.83 0l4 4a2 2 0 0 1 0 2.82l-3.18 3.18.35 2.47a2 2 0 0 1-.56 1.7l-1.1 1.1a1 1 0 0 1-1.42 0L11.6 13.9l-5.9 5.9a1 1 0 0 1-1.4-1.42l5.88-5.89-3.95-3.95a1 1 0 0 1 0-1.41l1.1-1.1a2 2 0 0 1 1.7-.57l2.47.35 3.1-3.2z"/></svg>
            {{ book.title }}
          </span>
          <span class="paper-author">{{ book.author || t('common.anonymous') }}</span>
          <span class="paper-meta">
            <template v-if="paperState(book) === 'done'"><span class="paper-done">{{ t('library.paperDone') }}</span></template>
            <template v-else-if="book.progress">
              <span class="paper-track"><span :style="{ width: `${Math.max(2, Math.round(book.progress * 100))}%` }" /></span>
              <span>{{ paperProgressText(book) }}</span>
            </template>
            <span v-else>{{ t('library.unread') }}</span>
            <span v-if="book.noSync" class="paper-badge">{{ t('library.privateBadge') }}</span>
            <span v-for="tag in book.tags.slice(0, 2)" :key="tag" class="paper-badge">{{ tag }}</span>
          </span>
        </span>
        <button
          v-if="!manageMode"
          class="paper-more"
          :title="t('common.moreActions')"
          :aria-label="t('common.moreActions')"
          @click.stop="menuBookId = book.id"
          @pointerdown.stop
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>
        </button>
      </li>
    </ul>

    <div v-else-if="filtered.length" class="grid">
      <BookCard
        v-for="book in filtered"
        :key="book.id"
        :book="book"
        :cover-url="library.coverUrls[book.id]"
        :selectable="manageMode"
        :selected="selectedIds.has(book.id)"
        :show-booklists="!paperMode"
        :convertible="canConvertToEpub(book.format)"
        :converting="!!converting"
        :sendable="settings.features.transfer"
        :compact="phone"
        @open="openBook(book)"
        @menu="menuBookId = book.id"
        @long-press="onLongPress(book)"
        @remove="removeBook(book)"
        @toggle-select="toggleSelect(book.id)"
        @toggle-pin="togglePin(book)"
        @add-to-booklist="openBooklistPicker([book.id])"
        @export="exportBook(book)"
        @convert="convertBooks([book.id])"
        @send="sendBookToDevices(book.id)"
        @toggle-private="setPrivate([book.id], !book.noSync)"
      />
    </div>

    <!-- 书单里还不在藏书中的书 (待找) -->
    <BooklistWantedPanel
      v-if="activeBooklist && library.loaded && !paperMode"
      :key="activeBooklist.id"
      :booklist-id="activeBooklist.id"
      :keyword="keyword"
    />

    <!-- 批量操作栏 -->
    <div v-if="manageMode && !phone" class="batch-bar card" role="toolbar" :aria-label="t('library.manage')">
      <span class="batch-count">{{ t('library.selectedCount', { count: selectedIds.size }) }}</span>
      <button class="btn btn-sm" @click="selectAll">
        {{ selectedIds.size === filtered.length && filtered.length ? t('library.deselectAll') : t('library.selectAll') }}
      </button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="uploadBooks([...selectedIds])">{{ t('library.uploadToCloud') }}</button>
      <button v-if="anyConvertible" class="btn btn-sm" :disabled="!selectedIds.size || !!converting" @click="convertBooks([...selectedIds])">{{ t('book.convertToEpub') }}</button>
      <button
        v-if="!paperMode"
        class="btn btn-sm"
        :disabled="!selectedIds.size"
        @click="openBooklistPicker([...selectedIds])"
      >{{ t('library.addToBooklist') }}</button>
      <button
        v-if="activeBooklist"
        class="btn btn-sm"
        :disabled="!selectedIds.size"
        @click="removeSelectedFromBooklist"
      >{{ t('library.removeFromBooklist') }}</button>
      <!-- 置顶 / 私密各一个按钮, 按所选书的现状切换 (同手机操作栏), 一行放得下 -->
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPin(!allSelectedPinned)">{{ allSelectedPinned ? t('library.unpin') : t('library.pin') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPrivate(!allSelectedPrivate)">{{ allSelectedPrivate ? t('library.unsetPrivate') : t('library.setPrivate') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="showTagModal = true">{{ t('library.setTags') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchExport">{{ t('library.batchExport') }}</button>
      <button class="btn btn-sm btn-danger" :disabled="!selectedIds.size" @click="batchDelete">{{ t('common.delete') }}</button>
      <button class="btn btn-sm" @click="toggleManage">{{ t('common.done') }}</button>
    </div>

    <!-- 手机批量操作: 盖住底部标签栏, 常用 4 项, 其余在「更多」 -->
    <nav v-if="manageMode && phone" class="phone-actionbar" :aria-label="t('library.manage')">
      <button v-if="!paperMode" :disabled="!selectedIds.size" @click="openBooklistPicker([...selectedIds])">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-3.5L5 21V4a1 1 0 0 1 1-1z"/></svg>
        {{ t('library.addToBooklist') }}
      </button>
      <button :disabled="!selectedIds.size" @click="batchPin(!allSelectedPinned)">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 4h14M12 20V9m-5 5 5-5 5 5"/></svg>
        {{ allSelectedPinned ? t('library.unpin') : t('library.pin') }}
      </button>
      <button class="danger" :disabled="!selectedIds.size" @click="batchDelete">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
        {{ t('common.delete') }}
      </button>
      <button :disabled="!selectedIds.size" @click="batchMoreSheet = true">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>
        {{ t('library.batchMore') }}
      </button>
    </nav>

    <!-- 手机: 添加面板 -->
    <AppModal v-if="addSheet" :title="t(paperMode ? 'library.importPapers' : 'library.import')" @close="addSheet = false">
      <div class="sheet-list">
        <button class="sheet-row" @click="addAction(chooseFiles)">
          <span class="sheet-ico brand"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.importLocal') }}</span><span class="sheet-desc">{{ t('library.addLocalDesc') }}</span></span>
        </button>
        <button v-if="folderSupported" class="sheet-row" @click="addAction(chooseFolder)">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('folder.choose') }}</span><span class="sheet-desc">{{ t('library.addFolderDesc') }}</span></span>
        </button>
        <button class="sheet-row" @click="addAction(() => (showUrlModal = true))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.urlImportTitle') }}</span><span class="sheet-desc">{{ t('library.addUrlDesc') }}</span></span>
        </button>
        <button v-if="paperMode" class="sheet-row" @click="addAction(() => router.push('/catalogs'))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.addArxiv') }}</span><span class="sheet-desc">{{ t('library.addArxivDesc') }}</span></span>
        </button>
        <button class="sheet-row" @click="addAction(() => uploadBooks())">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 18H5a4 4 0 0 1-.6-8 7 7 0 0 1 13.4-2 5 5 0 0 1 1.2 10h-2M12 20V10m-4 4 4-4 4 4"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.uploadToCloud') }}</span><span class="sheet-desc">{{ t('library.addCloudDesc') }}</span></span>
        </button>
        <button v-if="settings.features.transfer" class="sheet-row" @click="addAction(() => router.push('/transfer'))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3l3 3-3 3M20 6H5M7 21l-3-3 3-3M4 18h15"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.addTransfer') }}</span><span class="sheet-desc">{{ t('library.addTransferDesc') }}</span></span>
        </button>
        <template v-if="!paperMode">
          <div class="sheet-sep" />
          <button class="sheet-row" @click="addAction(openCreateBooklist)">
            <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-3.5L5 21V4a1 1 0 0 1 1-1z"/></svg></span>
            <span class="sheet-text"><span class="sheet-label">{{ t('library.newBooklist') }}</span></span>
          </button>
          <button class="sheet-row" @click="addAction(() => (showBooklistImport = true))">
            <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg></span>
            <span class="sheet-text"><span class="sheet-label">{{ t('booklist.import') }}</span></span>
          </button>
          <button v-if="library.booklists.length" class="sheet-row" @click="addAction(openBooklistManage)">
            <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg></span>
            <span class="sheet-text"><span class="sheet-label">{{ t('library.manageBooklists') }}</span></span>
          </button>
        </template>
      </div>
    </AppModal>

    <!-- 手机: 单本书操作面板 (书卡「⋯」) -->
    <AppModal v-if="menuBook" :title="shortTitle(menuBook.title)" :description="[menuBook.format.toUpperCase(), paperMode ? paperProgressText(menuBook) : menuBook.progress ? t('library.readPercent', { pct: Math.round(menuBook.progress * 100) }) : t('library.unread'), shortAuthor(menuBook.author) || t('common.anonymous')].join(' · ')" @close="menuBookId = ''">
      <div class="sheet-list">
        <button v-if="!paperMode" class="sheet-row" @click="bookMenuAction(book => openBooklistPicker([book.id]))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-3.5L5 21V4a1 1 0 0 1 1-1z"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.addToBooklist') }}</span></span>
        </button>
        <button class="sheet-row" @click="bookMenuAction(togglePin)">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 4h14M12 20V9m-5 5 5-5 5 5"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ menuBook.pinnedAt ? t('library.unpin') : t('library.pin') }}</span></span>
        </button>
        <button v-if="settings.features.transfer" class="sheet-row" @click="bookMenuAction(book => sendBookToDevices(book.id))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('transfer.sendToDevices') }}</span></span>
        </button>
        <button class="sheet-row" @click="bookMenuAction(book => uploadBooks([book.id]))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 18H5a4 4 0 0 1-.6-8 7 7 0 0 1 13.4-2 5 5 0 0 1 1.2 10h-2M12 20V10m-4 4 4-4 4 4"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.uploadToCloud') }}</span></span>
        </button>
        <button v-if="canConvertToEpub(menuBook.format)" class="sheet-row" :disabled="!!converting" @click="bookMenuAction(book => convertBooks([book.id]))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h13l-3.5-3.5M20 15H7l3.5 3.5"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('book.convertToEpub') }}</span></span>
        </button>
        <button class="sheet-row" @click="bookMenuAction(book => setPrivate([book.id], !book.noSync))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ menuBook.noSync ? t('library.unsetPrivate') : t('library.setPrivate') }}</span><span class="sheet-desc">{{ t('library.privateDesc') }}</span></span>
        </button>
        <button class="sheet-row danger" @click="bookMenuAction(removeBook)">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('book.removeFromLibrary') }}</span></span>
        </button>
      </div>
    </AppModal>

    <!-- 手机: 批量「更多」 -->
    <AppModal v-if="batchMoreSheet" :title="t('library.selectedCount', { count: selectedIds.size })" @close="batchMoreSheet = false">
      <div class="sheet-list">
        <button class="sheet-row" @click="batchMoreAction(() => uploadBooks([...selectedIds]))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 18H5a4 4 0 0 1-.6-8 7 7 0 0 1 13.4-2 5 5 0 0 1 1.2 10h-2M12 20V10m-4 4 4-4 4 4"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.uploadToCloud') }}</span></span>
        </button>
        <button v-if="anyConvertible" class="sheet-row" :disabled="!!converting" @click="batchMoreAction(() => convertBooks([...selectedIds]))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h13l-3.5-3.5M20 15H7l3.5 3.5"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('book.convertToEpub') }}</span></span>
        </button>
        <button v-if="activeBooklist" class="sheet-row" @click="batchMoreAction(removeSelectedFromBooklist)">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-3.5L5 21V4a1 1 0 0 1 1-1zM9 10h6"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.removeFromBooklist') }}</span></span>
        </button>
        <button class="sheet-row" @click="batchMoreAction(() => batchPrivate(!allSelectedPrivate))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ allSelectedPrivate ? t('library.unsetPrivate') : t('library.setPrivate') }}</span><span class="sheet-desc">{{ t('library.privateDesc') }}</span></span>
        </button>
        <button class="sheet-row" @click="batchMoreAction(() => (showTagModal = true))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.4" fill="currentColor" stroke="none"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.setTags') }}</span></span>
        </button>
      </div>
    </AppModal>

    <!-- 手机: 当前书单的操作 -->
    <AppModal v-if="booklistSheet && activeBooklist" :title="activeBooklist.name" @close="booklistSheet = false">
      <div class="sheet-list">
        <button class="sheet-row" @click="booklistAction(() => (showBooklistShare = true))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('booklist.share') }}</span></span>
        </button>
        <button v-if="booklistCount(activeBooklist.id)" class="sheet-row" @click="booklistAction(() => uploadBooks(library.booklistBookIds[activeBooklist!.id] ?? []))">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 18H5a4 4 0 0 1-.6-8 7 7 0 0 1 13.4-2 5 5 0 0 1 1.2 10h-2M12 20V10m-4 4 4-4 4 4"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.uploadBooklist') }}</span></span>
        </button>
        <button class="sheet-row" @click="booklistAction(openBooklistManage)">
          <span class="sheet-ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg></span>
          <span class="sheet-text"><span class="sheet-label">{{ t('library.manageBooklists') }}</span></span>
        </button>
      </div>
    </AppModal>

    <BooklistShareDialog v-if="showBooklistShare && activeBooklist" :booklist-id="activeBooklist.id" @close="showBooklistShare = false" />
    <BooklistImportDialog v-if="showBooklistImport" @close="showBooklistImport = false" @imported="id => (activeBooklistId = id)" />

    <LibraryUploadDialog v-if="showCloudUpload" :book-ids="cloudBookIds" @close="showCloudUpload = false" />
    <FolderPickDialog
      v-if="folderPick"
      action="import"
      :scanning="folderPick.scanning"
      :scan="folderPick.scan"
      :plan="folderPick.plan"
      :allow-booklists="!paperMode"
      @confirm="confirmFolderImport"
      @cancel="folderPick = null"
    />

    <!-- 新建书单 -->
    <div v-if="showBooklistCreate" class="modal-mask" @click.self="showBooklistCreate = false">
      <div class="modal booklist-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-create-title">
        <h3 id="booklist-create-title">{{ t('library.newBooklist') }}</h3>
        <p class="modal-description">{{ t('library.booklistCreateHint') }}</p>
        <input
          v-model="booklistDraft"
          class="input"
          :placeholder="t('library.booklistNamePlaceholder')"
          :aria-label="t('library.booklistNamePlaceholder')"
          maxlength="40"
          v-autofocus
          @keyup.enter="createBooklist"
        />
        <div class="form-actions">
          <button class="btn btn-sm" @click="showBooklistCreate = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!booklistDraft.trim()" @click="createBooklist">
            {{ t('library.createBooklist') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 选择书单 -->
    <div v-if="showBooklistPicker" class="modal-mask" @click.self="showBooklistPicker = false">
      <div class="modal booklist-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-picker-title">
        <h3 id="booklist-picker-title">{{ t('library.chooseBooklist') }}</h3>
        <p class="modal-description">
          {{ t('library.chooseBooklistHint', { count: pickerBookIds.length }) }}
        </p>
        <div v-if="library.booklists.length" class="booklist-picker-list">
          <button
            v-for="item in library.booklists"
            :key="item.id"
            class="booklist-picker-row"
            @click="addPickerBooks(item.id)"
          >
            <span class="booklist-picker-icon">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M5 4a2 2 0 0 1 2-2h9a3 3 0 0 1 3 3v15a1 1 0 0 1-1.45.9L12 18.12 6.45 20.9A1 1 0 0 1 5 20V4zm2 0v14.38l4.55-2.28a1 1 0 0 1 .9 0L17 18.38V5a1 1 0 0 0-1-1H7z"/></svg>
            </span>
            <span class="booklist-picker-name">{{ item.name }}</span>
            <span class="booklist-picker-count">{{ t('library.booklistBooks', { count: booklistCount(item.id) }) }}</span>
            <span class="booklist-picker-add">{{ t('common.add') }}</span>
          </button>
        </div>
        <div class="booklist-create-inline">
          <div class="inline-label">{{ t('library.createNewBooklist') }}</div>
          <div class="inline-fields">
            <input
              v-model="pickerDraft"
              class="input"
              name="booklist-name"
              autocomplete="off"
              :aria-label="t('library.booklistName')"
              :placeholder="t('library.booklistNamePlaceholder')"
              maxlength="40"
              v-autofocus="!library.booklists.length"
              @keyup.enter="createBooklistAndAdd"
            />
            <button
              class="btn btn-sm btn-primary"
              :disabled="!pickerDraft.trim()"
              @click="createBooklistAndAdd"
            >{{ t('library.createAndAdd') }}</button>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn btn-sm" @click="showBooklistPicker = false">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- 管理书单 -->
    <div v-if="showBooklistManage" class="modal-mask" @click.self="showBooklistManage = false">
      <div class="modal booklist-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-manage-title">
        <div class="modal-title-row">
          <h3 id="booklist-manage-title">{{ t('library.manageBooklists') }}</h3>
          <button class="btn btn-sm" @click="showBooklistManage = false; openCreateBooklist()">
            {{ t('library.newBooklist') }}
          </button>
        </div>
        <p class="modal-description">{{ t('library.manageBooklistsHint') }}</p>
        <div class="booklist-manage-list">
          <div v-for="item in library.booklists" :key="item.id" class="booklist-manage-row">
            <input
              v-model="booklistRenames[item.id]"
              class="input"
              autocomplete="off"
              :aria-label="t('library.booklistName')"
              maxlength="40"
              @keyup.enter="renameBooklist(item.id)"
            />
            <span class="booklist-manage-count">
              {{ t('library.booklistBooks', { count: booklistCount(item.id) }) }}
            </span>
            <button
              class="btn btn-sm"
              :disabled="!booklistRenames[item.id]?.trim() || booklistRenames[item.id].trim() === item.name"
              @click="renameBooklist(item.id)"
            >{{ t('common.save') }}</button>
            <button class="btn btn-sm btn-danger" @click="deleteBooklist(item.id)">
              {{ t('common.delete') }}
            </button>
          </div>
          <p v-if="!library.booklists.length" class="tag-manage-empty">
            {{ t('library.noBooklists') }}
          </p>
        </div>
        <div class="form-actions">
          <button class="btn btn-sm" @click="showBooklistManage = false">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>

    <!-- 批量标签弹窗 -->
    <div v-if="showTagModal" class="modal-mask" @click.self="showTagModal = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tag-modal-title">
        <h3 id="tag-modal-title">{{ t('library.tagModalTitle', { count: selectedIds.size }) }}</h3>
        <input v-model="tagDraft" class="input full" :placeholder="t('library.tagPlaceholder')" :aria-label="t('library.setTags')" v-autofocus @keyup.enter="batchTag" />
        <div class="form-actions">
          <button class="btn btn-sm" @click="batchClearTags">{{ t('library.clearTags') }}</button>
          <button class="btn btn-sm" @click="showTagModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!tagDraft.trim()" @click="batchTag">{{ t('common.add') }}</button>
        </div>
      </div>
    </div>

    <!-- URL 导入弹窗 -->
    <div v-if="showUrlModal" class="modal-mask" @click.self="!urlImporting && (showUrlModal = false)">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="url-modal-title">
        <h3 id="url-modal-title">{{ t('library.urlImportTitle') }}</h3>
        <input
          v-model="urlDraft"
          class="input full"
          type="url"
          inputmode="url"
          :placeholder="t('library.urlPlaceholder')"
          :aria-label="t('library.urlPlaceholder')"
          :disabled="!!urlImporting"
          v-autofocus
          @keyup.enter="doUrlImport"
        />
        <p class="url-hint">{{ t('library.urlHint') }}</p>
        <div v-if="urlImporting" class="url-progress" role="status">{{ urlImporting }}</div>
        <div class="form-actions">
          <button class="btn btn-sm" :disabled="!!urlImporting" @click="showUrlModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!urlDraft.trim() || !!urlImporting" @click="doUrlImport">
            {{ urlImporting ? t('common.loading') : t('library.urlDownloadImport') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 分类管理弹窗 -->
    <div v-if="showTagManage" class="modal-mask" @click.self="showTagManage = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tag-manage-title">
        <h3 id="tag-manage-title">{{ t('library.manageTags') }}</h3>
        <div class="tag-manage-list">
          <div v-for="tag in allTags" :key="tag" class="tag-manage-row">
            <input v-model="tagRenames[tag]" class="input" :aria-label="tag" @keyup.enter="renameTag(tag)" />
            <span class="tag-book-count">{{ t('library.tagBooks', { count: tagCount(tag) }) }}</span>
            <button
              class="btn btn-sm"
              :disabled="!tagRenames[tag]?.trim() || tagRenames[tag].trim() === tag"
              @click="renameTag(tag)"
            >{{ t('common.save') }}</button>
            <button class="btn btn-sm btn-danger" @click="deleteTag(tag)">{{ t('common.delete') }}</button>
          </div>
          <p v-if="!allTags.length" class="tag-manage-empty">{{ t('library.noTags') }}</p>
        </div>
        <div class="form-actions">
          <button class="btn btn-sm" @click="showTagManage = false">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>

    <div v-if="dragging || nativeDragging" class="drop-hint" aria-hidden="true">
      <div class="drop-hint-inner">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        <span>{{ t(paperMode ? 'library.dropHintPapers' : 'library.dropHint') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped src="../styles/views/library.css"></style>
