<script setup lang="ts">
/**
 * 漫画页: 本地漫画 (CBZ/CBR) 与在线漫画源分开显示。
 * 书籍与漫画共用同一个书库, 只在 UI 层按 format 分流 —— 同步、进度、标注全部沿用。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { importFiles } from '../services/importer'
import { readerPath } from '../services/readerRoute'
import { isComicFormat } from '../services/comicFormat'
import { toast } from '../services/toast'
import { askConfirm, deleteConfirmOptions } from '../services/confirm'
import { t } from '../i18n'
import { shortAuthor, shortTitle } from '../services/displayTitle'
import { loadDaily, localDay, onReadingLogChange } from '../services/readingLog'
import { weekStartOf } from '../services/readingStats'
import type { BookMeta } from '../storage'
import {
  installFromFile, installFromUrl, listPlugins, removePlugin, setPluginEnabled,
  type InstalledComicPlugin,
} from '../services/comicPlugin'
import { checkUpdates, installStoreEntry, type StoreUpdate } from '../services/comicPlugin/store'
import BookCard from '../components/BookCard.vue'
import AppModal from '../components/AppModal.vue'
import AppSelect from '../components/AppSelect.vue'
import { vAutofocus } from '../directives/autofocus'
import { sendBookToDevices } from '../services/transfer'
import { exportBooksToFolder, exportSingleBook } from '../services/bookExport'

const router = useRouter()
const library = useLibrary()
const settings = useSettings()

// ---- 今日 / 本周阅读时长 (与藏书页一致, 并入「最近阅读」卡片) ----
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
const goalMinutes = computed(() => Math.max(0, Math.round(settings.dailyGoalMinutes || 0)))
const todayRatio = computed(() => (goalMinutes.value > 0 ? Math.min(1, todaySeconds.value / (goalMinutes.value * 60)) : 0))
const todayDone = computed(() => goalMinutes.value > 0 && todayRatio.value >= 1)
const keyword = ref('')
const sortBy = ref<'recent' | 'added' | 'title' | 'author'>('recent')
const manageMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const tagFilter = ref('')
const showTagModal = ref(false)
const tagDraft = ref('')
/* 上次停在哪个 tab 记下来: 从别的页面切回「漫画」时不会又跳回本地列表 */
const TAB_KEY = 'lightread.comics.tab.v1'
const savedTab = (() => {
  try { return localStorage.getItem(TAB_KEY) === 'sources' ? 'sources' : 'local' } catch { return 'local' as const }
})()
const activeTab = ref<'local' | 'sources'>(savedTab)
watch(activeTab, value => {
  try { localStorage.setItem(TAB_KEY, value) } catch { /* 忽略 */ }
  if (value !== 'local') {
    manageMode.value = false
    selectedIds.value = new Set()
  }
})
const importing = ref(false)
const fileInput = ref<HTMLInputElement>()
const pluginFileInput = ref<HTMLInputElement>()

const localComics = computed(() => library.books.filter(b => isComicFormat(b.format)))
const allTags = computed(() => {
  const set = new Set<string>()
  for (const b of localComics.value) for (const tag of b.tags) set.add(tag)
  return [...set].sort()
})
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = localComics.value.filter(b => {
    if (tagFilter.value && !b.tags.includes(tagFilter.value)) return false
    if (!kw) return true
    return (
      b.title.toLowerCase().includes(kw)
      || b.author.toLowerCase().includes(kw)
      || b.tags.some(tag => tag.toLowerCase().includes(kw))
    )
  })
  return [...list].sort((a, b) => {
    const pa = a.pinnedAt ?? 0
    const pb = b.pinnedAt ?? 0
    if (pa !== pb) return pb - pa
    switch (sortBy.value) {
      case 'added': return b.addedAt - a.addedAt
      case 'title': return a.title.localeCompare(b.title, 'zh')
      case 'author': return a.author.localeCompare(b.author, 'zh')
      default: return (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt)
    }
  })
})

// ---- 最近阅读 (本地漫画里最近打开的一本) ----
const resumeComic = computed(() => {
  if (keyword.value.trim()) return undefined
  let last: BookMeta | undefined
  for (const book of localComics.value) if (book.lastReadAt && (!last || book.lastReadAt > (last.lastReadAt ?? 0))) last = book
  return last
})
const resumePercent = computed(() => Math.min(100, Math.max(0, Math.round((resumeComic.value?.progress ?? 0) * 100))))
function agoText(at: number) {
  const minutes = Math.floor((Date.now() - at) / 60000)
  if (minutes < 1) return t('library.agoJustNow')
  if (minutes < 60) return t('library.agoMinutes', { n: minutes })
  if (minutes < 1440) return t('library.agoHours', { n: Math.floor(minutes / 60) })
  return t('library.agoDays', { n: Math.floor(minutes / 1440) })
}

function openBook(book: BookMeta) {
  router.push(readerPath(book))
}

function cleanupLocalProgress(ids: string[]) {
  try {
    const raw = localStorage.getItem('lightread.comic.reader.v1')
    if (!raw) return
    const map = JSON.parse(raw) as Record<string, unknown>
    let changed = false
    for (const id of ids) {
      const key = `local:${id}`
      if (key in map) {
        delete map[key]
        changed = true
      }
    }
    if (changed) localStorage.setItem('lightread.comic.reader.v1', JSON.stringify(map))
  } catch { /* 忽略 */ }
}

async function removeBook(book: BookMeta) {
  await library.removeBook(book.id)
  cleanupLocalProgress([book.id])
  if (tagFilter.value && !allTags.value.includes(tagFilter.value)) tagFilter.value = ''
}

// ---- 批量管理 (复刻藏书页逻辑) ----
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

const allVisibleSelected = computed(() =>
  filtered.value.length > 0 && filtered.value.every(b => selectedIds.value.has(b.id)))

function selectAll() {
  selectedIds.value = allVisibleSelected.value
    ? new Set()
    : new Set(filtered.value.map(b => b.id))
}

watch(filtered, list => {
  if (!selectedIds.value.size) return
  const visible = new Set(list.map(b => b.id))
  const next = new Set([...selectedIds.value].filter(id => visible.has(id)))
  if (next.size !== selectedIds.value.size) selectedIds.value = next
})

function onLongPress(book: BookMeta) {
  manageMode.value = true
  selectedIds.value = new Set([book.id])
}

const selectedComics = computed(() => localComics.value.filter(b => selectedIds.value.has(b.id)))
const allSelectedPinned = computed(() => !!selectedComics.value.length && selectedComics.value.every(b => b.pinnedAt))
const allSelectedPrivate = computed(() => !!selectedComics.value.length && selectedComics.value.every(b => b.noSync))

async function batchDelete() {
  const ids = [...selectedIds.value]
  const count = ids.length
  if (!count || !(await askConfirm(t('library.batchDeleteConfirm', { count }), deleteConfirmOptions(t('library.batchDeleteTitle', { count }))))) return
  let deleted = 0
  const removedIds: string[] = []
  try {
    for (const id of ids) {
      await library.removeBook(id)
      removedIds.push(id)
      deleted += 1
    }
    cleanupLocalProgress(removedIds)
    selectedIds.value = new Set()
    manageMode.value = false
    if (tagFilter.value && !allTags.value.includes(tagFilter.value)) tagFilter.value = ''
    toast(t('library.batchDeleted', { count }), 'success')
  } catch (error: unknown) {
    cleanupLocalProgress(removedIds)
    selectedIds.value = new Set(ids.filter(id => library.books.some(book => book.id === id)))
    const msg = error instanceof Error ? error.message : String(error)
    toast(t('library.batchDeleteFailed', { deleted, msg }), 'error', 7000)
  }
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
    const book = localComics.value.find(b => b.id === id)
    if (!book) continue
    const pinnedAt = pin ? stamp-- : 0
    await storage.updateBook(id, { pinnedAt })
    book.pinnedAt = pinnedAt || undefined
  }
  toast(pin ? t('library.pinned') : t('library.unpinned'), 'success')
}

/** 设为 / 取消私密 (与藏书页一致: noSync 标记, 同步时跳过) */
async function setPrivate(ids: string[], on: boolean) {
  const storage = await (await import('../storage')).getStorage()
  for (const id of ids) {
    const book = localComics.value.find(b => b.id === id)
    if (!book) continue
    await storage.updateBook(id, { noSync: on })
    book.noSync = on || undefined
  }
  toast(on ? t('library.privateOn') : t('library.privateOff'), 'success')
}

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
  const targets = selectedComics.value
  if (!targets.length) return
  try {
    const res = await exportBooksToFolder(targets)
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

async function batchTag() {
  const tags = tagDraft.value.split(/[,，、]/).map(item => item.trim()).filter(Boolean)
  if (!tags.length) return
  const storage = await (await import('../storage')).getStorage()
  for (const id of selectedIds.value) {
    const book = localComics.value.find(b => b.id === id)
    if (!book) continue
    const merged = [...new Set([...book.tags, ...tags])]
    await storage.updateBook(id, { tags: merged })
    book.tags = merged
  }
  showTagModal.value = false
  tagDraft.value = ''
  toast(t('library.tagsAdded', { count: selectedIds.value.size }), 'success')
}

async function batchClearTags() {
  const storage = await (await import('../storage')).getStorage()
  for (const id of selectedIds.value) {
    const book = localComics.value.find(b => b.id === id)
    if (!book || !book.tags.length) continue
    await storage.updateBook(id, { tags: [] })
    book.tags = []
  }
  if (tagFilter.value && !allTags.value.includes(tagFilter.value)) tagFilter.value = ''
  showTagModal.value = false
  tagDraft.value = ''
  toast(t('library.tagsCleared', { count: selectedIds.value.size }), 'success')
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (showInstall.value || showTagModal.value) return
  if (manageMode.value) {
    manageMode.value = false
    selectedIds.value = new Set()
  }
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  importing.value = true
  try {
    const results = await importFiles(files, '本地导入')
    await library.refresh()
    const ok = results.filter(r => r.ok).length
    if (ok) toast(t('comics.importSuccess', { count: ok }), 'success')
    for (const f of results.filter(r => !r.ok)) toast(`${f.fileName}: ${f.error}`, 'error', 5000)
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    importing.value = false
  }
}

// ---- 漫画源管理 ----
const plugins = ref<InstalledComicPlugin[]>([])
const showInstall = ref(false)
const installMode = ref<'file' | 'url'>('file')
const installUrl = ref('')
const installing = ref(false)

onMounted(() => {
  plugins.value = listPlugins()
  void refreshToday()
  stopReadingLog = onReadingLogChange(() => void refreshToday())
  window.addEventListener('keydown', onKeyDown)
})
onBeforeUnmount(() => {
  stopReadingLog?.()
  window.removeEventListener('keydown', onKeyDown)
})
function refreshPlugins() { plugins.value = listPlugins() }

async function onPluginFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  installing.value = true
  try {
    let ok = 0
    for (const file of files) {
      try { await installFromFile(file); ok++ }
      catch (e: any) { toast(`${file.name}: ${e?.message ?? e}`, 'error', 6000) }
    }
    refreshPlugins()
    if (ok) {
      toast(t('comics.installSuccess', { count: ok }), 'success')
      showInstall.value = false
    }
  } finally {
    installing.value = false
  }
}

async function onInstallUrl() {
  const url = installUrl.value.trim()
  if (!url) return
  installing.value = true
  try {
    await installFromUrl(url)
    refreshPlugins()
    installUrl.value = ''
    showInstall.value = false
    toast(t('comics.installSuccess', { count: 1 }), 'success')
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    installing.value = false
  }
}

function togglePlugin(plugin: InstalledComicPlugin) {
  setPluginEnabled(plugin.uuid, !plugin.enabled)
  refreshPlugins()
}

async function uninstall(plugin: InstalledComicPlugin) {
  const ok = await askConfirm(
    t('comics.uninstallConfirm', { name: plugin.name }),
    deleteConfirmOptions(t('comics.uninstall')),
  )
  if (!ok) return
  removePlugin(plugin.uuid)
  refreshPlugins()
  toast(t('comics.uninstalled'), 'success')
}

function openSource(plugin: InstalledComicPlugin) {
  router.push(`/comics/source/${encodeURIComponent(plugin.uuid)}`)
}

function openSettings(plugin: InstalledComicPlugin) {
  router.push(`/comics/settings/${encodeURIComponent(plugin.uuid)}`)
}

function openStore() {
  router.push('/comics/store')
}

// ---- 插件更新检测 ----
const checkingUpdates = ref(false)
const updatingUuid = ref('')
/** 有更新的插件, 按 uuid / storeUuid 建索引 */
const updates = ref<Map<string, StoreUpdate>>(new Map())

function updateFor(plugin: InstalledComicPlugin): StoreUpdate | undefined {
  return updates.value.get(plugin.uuid) ?? updates.value.get(plugin.storeUuid ?? '')
}

async function checkForUpdates() {
  if (checkingUpdates.value) return
  checkingUpdates.value = true
  try {
    const list = await checkUpdates()
    const map = new Map<string, StoreUpdate>()
    for (const item of list) {
      map.set(item.installed.uuid, item)
      if (item.installed.storeUuid) map.set(item.installed.storeUuid, item)
    }
    updates.value = map
    if (list.length) {
      toast(t('comics.updatesFound', { count: list.length }), 'success')
    } else {
      toast(t('comics.noUpdates'), 'info')
    }
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    checkingUpdates.value = false
  }
}

async function updatePlugin(plugin: InstalledComicPlugin) {
  const item = updateFor(plugin)
  if (!item || updatingUuid.value) return
  updatingUuid.value = plugin.uuid
  try {
    await installStoreEntry(item.entry)
    updates.value = new Map([...updates.value].filter(([k]) => k !== plugin.uuid && k !== (plugin.storeUuid ?? '')))
    refreshPlugins()
    toast(t('comics.updateSuccess', { name: plugin.name }), 'success')
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    updatingUuid.value = ''
  }
}
</script>

<template>
  <div class="comics">
    <header class="toolbar">
      <div class="heading">
        <h1>{{ t('nav.comics') }}</h1>
      </div>
      <div class="spacer" />
      <div v-if="activeTab === 'local'" class="search-field">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16.5 16.5 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input v-model="keyword" class="search" type="search" :placeholder="t('comics.searchLocal')" :aria-label="t('comics.searchLocal')" />
      </div>
      <button v-if="activeTab === 'sources'" class="btn" @click="openStore">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 6h16v12H4zM4 10h16M9 6v12"/></svg>
        {{ t('comics.store') }}
      </button>
      <template v-if="activeTab === 'local'">
        <AppSelect v-if="localComics.length" v-model="sortBy" class="sort-select" :aria-label="t('common.sortBy')">
          <option value="recent">{{ t('library.sortRecent') }}</option>
          <option value="added">{{ t('library.sortAdded') }}</option>
          <option value="title">{{ t('library.sortTitle') }}</option>
          <option value="author">{{ t('library.sortAuthor') }}</option>
        </AppSelect>
        <button
          v-if="localComics.length"
          class="btn btn-sm"
          :class="manageMode ? 'btn-primary' : 'btn-ghost'"
          :aria-pressed="manageMode"
          @click="toggleManage"
        >
          {{ manageMode ? t('common.done') : t('library.manage') }}
        </button>
        <button class="btn btn-primary" :disabled="importing" @click="fileInput?.click()">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t('comics.import') }}
        </button>
      </template>
      <input ref="fileInput" type="file" accept=".cbz,.cbr,application/x-cbz,application/x-cbr" multiple hidden @change="onFiles" />
    </header>

    <!-- 最近阅读 (本地漫画里最近打开的一本, 与藏书页继续阅读同形态) -->
    <section v-if="activeTab === 'local' && resumeComic" class="resume card" role="button" tabindex="0" :aria-label="`${t('library.continueReading')}: ${resumeComic.title}`" @click="openBook(resumeComic)" @keydown.enter.prevent="openBook(resumeComic)">
      <div class="resume-cover" aria-hidden="true">
        <img v-if="library.coverUrls[resumeComic.id]" :src="library.coverUrls[resumeComic.id]" alt="" decoding="async" />
        <span v-else class="resume-cover-title">{{ shortTitle(resumeComic.title) }}</span>
      </div>
      <div class="resume-info">
        <span class="resume-eyebrow">{{ t('library.continueReadingAgo', { time: agoText(resumeComic.lastReadAt!) }) }}</span>
        <span class="resume-title">{{ shortTitle(resumeComic.title) }}</span>
        <span class="resume-author">{{ shortAuthor(resumeComic.author) || t('common.anonymous') }}</span>
        <span class="resume-foot">
          <span class="resume-track" aria-hidden="true"><span class="resume-fill" :style="{ width: `${Math.max(resumePercent, 2)}%` }" /></span>
          <span class="resume-pct">{{ resumePercent }}%</span>
          <span class="resume-go" aria-hidden="true">{{ t('library.continue') }}</span>
        </span>
      </div>
      <!-- 桌面: 今日 / 本周时长并入继续阅读卡 (与藏书页一致) -->
      <div class="resume-stats">
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

    <!-- 本地漫画与漫画源并排成两个标签页, 不再上下堆叠 -->
    <div class="comic-tabs" role="tablist">
      <button type="button" role="tab" class="comic-tab" :class="{ active: activeTab === 'local' }" :aria-selected="activeTab === 'local'" @click="activeTab = 'local'">
        {{ t('comics.local') }}
        <span class="tab-count">{{ localComics.length }}</span>
      </button>
      <button type="button" role="tab" class="comic-tab" :class="{ active: activeTab === 'sources' }" :aria-selected="activeTab === 'sources'" @click="activeTab = 'sources'">
        {{ t('comics.sources') }}
        <span class="tab-count">{{ plugins.length }}</span>
      </button>
    </div>

    <section v-if="activeTab === 'local'" class="comic-section">
      <!-- 标签筛选 -->
      <div v-if="allTags.length" class="tag-row">
        <button class="tag-chip" :class="{ active: !tagFilter }" :aria-pressed="!tagFilter" @click="tagFilter = ''">{{ t('library.filterAll') }}</button>
        <button
          v-for="tag in allTags"
          :key="tag"
          class="tag-chip"
          :class="{ active: tagFilter === tag }"
          :aria-pressed="tagFilter === tag"
          @click="tagFilter = tagFilter === tag ? '' : tag"
        >{{ tag }}</button>
      </div>

      <div v-if="filtered.length" class="grid">
        <BookCard
          v-for="book in filtered"
          :key="book.id"
          :book="book"
          :cover-url="library.coverUrls[book.id]"
          :selectable="manageMode"
          :selected="selectedIds.has(book.id)"
          :sendable="settings.features.transfer"
          @open="openBook(book)"
          @remove="removeBook(book)"
          @long-press="onLongPress(book)"
          @toggle-select="toggleSelect(book.id)"
          @toggle-pin="togglePin(book)"
          @export="exportBook(book)"
          @send="sendBookToDevices(book.id)"
          @toggle-private="setPrivate([book.id], !book.noSync)"
        />
      </div>
      <div v-else class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="10" rx="1"/><rect x="13" y="3" width="8" height="6" rx="1"/><rect x="3" y="15" width="8" height="6" rx="1"/><rect x="13" y="11" width="8" height="10" rx="1"/></svg>
        </div>
        <p class="empty-title">{{ keyword || tagFilter ? t('comics.noMatch') : t('comics.localEmptyTitle') }}</p>
        <p class="hint">{{ t('comics.localEmptyHint') }}</p>
        <div class="empty-actions">
          <button class="btn btn-primary" @click="fileInput?.click()">{{ t('comics.import') }}</button>
        </div>
      </div>

      <!-- 桌面批量操作栏 -->
      <div v-if="manageMode" class="batch-bar card" role="toolbar" :aria-label="t('library.manage')">
        <span class="batch-count">{{ t('library.selectedCount', { count: selectedIds.size }) }}</span>
        <button class="btn btn-sm" @click="selectAll">
          {{ allVisibleSelected ? t('library.deselectAll') : t('library.selectAll') }}
        </button>
        <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPin(!allSelectedPinned)">{{ allSelectedPinned ? t('library.unpin') : t('library.pin') }}</button>
        <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPrivate(!allSelectedPrivate)">{{ allSelectedPrivate ? t('library.unsetPrivate') : t('library.setPrivate') }}</button>
        <button class="btn btn-sm" :disabled="!selectedIds.size" @click="showTagModal = true">{{ t('library.setTags') }}</button>
        <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchExport">{{ t('library.batchExport') }}</button>
        <button class="btn btn-sm btn-danger" :disabled="!selectedIds.size" @click="batchDelete">{{ t('common.delete') }}</button>
        <button class="btn btn-sm" @click="toggleManage">{{ t('common.done') }}</button>
      </div>
    </section>

    <section v-else class="comic-section">
      <div class="section-head">
        <span v-if="plugins.length" class="count">{{ t('comics.sourceCount', { count: plugins.length }) }}</span>
        <div class="spacer" />
        <button class="btn" :disabled="checkingUpdates || !plugins.length" @click="checkForUpdates">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
          {{ checkingUpdates ? t('comics.checkingUpdates') : t('comics.checkUpdates') }}
        </button>
        <button class="btn" @click="showInstall = true">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t('comics.installSource') }}
        </button>
      </div>

      <div v-if="plugins.length" class="source-grid">
        <article v-for="plugin in plugins" :key="plugin.uuid" class="source-card" :class="{ 'is-disabled': !plugin.enabled }">
          <div class="source-top">
            <img v-if="plugin.iconUrl" :src="plugin.iconUrl" class="source-icon" alt="" referrerpolicy="no-referrer" />
            <div v-else class="source-icon source-icon-fallback" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>
            </div>
            <div class="source-meta">
              <div class="source-name">
                {{ plugin.name }}
                <span v-if="plugin.version" class="source-version">v{{ plugin.version }}</span>
                <span v-if="!plugin.enabled" class="source-badge">{{ t('comics.disabled') }}</span>
                <span v-if="updateFor(plugin)" class="source-badge source-update-badge">{{ t('comics.hasUpdate') }}</span>
              </div>
              <p class="source-desc">{{ plugin.describe || plugin.origin }}</p>
            </div>
          </div>
          <div class="source-actions">
            <button class="btn btn-primary" :disabled="!plugin.enabled" @click="openSource(plugin)">{{ t('comics.openSource') }}</button>
            <button v-if="updateFor(plugin)" class="btn btn-update" :disabled="updatingUuid === plugin.uuid" @click="updatePlugin(plugin)">
              {{ updatingUuid === plugin.uuid ? t('comics.updating') : t('comics.updateTo', { version: updateFor(plugin)!.entry.version }) }}
            </button>
            <button class="btn" @click="openSettings(plugin)">{{ t('comics.pluginSettings') }}</button>
            <button class="btn" @click="togglePlugin(plugin)">{{ plugin.enabled ? t('comics.disable') : t('comics.enable') }}</button>
            <button class="btn btn-ghost" @click="uninstall(plugin)">{{ t('comics.uninstall') }}</button>
          </div>
        </article>
      </div>
      <div v-else class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>
        </div>
        <p class="empty-title">{{ t('comics.sourcesEmptyTitle') }}</p>
        <p class="hint">{{ t('comics.sourcesEmptyHint') }}</p>
        <div class="empty-actions">
          <button class="btn btn-primary" @click="showInstall = true">{{ t('comics.installSource') }}</button>
        </div>
      </div>
    </section>

    <AppModal v-if="showInstall" :title="t('comics.installSource')" :description="t('comics.installHint')" @close="showInstall = false">
      <div class="install-dialog">
        <div class="install-tabs" role="tablist">
          <button type="button" :class="{ active: installMode === 'file' }" role="tab" :aria-selected="installMode === 'file'" @click="installMode = 'file'">{{ t('comics.installFromFile') }}</button>
          <button type="button" :class="{ active: installMode === 'url' }" role="tab" :aria-selected="installMode === 'url'" @click="installMode = 'url'">{{ t('comics.installFromUrl') }}</button>
        </div>
        <div v-if="installMode === 'file'" class="install-body">
          <button class="btn btn-primary" :disabled="installing" @click="pluginFileInput?.click()">{{ t('comics.choosePluginFile') }}</button>
          <input ref="pluginFileInput" type="file" accept=".js,.cjs,.mjs,text/javascript,application/javascript" multiple hidden @change="onPluginFiles" />
          <p class="hint">{{ t('comics.pluginFileHint') }}</p>
        </div>
        <div v-else class="install-body">
          <input v-model="installUrl" class="search install-input" type="url" :placeholder="t('comics.sourceUrlPlaceholder')" @keyup.enter="onInstallUrl" />
          <button class="btn btn-primary" :disabled="installing || !installUrl.trim()" @click="onInstallUrl">{{ t('comics.install') }}</button>
          <p class="hint">{{ t('comics.urlHint') }}</p>
        </div>
      </div>
    </AppModal>

    <!-- 批量标签弹窗 -->
    <AppModal v-if="showTagModal" :title="t('library.tagModalTitle', { count: selectedIds.size })" @close="showTagModal = false">
      <div class="tag-dialog">
        <input v-model="tagDraft" v-autofocus class="input full" :placeholder="t('library.tagPlaceholder')" :aria-label="t('library.setTags')" @keyup.enter="batchTag" />
        <div class="form-actions">
          <button class="btn btn-sm" @click="batchClearTags">{{ t('library.clearTags') }}</button>
          <span class="spacer" />
          <button class="btn btn-sm" @click="showTagModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!tagDraft.trim()" @click="batchTag">{{ t('common.add') }}</button>
        </div>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.comics {
  min-height: 100%;
  max-width: calc(var(--page-max) + 2 * var(--page-x));
  margin: 0 auto;
  padding: 0 var(--page-x) calc(var(--page-bottom) + var(--lr-safe-bottom));
  position: relative;
}
.toolbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 calc(-1 * var(--page-x)) 18px;
  padding: calc(var(--page-top) + 20px) calc(var(--page-x) + var(--chrome-inset-right)) 12px var(--page-x);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid transparent;
}
.heading { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.toolbar h1 { font-size: var(--page-title); font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
.count { color: var(--text-3); font-size: 13px; white-space: nowrap; }
.spacer { flex: 1; }
.search-field { position: relative; display: flex; align-items: center; width: 320px; max-width: 100%; }
.search-icon { position: absolute; left: 12px; color: var(--text-3); pointer-events: none; }
/* 搜索框跟按钮同高同字号, 否则一排控件高矮不齐 */
.search { width: 100%; height: var(--control-h); padding: 0 30px 0 34px; font-size: 13px; border-color: transparent; border-radius: var(--radius-pill); background: var(--surface-2); }
.toolbar .btn { padding: 0 12px; font-size: var(--fs-sm); }
.comic-section { margin-top: 12px; }

/* 最近阅读 (与藏书页继续阅读同形态) */
.resume {
  display: flex; gap: 14px; max-width: 560px; margin: 18px 0 4px;
  padding: 14px; border: none; border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm); cursor: pointer;
}
.resume:hover { box-shadow: var(--shadow-md); }
.resume:active { background: var(--surface-2); }
.resume:focus-visible { outline: none; box-shadow: var(--ring); }
.resume-cover {
  position: relative; flex-shrink: 0; width: 64px; aspect-ratio: 2 / 3;
  border-radius: 3px 5px 5px 3px; overflow: hidden;
  background: var(--cover-paper-0); color: var(--cover-ink-0); box-shadow: var(--cover-shadow);
}
.resume-cover::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  box-shadow: inset 0 0 0 1px var(--cover-edge);
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.12) 0, rgba(255, 255, 255, 0.14) 2.5%, transparent 6%);
}
.resume-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.resume-cover-title {
  display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden;
  padding: 10px 8px; font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif;
  font-size: var(--fs-xs); font-weight: 600; line-height: 1.4;
}
.resume-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.resume-eyebrow { font-size: 12px; color: var(--text-3); }
.resume-title {
  margin-top: 4px; font-size: var(--fs-subtitle); font-weight: 600; line-height: 1.35;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.resume-author { margin-top: 2px; font-size: 13px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.resume-foot { margin-top: auto; padding-top: 10px; display: flex; align-items: center; gap: 10px; }
.resume-track { flex: 1; height: 4px; border-radius: 2px; background: var(--surface-3); overflow: hidden; }
.resume-fill { display: block; height: 100%; border-radius: 2px; background: var(--brand); }
.resume-pct { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.resume-go {
  flex-shrink: 0; height: 32px; padding: 0 14px; border-radius: var(--radius-pill);
  display: inline-flex; align-items: center; background: var(--brand); color: var(--on-brand); font-size: 13px;
}

.comic-tabs { display: flex; gap: 4px; margin: 4px 0 0; border-bottom: 1px solid var(--line); }
.comic-tab {
  display: inline-flex; align-items: center; gap: 8px;
  border: 0; background: none; color: var(--text-3);
  padding: 10px 16px 12px; font-size: var(--fs-base); cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.comic-tab:hover { color: var(--text); }
.comic-tab.active { color: var(--text); border-bottom-color: var(--accent, currentColor); font-weight: 600; }
.tab-count { font-size: var(--fs-xs); color: var(--text-3); background: var(--surface-2); border-radius: 999px; padding: 1px 7px; }
.section-title { font-size: var(--fs-md); font-weight: 600; margin: 18px 0 14px; color: var(--text-2); }
.section-head { display: flex; align-items: center; gap: 10px; }
.section-head .section-title { margin-right: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 22px 16px; }
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 40px 16px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-lg, 14px);
  background: var(--surface-1);
}
.empty-icon { color: var(--text-3); width: 38px; height: 38px; margin-bottom: 12px; }
.empty-icon svg { width: 100%; height: 100%; }
.empty-title { font-size: var(--fs-md); font-weight: 600; margin: 0 0 6px; }
.hint { color: var(--text-3); font-size: var(--fs-sm); line-height: 1.6; margin: 0; }
.empty-actions { margin-top: 16px; }

/* ---- 漫画源卡片 (沿用藏书页卡片语言) ---- */
.source-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.source-card {
  display: flex; flex-direction: column; gap: 14px;
  padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-lg, 14px);
  background: var(--surface-1);
}
.source-card.is-disabled { opacity: 0.6; }
.source-top { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
.source-icon { width: 36px; height: 36px; border-radius: 9px; object-fit: contain; background: var(--surface-2); flex: none; }
.source-icon-fallback { display: grid; place-items: center; color: var(--text-3); padding: 7px; }
.source-icon-fallback svg { width: 100%; height: 100%; }
.source-meta { min-width: 0; }
.source-name { font-size: var(--fs-base); font-weight: 600; display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.source-version { font-size: var(--fs-xs); font-weight: 400; color: var(--text-3); }
.source-badge { font-size: var(--fs-xs); font-weight: 500; color: var(--text-3); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
.source-update-badge { color: var(--accent, currentColor); border-color: var(--accent, currentColor); }
.btn-update { color: var(--accent, currentColor); }
.source-desc { margin: 5px 0 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--text-3); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.source-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.source-actions .btn { flex: 1; white-space: nowrap; }

/* ---- 安装弹窗: AppModal 的 body 没有内边距, 这里自己留白避免按钮贴边 ---- */
.install-dialog { padding: 16px 20px 20px; }
.install-tabs { display: flex; gap: 6px; margin-bottom: 18px; border-bottom: 1px solid var(--line); }
.install-tabs button { border: 0; background: none; color: var(--text-3); padding: 8px 14px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; }
.install-tabs button.active { color: var(--text); border-bottom-color: var(--accent, currentColor); font-weight: 600; }
.install-body { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.install-body .btn { width: 100%; }
.install-input { padding-left: 12px; }

/* ---- 批量管理 / 标签 / 排序 (复刻藏书页) ---- */
.sort-select { width: auto; height: var(--control-h); min-height: 0; padding: 0 10px; font-size: 13px; border-radius: var(--radius-sm); }
.tag-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.tag-chip {
  height: 28px; padding: 0 12px; border: 1px solid var(--border); border-radius: 14px;
  background: var(--card); color: var(--text-2); font-size: 12px; font-weight: 500;
  transition: border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.tag-chip:hover { border-color: var(--border-strong); color: var(--text); }
.tag-chip:focus-visible { outline: none; box-shadow: var(--ring); }
.tag-chip.active { background: var(--brand-light); border-color: var(--brand); color: var(--brand); }
.batch-bar {
  position: sticky; bottom: calc(16px + var(--lr-safe-bottom)); margin-top: 20px;
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 14px;
  box-shadow: var(--shadow-lg); z-index: 10; animation: menu-in var(--dur) var(--ease);
}
.batch-count { font-size: 13px; font-weight: 600; color: var(--text); min-width: 70px; font-variant-numeric: tabular-nums; }
.tag-dialog { padding: 16px 20px 20px; display: flex; flex-direction: column; gap: 14px; }
.tag-dialog .full { width: 100%; }
.form-actions { display: flex; align-items: center; gap: 8px; }

/* ---- 桌面端 (≥721px): 最近阅读卡片对齐藏书页继续阅读 ---- */
@media (min-width: 721px) {
  .resume {
    max-width: none;
    align-items: center;
    gap: var(--space-6);
    margin: 0 0 var(--space-8);
    padding: var(--space-6);
    border-radius: var(--radius-lg);
  }
  .resume-cover { width: 88px; }
  .resume-cover-title { padding: 12px 10px; font-size: var(--fs-small); }
  .resume-eyebrow { font-size: var(--fs-caption); }
  .resume-title {
    margin-top: var(--space-1);
    font-size: var(--fs-title);
    font-weight: var(--fw-semibold);
    -webkit-line-clamp: 1;
  }
  .resume-author { font-size: var(--fs-small); }
  .resume-foot {
    max-width: 480px;
    margin-top: var(--space-4);
    padding-top: 0;
    gap: var(--space-3);
  }
  .resume-pct { font-size: var(--fs-small); }
  .resume-go {
    padding: 0 var(--space-4);
    border-radius: var(--radius-sm);
    font-size: var(--fs-small);
    font-weight: var(--fw-medium);
  }
  .resume-stats {
    flex-shrink: 0;
    display: flex;
    gap: var(--space-8);
    padding: 0 var(--space-4) 0 var(--space-8);
    border-left: 1px solid var(--border);
  }
  .resume-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-radius: var(--radius-sm);
    color: var(--text);
    text-decoration: none;
  }
  .resume-stat b {
    font-size: var(--fs-display);
    font-weight: var(--fw-semibold);
    line-height: 1.15;
    font-variant-numeric: tabular-nums;
    transition: color var(--dur-fast) var(--ease);
  }
  .resume-stat small {
    font-size: var(--fs-small);
    font-weight: var(--fw-regular);
    color: var(--text-3);
  }
  .resume-stat > span { font-size: var(--fs-small); color: var(--text-3); }
  .resume-stat > span.done { color: var(--success); }
  .resume-stat:hover b { color: var(--brand); }
  .resume-stat:focus-visible { outline: none; box-shadow: var(--ring); }
}
</style>
