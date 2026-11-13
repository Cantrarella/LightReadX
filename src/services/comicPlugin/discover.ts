/**
 * 漫画「发现页」协议层 (Breeze Scheme + data 页面协议)。
 *
 * 宿主按插件声明渲染页面, 不解析插件业务:
 *   getPluginHomePagesBundle → data.tabs[] (page 功能页 / scene 分页列表)
 *   getFunctionPage({ id })  → scheme.body.children + data 按 key 取值
 *   scene.body.request.fnPath → 插件自定义列表数据函数, 宿主按 page 分页调用
 *
 * 首版实现四种区块 (chip-list / action-grid / comic-section-list / comic-grid)
 * 与列表分页; 筛选 bundle 只取值不做二级联动面板。收藏相关 action 明确不支持。
 */
import { withPlugin, type ComicPluginHost } from './index'
import { coverUrl } from './normalize'
import type { ComicSearchItem } from './types'

export interface PluginAction {
  type: string
  payload?: Record<string, unknown>
  [key: string]: unknown
}

export interface ComicListRequest {
  fnPath: string
  core?: Record<string, unknown>
  extern?: Record<string, unknown>
}

export interface ComicListScene {
  title: string
  source?: string
  body: { type?: string; request: ComicListRequest }
  filter?: ComicListRequest
  [key: string]: unknown
}

export interface DiscoverItem {
  id: string
  title: string
  subtitle: string
  cover: string
  action?: PluginAction
}

export interface DiscoverChip { label: string; action?: PluginAction }
export interface DiscoverTile { title: string; cover: string; action?: PluginAction }
export interface DiscoverSection {
  title: string
  subtitle: string
  action?: PluginAction
  items: DiscoverItem[]
}

export interface DiscoverBlock {
  type: string
  key: string
  title: string
  action?: PluginAction
  chips: DiscoverChip[]
  tiles: DiscoverTile[]
  sections: DiscoverSection[]
  items: DiscoverItem[]
}

export interface DiscoverPage {
  title: string
  blocks: DiscoverBlock[]
  hasReachedMax: boolean
}

export interface DiscoverTab {
  id: string
  title: string
  kind: 'page' | 'scene'
  page?: DiscoverPage
  scene?: ComicListScene
}

export interface DiscoverHome {
  tabs: DiscoverTab[]
  /** 插件没有首页 bundle 时给出的说明 */
  notice?: string
}

export interface ScenePage {
  items: DiscoverItem[]
  hasReachedMax: boolean
  extern?: Record<string, unknown>
}

export interface FilterField {
  key: string
  label: string
  options: Array<{ label: string; value: unknown; result?: Record<string, unknown>; children?: unknown[] }>
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function actionOf(value: unknown): PluginAction | undefined {
  const a = obj(value)
  return typeof a.type === 'string' && a.type ? a as PluginAction : undefined
}

/** ComicListItem / action 里的漫画卡片统一形状 */
export function normalizeItem(raw: unknown): DiscoverItem {
  const r = obj(raw)
  const action = actionOf(r.action)
  const comicId = text(action?.type === 'openComicInfo' ? obj(action.payload).comicId : '')
  return {
    id: text(r.id) || comicId,
    title: text(r.title) || text(r.name),
    subtitle: text(r.subtitle) || text(r.updatedAt),
    cover: coverUrl(r.cover),
    action,
  }
}

/** 把 scheme.body.children 与 data[key] 拼成可直接渲染的区块 */
export function normalizeFunctionPage(raw: unknown): DiscoverPage {
  const root = obj(raw)
  const data = obj(root.data)
  const scheme = obj(root.scheme)
  const body = obj(scheme.body)
  const children = arr(body.children)
  const blocks: DiscoverBlock[] = children.map((child, index) => {
    const c = obj(child)
    const type = text(c.type)
    const key = text(c.key) || `block-${index}`
    const rawSlot = data[key] ?? root[key]
    // 真实插件常把 key 直接写成 "items", 此时 data.items 本身就是数组;
    // 也有的写成 { items: [...] } / { sections: [...] }, 两种都兼容。
    const slot = obj(rawSlot)
    const slotItems = Array.isArray(rawSlot) ? rawSlot : arr(slot.items)
    const sectionList = arr(slot.sections)
    const block: DiscoverBlock = {
      type, key, title: text(c.title) || text(slot.title),
      action: actionOf(c.action) ?? actionOf(slot.action),
      chips: [], tiles: [], sections: [], items: [],
    }
    if (type === 'chip-list') {
      block.chips = slotItems.map(item => {
        const i = obj(item)
        return { label: text(i.label) || text(i.title) || text(i.name), action: actionOf(i.action) }
      }).filter(chip => chip.label)
    } else if (type === 'action-grid') {
      block.tiles = slotItems.map(item => {
        const i = obj(item)
        return { title: text(i.title) || text(i.name), cover: coverUrl(i.cover), action: actionOf(i.action) }
      }).filter(tile => tile.title)
    } else if (type === 'comic-section-list') {
      block.sections = (sectionList.length ? sectionList : rawSlot && Array.isArray(rawSlot) ? [rawSlot] : []).map(section => {
        const s = obj(section)
        return {
          title: text(s.title), subtitle: text(s.subtitle), action: actionOf(s.action),
          items: arr(s.items ?? (Array.isArray(section) ? section : [])).map(normalizeItem).filter(i => i.id),
        }
      })
    } else {
      // comic-grid 以及未知类型一律按网格兜底, 保证新区块不会白屏
      block.items = (slotItems.length ? slotItems : arr(slot.comics ?? data.items))
        .map(normalizeItem).filter(i => i.id)
    }
    return block
  })
  return {
    title: text(scheme.title) || text(root.title),
    blocks,
    hasReachedMax: slotHasReachedMax(data),
  }
}

function slotHasReachedMax(data: Record<string, unknown>): boolean {
  return data.hasReachedMax === true || obj(data.paging).hasReachedMax === true
}

function normalizeTab(raw: unknown, index: number): DiscoverTab | null {
  const t = obj(raw)
  const id = text(t.id) || `tab-${index}`
  const title = text(t.title) || id
  if (t.scene) {
    const scene = normalizeScene(t.scene)
    if (scene) return { id, title, kind: 'scene', scene }
  }
  if (t.page) return { id, title, kind: 'page', page: normalizeFunctionPage(t.page) }
  return null
}

export function normalizeScene(raw: unknown): ComicListScene | null {
  const s = obj(raw)
  const request = obj(obj(s.body).request)
  if (!text(request.fnPath)) return null
  return {
    title: text(s.title),
    source: text(s.source),
    body: { type: text(obj(s.body).type), request: normalizeRequest(request) },
    ...(s.filter ? { filter: normalizeRequest(obj(s.filter)) } : {}),
  }
}

function normalizeRequest(raw: Record<string, unknown>): ComicListRequest {
  return {
    fnPath: text(raw.fnPath),
    core: obj(raw.core),
    extern: obj(raw.extern),
  }
}

/** 解析首页 bundle; 兼容 tabs 挂在根节点 / data 节点两种写法 */
export function normalizeHomeBundle(raw: unknown): DiscoverHome {
  const root = obj(raw)
  const tabs = arr(obj(root.data).tabs ?? root.tabs)
    .map(normalizeTab)
    .filter((t): t is DiscoverTab => !!t)
  return { tabs }
}

/** 读取插件发现页, 按能力逐级回退, 老插件也能给出可用入口 */
export async function loadDiscoverHome(uuid: string): Promise<DiscoverHome> {
  return withPlugin(uuid, async host => {
    if (host.hasFn('getPluginHomePagesBundle')) {
      try {
        const raw = await host.call('getPluginHomePagesBundle', { core: {}, extern: { source: uuid } }, { timeoutMs: 60_000 })
        const home = normalizeHomeBundle(raw)
        if (home.tabs.length) return home
      } catch { /* 落到下一级回退 */ }
    }
    if (host.hasFn('getComicListSceneBundle')) {
      try {
        const raw = await host.call('getComicListSceneBundle', {}, { timeoutMs: 60_000 })
        const scene = normalizeScene(obj(obj(raw).data).scene ?? obj(raw).scene)
        if (scene) return { tabs: [{ id: 'home', title: scene.title || '发现', kind: 'scene', scene }] }
      } catch { /* 落到下一级回退 */ }
    }
    if (host.hasFn('getFunctionPage')) {
      // 部分插件只给 getInfo().function 入口, 聚合为一个功能宫格
      const info = await host.call<{ function?: unknown[] }>('getInfo', {}, { timeoutMs: 20_000 })
      const tiles: DiscoverTile[] = arr(info?.function).map(item => {
        const f = obj(item)
        return { title: text(f.title) || text(f.id), cover: '', action: actionOf(f.action) }
      }).filter(tile => tile.title && tile.action)
      if (tiles.length) {
        return {
          tabs: [{
            id: 'functions', title: '功能', kind: 'page',
            page: {
              title: '', hasReachedMax: true,
              blocks: [{
                type: 'action-grid', key: 'functions', title: '',
                chips: [], tiles, sections: [], items: [],
              }],
            },
          }],
        }
      }
    }
    return { tabs: [], notice: 'noHome' }
  })
}

/** 打开 getInfo().function 里声明的 openPluginFunction 功能页 */
export async function loadFunctionPage(uuid: string, id: string, page = 1): Promise<DiscoverPage> {
  return withPlugin(uuid, async host =>
    normalizeFunctionPage(await host.call('getFunctionPage', { id, page, core: {}, extern: {} }, { timeoutMs: 60_000 })))
}

/** 按 scene.body.request.fnPath 调插件自定义列表函数 (分页 + 筛选参数合并) */
export async function loadScenePage(
  uuid: string,
  scene: ComicListScene,
  page = 1,
  extra?: { core?: Record<string, unknown>; extern?: Record<string, unknown> },
): Promise<ScenePage> {
  const request = scene.body.request
  const payload = {
    page,
    ...(request.core ?? {}),
    ...(extra?.core ?? {}),
    extern: { ...(request.extern ?? {}), ...(extra?.extern ?? {}) },
  }
  return withPlugin(uuid, async (host: ComicPluginHost) => {
    const raw = await host.call(request.fnPath, payload, { timeoutMs: 60_000 })
    const root = obj(raw)
    const data = obj(root.data)
    const items = arr(data.items ?? root.items)
      .map(normalizeItem)
      .filter(i => i.id)
    return {
      items,
      hasReachedMax: slotHasReachedMax(data),
      extern: obj(root.extern),
    }
  })
}

/** 读取列表筛选配置 (scheme.fields + data.values), 没有配置返回空 */
export async function loadSceneFilter(uuid: string, scene: ComicListScene): Promise<FilterField[]> {
  const request = scene.filter
  if (!request?.fnPath) return []
  return withPlugin(uuid, async host => {
    try {
      const raw = await host.call(request.fnPath, {}, { timeoutMs: 30_000 })
      const fields = arr(obj(obj(raw).scheme).fields)
      return fields.map(field => {
        const f = obj(field)
        return {
          key: text(f.key), label: text(f.label) || text(f.key),
          options: arr(f.options).map(option => {
            const o = obj(option)
            return {
              label: text(o.label), value: o.value,
              result: obj(o.result), children: arr(o.children),
            }
          }),
        }
      }).filter(f => f.key && f.options.length)
    } catch { return [] }
  })
}

/** 把筛选选中项的 result.core / result.extern 合并成列表请求参数 */
export function mergeFilterResult(options: Array<{ result?: Record<string, unknown> }>): {
  core: Record<string, unknown>
  extern: Record<string, unknown>
} {
  const core: Record<string, unknown> = {}
  const extern: Record<string, unknown> = {}
  for (const option of options) {
    Object.assign(core, obj(option.result?.core))
    Object.assign(extern, obj(option.result?.extern))
  }
  return { core, extern }
}

/** 漫画卡片点击时优先用自带的 openComicInfo, 否则按 id 构造 */
export function comicIdOf(item: DiscoverItem): string {
  if (item.action?.type === 'openComicInfo') return text(obj(item.action.payload).comicId) || item.id
  return item.id
}

export function asSearchItem(item: DiscoverItem): ComicSearchItem {
  return { id: item.id, title: item.title, subtitle: item.subtitle, cover: { url: item.cover } }
}
