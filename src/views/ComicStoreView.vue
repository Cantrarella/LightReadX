<script setup lang="ts">
/**
 * 插件商店: 订阅索引 → 浏览 → 一键安装 / 更新 Breeze 兼容漫画源。
 * UI 沿用漫画页的 toolbar / 卡片 / 空态语言, 不另起一套视觉。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { t } from '../i18n'
import { toast } from '../services/toast'
import { askConfirm, deleteConfirmOptions } from '../services/confirm'
import { openExternalLink } from '../services/transfer'
import {
  addSubscription, installStoreEntry, listSubscriptions, loadCachedStore, loadStore,
  removeSubscription, setSubscriptionEnabled, storeState,
  type StoreEntry, type StoreSubscription,
} from '../services/comicPlugin/store'
import AppModal from '../components/AppModal.vue'

const router = useRouter()
const entries = ref<StoreEntry[]>([])
const subs = ref<StoreSubscription[]>([])
const keyword = ref('')
const sourceFilter = ref('')
const loading = ref(false)
const loadingText = ref('')
const errors = ref<string[]>([])
const fromCache = ref(false)
const busyUuid = ref('')
const showSubs = ref(false)
const subName = ref('')
const subUrl = ref('')
const adding = ref(false)
const brokenIcons = ref<Record<string, boolean>>({})

onMounted(() => {
  subs.value = listSubscriptions()
  // 先把上次索引渲染出来, 桌面 WebView 原生请求即使挂住也不会一直停在「正在拉取…」
  const cached = loadCachedStore()
  if (cached.length) { entries.value = cached; fromCache.value = true }
  void refresh(false)
})

async function refresh(force: boolean) {
  if (loading.value) return
  loading.value = true
  loadingText.value = t('comics.storeRefreshing')
  errors.value = []
  try {
    const result = await loadStore(force)
    // 全部源都失败时保留已有列表, 只显示错误 + 重试, 不清空页面
    if (result.entries.length) entries.value = result.entries
    errors.value = result.errors
    fromCache.value = result.fromCache || !result.entries.length
    subs.value = listSubscriptions()
  } catch (e: any) {
    errors.value = [e?.message ?? String(e)]
  } finally {
    loading.value = false
  }
}

const sources = computed(() => {
  const map = new Map<string, string>()
  for (const e of entries.value) map.set(e.sourceId, e.sourceName)
  return [...map].map(([id, name]) => ({ id, name }))
})

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return entries.value.filter(e => {
    if (sourceFilter.value && e.sourceId !== sourceFilter.value) return false
    if (!kw) return true
    return [e.name, e.describe, e.author, e.repo, e.npmName]
      .some(v => v && v.toLowerCase().includes(kw))
  })
})

async function install(entry: StoreEntry) {
  if (busyUuid.value) return
  busyUuid.value = entry.uuid
  loadingText.value = t('comics.storeInstalling')
  try {
    const { plugin } = await installStoreEntry(entry)
    toast(t('comics.storeInstallSuccess', { name: plugin.name || entry.name }), 'success')
    entries.value = [...entries.value]
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    busyUuid.value = ''
  }
}

async function addSub() {
  if (adding.value) return
  adding.value = true
  try {
    addSubscription(subName.value, subUrl.value)
    subName.value = ''
    subUrl.value = ''
    subs.value = listSubscriptions()
    showSubs.value = false
    await refresh(true)
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    adding.value = false
  }
}

async function removeSub(sub: StoreSubscription) {
  if (sub.builtin) return
  const ok = await askConfirm(
    t('comics.storeSubscribeRemoveConfirm', { name: sub.name }),
    deleteConfirmOptions(t('comics.storeSubscribeRemove')),
  )
  if (!ok) return
  removeSubscription(sub.id)
  subs.value = listSubscriptions()
  if (sourceFilter.value === sub.id) sourceFilter.value = ''
  await refresh(false)
}

function toggleSub(sub: StoreSubscription) {
  setSubscriptionEnabled(sub.id, !sub.enabled)
  subs.value = listSubscriptions()
  void refresh(false)
}

function openHome(entry: StoreEntry) {
  if (entry.home) void openExternalLink(entry.home).catch(() => {})
}
</script>

<template>
  <div class="comic-store">
    <header class="toolbar">
      <button class="btn btn-ghost back-btn" @click="router.push('/comics')">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m15 18-6-6 6-6"/></svg>
        {{ t('comics.storeBack') }}
      </button>
      <div class="heading"><h1>{{ t('comics.storeTitle') }}</h1></div>
      <span v-if="!loading && entries.length" class="count">{{ t('comics.storeCount', { count: entries.length }) }}</span>
      <div class="spacer" />
      <div class="search-field">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16.5 16.5 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input v-model="keyword" class="search" type="search" :placeholder="t('comics.storeSearchPlaceholder')" :aria-label="t('comics.storeSearchPlaceholder')" />
      </div>
      <button class="btn" :disabled="loading" @click="refresh(true)">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>
        {{ t('comics.storeRefresh') }}
      </button>
      <button class="btn btn-primary" @click="showSubs = true">{{ t('comics.storeSubscribe') }}</button>
    </header>

    <p class="store-hint">{{ t('comics.storeHint') }}</p>
    <p v-if="loading" class="hint loading-hint">{{ loadingText }}</p>
    <p v-if="errors.length" class="error-text">
      {{ t('comics.storeLoadFailed') }}：{{ errors.join('；') }}
      <button class="btn btn-ghost" :disabled="loading" @click="refresh(true)">{{ t('comics.storeRetry') }}</button>
    </p>
    <p v-if="fromCache && !loading" class="hint">{{ t('comics.storeFromCache') }}</p>

    <div v-if="sources.length > 1" class="filter-row">
      <button type="button" class="chip" :class="{ active: !sourceFilter }" @click="sourceFilter = ''">{{ t('comics.storeAll') }}</button>
      <button v-for="s in sources" :key="s.id" type="button" class="chip" :class="{ active: sourceFilter === s.id }" @click="sourceFilter = s.id">{{ s.name }}</button>
    </div>

    <div v-if="filtered.length" class="store-grid">
      <article v-for="entry in filtered" :key="entry.uuid" class="store-card">
        <div class="store-top">
          <img
            v-if="entry.iconUrl && !brokenIcons[entry.uuid]"
            :src="entry.iconUrl" class="store-icon" alt="" referrerpolicy="no-referrer"
            @error="brokenIcons[entry.uuid] = true"
          />
          <div v-else class="store-icon store-icon-fallback" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>
          </div>
          <div class="store-meta">
            <div class="store-name">
              {{ entry.name }}
              <span v-if="entry.version" class="store-version">v{{ entry.version }}</span>
              <span v-if="storeState(entry) === 'update'" class="store-badge update">{{ t('comics.storeHasUpdate') }}</span>
            </div>
            <p class="store-desc">{{ entry.describe || entry.repo }}</p>
            <p class="store-sub">
              <span v-if="entry.author">{{ t('comics.storeBy', { author: entry.author }) }}</span>
              <span v-if="entry.author && entry.sourceName"> · </span>
              <span>{{ t('comics.storeSource', { source: entry.sourceName }) }}</span>
            </p>
          </div>
        </div>
        <div class="store-actions">
          <button
            v-if="storeState(entry) !== 'installed'"
            class="btn btn-primary"
            :disabled="!!busyUuid"
            @click="install(entry)"
          >{{ busyUuid === entry.uuid ? t('comics.storeInstalling') : storeState(entry) === 'update' ? t('comics.storeUpdate') : t('comics.storeInstall') }}</button>
          <span v-else class="installed-label">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 13 4 4L19 7"/></svg>
            {{ t('comics.storeInstalled') }}
          </span>
          <button v-if="entry.home" class="btn btn-ghost" :title="t('comics.storeHome')" @click="openHome(entry)">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>
          </button>
        </div>
      </article>
    </div>
    <div v-else-if="!loading" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16v12H4zM4 10h16M9 6v12"/></svg>
      </div>
      <p class="empty-title">{{ keyword || sourceFilter ? t('comics.storeNoMatch') : t('comics.storeEmpty') }}</p>
      <p class="hint">{{ t('comics.storeEmptyHint') }}</p>
      <div class="empty-actions">
        <button class="btn" @click="refresh(true)">{{ t('comics.storeRefresh') }}</button>
        <button class="btn btn-primary" @click="showSubs = true">{{ t('comics.storeSubscribe') }}</button>
      </div>
    </div>

    <AppModal v-if="showSubs" :title="t('comics.storeSubscribe')" :description="t('comics.storeSubscribeHint')" @close="showSubs = false">
      <div class="sub-list">
        <div v-for="sub in subs" :key="sub.id" class="sub-row" :class="{ 'is-disabled': !sub.enabled }">
          <div class="sub-meta">
            <div class="sub-name">
              {{ sub.name }}
              <span v-if="sub.builtin" class="store-badge">{{ t('comics.storeOfficial') }}</span>
            </div>
            <p class="sub-url" :title="sub.url">{{ sub.url }}</p>
          </div>
          <button class="btn" :disabled="sub.builtin" @click="toggleSub(sub)">{{ sub.enabled ? t('comics.storeDisable') : t('comics.storeEnable') }}</button>
          <button v-if="!sub.builtin" class="btn btn-ghost" @click="removeSub(sub)">{{ t('comics.storeSubscribeRemove') }}</button>
        </div>
      </div>
      <div class="sub-add">
        <input v-model="subName" class="search" type="text" :placeholder="t('comics.storeSubscribeName')" :aria-label="t('comics.storeSubscribeName')" />
        <input v-model="subUrl" class="search" type="url" :placeholder="t('comics.storeSubscribeUrl')" :aria-label="t('comics.storeSubscribeUrl')" @keyup.enter="addSub" />
        <button class="btn btn-primary" :disabled="adding || !subUrl.trim()" @click="addSub">{{ t('comics.storeSubscribeAdd') }}</button>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.comic-store {
  min-height: 100%;
  max-width: calc(var(--page-max) + 2 * var(--page-x));
  margin: 0 auto;
  padding: 0 var(--page-x) calc(var(--page-bottom) + var(--lr-safe-bottom));
  position: relative;
}
.toolbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 0 calc(-1 * var(--page-x)) 14px;
  padding: calc(var(--page-top) + 20px) calc(var(--page-x) + var(--chrome-inset-right)) 12px var(--page-x);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  border-bottom: 1px solid transparent;
}
.heading { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.toolbar h1 { font-size: var(--page-title); font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; }
.count { color: var(--text-3); font-size: 13px; white-space: nowrap; }
.spacer { flex: 1; }
.back-btn { padding-left: 8px; }
.search-field { position: relative; display: flex; align-items: center; width: 260px; max-width: 100%; }
.search-icon { position: absolute; left: 12px; color: var(--text-3); pointer-events: none; }
.search { width: 100%; height: var(--control-h); padding: 0 30px 0 34px; font-size: 13px; border-color: transparent; border-radius: var(--radius-pill); background: var(--surface-2); }
.toolbar .btn { padding: 0 12px; font-size: 13px; }
.store-hint { color: var(--text-3); font-size: 13px; line-height: 1.6; margin: 0 0 4px; }
.hint { color: var(--text-3); font-size: 13px; line-height: 1.6; margin: 0; }
.loading-hint { padding: 10px 0; }
.error-text { color: var(--danger, #d9534f); font-size: 13px; padding: 8px 0; }

.filter-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 4px; }
.chip {
  border: 1px solid var(--line); background: var(--surface-1); color: var(--text-3);
  border-radius: 999px; padding: 5px 13px; font-size: 12px; cursor: pointer;
}
.chip:hover { color: var(--text); }
.chip.active { color: var(--text); border-color: var(--accent, currentColor); font-weight: 600; background: var(--surface-2); }

.store-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; margin-top: 16px; }
.store-card {
  display: flex; flex-direction: column; gap: 14px;
  padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-lg, 14px);
  background: var(--surface-1);
}
.store-top { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
.store-icon { width: 40px; height: 40px; border-radius: 10px; object-fit: contain; background: var(--surface-2); flex: none; }
.store-icon-fallback { display: grid; place-items: center; color: var(--text-3); padding: 8px; }
.store-icon-fallback svg { width: 100%; height: 100%; }
.store-meta { min-width: 0; flex: 1; }
.store-name { font-size: 14px; font-weight: 650; display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.store-version { font-size: 11px; font-weight: 400; color: var(--text-3); }
.store-badge { font-size: 11px; font-weight: 500; color: var(--text-3); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
.store-badge.update { color: var(--accent, currentColor); border-color: var(--accent, currentColor); }
.store-desc { margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-3); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.store-sub { margin: 6px 0 0; font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.store-actions { display: flex; gap: 8px; align-items: center; }
.store-actions .btn-primary { flex: 1; }
.installed-label {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  flex: 1; color: var(--text-3); font-size: 12px;
  padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius-pill, 999px);
  background: var(--surface-2);
}

.empty {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: 40px 16px; margin-top: 16px;
  border: 1px dashed var(--line); border-radius: var(--radius-lg, 14px); background: var(--surface-1);
}
.empty-icon { color: var(--text-3); width: 38px; height: 38px; margin-bottom: 12px; }
.empty-icon svg { width: 100%; height: 100%; }
.empty-title { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
.empty-actions { display: flex; gap: 10px; margin-top: 16px; }

/* ---- 订阅弹窗 ---- */
.sub-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px; }
.sub-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; }
.sub-row.is-disabled { opacity: 0.55; }
.sub-meta { flex: 1; min-width: 0; }
.sub-name { font-size: 13px; font-weight: 600; display: flex; align-items: baseline; gap: 7px; }
.sub-url { margin: 3px 0 0; font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-add { display: flex; flex-direction: column; gap: 10px; }
.sub-add .search { padding-left: 12px; }
</style>
