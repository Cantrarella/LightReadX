<script setup lang="ts">
/**
 * 漫画源「进入」页里的浏览面板 (由原发现页改造而来): 渲染 Breeze 插件的
 * Scheme + data 页面协议, 支持四种区块 / scene 分页 / 二级筛选 / 云端收藏 tab。
 *
 * 独立发现页已取消, 本组件嵌在 ComicSourceView 里, 点漫画或搜索词通过 emit
 * 交给父页面切到详情 / 搜索视图, 保证整个漫画源只有一个入口。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { t } from '../i18n'
import { toast } from '../services/toast'
import { openExternalLink } from '../services/transfer'
import { getPlugin, isUnauthorizedError, openPlugin, type ComicPluginHost } from '../services/comicPlugin'
import { bytesToObjectUrl } from '../services/comicPlugin/download'
import AppModal from './AppModal.vue'
import {
  comicIdOf, loadDiscoverHome, loadFunctionPage, loadSceneFilter,
  loadScenePage, mergeFilterResult, normalizeScene,
  type ComicListScene, type DiscoverBlock, type DiscoverHome, type DiscoverItem,
  type DiscoverPage, type FilterField, type PluginAction,
} from '../services/comicPlugin/discover'

const props = defineProps<{ uuid: string; initialTab?: string }>()
const emit = defineEmits<{
  (e: 'openComic', payload: { comicId: string; title?: string }): void
  (e: 'openSearch', payload: { keyword: string }): void
}>()
const router = useRouter()
const uuid = props.uuid
const plugin = getPlugin(uuid)

type Overlay =
  | { kind: 'scene'; scene: ComicListScene; title: string }
  | { kind: 'function'; id: string; title: string }

const home = ref<DiscoverHome | null>(null)
const activeTab = ref('')
const overlay = ref<Overlay | null>(null)
const functionPage = ref<DiscoverPage | null>(null)
const sceneItems = ref<DiscoverItem[]>([])
const scenePage = ref(1)
const sceneMax = ref(false)
const sceneExtern = ref<Record<string, unknown> | undefined>()
const filters = ref<FilterField[]>([])
const filterSelection = reactive<Record<string, number>>({})
const childSelection = reactive<Record<string, number>>({})
const showFilter = ref(false)
const loading = ref(false)
const error = ref('')
const needLogin = ref(false)
const covers = reactive<Record<string, string>>({})

let coverHost: ComicPluginHost | null = null
let coverSeq = 0

onBeforeUnmount(() => {
  coverHost?.dispose()
  coverHost = null
  for (const url of Object.values(covers)) URL.revokeObjectURL(url)
})

async function loadHome() {
  loading.value = true
  error.value = ''
  needLogin.value = false
  overlay.value = null
  try {
    home.value = await loadDiscoverHome(uuid)
    // 设置页「查看云端收藏」可用 ?tab=cloudFavorite 直接落到云端收藏 tab
    const requested = String(props.initialTab ?? '')
    const match = home.value.tabs.find(tab => tab.id === requested)
      ?? (requested === 'cloudFavorite' ? home.value.tabs.find(tab => tab.id.startsWith('cloudFavorite:')) : undefined)
    activeTab.value = match?.id ?? home.value.tabs[0]?.id ?? ''
  } catch (e) {
    handleError(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => { void loadHome() })

const currentTab = computed(() => home.value?.tabs.find(tab => tab.id === activeTab.value))
const currentScene = computed<ComicListScene | null>(() => {
  if (overlay.value?.kind === 'scene') return overlay.value.scene
  return currentTab.value?.kind === 'scene' ? currentTab.value.scene ?? null : null
})
const currentBlocks = computed<DiscoverBlock[]>(() => {
  if (overlay.value?.kind === 'function') return functionPage.value?.blocks ?? []
  if (overlay.value) return []
  return currentTab.value?.kind === 'page' ? currentTab.value.page?.blocks ?? [] : []
})
const heading = computed(() => {
  if (overlay.value) return overlay.value.title
  return currentTab.value?.title || plugin?.name || t('comics.discoverTitle')
})

/** 封面也走插件 fetchImageBytes (带防盗链头), 一个长驻宿主并发拉取 */
/** 一次最多补多少张封面: 列表动辄 40 条, 全量拉会把插件宿主占满, 界面像卡死 */
const COVER_LIMIT = 40
const COVER_WORKERS = 3

async function loadCovers(items: Array<{ id: string; cover: string }>) {
  const seq = ++coverSeq
  const queue = items.filter(i => i.cover && i.id && !covers[i.id]).slice(0, COVER_LIMIT)
  if (!queue.length) return
  if (!coverHost) coverHost = await openPlugin(uuid)
  const host = coverHost
  if (seq !== coverSeq) return
  let cursor = 0
  const worker = async () => {
    while (seq === coverSeq && cursor < queue.length) {
      const item = queue[cursor++]
      try {
        const bytes = await host.callBytes('fetchImageBytes', { url: item.cover }, { timeoutMs: 20_000 })
        if (seq === coverSeq && bytes?.length) covers[item.id] = bytesToObjectUrl(bytes, item.cover)
      } catch { /* 单张失败用占位图 */ }
    }
  }
  await Promise.all(Array.from({ length: COVER_WORKERS }, () => worker()))
}

function coverKey(item: DiscoverItem): string {
  return item.id || item.cover
}

function visibleCovers(): Array<{ id: string; cover: string }> {
  const out: Array<{ id: string; cover: string }> = []
  for (const block of currentBlocks.value) {
    for (const item of block.items) out.push({ id: coverKey(item), cover: item.cover })
    for (const section of block.sections) {
      for (const item of section.items) out.push({ id: coverKey(item), cover: item.cover })
    }
    for (const tile of block.tiles) {
      if (tile.cover) out.push({ id: `tile:${tile.title}`, cover: tile.cover })
    }
  }
  for (const item of sceneItems.value) out.push({ id: coverKey(item), cover: item.cover })
  return out
}

/** 登录失效等错误的统一处理 */
function handleError(e: unknown) {
  if (isUnauthorizedError(e)) {
    needLogin.value = true
    error.value = t('comics.loginRequired')
  } else {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function goToSettings() {
  void router.push(`/comics/settings/${encodeURIComponent(uuid)}`)
}

/** 当前选中项的二级选项 (Breeze children 联动) */
function childOptions(field: FilterField) {
  const index = filterSelection[field.key]
  return index == null ? [] : field.options[index]?.children ?? []
}

function selectFilter(field: FilterField, index: number) {
  filterSelection[field.key] = index
  delete childSelection[field.key]
}

/** 当前视图 (tab / overlay) 变化时重新拉数据 */
async function reloadView() {
  error.value = ''
  needLogin.value = false
  const scene = currentScene.value
  const fn = overlay.value?.kind === 'function' ? overlay.value : null
  if (!scene && !fn) {
    void loadCovers(visibleCovers())
    return
  }
  loading.value = true
  try {
    if (fn) {
      functionPage.value = await loadFunctionPage(uuid, fn.id)
    } else if (scene) {
      sceneItems.value = []
      scenePage.value = 1
      sceneMax.value = false
      filters.value = await loadSceneFilter(uuid, scene)
      for (const key of Object.keys(filterSelection)) delete filterSelection[key]
      for (const key of Object.keys(childSelection)) delete childSelection[key]
      await fetchScenePage(1)
    }
    void loadCovers(visibleCovers())
  } catch (e) {
    handleError(e)
  } finally {
    loading.value = false
  }
}

watch([activeTab, overlay], () => { void reloadView() }, { flush: 'post' })

async function fetchScenePage(page: number) {
  const scene = currentScene.value
  if (!scene) return
  const chosen = filters.value.flatMap(field => {
    const index = filterSelection[field.key]
    if (index == null) return []
    const option = field.options[index]
    if (!option) return []
    const childIndex = childSelection[field.key]
    const child = childIndex == null ? undefined : option.children?.[childIndex]
    return child ? [option, child] : [option]
  })
  const { core, extern } = mergeFilterResult(chosen)
  const result = await loadScenePage(uuid, scene, page, {
    core, extern: { ...extern, ...(page > 1 ? sceneExtern.value ?? {} : {}) },
  })
  sceneItems.value = page === 1 ? result.items : [...sceneItems.value, ...result.items]
  scenePage.value = page
  sceneMax.value = result.hasReachedMax || result.items.length === 0
  sceneExtern.value = result.extern
}

async function loadMore() {
  if (sceneMax.value || loading.value) return
  loading.value = true
  try { await fetchScenePage(scenePage.value + 1); void loadCovers(visibleCovers()) }
  catch (e) { handleError(e) }
  finally { loading.value = false }
}

async function applyFilter() {
  showFilter.value = false
  needLogin.value = false
  loading.value = true
  try { await fetchScenePage(1); void loadCovers(visibleCovers()) }
  catch (e) { handleError(e) }
  finally { loading.value = false }
}

function resetFilter() {
  for (const key of Object.keys(filterSelection)) delete filterSelection[key]
  for (const key of Object.keys(childSelection)) delete childSelection[key]
  void applyFilter()
}

function closeOverlay() {
  overlay.value = null
  functionPage.value = null
  sceneItems.value = []
}

function openComic(item: DiscoverItem) {
  const id = comicIdOf(item)
  if (!id) return
  emit('openComic', { comicId: id, title: item.title })
}

/** 执行 Breeze 的 PluginAction, 不支持的入口给明确提示而不是静默无反应 */
function runAction(action?: PluginAction) {
  if (!action) { toast(t('comics.discoverUnsupported'), 'error'); return }
  const payload = (action.payload ?? {}) as Record<string, unknown>
  switch (action.type) {
    case 'openComicInfo':
    case 'openComicDetail': {
      const id = String(payload.comicId ?? '')
      if (id) emit('openComic', { comicId: id })
      else toast(t('comics.discoverUnsupported'), 'error')
      break
    }
    case 'openSearch': {
      emit('openSearch', { keyword: String(payload.keyword ?? '') })
      break
    }
    case 'openComicList': {
      const scene = normalizeScene(payload.scene)
      if (scene) overlay.value = { kind: 'scene', scene, title: scene.title || String(payload.title ?? t('comics.discover')) }
      else toast(t('comics.discoverUnsupported'), 'error')
      break
    }
    case 'openPluginFunction': {
      const id = String(payload.id ?? '')
      if (id) overlay.value = { kind: 'function', id, title: String(payload.title ?? t('comics.discover')) }
      else toast(t('comics.discoverUnsupported'), 'error')
      break
    }
    case 'openWeb': {
      const url = String(payload.url ?? '')
      if (url) void openExternalLink(url).catch(() => {})
      else toast(t('comics.discoverUnsupported'), 'error')
      break
    }
    default:
      toast(t('comics.discoverUnsupported'), 'error')
  }
}

function onItemClick(item: DiscoverItem) {
  if (item.action) runAction(item.action)
  else openComic(item)
}

function onSectionMore(block: DiscoverBlock, sectionIndex: number) {
  const section = block.sections[sectionIndex]
  if (section?.action) runAction(section.action)
  else if (block.action) runAction(block.action)
}
</script>

<template>
  <div class="comic-discover">
    <p v-if="!plugin" class="error-text">{{ t('comics.sourceMissing') }}</p>
    <template v-else>
      <!-- tab 与操作按钮同一行; 插件设置由父页面顶栏提供, 这里不重复 -->
      <div class="browse-bar">
        <div v-if="home?.tabs.length && !overlay" class="tab-row" role="tablist">
          <button
            v-for="tab in home.tabs" :key="tab.id" type="button" role="tab"
            class="tab" :class="{ active: activeTab === tab.id }" :aria-selected="activeTab === tab.id"
            @click="activeTab = tab.id"
          >{{ tab.title }}</button>
        </div>
        <span v-if="overlay" class="overlay-title">{{ heading }}</span>
        <div class="spacer" />
        <div class="panel-tools">
          <button v-if="overlay" class="btn btn-ghost back-btn" @click="closeOverlay">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m15 18-6-6 6-6"/></svg>
            {{ t('common.back') }}
          </button>
          <button v-if="currentScene && filters.length" class="btn" @click="showFilter = true">{{ t('comics.discoverFilter') }}</button>
          <button class="btn" :disabled="loading" @click="overlay ? reloadView() : loadHome()">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>
            {{ t('comics.discoverRefresh') }}
          </button>
        </div>
      </div>

      <p v-if="loading" class="hint loading-hint">{{ t('comics.discoverLoading') }}</p>
      <p v-if="error" class="error-text">{{ error }}</p>
      <div v-if="needLogin" class="login-prompt">
        <span>{{ t('comics.loginRequiredHint') }}</span>
        <button class="btn btn-primary" @click="goToSettings">{{ t('comics.goLogin') }}</button>
      </div>

      <!-- 四种 scheme 区块 -->
      <template v-if="currentBlocks.length">
        <section v-for="block in currentBlocks" :key="block.key" class="discover-block">
          <div v-if="block.title" class="block-head">
            <h2 class="block-title">{{ block.title }}</h2>
            <button v-if="block.action" class="btn btn-ghost" @click="runAction(block.action)">{{ t('comics.discoverSeeAll') }}</button>
          </div>

          <!-- chip-list: 热搜词 / 快捷入口 -->
          <div v-if="block.type === 'chip-list'" class="chip-row">
            <button v-for="(chip, i) in block.chips" :key="`${chip.label}-${i}`" type="button" class="chip" @click="runAction(chip.action)">{{ chip.label }}</button>
          </div>

          <!-- action-grid: 图标宫格 -->
          <div v-else-if="block.type === 'action-grid'" class="tile-grid">
            <button v-for="(tile, i) in block.tiles" :key="`${tile.title}-${i}`" type="button" class="tile" @click="runAction(tile.action)">
              <div class="tile-cover">
                <img v-if="tile.cover && covers[`tile:${tile.title}`]" :src="covers[`tile:${tile.title}`]" alt="" loading="lazy" />
                <div v-else class="cover-placeholder" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
                </div>
              </div>
              <span class="tile-title">{{ tile.title }}</span>
            </button>
          </div>

          <!-- comic-section-list: 分区横滑 -->
          <template v-else-if="block.type === 'comic-section-list'">
            <div v-for="(section, si) in block.sections" :key="`${section.title}-${si}`" class="section">
              <div class="section-head">
                <h3 class="section-title">{{ section.title }}<span v-if="section.subtitle" class="section-subtitle">{{ section.subtitle }}</span></h3>
                <button v-if="section.action" class="btn btn-ghost" @click="onSectionMore(block, si)">{{ t('comics.discoverSeeAll') }}</button>
              </div>
              <div class="card-row">
                <button v-for="item in section.items" :key="coverKey(item)" type="button" class="comic-card" @click="onItemClick(item)">
                  <div class="card-cover">
                    <img v-if="covers[coverKey(item)]" :src="covers[coverKey(item)]" alt="" loading="lazy" />
                    <div v-else class="cover-placeholder" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
                    </div>
                  </div>
                  <span class="card-title">{{ item.title }}</span>
                  <span v-if="item.subtitle" class="card-subtitle">{{ item.subtitle }}</span>
                </button>
              </div>
            </div>
          </template>

          <!-- comic-grid 及未知区块按网格兜底 -->
          <div v-else class="card-grid">
            <button v-for="item in block.items" :key="coverKey(item)" type="button" class="comic-card" @click="onItemClick(item)">
              <div class="card-cover">
                <img v-if="covers[coverKey(item)]" :src="covers[coverKey(item)]" alt="" loading="lazy" />
                <div v-else class="cover-placeholder" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
                </div>
              </div>
              <span class="card-title">{{ item.title }}</span>
              <span v-if="item.subtitle" class="card-subtitle">{{ item.subtitle }}</span>
            </button>
          </div>
        </section>
      </template>

      <!-- scene 分页列表 -->
      <template v-if="currentScene">
        <div v-if="sceneItems.length" class="card-grid">
          <button v-for="item in sceneItems" :key="coverKey(item)" type="button" class="comic-card" @click="onItemClick(item)">
            <div class="card-cover">
              <img v-if="covers[coverKey(item)]" :src="covers[coverKey(item)]" alt="" loading="lazy" />
              <div v-else class="cover-placeholder" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
              </div>
            </div>
            <span class="card-title">{{ item.title }}</span>
            <span v-if="item.subtitle" class="card-subtitle">{{ item.subtitle }}</span>
          </button>
        </div>
        <div v-else-if="!loading && !error" class="empty-inline"><p class="hint">{{ t('comics.noSearchResult') }}</p></div>
        <div v-if="sceneItems.length && !sceneMax" class="load-more">
          <button class="btn" :disabled="loading" @click="loadMore">{{ t('comics.discoverLoadMore') }}</button>
        </div>
        <p v-else-if="sceneItems.length && sceneMax" class="hint no-more">{{ t('comics.discoverNoMore') }}</p>
      </template>

      <div v-else-if="!loading && !error && !currentBlocks.length" class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>
        </div>
        <p class="empty-title">{{ t('comics.discoverEmpty') }}</p>
        <p class="hint">{{ t('comics.discoverEmptyHint') }}</p>
        <div class="empty-actions">
          <button class="btn btn-primary" @click="emit('openSearch', { keyword: '' })">{{ t('comics.searchOnline') }}</button>
        </div>
      </div>
    </template>

    <AppModal v-if="showFilter" :title="t('comics.discoverFilter')" @close="showFilter = false">
      <div class="filter-dialog">
        <div v-for="field in filters" :key="field.key" class="filter-group">
        <h3 class="filter-label">{{ field.label }}</h3>
        <div class="chip-row">
          <button
            v-for="(option, i) in field.options" :key="`${field.key}-${i}`" type="button" class="chip"
            :class="{ active: filterSelection[field.key] === i }"
            @click="selectFilter(field, i)"
          >{{ option.label }}</button>
        </div>
        <div v-if="childOptions(field).length" class="chip-row child-row">
          <span class="child-label">{{ t('comics.filterSub') }}</span>
          <button
            v-for="(child, i) in childOptions(field)" :key="`${field.key}-child-${i}`" type="button" class="chip"
            :class="{ active: childSelection[field.key] === i }"
            @click="childSelection[field.key] = i"
          >{{ child.label }}</button>
        </div>
      </div>
        <div class="filter-actions">
          <button class="btn" @click="resetFilter">{{ t('comics.discoverFilterClear') }}</button>
          <button class="btn btn-primary" @click="applyFilter">{{ t('comics.discoverFilterApply') }}</button>
        </div>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.comic-discover { position: relative; }
.browse-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  border-bottom: 1px solid var(--line); margin-bottom: 16px;
}
.browse-bar .tab-row { border-bottom: 0; margin-bottom: 0; flex: 1; }
.panel-tools { display: flex; align-items: center; gap: 8px; padding-bottom: 4px; }
.overlay-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spacer { flex: 1; }
.back-btn { padding-left: 8px; }
.hint { color: var(--text-3); font-size: 13px; line-height: 1.6; margin: 0; }
.loading-hint { padding: 12px 0; }
.error-text { color: var(--danger, #d9534f); font-size: 13px; padding: 10px 0; }

.tab-row { display: flex; gap: 6px; flex-wrap: wrap; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.tab { border: 0; background: none; color: var(--text-3); padding: 9px 15px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-bottom-color: var(--accent, currentColor); font-weight: 600; }

.discover-block { margin: 4px 0 26px; }
.block-head, .section-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.block-title { font-size: 15px; font-weight: 650; margin: 0; color: var(--text-2); }
.section-title { font-size: 14px; font-weight: 600; margin: 0; }
.section-subtitle { font-size: 12px; font-weight: 400; color: var(--text-3); margin-left: 8px; }
.block-head .spacer, .section-head .spacer { flex: 1; }
.block-head .btn-ghost, .section-head .btn-ghost { margin-left: auto; }

.chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  border: 1px solid var(--line); background: var(--surface-1); color: var(--text-3);
  border-radius: 999px; padding: 6px 14px; font-size: 12px; cursor: pointer;
}
.chip:hover { color: var(--text); }
.chip.active { color: var(--text); border-color: var(--accent, currentColor); font-weight: 600; background: var(--surface-2); }

.tile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 14px; }
.tile { display: flex; flex-direction: column; align-items: center; gap: 8px; border: 0; background: none; color: inherit; cursor: pointer; padding: 0; min-width: 0; }
.tile-cover { width: 72px; height: 72px; border-radius: 14px; overflow: hidden; background: var(--surface-2); border: 1px solid var(--line); }
.tile-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tile-title { font-size: 12px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 20px 14px; }
.card-row { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 6px; scrollbar-width: thin; }
.card-row .comic-card { flex: 0 0 130px; }
.comic-card { display: block; text-align: left; border: 0; background: none; color: inherit; cursor: pointer; padding: 0; min-width: 0; }
.card-cover { aspect-ratio: 3 / 4; border-radius: 10px; overflow: hidden; background: var(--surface-2); border: 1px solid var(--line); }
.card-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-title { display: block; font-size: 13px; margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-subtitle { display: block; font-size: 11px; color: var(--text-3); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cover-placeholder { width: 100%; height: 100%; display: grid; place-items: center; color: var(--text-3); padding: 22%; }
.cover-placeholder svg { width: 100%; height: 100%; }

.section { margin-bottom: 22px; }
.load-more { display: flex; justify-content: center; margin: 20px 0; }
.no-more { text-align: center; padding: 16px 0; }
.empty-inline { padding: 28px 0; text-align: center; }
.empty {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: 40px 16px; margin-top: 16px;
  border: 1px dashed var(--line); border-radius: var(--radius-lg, 14px); background: var(--surface-1);
}
.empty-icon { color: var(--text-3); width: 38px; height: 38px; margin-bottom: 12px; }
.empty-icon svg { width: 100%; height: 100%; }
.empty-title { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
.empty-actions { margin-top: 16px; }

.filter-dialog { padding: 16px 20px 20px; }
.filter-group { margin-bottom: 18px; }
.filter-label { font-size: 13px; font-weight: 600; margin: 0 0 10px; }
.child-row { margin-top: 10px; align-items: center; }
.child-label { color: var(--text-3); font-size: 12px; margin-right: 2px; }
.login-prompt {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 14px 16px; margin: 12px 0;
  border: 1px solid var(--border, var(--surface-2)); border-radius: 10px;
  background: var(--surface-2); color: var(--text-2); font-size: 13px;
}
.filter-actions { display: flex; gap: 10px; justify-content: flex-end; }
</style>
