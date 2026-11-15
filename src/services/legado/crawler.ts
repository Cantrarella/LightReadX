/**
 * 书源抓取层：搜索 / 详情 / 目录 / 正文。
 *
 * 复用 fetchRemote（桌面 Tauri 走 Rust 原生 HTTP，无跨域限制）抓取 HTML/JSON，
 * 再用 legado/parser 的规则引擎解析。
 *
 * 数据流：
 *   search(key) → 多源搜索 → 合并结果
 *   getBookInfo(source, bookUrl) → 详情
 *   getToc(source, tocUrl) → 目录
 *   getContent(source, chapterUrl) → 正文
 */
import type { BookSource, SearchResultBook, BookInfo, ChapterItem, ChapterContent, MergedSearchBook, BookSourceEntry } from './types'
import { evaluateRule, parseHtml, replaceVariables } from './parser.ts'
import { sourceHeaders, urlHost, resolveUrl, legadoCssToSelector, strVal } from './url.ts'
import { fetchRemote } from '../net'

/** 单次书源请求超时（毫秒）。失效源请求挂起会拖垮多源并发搜索，超时即放弃该源 */
const SOURCE_TIMEOUT_MS = 10_000

/** 规则解析失败时会留下 `$...` / `{{...}}` 模板原文，不能当作真实书籍字段。 */
function isResolvedSearchValue(value: string): boolean {
  const text = value.trim()
  return Boolean(text) && !text.startsWith('$') && !text.startsWith('{{')
}

/** 抓取并解析为 HTML Document 或 JSON 对象 */
async function fetchSource(
  source: BookSource,
  url: string,
): Promise<{ doc: Document | null; json: unknown; text: string; baseUrl: string }> {
  const headers = sourceHeaders(source)
  const res = await fetchRemote(url, undefined, {
    headers,
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  })
  const text = await res.text()
  const baseUrl = url

  let doc: Document | null = null
  let json: unknown = null
  // 尝试判断是 JSON 还是 HTML
  const contentType = res.headers.get('content-type') ?? ''
  const trimmed = text.trim()
  if (contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      json = JSON.parse(text)
    } catch {
      // 不是合法 JSON，按 HTML 处理
      doc = parseHtml(text)
    }
  } else {
    doc = parseHtml(text)
  }

  return { doc, json, text, baseUrl }
}

/**
 * 搜索书籍（单源）。
 * @returns 搜索结果列表
 */
export async function searchSource(
  source: BookSource,
  key: string,
  page = 1,
): Promise<SearchResultBook[]> {
  if (!source.searchUrl || !source.ruleSearch?.bookList) return []

  const host = urlHost(source.bookSourceUrl)
  const searchUrl = replaceVariables(source.searchUrl, { key, page, vars: { ho: host } })
  const fullUrl = resolveUrl(source.bookSourceUrl, searchUrl)

  const { doc, json } = await fetchSource(source, fullUrl)
  const rule = source.ruleSearch
  const ctx = {
    key,
    page,
    vars: { ho: host, key },
    baseUrl: fullUrl,
    bookSource: source,
  }

  // 1. 定位结果列表元素
  const listElements = queryList(doc, json, rule.bookList!, ctx)

  const results: SearchResultBook[] = []
  for (const el of listElements) {
    const itemCtx = { ...ctx, result: el }
    const name = strVal(evaluateRule(rule.name, doc, json, itemCtx)).trim()
    const author = strVal(evaluateRule(rule.author, doc, json, itemCtx)).trim()
    const bookUrlRaw = strVal(evaluateRule(rule.bookUrl, doc, json, itemCtx)).trim()
    const bookUrl = resolveUrl(fullUrl, bookUrlRaw)
    if (!isResolvedSearchValue(name) || (author && !isResolvedSearchValue(author))) continue
    if (!isResolvedSearchValue(bookUrlRaw) || !bookUrl) continue

    results.push({
      name,
      author,
      bookUrl,
      coverUrl: rule.coverUrl ? resolveUrl(fullUrl, strVal(evaluateRule(rule.coverUrl, doc, json, itemCtx))) : undefined,
      intro: rule.intro ? strVal(evaluateRule(rule.intro, doc, json, itemCtx)) : undefined,
      kind: rule.kind ? strVal(evaluateRule(rule.kind, doc, json, itemCtx)) : undefined,
      lastChapter: rule.lastChapter ? strVal(evaluateRule(rule.lastChapter, doc, json, itemCtx)) : undefined,
      wordCount: rule.wordCount ? strVal(evaluateRule(rule.wordCount, doc, json, itemCtx)) : undefined,
      origin: source.bookSourceName,
      source,
    })
  }
  return results
}

/** 从 doc 或 json 中按 bookList 规则取出元素列表 */
function queryList(
  doc: Document | null,
  json: unknown,
  bookListRule: string,
  ctx: Record<string, unknown>,
): any[] {
  const rule = bookListRule.trim()
  // JSON 书源：bookList 是 JSONPath
  if (rule.startsWith('@json:') || rule.startsWith('$')) {
    const v = evaluateRule(rule, doc, json, ctx)
    return Array.isArray(v) ? v : v != null ? [v] : []
  }
  // HTML 书源：bookList 是 CSS 选择器
  if (!doc) return []
  // 用 queryByCssRule 取出所有匹配元素（而不是只取第一个）
  // 这里需要「元素列表」，用标准 querySelectorAll
  const selector = legadoCssToSelector(rule)
  return Array.from(doc.querySelectorAll(selector))
}

/**
 * 获取书籍详情。
 */
export async function getBookInfo(
  source: BookSource,
  bookUrl: string,
): Promise<BookInfo> {
  const host = urlHost(source.bookSourceUrl)
  const { doc, json } = await fetchSource(source, bookUrl)
  const rule = source.ruleBookInfo
  const ctx = { vars: { ho: host }, baseUrl: bookUrl, bookSource: source }

  const name = rule?.name ? strVal(evaluateRule(rule.name, doc, json, ctx)) : ''
  const author = rule?.author ? strVal(evaluateRule(rule.author, doc, json, ctx)) : ''
  const intro = rule?.intro ? strVal(evaluateRule(rule.intro, doc, json, ctx)) : ''
  const coverUrl = rule?.coverUrl ? resolveUrl(bookUrl, strVal(evaluateRule(rule.coverUrl, doc, json, ctx))) : ''
  const tocUrl = rule?.tocUrl ? resolveUrl(bookUrl, strVal(evaluateRule(rule.tocUrl, doc, json, ctx))) : bookUrl

  return {
    name: name || '',
    author: author || '',
    intro: intro || undefined,
    coverUrl: coverUrl || undefined,
    tocUrl,
    kind: rule?.kind ? strVal(evaluateRule(rule.kind, doc, json, ctx)) : undefined,
    lastChapter: rule?.lastChapter ? strVal(evaluateRule(rule.lastChapter, doc, json, ctx)) : undefined,
    wordCount: rule?.wordCount ? strVal(evaluateRule(rule.wordCount, doc, json, ctx)) : undefined,
  }
}

/**
 * 获取目录。
 */
export async function getToc(
  source: BookSource,
  tocUrl: string,
): Promise<ChapterItem[]> {
  const host = urlHost(source.bookSourceUrl)
  const { doc, json } = await fetchSource(source, tocUrl)
  const rule = source.ruleToc
  if (!rule?.chapterList) return []

  const ctx = { vars: { ho: host }, baseUrl: tocUrl, bookSource: source }
  const listElements = queryList(doc, json, rule.chapterList, ctx)

  const chapters: ChapterItem[] = []
  for (const el of listElements) {
    const itemCtx = { ...ctx, result: el }
    const name = strVal(evaluateRule(rule.chapterName, doc, json, itemCtx))
    const urlRaw = strVal(evaluateRule(rule.chapterUrl, doc, json, itemCtx))
    const url = resolveUrl(tocUrl, urlRaw)
    if (!name || !url) continue
    chapters.push({
      name,
      url,
      volume: rule.isVolume ? strVal(evaluateRule(rule.isVolume, doc, json, itemCtx)) : undefined,
      isVip: rule.isVip ? strVal(evaluateRule(rule.isVip, doc, json, itemCtx)) === 'true' : undefined,
      isPay: rule.isPay ? strVal(evaluateRule(rule.isPay, doc, json, itemCtx)) === 'true' : undefined,
    })
  }
  return chapters
}

/**
 * 获取正文。
 */
export async function getContent(
  source: BookSource,
  chapterUrl: string,
): Promise<ChapterContent> {
  const host = urlHost(source.bookSourceUrl)
  const { doc, json } = await fetchSource(source, chapterUrl)
  const rule = source.ruleContent
  if (!rule?.content) return { text: '' }

  const ctx = { vars: { ho: host }, baseUrl: chapterUrl, bookSource: source }
  const text = strVal(evaluateRule(rule.content, doc, json, ctx))

  // 下一章 URL（多页正文）
  let nextUrl: string | undefined
  if (rule.nextContentUrl) {
    const n = strVal(evaluateRule(rule.nextContentUrl, doc, json, ctx))
    if (n) nextUrl = resolveUrl(chapterUrl, n)
  }

  return { text, nextUrl }
}

/** 单章最多抓取的分页数，避免异常书源造成无限请求。 */
const MAX_CONTENT_PAGES = 30

/**
 * 抓取一章的完整分页正文。
 *
 * 返回的 nextUrl 表示「尚未抓取的下一页」：循环、超过页数上限或后续页失败时保留，
 * 调用方因此可以展示已抓内容，但不会把残缺正文写入缓存。
 */
export async function getFullContent(
  source: BookSource,
  chapterUrl: string,
  maxPages = MAX_CONTENT_PAGES,
): Promise<ChapterContent> {
  const texts: string[] = []
  const visited = new Set<string>()
  let currentUrl = chapterUrl
  let nextUrl: string | undefined = chapterUrl

  for (let page = 0; page < Math.max(1, maxPages); page++) {
    if (visited.has(currentUrl)) break
    visited.add(currentUrl)

    let content: ChapterContent
    try {
      content = await getContent(source, currentUrl)
    } catch (err) {
      if (texts.length === 0) throw err
      console.warn('[book-source] 后续正文页抓取失败，保留已抓内容', err)
      return { text: texts.join('\n'), nextUrl: currentUrl }
    }

    if (content.text) texts.push(content.text)
    nextUrl = content.nextUrl
    if (!nextUrl) return { text: texts.join('\n') }
    if (visited.has(nextUrl)) break
    currentUrl = nextUrl
  }

  return { text: texts.join('\n'), nextUrl }
}

/**
 * 多源并行搜索，按书名+作者合并结果。
 * @param sources 启用的书源列表
 * @param key 关键词
 * @returns 合并去重后的结果（每条附带来源书源）
 */
export async function searchAllSources(
  sources: BookSource[],
  key: string,
): Promise<SearchResultBook[]> {
  const enabled = sources.filter(s => s.enabled !== false)
  const tasks = enabled.map(async source => {
    try {
      const results = await searchSource(source, key)
      return results
    } catch (err) {
      console.warn(`[book-source] 搜索 ${source.bookSourceName} 失败`, err)
      return []
    }
  })

  const all = await Promise.all(tasks)
  const flat = all.flat()

  // 按 书名|作者 合并去重，保留第一个出现的（同时记录来源）
  const seen = new Map<string, SearchResultBook>()
  for (const book of flat) {
    const k = `${book.name}|${book.author}`
    if (!seen.has(k)) seen.set(k, book)
  }
  return Array.from(seen.values())
}

/**
 * 多源搜索并合并成「一本书 + 多个来源」（换源）。
 * 同一本书（书名|作者相同）在不同书源的入口归并到一起，供详情页选源。
 */
export async function searchAllSourcesMerged(
  sources: BookSource[],
  key: string,
): Promise<MergedSearchBook[]> {
  const enabled = sources.filter(s => s.enabled !== false)
  const tasks = enabled.map(async source => {
    try {
      return await searchSource(source, key)
    } catch (err) {
      console.warn(`[book-source] 搜索 ${source.bookSourceName} 失败`, err)
      return []
    }
  })

  const all = await Promise.all(tasks)
  const flat = all.flat()

  // 按 书名|作者 分组
  const grouped = new Map<string, SearchResultBook[]>()
  for (const book of flat) {
    const k = `${book.name}|${book.author}`
    const arr = grouped.get(k) ?? []
    arr.push(book)
    grouped.set(k, arr)
  }

  const merged: MergedSearchBook[] = []
  for (const [, books] of grouped) {
    const first = books[0]
    const entries: BookSourceEntry[] = books.map(b => ({
      sourceName: b.origin,
      source: b.source!,
      bookUrl: b.bookUrl,
      intro: b.intro,
      coverUrl: b.coverUrl,
      lastChapter: b.lastChapter,
    }))
    merged.push({
      name: first.name,
      author: first.author,
      sources: entries,
      primary: entries[0],
    })
  }
  return merged
}

/** 单个书源的健康检测结果 */
export interface SourceCheckResult {
  /** 源是否可用 */
  ok: boolean
  /** 结果说明（成功/失败原因） */
  message: string
  /** 检测返回的结果条数（成功时 > 0） */
  count: number
  /** 耗时（毫秒） */
  elapsedMs: number
}

/**
 * 书源健康检测：用测试关键词做一次真实搜索，判断源是否仍可用。
 *
 * 判定标准：
 *  - 源缺少 searchUrl 或 ruleSearch.bookList → 直接判为「规则不完整」
 *  - 搜索抛错 → 「请求失败」
 *  - 搜索成功但结果为空 → 「搜索无结果」（可能源失效或关键词不对）
 *  - 结果 >= 1 → 可用
 */
export async function checkSource(
  source: BookSource,
  key = '斗破苍穹',
): Promise<SourceCheckResult> {
  const started = Date.now()
  const done = (ok: boolean, message: string, count = 0): SourceCheckResult => ({
    ok,
    message,
    count,
    elapsedMs: Date.now() - started,
  })

  if (!source.searchUrl || !source.ruleSearch?.bookList) {
    return done(false, '规则不完整（缺搜索 URL 或 bookList）')
  }

  try {
    const results = await searchSource(source, key)
    if (results.length > 0) {
      return done(true, '可用', results.length)
    }
    return done(false, '搜索无结果（源可能已失效）', 0)
  } catch (err) {
    return done(false, `请求失败：${String(err).slice(0, 80)}`)
  }
}
