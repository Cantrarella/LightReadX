/**
 * Breeze 兼容漫画插件协议类型。
 *
 * 插件是 CommonJS bundle (module.exports.default = { getInfo, searchComic, ... }),
 * 在 QuickJS 沙箱里执行; 字段命名沿用 Breeze 的 fnPath 契约, 便于直接复用现成插件包。
 * 数据结构以真实插件 (breeze-plugin-webtoon) 的返回为准, 并兼容 items/eps/pages
 * 同时挂在根节点与 data 节点两种写法。
 */

/** getInfo 返回的插件自述信息 */
export interface ComicPluginInfo {
  name: string
  uuid: string
  version?: string
  describe?: string
  iconUrl?: string
  home?: string
  updateUrl?: string
  npmName?: string
  haveHome?: boolean
  function?: unknown[]
  [key: string]: unknown
}

/** 搜索结果里的一部漫画 */
export interface ComicSearchItem {
  id: string
  title: string
  subtitle?: string
  cover?: { url?: string; [key: string]: unknown }
  finished?: boolean
  likesCount?: number
  viewsCount?: number
  updatedAt?: string
  source?: string
  [key: string]: unknown
}

export interface ComicPaging {
  page: number
  pages: number
  total: number
  hasReachedMax?: boolean
}

/** searchComic 返回 */
export interface ComicSearchResult {
  source?: string
  scheme?: { type?: string; [key: string]: unknown }
  data?: { paging?: ComicPaging; items?: ComicSearchItem[]; [key: string]: unknown }
  paging?: ComicPaging
  items?: ComicSearchItem[]
  [key: string]: unknown
}

/** 章节 / 话 (id, requestId, storageChapterId 语义不同, 分开存) */
export interface ComicChapter {
  id: string
  requestId?: string
  logicalKey?: string
  storageChapterId?: string
  name: string
  order?: number
  extern?: Record<string, unknown>
  [key: string]: unknown
}

export interface ComicInfo {
  id: string
  title: string
  description?: string
  cover?: { url?: string; [key: string]: unknown }
  creator?: { name?: string; [key: string]: unknown }
  titleMeta?: Array<{ name?: string; [key: string]: unknown }>
  [key: string]: unknown
}

/** getComicDetail 返回 */
export interface ComicDetailResult {
  source?: string
  comicId?: string
  data?: {
    normal?: {
      comicInfo?: ComicInfo
      eps?: ComicChapter[]
      allowDownload?: boolean
      [key: string]: unknown
    }
    eps?: ComicChapter[]
    raw?: Record<string, unknown>
    [key: string]: unknown
  }
  eps?: ComicChapter[]
  [key: string]: unknown
}

/** 章节里的一页图 */
export interface ComicPage {
  id: string
  name?: string
  path?: string
  url: string
  extern?: Record<string, unknown>
  [key: string]: unknown
}

/** getChapter 返回 */
export interface ComicChapterResult {
  source?: string
  comicId?: string
  chapterId?: string
  data?: {
    comic?: { id?: string; title?: string; [key: string]: unknown }
    chapter?: { id?: string; name?: string; pages?: ComicPage[]; [key: string]: unknown }
    chapters?: ComicChapter[]
    pages?: ComicPage[]
    [key: string]: unknown
  }
  pages?: ComicPage[]
  [key: string]: unknown
}

/** 已安装的插件记录 (持久化到 localStorage) */
export interface InstalledComicPlugin {
  uuid: string
  name: string
  version: string
  describe?: string
  iconUrl?: string
  home?: string
  updateUrl?: string
  npmName?: string
  /** 插件 bundle 源码 (CommonJS) */
  code: string
  enabled: boolean
  installedAt: number
  source: 'file' | 'url' | 'store'
  /** 文件名或安装 URL */
  origin?: string
  /** 从商店安装时记录索引里的 uuid (插件自述的 uuid 偶尔与索引不一致) */
  storeUuid?: string
  /** 商店安装时索引里的版本, 用于更新提示 */
  storeVersion?: string
}

/** 宿主提供给插件沙箱的一次网络请求 */
export interface PluginRequestInit {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface PluginResponse {
  status: number
  ok: boolean
  url: string
  headers: Record<string, string>
  /** 二进制统一以 base64 回传 (QuickJS 侧 btoa/atob 解码) */
  bodyBase64: string
}
