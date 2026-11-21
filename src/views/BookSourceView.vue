<script setup lang="ts">
/**
 * 书源搜书页（Legado 格式书源 → 搜索 + 在线阅读）。
 *
 * 三视图：search → detail（选源/目录）→ reader（正文阅读 + 缓存）。
 * 书源的「导入」入口保留在搜索视图顶部（无书源时引导导入）。
 */
import { computed, ref, onMounted } from 'vue'
import { useBookSourceStore, parseBookSourceJson } from '../stores/bookSource'
import { searchAllSourcesMerged, checkSource } from '../services/legado/crawler'
import { getTocForEntry, getChapterCached, clearCachedBook } from '../services/legado/reader'
import type { MergedSearchBook, BookSourceEntry, ChapterItem } from '../services/legado/types'
import { toast } from '../services/toast'
import { askConfirm, deleteConfirmOptions } from '../services/confirm'
import { t } from '../i18n'

const store = useBookSourceStore()

// ---------------------------------------------------------------------------
// 视图状态：search → detail → reader
// ---------------------------------------------------------------------------
type View = 'search' | 'detail' | 'reader'
const view = ref<View>('search')

/** 递增令牌：每次异步操作前取一个，回写前校验是否仍是最新，避免过期请求覆盖新视图。 */
let requestSeq = 0
function nextToken(): number {
  return ++requestSeq
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------
const searchKey = ref('')
const searching = ref(false)
const searchError = ref('')
const results = ref<MergedSearchBook[]>([])

async function doSearch() {
  const key = searchKey.value.trim()
  if (!key) return
  if (store.enabledSources.length === 0) {
    toast(t('bookSource.noSource'), 'info')
    return
  }
  const token = nextToken()
  searching.value = true
  searchError.value = ''
  results.value = []
  try {
    const merged = await searchAllSourcesMerged(store.enabledSources.map(r => r.source), key)
    if (token !== requestSeq) return
    results.value = merged
    if (merged.length === 0) {
      toast(t('bookSource.searchEmpty'), 'info')
    }
  } catch (err) {
    if (token !== requestSeq) return
    searchError.value = String(err)
    toast(t('bookSource.searchError', { msg: String(err) }), 'error')
  } finally {
    if (token === requestSeq) searching.value = false
  }
}

function openBook(book: MergedSearchBook) {
  nextToken()
  currentBook.value = book
  selectedEntry.value = book.primary
  view.value = 'detail'
  loadToc()
}

// ---------------------------------------------------------------------------
// 详情 / 选源 / 目录
// ---------------------------------------------------------------------------
const currentBook = ref<MergedSearchBook | null>(null)
const selectedEntry = ref<BookSourceEntry | null>(null)
const chapters = ref<ChapterItem[]>([])
const loadingToc = ref(false)

async function loadToc() {
  const entry = selectedEntry.value
  if (!entry) return
  const token = nextToken()
  loadingToc.value = true
  chapters.value = []
  try {
    const list = await getTocForEntry(entry)
    if (token !== requestSeq) return
    chapters.value = list
    if (list.length === 0) {
      toast(t('bookSource.tocEmpty'), 'info')
    }
  } catch (err) {
    if (token !== requestSeq) return
    toast(t('bookSource.tocEmpty'), 'error')
  } finally {
    if (token === requestSeq) loadingToc.value = false
  }
}

async function selectEntry(entry: BookSourceEntry) {
  selectedEntry.value = entry
  await loadToc()
}

const clearingCache = ref(false)

async function clearCurrentBookCache() {
  const entry = selectedEntry.value
  const book = currentBook.value
  if (!entry || !book || clearingCache.value) return
  const confirmed = await askConfirm(
    t('bookSource.clearBookCacheConfirm', { name: book.name, source: entry.sourceName }),
    deleteConfirmOptions(t('bookSource.clearBookCache')),
  )
  if (!confirmed) return

  clearingCache.value = true
  try {
    await clearCachedBook(entry.source, book.name, book.author)
    toast(t('bookSource.bookCacheCleared'), 'success')
  } catch (err) {
    toast(t('bookSource.bookCacheClearFailed', { msg: String(err) }), 'error')
  } finally {
    clearingCache.value = false
  }
}

function backToSearch() {
  nextToken()
  view.value = 'search'
}

// ---------------------------------------------------------------------------
// 阅读器
// ---------------------------------------------------------------------------
const readingIndex = ref(-1)
const chapterText = ref('')
const loadingChapter = ref(false)
const fontSize = ref(18)
const showToc = ref(false)

function toggleToc() {
  showToc.value = !showToc.value
}

function closeToc() {
  showToc.value = false
}

function jumpChapter(index: number) {
  closeToc()
  openChapter(index)
}

function decFont() {
  if (fontSize.value > 14) fontSize.value--
}

function incFont() {
  if (fontSize.value < 28) fontSize.value++
}

async function openChapter(index: number) {
  const entry = selectedEntry.value
  const book = currentBook.value
  if (!entry || !book || index < 0 || index >= chapters.value.length) return
  readingIndex.value = index
  view.value = 'reader'
  const token = nextToken()
  chapterText.value = ''
  loadingChapter.value = true
  try {
    const content = await getChapterCached(
      entry.source,
      book.name,
      book.author,
      chapters.value[index],
    )
    if (token !== requestSeq) return
    chapterText.value = content.text
  } catch (err) {
    if (token !== requestSeq) return
    toast(t('bookSource.chapterEmpty'), 'error')
    chapterText.value = ''
  } finally {
    if (token === requestSeq) loadingChapter.value = false
  }
}

function backToToc() {
  nextToken()
  view.value = 'detail'
}

function prevChapter() {
  if (readingIndex.value > 0) openChapter(readingIndex.value - 1)
}

function nextChapter() {
  if (readingIndex.value < chapters.value.length - 1) openChapter(readingIndex.value + 1)
}

// ---------------------------------------------------------------------------
// 书源导入（无书源时的引导入口）
// ---------------------------------------------------------------------------
const importing = ref(false)
const importText = ref('')
const importUrl = ref('')
const importingUrl = ref(false)

onMounted(() => {
  store.load()
})

const hasSources = computed(() => store.count > 0)

/** 更多导入方式面板的展开状态 */
const showImportPanel = ref(false)
function toggleImportPanel() {
  showImportPanel.value = !showImportPanel.value
}

/** 网络导入：从书源 JSON / 订阅地址拉取内容并解析 */
async function importFromUrl() {
  const url = importUrl.value.trim()
  if (!url || importingUrl.value) return
  importingUrl.value = true
  try {
    const { fetchRemote } = await import('../services/net')
    const res = await fetchRemote(url, undefined, { headers: { accept: 'application/json, text/plain, */*' } })
    const text = await res.text()
    if (!text.trim()) {
      toast(t('bookSource.importNothing'), 'info')
      return
    }
    doImport(text)
    importUrl.value = ''
  } catch (err) {
    toast(t('bookSource.importUrlFailed', { msg: String(err) }), 'error')
  } finally {
    importingUrl.value = false
  }
}

async function importFile() {
  importing.value = true
  try {
    let text = ''
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ multiple: false, filters: [{ name: 'JSON', extensions: ['json', 'txt'] }] })
      if (!selected) return
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      text = await readTextFile(selected as string)
    } else {
      text = await new Promise<string>((resolve, reject) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json,.txt,application/json'
        let settled = false
        const finish = (value: string) => {
          if (settled) return
          settled = true
          window.removeEventListener('focus', onFocus)
          resolve(value)
        }
        const onFocus = () => {
          setTimeout(() => {
            if (!input.files?.length) finish('')
          }, 300)
        }
        input.oncancel = () => finish('')
        input.onchange = () => {
          const file = input.files?.[0]
          if (!file) { finish(''); return }
          const reader = new FileReader()
          reader.onload = () => {
            settled = true
            window.removeEventListener('focus', onFocus)
            resolve(String(reader.result ?? ''))
          }
          reader.onerror = () => {
            settled = true
            window.removeEventListener('focus', onFocus)
            reject(new Error('读取文件失败'))
          }
          reader.readAsText(file)
        }
        window.addEventListener('focus', onFocus, { once: true })
        input.click()
      })
    }
    if (text) doImport(text)
  } catch (err) {
    toast(t('bookSource.importFailed', { msg: String(err) }), 'error')
  } finally {
    importing.value = false
  }
}

function importPaste() {
  const text = importText.value.trim()
  if (!text) return
  doImport(text)
}

function clearSources() {
  store.clearAll()
  results.value = []
  importText.value = ''
  toast(t('bookSource.cleared'), 'success')
}

// ---------------------------------------------------------------------------
// 书源管理（列表 / 启停 / 删除 / 检测 / 导出）
// ---------------------------------------------------------------------------
const showSourceList = ref(false)
/** 每个书源的检测结果，key 为书源 id */
const checkResults = ref<Record<string, { ok: boolean; message: string; count: number }>>({})
const checkingId = ref<string | null>(null)
const checkingAll = ref(false)

function toggleSourceList() {
  showSourceList.value = !showSourceList.value
}

function toggleSource(id: string) {
  store.toggleEnabled(id)
}

async function removeSource(id: string) {
  const rec = store.records.find(r => r.id === id)
  if (!rec) return
  const confirmed = await askConfirm(
    t('bookSource.deleteConfirm', { name: rec.source.bookSourceName }),
    deleteConfirmOptions(t('common.delete')),
  )
  if (!confirmed) return
  store.removeSource(id)
  delete checkResults.value[id]
  toast(t('bookSource.deleted'), 'success')
}

async function checkOne(id: string) {
  const rec = store.records.find(r => r.id === id)
  if (!rec || checkingId.value) return
  checkingId.value = id
  try {
    const result = await checkSource(rec.source)
    checkResults.value[id] = { ok: result.ok, message: result.message, count: result.count }
  } catch (err) {
    checkResults.value[id] = { ok: false, message: String(err), count: 0 }
  } finally {
    checkingId.value = null
  }
}

async function checkAll() {
  if (checkingAll.value) return
  checkingAll.value = true
  const list = store.records.filter(r => r.enabled)
  let cursor = 0
  const workers = Math.min(4, list.length)
  try {
    await Promise.all(Array.from({ length: workers }, async () => {
      while (cursor < list.length) {
        const rec = list[cursor++]
        try {
          const result = await checkSource(rec.source)
          checkResults.value[rec.id] = { ok: result.ok, message: result.message, count: result.count }
        } catch (err) {
          checkResults.value[rec.id] = { ok: false, message: String(err), count: 0 }
        }
      }
    }))
  } finally {
    checkingAll.value = false
  }
}

/** 检测失败的书源 id（已检测且 ok === false） */
const failedSourceIds = computed(() =>
  store.records.filter(r => checkResults.value[r.id] && !checkResults.value[r.id].ok).map(r => r.id))

/** 批量删除检测失败的书源 */
async function removeFailedSources() {
  const ids = failedSourceIds.value
  if (ids.length === 0) {
    toast(t('bookSource.noFailedSources'), 'info')
    return
  }
  const confirmed = await askConfirm(
    t('bookSource.deleteFailedConfirm', { count: ids.length }),
    deleteConfirmOptions(t('common.delete')),
  )
  if (!confirmed) return
  const removed = store.removeSources(ids)
  for (const id of ids) delete checkResults.value[id]
  toast(t('bookSource.deleteFailedDone', { count: removed }), 'success')
}

async function exportSources() {
  const list = store.records
  if (list.length === 0) {
    toast(t('bookSource.sourceListEmpty'), 'info')
    return
  }
  const json = store.exportSources()
  const blob = new Blob([json], { type: 'application/json' })
  const filename = `book-sources-${new Date().toISOString().slice(0, 10)}.json`

  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      const path = await save({ defaultPath: filename, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (!path) return
      await writeTextFile(path, json)
      toast(t('bookSource.exported', { count: list.length }), 'success')
    } catch (err) {
      toast(t('bookSource.exportFailed', { msg: String(err) }), 'error')
    }
    return
  }

  // 浏览器：触发下载
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  toast(t('bookSource.exported', { count: list.length }), 'success')
}

function doImport(text: string) {
  try {
    const parsed = parseBookSourceJson(text)
    const n = store.importSources(parsed)
    if (n > 0) {
      toast(t('bookSource.imported', { count: n }), 'success')
      importText.value = ''
    } else {
      toast(t('bookSource.importNothing'), 'info')
    }
  } catch (err) {
    toast(t('bookSource.importInvalid', { msg: String(err) }), 'error')
  }
}
</script>

<template>
  <div class="book-source-view">
    <!-- ================= 搜索视图 ================= -->
    <template v-if="view === 'search'">
      <header class="page-head">
        <div class="page-title">
          <h1>{{ t('bookSource.title') }}</h1>
          <p>{{ t('bookSource.searchHint') }}</p>
        </div>
      </header>

      <!-- 书源状态条（常驻，随时可导入/管理） -->
      <section class="card source-bar">
        <span class="source-bar-info">
          {{ hasSources ? t('bookSource.sourceBarHas', { count: store.count }) : t('bookSource.sourceBarNone') }}
        </span>
        <span class="source-bar-actions">
          <button class="btn btn-sm" :disabled="importing" @click="importFile">
            {{ t('bookSource.importFile') }}
          </button>
          <button class="btn btn-sm" @click="toggleImportPanel">
            {{ t('bookSource.moreImport') }}
          </button>
          <button v-if="hasSources" class="btn btn-sm" @click="toggleSourceList">
            {{ t('bookSource.manageSources') }}
          </button>
        </span>
      </section>

      <!-- 更多导入方式（网络 / 粘贴） -->
      <section v-if="showImportPanel" class="card import-panel">
        <div class="import-panel-head">
          <span class="source-list-title">{{ t('bookSource.moreImport') }}</span>
        </div>
        <!-- 网络导入 -->
        <div class="import-row">
          <input
            v-model="importUrl"
            type="url"
            class="search-input import-url-input"
            :placeholder="t('bookSource.importUrlPlaceholder')"
            :aria-label="t('bookSource.importUrlPlaceholder')"
            @keyup.enter="importFromUrl"
          />
          <button class="btn btn-sm" :disabled="importingUrl || !importUrl.trim()" @click="importFromUrl">
            {{ importingUrl ? t('bookSource.importingUrl') : t('bookSource.importFromUrl') }}
          </button>
        </div>
        <!-- 粘贴导入 -->
        <textarea
          v-model="importText"
          class="import-textarea"
          :placeholder="t('bookSource.pastePlaceholder')"
          rows="4"
          :aria-label="t('bookSource.pastePlaceholder')"
        />
        <div class="import-actions">
          <button class="btn btn-sm" :disabled="importing || !importText.trim()" @click="importPaste">
            {{ t('bookSource.importPaste') }}
          </button>
        </div>
      </section>

      <!-- 书源管理列表 -->
      <section v-if="showSourceList" class="card source-list-card">
        <div class="source-list-head">
          <span class="source-list-title">{{ t('bookSource.manageSources') }}</span>
          <span class="source-list-actions">
            <button v-if="hasSources" class="btn btn-sm" :disabled="checkingAll" @click="checkAll">
              {{ checkingAll ? t('bookSource.checkingAll') : t('bookSource.checkAll') }}
            </button>
            <button v-if="failedSourceIds.length" class="btn btn-sm" @click="removeFailedSources">
              {{ t('bookSource.deleteFailed', { count: failedSourceIds.length }) }}
            </button>
            <button v-if="hasSources" class="btn btn-sm" @click="exportSources">
              {{ t('bookSource.export') }}
            </button>
            <button v-if="hasSources" class="btn btn-sm" @click="clearSources">
              {{ t('bookSource.clearSources') }}
            </button>
          </span>
        </div>

        <div v-if="!hasSources" class="empty">{{ t('bookSource.sourceListEmpty') }}</div>
        <div v-else class="source-list">
          <div v-for="rec in store.records" :key="rec.id" class="source-item">
            <div class="source-item-main">
              <div class="source-item-name">
                {{ rec.source.bookSourceName }}
                <span class="src-badge" :class="{ off: !rec.enabled }">
                  {{ rec.enabled ? t('bookSource.enabled') : t('bookSource.disabled') }}
                </span>
              </div>
              <div class="source-item-url">{{ rec.source.bookSourceUrl }}</div>
              <div v-if="checkResults[rec.id]" class="source-item-check" :class="{ ok: checkResults[rec.id].ok }">
                {{ checkResults[rec.id].ok
                    ? t('bookSource.checkOk', { count: checkResults[rec.id].count })
                    : t('bookSource.checkFail', { msg: checkResults[rec.id].message }) }}
              </div>
            </div>
            <div class="source-item-actions">
              <button class="btn btn-sm" @click="toggleSource(rec.id)">
                {{ rec.enabled ? t('bookSource.disable') : t('bookSource.enable') }}
              </button>
              <button class="btn btn-sm" :disabled="checkingId === rec.id" @click="checkOne(rec.id)">
                {{ checkingId === rec.id ? t('bookSource.checking') : t('bookSource.check') }}
              </button>
              <button class="btn btn-sm" @click="removeSource(rec.id)">
                {{ t('bookSource.delete') }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="card search-card">
        <div class="search-row">
          <input
            v-model="searchKey"
            type="text"
            class="search-input"
            :placeholder="t('bookSource.searchPlaceholder')"
            :aria-label="t('bookSource.searchPlaceholder')"
            @keyup.enter="doSearch"
          />
          <button class="btn btn-primary" :disabled="searching" @click="doSearch">
            {{ searching ? t('bookSource.searching') : t('bookSource.searchBtn') }}
          </button>
        </div>
      </section>

      <!-- 结果列表 -->
      <section class="card result-card">
        <div v-if="searchError" class="empty error">{{ searchError }}</div>
        <div v-else-if="results.length" class="book-list">
          <button
            v-for="(book, i) in results"
            :key="i"
            class="book-item"
            @click="openBook(book)"
          >
            <div class="book-meta">
              <div class="book-name">
                {{ book.name }}
                <span class="src-badge">{{ t('bookSource.sourceBadge', { count: book.sources.length }) }}</span>
              </div>
              <div class="book-author">{{ book.author }}</div>
              <div v-if="book.primary.lastChapter" class="book-last">{{ book.primary.lastChapter }}</div>
            </div>
          </button>
        </div>
        <div v-else-if="!searching" class="empty">
          <p v-if="hasSources">{{ t('bookSource.searchEmpty') }}</p>
          <template v-else>
            <div class="import-guide">
              <p class="import-tip">{{ t('bookSource.noSource') }}</p>
              <button class="btn btn-primary import-file-btn" :disabled="importing" @click="importFile">
                {{ t('bookSource.importFile') }}
              </button>
              <div class="import-divider"><span>{{ t('bookSource.orPaste') }}</span></div>
              <textarea
                v-model="importText"
                class="import-textarea"
                :placeholder="t('bookSource.pastePlaceholder')"
                rows="5"
                :aria-label="t('bookSource.pastePlaceholder')"
              />
              <div class="import-actions">
                <button class="btn" :disabled="importing || !importText.trim()" @click="importPaste">
                  {{ t('bookSource.importPaste') }}
                </button>
              </div>
            </div>
          </template>
        </div>
      </section>
    </template>

    <!-- ================= 详情 / 目录视图 ================= -->
    <template v-else-if="view === 'detail' && currentBook">
      <header class="page-head">
        <button class="btn btn-sm back-btn" @click="backToSearch">{{ t('bookSource.backToSearch') }}</button>
        <div class="page-title">
          <h1>{{ currentBook.name }}</h1>
          <p>{{ currentBook.author }}</p>
        </div>
      </header>

      <!-- 选源 -->
      <section v-if="currentBook.sources.length > 1" class="card">
        <h2 class="card-title">{{ t('bookSource.selectSource') }}</h2>
        <div class="source-chips">
          <button
            v-for="(s, i) in currentBook.sources"
            :key="i"
            class="chip"
            :class="{ active: selectedEntry === s }"
            @click="selectEntry(s)"
          >
            {{ s.sourceName }}
          </button>
        </div>
      </section>

      <!-- 目录 -->
      <section class="card toc-card">
        <div class="toc-title-row">
          <h2 class="card-title">
            {{ t('bookSource.chapters') }}
            <span v-if="chapters.length" class="count">{{ t('bookSource.chapterCount', { count: chapters.length }) }}</span>
          </h2>
          <button class="btn btn-sm" :disabled="clearingCache" @click="clearCurrentBookCache">
            {{ clearingCache ? t('bookSource.clearingBookCache') : t('bookSource.clearBookCache') }}
          </button>
        </div>

        <div v-if="loadingToc" class="empty">{{ t('bookSource.loadingToc') }}</div>
        <div v-else-if="!chapters.length" class="empty">{{ t('bookSource.tocEmpty') }}</div>
        <div v-else class="chapter-list">
          <button
            v-for="(ch, i) in chapters"
            :key="ch.url + i"
            class="chapter-item"
            @click="openChapter(i)"
          >
            <span class="ch-name">{{ ch.name }}</span>
          </button>
        </div>
      </section>
    </template>

    <!-- ================= 阅读器视图 ================= -->
    <template v-else-if="view === 'reader' && currentBook && readingIndex >= 0">
      <div class="reader-view">
        <header class="reader-bar">
          <div class="reader-bar-left">
            <button class="btn btn-sm" @click="backToToc">{{ t('bookSource.readerBack') }}</button>
            <span class="reader-title">{{ chapters[readingIndex]?.name }}</span>
          </div>
          <div class="reader-bar-right">
            <button class="btn btn-sm" @click="toggleToc">{{ t('bookSource.chapters') }}</button>
            <div class="font-step" role="group" :aria-label="t('bookSource.fontSize')">
              <button class="btn btn-sm font-btn" :disabled="fontSize <= 14" @click="decFont" aria-label="A-">A−</button>
              <span class="font-value" :title="t('bookSource.fontSize')">{{ t('bookSource.fontSizeValue', { size: fontSize }) }}</span>
              <button class="btn btn-sm font-btn" :disabled="fontSize >= 28" @click="incFont" aria-label="A+">A+</button>
            </div>
          </div>
        </header>

        <!-- 目录抽屉 -->
        <div v-if="showToc" class="toc-overlay" @click="closeToc"></div>
        <aside v-if="showToc" class="toc-drawer">
          <div class="toc-drawer-head">
            <h3>{{ t('bookSource.chapters') }}</h3>
            <button class="btn btn-sm" @click="closeToc">×</button>
          </div>
          <div class="toc-drawer-list">
            <button
              v-for="(ch, i) in chapters"
              :key="ch.url + i"
              class="chapter-item"
              :class="{ active: i === readingIndex }"
              @click="jumpChapter(i)"
            >
              <span class="ch-name">{{ ch.name }}</span>
            </button>
          </div>
        </aside>

        <div v-if="loadingChapter" class="reader-loading">{{ t('bookSource.loadingChapter') }}</div>
        <article v-else-if="chapterText" class="reader-content" :style="{ fontSize: fontSize + 'px' }">
          <p v-for="(para, pi) in chapterText.split(/\n+/)" :key="pi">{{ para }}</p>
        </article>
        <div v-else class="reader-loading">{{ t('bookSource.chapterEmpty') }}</div>

        <footer class="reader-nav">
          <button class="btn" :disabled="readingIndex <= 0" @click="prevChapter">
            {{ t('bookSource.prevChapter') }}
          </button>
          <button class="btn" :disabled="readingIndex >= chapters.length - 1" @click="nextChapter">
            {{ t('bookSource.nextChapter') }}
          </button>
        </footer>
      </div>
    </template>
  </div>
</template>

<style scoped>
.book-source-view {
  padding: calc(var(--page-top) + 20px) var(--page-x) calc(var(--page-bottom) + var(--lr-safe-bottom));
  max-width: 860px;
  margin: 0 auto;
}

.card {
  margin-bottom: 20px;
  padding: 20px;
}

.card-title {
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  margin: 0 0 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.count {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-radius: var(--radius);
  padding: 1px 8px;
}

.toc-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.toc-title-row .card-title {
  margin-bottom: 14px;
}

.toc-title-row .btn {
  flex-shrink: 0;
}

input, textarea {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  font-size: var(--fs-sm);
}

/* ---- 书源状态条 ---- */
.source-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 16px;
}

.source-bar-info {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.source-bar-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

/* ---- 书源管理列表 ---- */
.source-list-card {
  margin-bottom: 16px;
}

.source-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.source-list-title {
  font-weight: var(--fw-semibold);
  font-size: var(--fs-base);
}

.source-list-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.source-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
}

.source-item-main {
  min-width: 0;
  flex: 1;
}

.source-item-name {
  font-weight: var(--fw-semibold);
  display: flex;
  align-items: center;
  gap: 8px;
}

.source-item-url {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-item-check {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  margin-top: 4px;
}

.source-item-check.ok {
  color: var(--success);
}

.source-item-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.src-badge.off {
  color: var(--text-tertiary);
  background: var(--bg);
}

/* ---- 搜索 ---- */
.search-row {
  display: flex;
  gap: 10px;
}

.search-input {
  flex: 1;
  font-size: var(--fs-md);
  padding: 10px 14px;
}

/* ---- 导入引导（无书源时） ---- */
.import-guide {
  max-width: 480px;
  margin: 20px auto 0;
  padding: 24px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  text-align: center;
}

/* ---- 更多导入方式面板 ---- */
.import-panel {
  margin-bottom: 16px;
}

.import-panel-head {
  margin-bottom: 12px;
}

.import-row {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.import-url-input {
  flex: 1;
  font-size: var(--fs-sm);
}

.import-tip {
  margin: 0 0 16px;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.import-file-btn {
  min-width: 200px;
}

.import-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 18px 0;
  color: var(--text-tertiary);
  font-size: var(--fs-xs);
}

.import-divider::before,
.import-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.import-textarea {
  width: 100%;
  resize: vertical;
  text-align: left;
  box-sizing: border-box;
}

.import-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

/* ---- 结果列表 ---- */
.book-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.book-item {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.book-item:hover {
  background: var(--bg-secondary);
}

.book-meta {
  min-width: 0;
  flex: 1;
}

.book-name {
  font-weight: var(--fw-semibold);
  display: flex;
  align-items: center;
  gap: 8px;
}

.src-badge {
  font-size: var(--fs-caption);
  color: var(--accent, #4f8cff);
  background: rgba(79, 140, 255, 0.12);
  border-radius: var(--radius);
  padding: 1px 8px;
  white-space: nowrap;
}

.book-author {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-top: 2px;
}

.book-last {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 详情 / 目录 ---- */
.back-btn {
  margin-bottom: 10px;
}

.source-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  font-size: var(--fs-sm);
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.chip.active {
  border-color: var(--accent, #4f8cff);
  color: var(--accent, #4f8cff);
  background: rgba(79, 140, 255, 0.1);
}

.chapter-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 60vh;
  overflow-y: auto;
}

.chapter-item {
  text-align: left;
  padding: 9px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font-size: var(--fs-base);
  cursor: pointer;
}

.chapter-item:hover {
  background: var(--bg-secondary);
}

.ch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 阅读器 ---- */
.reader-view {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - var(--page-top) - var(--page-bottom) - 40px);
}

.reader-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}

.reader-bar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.reader-bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  /* 右侧留出安全边距，避免字号控件顶到窗口最小化/关闭按钮 */
  padding-right: 6px;
}

.reader-title {
  font-weight: var(--fw-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.font-step {
  display: flex;
  align-items: center;
  gap: 6px;
}

.font-btn {
  min-width: 30px;
  font-weight: var(--fw-semibold);
}

.font-value {
  min-width: 22px;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

/* ---- 阅读器目录抽屉 ---- */
.reader-view {
  position: relative;
}

.toc-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  z-index: 40;
}

.toc-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(320px, 82vw);
  background: var(--bg);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  z-index: 41;
  display: flex;
  flex-direction: column;
}

.toc-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.toc-drawer-head h3 {
  margin: 0;
  font-size: var(--fs-base);
  font-weight: var(--fw-semibold);
}

.toc-drawer-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chapter-item.active {
  background: var(--bg-secondary);
  color: var(--accent, #4f8cff);
  font-weight: var(--fw-semibold);
}

.reader-loading {
  padding: 60px 0;
  text-align: center;
  color: var(--text-secondary);
}

.reader-content {
  line-height: 1.9;
  letter-spacing: 0.3px;
  padding: 8px 4px 40px;
}

.reader-content p {
  margin: 0 0 0.9em;
  text-indent: 0;
}

.reader-nav {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 0 20px;
  border-top: 1px solid var(--border);
  margin-top: auto;
}

.empty {
  padding: 30px 0;
  text-align: center;
  color: var(--text-secondary);
}

.empty.error {
  color: #ef4444;
}

.btn-sm { padding: 4px 10px; font-size: var(--fs-xs); }
</style>
