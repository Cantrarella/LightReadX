/**
 * 书源在线阅读整合层：缓存优先抓正文 + 换源辅助。
 *
 * 目标「搜索 + 在线阅读」的最后一块：
 *  - getChapterCached：抓正文时先查本地缓存，命中直接返回（离线可读），未命中抓取后写缓存
 *  - 换源：通过 MergedSearchBook.sources 切换 source + bookUrl
 */
import type { BookSource, ChapterItem, ChapterContent, BookSourceEntry } from './types'
import { getFullContent, getToc } from './crawler.ts'
import { cacheChapter, clearBookCache, getCachedChapter, listCachedChapters, chapterCacheKey } from './chapterCache.ts'

/** 抓取章节正文（缓存优先）。命中缓存直接返回，未命中抓取后写缓存。 */
export async function getChapterCached(
  source: BookSource,
  bookName: string,
  author: string,
  chapter: ChapterItem,
): Promise<ChapterContent> {
  const bookKey = chapterCacheKey(bookName, author, source.bookSourceUrl)
  // 先查缓存
  const cached = await getCachedChapter(bookKey, chapter.url)
  if (cached) {
    return { text: cached.text }
  }
  // 未命中：抓完整章分页后才写缓存；残缺内容只展示、不固化到本地。
  const content = await getFullContent(source, chapter.url)
  if (content.text && !content.nextUrl) {
    await cacheChapter(bookKey, {
      name: chapter.name,
      url: chapter.url,
      text: content.text,
      cachedAt: Date.now(),
    })
  }
  return content
}

/** 预取一本书的目录（不缓存正文，仅返回目录，供在线阅读时逐章抓取） */
export async function getTocForEntry(
  entry: BookSourceEntry,
): Promise<ChapterItem[]> {
  // 从详情页拿目录 URL：优先 ruleBookInfo.tocUrl，否则用 bookUrl 直接抓目录
  const { getBookInfo } = await import('./crawler.ts')
  try {
    const info = await getBookInfo(entry.source, entry.bookUrl)
    const tocUrl = info.tocUrl || entry.bookUrl
    return await getToc(entry.source, tocUrl)
  } catch (err) {
    console.warn('[book-source] 抓目录失败，回退用 bookUrl', err)
    return await getToc(entry.source, entry.bookUrl)
  }
}

/** 判断某个书源下的书是否已有缓存章节 */
export async function hasCachedChapters(source: BookSource, bookName: string, author: string): Promise<boolean> {
  const list = await listCachedChapters(chapterCacheKey(bookName, author, source.bookSourceUrl))
  return list.length > 0
}

/** 只清除当前书在当前书源下的正文缓存，不影响其他来源。 */
export async function clearCachedBook(source: BookSource, bookName: string, author: string): Promise<void> {
  await clearBookCache(chapterCacheKey(bookName, author, source.bookSourceUrl))
}
