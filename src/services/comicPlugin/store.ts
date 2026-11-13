/**
 * 漫画插件商店: 订阅索引 → 归一化 → 解析 bundle 地址 → 一键安装。
 *
 * 索引格式对齐 Breeze 官方 Breeze-plugin-list/plugins_data.json:
 *   [{ repo: "owner/name", manifest: { name, uuid, version, iconUrl, describe,
 *      home, updateUrl, npmName, haveHome, creator, ... } }, ...]
 * 同时兼容 { plugins: [...] } / 扁平 manifest 数组等自定义订阅源。
 *
 * 插件包是单文件 CommonJS bundle, 优先走 npm CDN, 其次 GitHub 仓库 dist,
 * 最后才解析 updateUrl (GitHub Release API 有未认证限流, 放最后兜底)。
 * 所有请求走 fetchRemote: 桌面端 Rust 原生 HTTP, 不受跨域限制。
 */
import { fetchRemote } from '../net'
import { t } from '../../i18n'
import { installFromCode, listPlugins, type InstalledComicPlugin } from './index'

const SUBS_KEY = 'lightread.comicStore.subscriptions.v1'
const CACHE_KEY = 'lightread.comicStore.cache.v1'
/** 索引缓存 30 分钟, 过期后仍可在联网失败时回退使用 */
const CACHE_TTL = 30 * 60 * 1000

export const OFFICIAL_INDEX_URL =
  'https://raw.githubusercontent.com/breeze-project-org/Breeze-plugin-list/main/plugins_data.json'
export const OFFICIAL_INDEX_NAME = 'Breeze 官方插件列表'

export interface StoreSubscription {
  id: string
  name: string
  url: string
  enabled: boolean
  builtin?: boolean
  addedAt: number
}

/** 商店里的一条插件 (已归一化, 与索引原始字段解耦) */
export interface StoreEntry {
  uuid: string
  name: string
  version: string
  describe: string
  iconUrl: string
  home: string
  repo: string
  npmName: string
  updateUrl: string
  author: string
  haveHome: boolean
  sourceId: string
  sourceName: string
}

export interface StoreLoadResult {
  entries: StoreEntry[]
  errors: string[]
  fromCache: boolean
  fetchedAt: number
}

interface CachedIndex { at: number; entries: StoreEntry[] }

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch { return fallback }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 容量满时忽略 */ }
}

function defaultSubs(): StoreSubscription[] {
  return [{
    id: 'breeze-official',
    name: OFFICIAL_INDEX_NAME,
    url: OFFICIAL_INDEX_URL,
    enabled: true,
    builtin: true,
    addedAt: 0,
  }]
}

export function listSubscriptions(): StoreSubscription[] {
  const list = readJson<StoreSubscription[]>(SUBS_KEY, [])
  if (!Array.isArray(list) || !list.length) return defaultSubs()
  // 内置源始终在, 防止用户误删后无法恢复
  const hasOfficial = list.some(s => s.url === OFFICIAL_INDEX_URL)
  return hasOfficial ? list : [...defaultSubs(), ...list]
}

function saveSubs(list: StoreSubscription[]): void {
  writeJson(SUBS_KEY, list)
}

export function addSubscription(name: string, url: string): StoreSubscription {
  const trimmedUrl = url.trim()
  if (!/^https?:\/\/\S+$/i.test(trimmedUrl)) throw new Error(t('comics.storeInvalidUrl'))
  const sub: StoreSubscription = {
    id: `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || new URL(trimmedUrl).hostname,
    url: trimmedUrl,
    enabled: true,
    addedAt: Date.now(),
  }
  saveSubs([...listSubscriptions(), sub])
  return sub
}

export function removeSubscription(id: string): void {
  saveSubs(listSubscriptions().filter(s => s.id !== id || s.builtin))
}

export function setSubscriptionEnabled(id: string, enabled: boolean): void {
  const list = listSubscriptions()
  const sub = list.find(s => s.id === id)
  if (!sub) return
  sub.enabled = enabled
  saveSubs(list)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function fallbackUuid(name: string, repo: string): string {
  const seed = repo || name
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `store-${hash.toString(16)}`
}

function normalizeEntry(raw: unknown, sub: StoreSubscription): StoreEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  // 官方格式把自述信息放在 manifest 里; 自定义源可能直接平铺
  const m = (row.manifest && typeof row.manifest === 'object')
    ? row.manifest as Record<string, unknown>
    : row
  const name = str(m.name)
  if (!name) return null
  const repo = str(row.repo) || str(m.repo) || str(m.home)
  const creator = m.creator
  const author = typeof creator === 'object' && creator
    ? str((creator as Record<string, unknown>).name)
    : str(creator) || repo.split('/')[0] || ''
  return {
    uuid: str(m.uuid) || fallbackUuid(name, repo),
    name,
    version: str(m.version),
    describe: str(m.describe) || str(m.description),
    iconUrl: str(m.iconUrl) || str(m.icon),
    home: str(m.home) || str(m['breeze-plugin-github-repository']) || (repo ? `https://github.com/${repo}` : ''),
    repo,
    npmName: str(m.npmName),
    updateUrl: str(m.updateUrl),
    author,
    haveHome: m.haveHome === true,
    sourceId: sub.id,
    sourceName: sub.name,
  }
}

/** 解析任意一种索引形状, 供离线回归测试直接调用 */
export function parseStoreIndex(raw: unknown, sub: StoreSubscription): StoreEntry[] {
  let rows: unknown[] = []
  if (Array.isArray(raw)) rows = raw
  else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const candidate = obj.plugins ?? obj.list ?? obj.items
      ?? (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)
        ? (obj.data as Record<string, unknown>).plugins
        : obj.data)
    if (Array.isArray(candidate)) rows = candidate
  }
  const out: StoreEntry[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const entry = normalizeEntry(row, sub)
    if (entry && !seen.has(entry.uuid)) { seen.add(entry.uuid); out.push(entry) }
  }
  return out
}

function readCache(): Record<string, CachedIndex> {
  const raw = readJson<Record<string, CachedIndex>>(CACHE_KEY, {})
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/** 单次网络硬超时; 桌面 WebView 的原生 HTTP 可能忽略 AbortSignal, 不能只靠它 */
// 离线回归可在 import 前把 globalThis.__LR_STORE_TIMEOUT__ 调小, 验证挂起请求能及时返回
const testTimeout = Number((globalThis as { __LR_STORE_TIMEOUT__?: number }).__LR_STORE_TIMEOUT__)
const STORE_FETCH_TIMEOUT = Number.isFinite(testTimeout) && testTimeout > 0 ? testTimeout : 12_000
const BUNDLE_FETCH_TIMEOUT = 15_000

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 不依赖 AbortSignal 的硬超时: 挂起的底层请求不再阻塞 UI, 也不会留下未处理的 rejection */
function withHardTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (${Math.round(ms / 1000)}s)`)), ms)
    task.then(
      value => { clearTimeout(timer); resolve(value) },
      err => { clearTimeout(timer); reject(err) },
    )
  })
}

/** 请求 + 读 body 都受硬超时保护 (WebView 里 body 也可能一直不返回) */
async function readRemoteText(url: string, accept: string, ms: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await withHardTimeout(
      fetchRemote(url, undefined, { raw: true, headers: { accept }, signal: controller.signal }),
      ms, t('comics.storeTimeout'),
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await withHardTimeout(res.text(), ms, t('comics.storeTimeout'))
  } finally { clearTimeout(timer) }
}

/** 桌面 WebView 原生 HTTP 挂住时, 换浏览器 fetch 再走一次 (索引站普遍允许 CORS) */
async function readIndexViaBrowser(url: string): Promise<string> {
  const res = await withHardTimeout(
    fetch(url, {
      headers: { accept: 'application/json, */*' },
      signal: AbortSignal.timeout(STORE_FETCH_TIMEOUT),
    }),
    STORE_FETCH_TIMEOUT, t('comics.storeTimeout'),
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return withHardTimeout(res.text(), STORE_FETCH_TIMEOUT, t('comics.storeTimeout'))
}

async function readIndex(url: string): Promise<string> {
  try {
    return await readRemoteText(url, 'application/json, */*', STORE_FETCH_TIMEOUT)
  } catch (nativeError) {
    try {
      return await readIndexViaBrowser(url)
    } catch (webError) {
      throw new Error(`${messageOf(nativeError)} / WebView: ${messageOf(webError)}`)
    }
  }
}

/** 先把上次缓存吐给 UI, 不等待网络; 桌面端首次打开也不会一直转圈 */
export function loadCachedStore(): StoreEntry[] {
  const cache = readCache()
  const out: StoreEntry[] = []
  const seen = new Set<string>()
  for (const sub of listSubscriptions().filter(s => s.enabled)) {
    for (const entry of cache[sub.id]?.entries ?? []) {
      if (!seen.has(entry.uuid)) { seen.add(entry.uuid); out.push(entry) }
    }
  }
  return out
}

interface SubResult {
  id: string
  entries: StoreEntry[]
  at: number
  fromCache: boolean
  error: string
  fresh: StoreEntry[] | null
}

/** 并行拉取所有启用订阅源并合并; 单源超时/失败不拖全局, 旧缓存随时兜底 */
export async function loadStore(force = false): Promise<StoreLoadResult> {
  const subs = listSubscriptions().filter(s => s.enabled)
  const cache = readCache()
  const settled = await Promise.all(subs.map(async (sub): Promise<SubResult> => {
    const hit = cache[sub.id]
    if (hit && !force && Date.now() - hit.at < CACHE_TTL) {
      return { id: sub.id, entries: hit.entries, at: hit.at, fromCache: true, error: '', fresh: null }
    }
    try {
      const list = parseStoreIndex(JSON.parse(await readIndex(sub.url)), sub)
      if (!list.length) throw new Error(t('comics.storeEmptyIndex'))
      return { id: sub.id, entries: list, at: Date.now(), fromCache: false, error: '', fresh: list }
    } catch (e) {
      return {
        id: sub.id,
        entries: hit?.entries ?? [], at: hit?.at ?? 0,
        fromCache: !!hit, error: `${sub.name}: ${messageOf(e)}`, fresh: null,
      }
    }
  }))

  const entries: StoreEntry[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  let fromCache = false
  let fetchedAt = 0
  let cacheChanged = false
  for (const r of settled) {
    if (r.fresh) { cache[r.id] = { at: r.at, entries: r.fresh }; cacheChanged = true }
    for (const entry of r.entries) if (!seen.has(entry.uuid)) { seen.add(entry.uuid); entries.push(entry) }
    if (r.error) errors.push(r.error)
    if (r.fromCache) fromCache = true
    if (r.at) fetchedAt = Math.max(fetchedAt, r.at)
  }
  if (cacheChanged) writeJson(CACHE_KEY, cache)
  return { entries, errors, fromCache, fetchedAt }
}

/** 语义化版本比较: 返回 1 / 0 / -1; 预发布版低于同号正式版 */
export function compareVersion(a: string, b: string): number {
  const parse = (raw: string) => {
    const s = raw.replace(/^v/i, '').split('+')[0]
    const dash = s.indexOf('-')
    return {
      parts: (dash >= 0 ? s.slice(0, dash) : s).split('.'),
      pre: dash >= 0 ? s.slice(dash + 1) : '',
    }
  }
  const x = parse(a), y = parse(b)
  const len = Math.max(x.parts.length, y.parts.length)
  for (let i = 0; i < len; i++) {
    const p = x.parts[i] ?? '0'
    const q = y.parts[i] ?? '0'
    const np = /^\d+$/.test(p), nq = /^\d+$/.test(q)
    if (np && nq) {
      const d = Number(p) - Number(q)
      if (d) return d > 0 ? 1 : -1
    } else if (p !== q) {
      return p > q ? 1 : -1
    }
  }
  // 数字部分相同: 无预发布标记的更新, 都有标记时按字典序比
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre > y.pre ? 1 : -1
}

export function installedByUuid(uuid: string): InstalledComicPlugin | undefined {
  return listPlugins().find(p => p.uuid === uuid || p.storeUuid === uuid)
}

export function storeState(entry: StoreEntry): 'new' | 'update' | 'installed' {
  const installed = installedByUuid(entry.uuid)
  if (!installed) return 'new'
  const current = installed.storeVersion || installed.version
  return entry.version && current && compareVersion(entry.version, current) > 0
    ? 'update'
    : 'installed'
}

/** 候选 bundle 直链, 由先到后逐个尝试 */
export function bundleCandidates(entry: StoreEntry): string[] {
  const urls: string[] = []
  const push = (url: string) => { if (url && !urls.includes(url)) urls.push(url) }
  const name = entry.npmName
  const file = name ? `${name}.bundle.cjs` : ''
  if (name) {
    if (entry.version) push(`https://cdn.jsdelivr.net/npm/${name}@${entry.version}/dist/${file}`)
    push(`https://cdn.jsdelivr.net/npm/${name}/dist/${file}`)
  }
  if (entry.repo && /^[\w.-]+\/[\w.-]+$/.test(entry.repo)) {
    const base = `https://cdn.jsdelivr.net/gh/${entry.repo}@main/dist`
    const raw = `https://raw.githubusercontent.com/${entry.repo}/main/dist`
    const guess = entry.repo.split('/')[1]
    for (const prefix of [base, raw]) {
      for (const filename of [`${guess}.bundle.cjs`, `${name || guess}.bundle.cjs`, 'index.cjs', 'plugin.bundle.cjs']) {
        push(`${prefix}/${filename}`)
      }
    }
  }
  return urls
}

/** 从 updateUrl (Release API / latest.json) 里挖出可下载的 bundle 链接 */
export async function resolveUpdateUrls(entry: StoreEntry): Promise<string[]> {
  const url = entry.updateUrl
  if (!url) return []
  // 已经是源码直链, 不必再请求
  if (/\.(cjs|mjs|js)(\?|$)/i.test(url)) return [url]
  try {
    const parsed = JSON.parse(await readRemoteText(url, 'application/json, */*', BUNDLE_FETCH_TIMEOUT)) as unknown
    return collectBundleLinks(parsed)
  } catch { return [] }
}

/** 从任意 JSON 里找 .cjs/.js 下载地址, 兼容 GitHub Release assets 与自定义 latest.json */
export function collectBundleLinks(value: unknown, depth = 0): string[] {
  if (depth > 5 || !value || typeof value !== 'object') return []
  const out: string[] = []
  const add = (v: unknown) => {
    if (typeof v === 'string' && /^https?:\/\//i.test(v) && /\.(cjs|mjs|js)(\?|$)/i.test(v)
      && !/\.br(\?|$)/i.test(v) && !out.includes(v)) out.push(v)
  }
  const obj = Array.isArray(value) ? value : [value]
  for (const node of obj) {
    if (!node || typeof node !== 'object') continue
    const row = node as Record<string, unknown>
    add(row.browser_download_url)
    add(row.downloadUrl)
    add(row.bundleUrl)
    add(row.url)
    if (Array.isArray(row.assets)) out.push(...collectBundleLinks(row.assets, depth + 1))
    if (row.data) out.push(...collectBundleLinks(row.data, depth + 1))
  }
  return [...new Set(out)]
}

/** 内容必须像 CommonJS bundle, 挡掉 HTML 错误页 / JSON / 空响应 */
export function looksLikeBundle(text: string): boolean {
  const s = text.trim()
  if (!s || s.length < 40) return false
  if (/^\s*(<!doctype|<html|\{\s*"|<json)/i.test(s)) return false
  return /module\.exports|exports\.default|["']use strict["']|__webpack|__commonJS|=>\s*\{/.test(s.slice(0, 8000))
}

export interface StoreInstallResult {
  plugin: InstalledComicPlugin
  url: string
}

/** 依次尝试候选地址, 拿到源码后复用统一安装流程 (getInfo 校验 + uuid 去重) */
export async function installStoreEntry(entry: StoreEntry): Promise<StoreInstallResult> {
  const urls = [...bundleCandidates(entry)]
  try { urls.push(...await resolveUpdateUrls(entry)) } catch { /* 忽略 */ }
  if (!urls.length) throw new Error(t('comics.storeNoBundle'))
  let lastError = ''
  for (const url of urls) {
    try {
      const code = await readRemoteText(url, 'application/javascript, text/plain, */*', BUNDLE_FETCH_TIMEOUT)
      if (!looksLikeBundle(code)) { lastError = t('comics.storeInvalidBundle'); continue }
      const plugin = await installFromCode(code, 'store', url, {
        storeUuid: entry.uuid,
        storeVersion: entry.version,
      })
      return { plugin, url }
    } catch (e: any) {
      lastError = e?.message ?? String(e)
    }
  }
  throw new Error(`${t('comics.storeNoBundle')}${lastError ? ` (${lastError})` : ''}`)
}
