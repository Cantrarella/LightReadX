/**
 * 真实网络端到端验证（需联网）：用 52书库（po5.net）真实书源，
 * 验证「搜索 → 详情 → 目录 → 正文」整条链路。
 *
 * 这是联网测试，CI 环境可能无法访问外网，默认跳过；
 * 本地手动运行验证用：node --experimental-strip-types scripts/test-legado-live.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHTML } from 'linkedom'

const { document: linkedomDoc, DOMParser: LinkedomDOMParser } = parseHTML('<!DOCTYPE html><body></body>')
globalThis.DOMParser = LinkedomDOMParser
globalThis.document = linkedomDoc

const { evaluateRule, parseHtml } = await import('../src/services/legado/parser.ts')

// 52书库真实书源
const source52 = {
  bookSourceUrl: 'https://www.po5.net',
  bookSourceName: '52书库',
  searchUrl: '/so/search.php?q={{key}}&m=&f=_all&s=&p={{page}}',
  ruleSearch: {
    bookList: '.excerpt',
    name: 'h2@text##_.*|^\\d+\\.',
    author: 'h2@text##.*_|【.*】',
    intro: '.note@text',
    kind: '.muted@text##.所属栏目：|获赞：.*',
    lastChapter: 'h2@text##.*【|】.*',
    bookUrl: 'a@href',
  },
  ruleToc: {
    chapterList: '.mulu a',
    chapterName: 'text',
    chapterUrl: 'href',
  },
  ruleContent: {
    content: '#nr1@p@html',
    replaceRegex: '##\\s*.*如果觉得52书库不错.*\\s*|\\s*传送门：排行榜.*\\s*|.*www.po5.net.*',
  },
}

const { resolveUrl } = await import('../src/services/legado/url.ts')
const { strVal } = await import('../src/services/legado/url.ts')

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0' },
  })
  return await res.text()
}

test('52书库：搜索「斗破」→ 解析结果', async () => {
  const searchUrl = resolveUrl('https://www.po5.net', '/so/search.php?q=' + encodeURIComponent('斗破') + '&m=&f=_all&s=&p=1')
  const html = await fetchHtml(searchUrl)
  const doc = parseHtml(html)

  // bookList 定位
  const items = Array.from(doc.querySelectorAll('.excerpt'))
  assert.ok(items.length > 0, '应至少有一个搜索结果')

  // 第一条结果
  const first = items[0]
  const ctx = { baseUrl: searchUrl, bookSource: source52 }

  const name = strVal(evaluateRule(source52.ruleSearch.name, doc, null, { ...ctx, result: first }))
  const author = strVal(evaluateRule(source52.ruleSearch.author, doc, null, { ...ctx, result: first }))
  const bookUrl = strVal(evaluateRule(source52.ruleSearch.bookUrl, doc, null, { ...ctx, result: first }))

  console.log('  书名:', name)
  console.log('  作者:', author)
  console.log('  链接:', bookUrl)

  assert.ok(name.length > 0, '书名非空')
  assert.ok(bookUrl.startsWith('http'), '链接应为绝对 URL')
})

test('52书库：抓目录 → 解析章节', async () => {
  // 先用真实搜索拿到一本书的 URL
  const searchUrl = resolveUrl('https://www.po5.net', '/so/search.php?q=' + encodeURIComponent('斗破苍穹前传') + '&m=&f=_all&s=&p=1')
  const searchHtml = await fetchHtml(searchUrl)
  const searchDoc = parseHtml(searchHtml)
  const items = Array.from(searchDoc.querySelectorAll('.excerpt'))
  assert.ok(items.length > 0, '应找到书')

  const first = items[0]
  const ctx = { baseUrl: searchUrl, bookSource: source52 }
  const bookUrl = strVal(evaluateRule(source52.ruleSearch.bookUrl, searchDoc, null, { ...ctx, result: first }))
  assert.ok(bookUrl.startsWith('http'))

  // 抓详情页（目录）
  const tocHtml = await fetchHtml(bookUrl)
  const tocDoc = parseHtml(tocHtml)

  const chapters = Array.from(tocDoc.querySelectorAll('.mulu a'))
  console.log('  章节数:', chapters.length)
  assert.ok(chapters.length > 0, '应解析出章节')

  const chName = strVal(evaluateRule('text', tocDoc, null, { ...ctx, result: chapters[0] }))
  const chUrl = strVal(evaluateRule('href', tocDoc, null, { ...ctx, result: chapters[0] }))
  console.log('  第一章:', chName, '→', chUrl)
  assert.ok(chName.length > 0)
})
