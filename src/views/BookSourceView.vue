<script setup lang="ts">
/**
 * 书源搜书页（Legado 格式书源 → 搜索 + 在线阅读）。
 *
 * 三视图：search → detail（选源/目录）→ reader（正文阅读 + 缓存）。
 * 书源的「导入」入口保留在搜索视图顶部（无书源时引导导入）。
 */
import { computed, ref, onMounted } from 'vue'
import { useBookSourceStore, parseBookSourceJson } from '../stores/bookSource'
import { searchAllSourcesMerged } from '../services/legado/crawler'
import { getTocForEntry, getChapterCached, clearCachedBook } from '../services/legado/reader'
import type { MergedSearchBook, BookSourceEntry, ChapterItem } from '../services/legado/types'
import { toast } from '../services/toast'
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
  const confirmed = window.confirm(t('bookSource.clearBookCacheConfirm', {
    name: book.name,
    source: entry.sourceName,
  }))
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

onMounted(() => {
  store.load()
})

const hasSources = computed(() => store.count > 0)

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
        input.onchange = () => {
          const file = input.files?.[0]
          if (!file) { resolve(''); return }
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result ?? ''))
          reader.onerror = () => reject(new Error('读取文件失败'))
          reader.readAsText(file)
        }
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

      <!-- 书源状态条（常驻，随时可导入/清空） -->
      <section class="card source-bar">
        <span class="source-bar-info">
          {{ hasSources ? t('bookSource.sourceBarHas', { count: store.count }) : t('bookSource.sourceBarNone') }}
        </span>
        <span class="source-bar-actions">
          <button class="btn btn-sm" :disabled="importing" @click="importFile">
            {{ t('bookSource.importFile') }}
          </button>
          <button v-if="hasSources" class="btn btn-sm" @click="clearSources">
            {{ t('bookSource.clearSources') }}
          </button>
        </span>
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
          <button class="btn btn-sm" @click="backToToc">{{ t('bookSource.readerBack') }}</button>
          <span class="reader-title">{{ chapters[readingIndex]?.name }}</span>
          <span class="reader-spacer"></span>
          <label class="font-label">
            {{ t('bookSource.fontSize') }}
            <input v-model.number="fontSize" type="range" min="14" max="28" step="1" class="font-range" />
          </label>
        </header>

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
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.count {
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-radius: 10px;
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
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
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
  font-size: 13px;
  color: var(--text-secondary);
}

.source-bar-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

/* ---- 搜索 ---- */
.search-row {
  display: flex;
  gap: 10px;
}

.search-input {
  flex: 1;
  font-size: 15px;
  padding: 10px 14px;
}

/* ---- 导入引导（无书源时） ---- */
.import-guide {
  max-width: 480px;
  margin: 20px auto 0;
  padding: 24px;
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  background: var(--bg-secondary);
  text-align: center;
}

.import-tip {
  margin: 0 0 16px;
  font-size: 13px;
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
  font-size: 12px;
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
  border-radius: 8px;
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
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.src-badge {
  font-size: 11px;
  color: var(--accent, #4f8cff);
  background: rgba(79, 140, 255, 0.12);
  border-radius: 10px;
  padding: 1px 8px;
  white-space: nowrap;
}

.book-author {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.book-last {
  font-size: 12px;
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
  border-radius: 16px;
  font-size: 13px;
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
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 14px;
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
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}

.reader-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 50%;
}

.reader-spacer {
  flex: 1;
}

.font-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.font-range {
  width: 90px;
  padding: 0;
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

.btn-sm { padding: 4px 10px; font-size: 12px; }
</style>
