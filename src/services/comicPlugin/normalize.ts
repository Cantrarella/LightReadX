/**
 * 把不同插件的返回结构收敛成 UI 用的统一形状。
 * Breeze 生态里 items / eps / pages 有的挂根节点、有的挂 data 节点, 这里都兼容。
 */
import type {
  ComicChapter,
  ComicChapterResult,
  ComicDetailResult,
  ComicInfo,
  ComicPage,
  ComicPaging,
  ComicSearchItem,
  ComicSearchResult,
} from './types'

export interface NormalizedSearch {
  items: ComicSearchItem[]
  paging?: ComicPaging
}

/** 详情页可直接渲染的一枚 chip; 带 keyword 时点击触发站内搜索 */
export interface DetailChip {
  label: string
  keyword?: string
}

/** metadata 的一个分组 (作者 / 标签 / 作品 / 角色 …), 组名由插件给 */
export interface DetailMetaGroup {
  key: string
  name: string
  chips: DetailChip[]
}

export interface NormalizedDetail {
  info?: ComicInfo
  chapters: ComicChapter[]
  allowDownload: boolean
  recommend: ComicSearchItem[]
  totalViews: number
  totalLikes: number
  totalComments: number
  /** comicInfo.titleMeta: 浏览 / 更新时间 / 章节数 / 总页数 / 车号 */
  titleMeta: DetailChip[]
  /** comicInfo.metadata: 作者 / 标签 / 作品 / 角色 分组 chips */
  metadata: DetailMetaGroup[]
}

export interface NormalizedChapter {
  title: string
  chapterName: string
  pages: ComicPage[]
  chapters: ComicChapter[]
}

export function normalizeSearch(result: ComicSearchResult | null | undefined): NormalizedSearch {
  return {
    items: result?.data?.items ?? result?.items ?? [],
    paging: result?.data?.paging ?? result?.paging,
  }
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}
function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** ISO 时间戳直接摆在 chips 里很难看 (插件给的是 2026-11-12T02:33:48.000Z), 转成本地简短格式 */
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g

export function humanizeIsoText(text: string): string {
  if (!ISO_RE.test(text)) return text
  ISO_RE.lastIndex = 0
  return text.replace(ISO_RE, iso => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
}

/** Breeze 的 titleMeta / metadata.value 都是 {name, onTap:{type:'openSearch',payload:{keyword}}} */
export function detailChip(raw: unknown): DetailChip | null {
  if (typeof raw === 'string') {
    const label = humanizeIsoText(raw.trim())
    return label ? { label } : null
  }
  const item = obj(raw)
  const label = humanizeIsoText(str(item.name))
  if (!label) return null
  const keyword = str(obj(obj(item.onTap).payload).keyword)
  return keyword ? { label, keyword } : { label }
}

export function normalizeDetail(result: ComicDetailResult | null | undefined): NormalizedDetail {
  const normal = result?.data?.normal
  const info = (normal?.comicInfo ?? result?.data?.comicInfo ?? result?.comicInfo) as ComicInfo | undefined
  const titleMeta = arr(info?.titleMeta).map(detailChip)
    .filter((chip): chip is DetailChip => !!chip)
  const metadata = arr(info?.metadata).map((group, index) => {
    const g = obj(group)
    const chips = arr(g.value).map(detailChip).filter((chip): chip is DetailChip => !!chip)
    return { key: str(g.type) || `group-${index}`, name: str(g.name), chips }
  }).filter(group => group.chips.length)
  return {
    info,
    chapters: normal?.eps ?? result?.data?.eps ?? result?.eps ?? [],
    allowDownload: normal?.allowDownload ?? true,
    recommend: arr(normal?.recommend ?? result?.data?.recommend) as ComicSearchItem[],
    totalViews: num(normal?.totalViews ?? result?.data?.totalViews),
    totalLikes: num(normal?.totalLikes ?? result?.data?.totalLikes),
    totalComments: num(normal?.totalComments ?? result?.data?.totalComments),
    titleMeta,
    metadata,
  }
}

export function normalizeChapter(result: ComicChapterResult | null | undefined): NormalizedChapter {
  const data = result?.data
  return {
    title: data?.comic?.title ?? '',
    chapterName: data?.chapter?.name ?? '',
    pages: data?.chapter?.pages ?? data?.pages ?? result?.pages ?? [],
    chapters: data?.chapters ?? [],
  }
}

/** 章节 id 优先用 requestId (Breeze 里请求章节内容用的 key), 没有才退回 id */
export function chapterRequestId(chapter: ComicChapter): string {
  return chapter.requestId ?? chapter.storageChapterId ?? chapter.id
}

/** 搜索结果封面 URL (Breeze 的 cover 是对象, 个别插件直接给字符串) */
export function coverUrl(cover: unknown): string {
  if (typeof cover === 'string') return cover
  const url = (cover as { url?: unknown } | null)?.url
  return typeof url === 'string' ? url : ''
}

/** 章节页图片地址: 按自然数补零命名, 打包 CBZ 时保证阅读顺序 */
export function pageFileName(page: ComicPage, index: number, total: number): string {
  const ext = (() => {
    const raw = (page.name || page.url || '').split('?')[0]
    const m = /\.(jpe?g|png|webp|gif|avif|bmp)(?:$|\?)/i.exec(raw)
    return m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'jpg'
  })()
  const width = Math.max(3, String(total).length)
  return String(index + 1).padStart(width, '0') + '.' + ext
}
