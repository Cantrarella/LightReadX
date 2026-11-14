/**
 * 漫画插件上层 API: 安装 / 启停 / 搜索 / 详情 / 章节 / 图片下载。
 *
 * 网络请求统一走 fetchRemote: 桌面端是 Rust 原生 HTTP (无跨域、可带防盗链头、支持代理),
 * 网页端是浏览器 fetch + 可选 CORS 代理。插件只负责解析, 不直接接触系统网络。
 */
import { fetchRemote } from '../net'
import { t } from '../../i18n'
import { createComicPluginHost, type ComicPluginHost, type HostOptions } from './host'
import { normalizeChapter, normalizeDetail, normalizeSearch, type NormalizedChapter, type NormalizedDetail, type NormalizedSearch } from './normalize'
import * as registry from './registry'
import type {
  ComicChapterResult,
  ComicDetailResult,
  ComicPluginInfo,
  ComicSearchResult,
  InstalledComicPlugin,
  PluginRequestInit,
  PluginResponse,
} from './types'

export { listPlugins, getPlugin, removePlugin, setPluginEnabled, MAX_PLUGIN_CODE_BYTES } from './registry'
export { normalizeSearch, normalizeDetail, normalizeChapter, coverUrl, pageFileName, chapterRequestId } from './normalize'
export type { ComicPluginHost } from './host'
export type * from './types'

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

/** 默认请求实现: 插件的所有 fetch 都从这里出 */
export async function defaultPluginRequest(init: PluginRequestInit): Promise<PluginResponse> {
  // 插件给的 header 优先 (防盗链 / Cookie / UA), 统一小写以免和 fetchRemote 默认头撞车
  const headers: Record<string, string> = { accept: '*/*' }
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    headers[key.toLowerCase()] = String(value)
  }
  const res = await fetchRemote(init.url, undefined, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
    // 非 2xx 交给插件自己判断 (有的源靠 403 做风控探测)
    raw: true,
    signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
  })
  const bytes = new Uint8Array(await res.arrayBuffer())
  const outHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => { outHeaders[key.toLowerCase()] = value })
  return {
    status: res.status,
    ok: res.ok,
    url: res.url || init.url,
    headers: outHeaders,
    bodyBase64: bytesToBase64(bytes),
  }
}

export interface OpenOptions {
  /** 下载任务共用的取消标记集合 */
  cancelledGroups?: Set<string>
  /** 测试时可注入自定义请求实现 */
  request?: (init: PluginRequestInit) => Promise<PluginResponse>
  /** 插件通过 flutter.showToast 发的提示 */
  onToast?: (message: string) => void
  log?: HostOptions['log']
}

/** 打开一个长驻宿主 (下载整章时复用, 避免每页图都重新加载 bundle) */
export async function openPlugin(uuid: string, opts: OpenOptions = {}): Promise<ComicPluginHost> {
  const plugin = registry.getPlugin(uuid)
  if (!plugin) throw new Error(t('comics.sourceMissing'))
  if (!plugin.enabled) throw new Error(t('comics.sourceDisabled', { name: plugin.name }))
  return createComicPluginHost({
    code: plugin.code,
    request: opts.request ?? defaultPluginRequest,
    pluginUuid: uuid,
    pluginConfig: registry.getPluginConfig(uuid),
    onConfigSave: (key, value) => registry.setPluginConfigValue(uuid, key, value),
    onToast: opts.onToast,
    cancelledGroups: opts.cancelledGroups,
    log: opts.log,
  })
}

/** 一次性调用, 用完自动释放 */
export async function withPlugin<T>(
  uuid: string,
  fn: (host: ComicPluginHost) => Promise<T>,
  opts: OpenOptions = {},
): Promise<T> {
  const host = await openPlugin(uuid, opts)
  try { return await fn(host) } finally { host.dispose() }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function fallbackUuid(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `local-${hash.toString(16)}`
}

/** 加载 bundle 并读 getInfo, 顺便挡掉选错文件的情况 */
async function inspect(code: string, request?: OpenOptions['request']): Promise<ComicPluginInfo> {
  const host = await createComicPluginHost({
    code,
    request: request ?? defaultPluginRequest,
  })
  try {
    if (!host.hasFn('getInfo')) throw new Error(t('comics.invalidPlugin'))
    const info = await host.call<ComicPluginInfo>('getInfo', {}, { timeoutMs: 20_000 })
    if (!info?.name) throw new Error(t('comics.invalidPlugin'))
    return info
  } finally {
    host.dispose()
  }
}

export async function installFromCode(
  code: string,
  source: InstalledComicPlugin['source'],
  origin?: string,
  /** 商店安装时带入索引信息, 保留原有 enabled 状态 */
  extra?: Pick<InstalledComicPlugin, 'storeUuid' | 'storeVersion'>,
): Promise<InstalledComicPlugin> {
  if (!code.trim()) throw new Error(t('comics.emptyPlugin'))
  const info = await inspect(code)
  const uuid = asString(info.uuid) || fallbackUuid(info.name)
  const previous = registry.getPlugin(uuid)
  const plugin: InstalledComicPlugin = {
    uuid,
    name: info.name,
    version: asString(info.version) || '',
    describe: asString(info.describe),
    iconUrl: asString(info.iconUrl),
    home: asString(info.home),
    updateUrl: asString(info.updateUrl),
    npmName: asString(info.npmName),
    code,
    enabled: previous?.enabled ?? true,
    installedAt: previous?.installedAt ?? Date.now(),
    source,
    origin,
    ...(extra ?? {}),
  }
  registry.savePlugin(plugin)
  return plugin
}

export async function installFromFile(file: File): Promise<InstalledComicPlugin> {
  return installFromCode(await file.text(), 'file', file.name)
}

export async function installFromUrl(url: string): Promise<InstalledComicPlugin> {
  const res = await fetchRemote(url, undefined, { raw: true })
  if (!res.ok) throw new Error(t('comics.installFetchFailed', { status: res.status }))
  return installFromCode(await res.text(), 'url', url)
}

export async function pluginInfo(uuid: string): Promise<ComicPluginInfo> {
  return withPlugin(uuid, host => host.call<ComicPluginInfo>('getInfo', {}, { timeoutMs: 20_000 }))
}

export async function search(uuid: string, keyword: string, page = 1): Promise<NormalizedSearch> {
  return withPlugin(uuid, async host => {
    const result = await host.call<ComicSearchResult>('searchComic', { keyword, page }, { timeoutMs: 45_000 })
    return normalizeSearch(result)
  })
}

export async function detail(uuid: string, comicId: string): Promise<NormalizedDetail> {
  return withPlugin(uuid, async host => {
    const result = await host.call<ComicDetailResult>('getComicDetail', { comicId }, { timeoutMs: 45_000 })
    return normalizeDetail(result)
  })
}

export async function chapter(uuid: string, comicId: string, chapterId: string): Promise<NormalizedChapter> {
  return withPlugin(uuid, async host => {
    const result = await host.call<ComicChapterResult>('getChapter', { comicId, chapterId }, { timeoutMs: 45_000 })
    return normalizeChapter(result)
  })
}

export async function image(uuid: string, url: string, taskGroupKey?: string): Promise<Uint8Array> {
  return withPlugin(uuid, host => host.callBytes('fetchImageBytes', { url, taskGroupKey }, { timeoutMs: 60_000 }))
}

/** 插件抛出的登录失效错误, UI 层据此跳插件设置 / 登录页 */
export function isUnauthorizedError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'unauthorized'
}

/** 插件可自定义下载并发, 宿主钳制到 1~32, 默认 5 */
export async function downloadConcurrency(host: ComicPluginHost): Promise<number> {
  if (!host.hasFn('getDownloadConcurrency')) return 5
  try {
    const value = await host.call<number>('getDownloadConcurrency', {}, { timeoutMs: 5_000 })
    return Math.min(32, Math.max(1, Number(value) || 5))
  } catch {
    return 5
  }
}
