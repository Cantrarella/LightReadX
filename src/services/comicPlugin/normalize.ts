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

export interface NormalizedDetail {
  info?: ComicInfo
  chapters: ComicChapter[]
  allowDownload: boolean
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

export function normalizeDetail(result: ComicDetailResult | null | undefined): NormalizedDetail {
  const normal = result?.data?.normal
  return {
    info: normal?.comicInfo,
    chapters: normal?.eps ?? result?.data?.eps ?? result?.eps ?? [],
    allowDownload: normal?.allowDownload ?? true,
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
