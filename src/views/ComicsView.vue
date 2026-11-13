<script setup lang="ts">
/**
 * 漫画页: 本地漫画 (CBZ/CBR) 与在线漫画源分开显示。
 * 书籍与漫画共用同一个书库, 只在 UI 层按 format 分流 —— 同步、进度、标注全部沿用。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { importFiles } from '../services/importer'
import { readerPath } from '../services/readerRoute'
import { isComicFormat } from '../services/comicFormat'
import { toast } from '../services/toast'
import { askConfirm, deleteConfirmOptions } from '../services/confirm'
import { t } from '../i18n'
import type { BookMeta } from '../storage'
import {
  installFromFile, installFromUrl, listPlugins, removePlugin, setPluginEnabled,
  type InstalledComicPlugin,
} from '../services/comicPlugin'
import BookCard from '../components/BookCard.vue'
import AppModal from '../components/AppModal.vue'

const router = useRouter()
const library = useLibrary()
const keyword = ref('')
const activeTab = ref<'local' | 'sources'>('local')
const importing = ref(false)
const fileInput = ref<HTMLInputElement>()
const pluginFileInput = ref<HTMLInputElement>()

const localComics = computed(() => library.books.filter(b => isComicFormat(b.format)))
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = kw
    ? localComics.value.filter(b =>
      b.title.toLowerCase().includes(kw)
      || b.author.toLowerCase().includes(kw)
      || b.tags.some(tag => tag.toLowerCase().includes(kw)))
    : localComics.value
  return [...list].sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt))
})

function openBook(book: BookMeta) {
  router.push(readerPath(book))
}

async function removeBook(book: BookMeta) {
  await library.removeBook(book.id)
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

onMounted(() => { plugins.value = listPlugins() })
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
      <button v-if="activeTab === 'local'" class="btn btn-primary" :disabled="importing" @click="fileInput?.click()">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
        {{ t('comics.import') }}
      </button>
      <input ref="fileInput" type="file" accept=".cbz,.cbr,application/x-cbz,application/x-cbr" multiple hidden @change="onFiles" />
    </header>

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
      <div v-if="filtered.length" class="grid">
        <BookCard
          v-for="book in filtered"
          :key="book.id"
          :book="book"
          :cover-url="library.coverUrls[book.id]"
          @open="openBook(book)"
          @remove="removeBook(book)"
        />
      </div>
      <div v-else class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="10" rx="1"/><rect x="13" y="3" width="8" height="6" rx="1"/><rect x="3" y="15" width="8" height="6" rx="1"/><rect x="13" y="11" width="8" height="10" rx="1"/></svg>
        </div>
        <p class="empty-title">{{ keyword ? t('comics.noMatch') : t('comics.localEmptyTitle') }}</p>
        <p class="hint">{{ t('comics.localEmptyHint') }}</p>
        <div class="empty-actions">
          <button class="btn btn-primary" @click="fileInput?.click()">{{ t('comics.import') }}</button>
        </div>
      </div>
    </section>

    <section v-else class="comic-section">
      <div class="section-head">
        <span v-if="plugins.length" class="count">{{ t('comics.sourceCount', { count: plugins.length }) }}</span>
        <div class="spacer" />
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
              </div>
              <p class="source-desc">{{ plugin.describe || plugin.origin }}</p>
            </div>
          </div>
          <div class="source-actions">
            <button class="btn btn-primary" :disabled="!plugin.enabled" @click="openSource(plugin)">{{ t('comics.openSource') }}</button>
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
.toolbar .btn { padding: 0 12px; font-size: 13px; }
.comic-section { margin-top: 12px; }
.comic-tabs { display: flex; gap: 4px; margin: 4px 0 0; border-bottom: 1px solid var(--line); }
.comic-tab {
  display: inline-flex; align-items: center; gap: 8px;
  border: 0; background: none; color: var(--text-3);
  padding: 10px 16px 12px; font-size: 14px; cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.comic-tab:hover { color: var(--text); }
.comic-tab.active { color: var(--text); border-bottom-color: var(--accent, currentColor); font-weight: 650; }
.tab-count { font-size: 11px; color: var(--text-3); background: var(--surface-2); border-radius: 999px; padding: 1px 7px; }
.section-title { font-size: 15px; font-weight: 650; margin: 18px 0 14px; color: var(--text-2); }
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
.empty-title { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
.hint { color: var(--text-3); font-size: 13px; line-height: 1.6; margin: 0; }
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
.source-name { font-size: 14px; font-weight: 650; display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.source-version { font-size: 11px; font-weight: 400; color: var(--text-3); }
.source-badge { font-size: 11px; font-weight: 500; color: var(--text-3); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
.source-desc { margin: 5px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-3); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
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
</style>
