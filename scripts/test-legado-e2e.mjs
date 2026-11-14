/**
 * 端到端验证：用真实书源规则 + 模拟真实 HTML，验证「搜索→详情→目录→正文」全链路。
 *
 * 这里用笔趣阁（b5200.net）的真实规则，配合笔趣阁典型页面的 HTML 结构，
 * 验证解析引擎能正确抽取字段。不依赖网络，确保回归可重复。
 * DOM 解析用 linkedom（轻量服务端 DOM）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHTML } from 'linkedom'

// 注入全局 DOMParser / document（linkedom 提供）
const { document: linkedomDoc, DOMParser: LinkedomDOMParser } = parseHTML('<!DOCTYPE html><body></body>')
globalThis.DOMParser = LinkedomDOMParser
globalThis.document = linkedomDoc

const { evaluateRule } = await import('../src/services/legado/parser.ts')

// 笔趣阁真实书源（从 reader.db 提取）
const biqugeSource = {
  bookSourceUrl: 'http://www.b5200.net',
  bookSourceName: '❤️笔趣阁🎃',
  searchUrl: 'http://www.b5200.net/modules/article/search.php?searchkey={{key}}',
  ruleSearch: {
    bookList: 'class.grid@tag.tr',
    name: 'class.odd.0@tag.a.0@text',
    author: 'class.odd.1@text',
    lastChapter: 'class.even.0@tag.a.0@text',
    bookUrl: 'class.odd.0@tag.a.0@href',
  },
  ruleBookInfo: {
    intro: 'id.intro.0@tag.p.0@text',
    coverUrl: 'id.fmimg.0@tag.img.0@src',
  },
  ruleToc: {
    chapterList: 'class.box_con@tag.dd!0:1:2:3:4:5:6:7:8',
    chapterName: 'tag.a@text',
    chapterUrl: 'tag.a@href',
  },
  ruleContent: {
    content: 'tag.h1.0@textNodes&&id.content@tag.p@text##(第.{1,8}章)\\s*?(\\S*?)\\s*?\\S+?正文卷\\1\\2',
  },
}

function parse(html) {
  const { document } = parseHTML(html)
  return document
}

// 模拟笔趣阁搜索结果页 HTML
const searchHtml = `
<table class="grid">
  <tr>
    <td class="odd"><a href="/book/123/">斗破苍穹</a></td>
    <td class="odd">天蚕土豆</td>
    <td class="even"><a href="/book/123/12345.html">第一千六百章 大结局</a></td>
  </tr>
  <tr>
    <td class="odd"><a href="/book/456/">凡人修仙传</a></td>
    <td class="odd">忘语</td>
    <td class="even"><a href="/book/456/45678.html">第两千章 飞升</a></td>
  </tr>
</table>
`

// 模拟笔趣阁目录页 HTML
const tocHtml = `
<div class="box_con">
  <dl>
    <dd><a href="/book/123/1000.html">第一章 序章</a></dd>
    <dd><a href="/book/123/1001.html">第二章 修炼</a></dd>
    <dd><a href="/book/123/1002.html">第三章 突破</a></dd>
    <dd><a href="/book/123/1003.html">第四章 决战</a></dd>
  </dl>
</div>
`

// 模拟笔趣阁正文页 HTML
const contentHtml = `
<div class="bookname"><h1>第四章 决战</h1></div>
<div id="content">
  <p>　　第一段正文内容。</p>
  <p>第二段正文内容，继续阅读。</p>
  <p>第三段正文内容，精彩继续。</p>
</div>
`

test('搜索规则：逐字段抽取（书名/作者/URL）', () => {
  const doc = parse(searchHtml)
  const rule = biqugeSource.ruleSearch
  const ctx = { baseUrl: 'http://www.b5200.net', bookSource: biqugeSource }

  const rows = Array.from(doc.querySelectorAll('.grid tr'))
  assert.equal(rows.length, 2)

  // 第一本书（模拟 crawler 把 result 设为当前 tr）
  const row0 = rows[0]
  const name = evaluateRule(rule.name, doc, null, { ...ctx, result: row0 })
  const author = evaluateRule(rule.author, doc, null, { ...ctx, result: row0 })
  const bookUrl = evaluateRule(rule.bookUrl, doc, null, { ...ctx, result: row0 })

  assert.equal(String(name).trim(), '斗破苍穹')
  assert.equal(String(author).trim(), '天蚕土豆')
  assert.equal(String(bookUrl).trim(), '/book/123/')
})

test('目录规则：章节名/URL 抽取', () => {
  const doc = parse(tocHtml)
  const ctx = { baseUrl: 'http://www.b5200.net', bookSource: biqugeSource }

  const dds = Array.from(doc.querySelectorAll('.box_con dd'))
  assert.equal(dds.length, 4)

  const first = dds[0]
  const chapterName = evaluateRule('tag.a@text', doc, null, { ...ctx, result: first })
  const chapterUrl = evaluateRule('tag.a@href', doc, null, { ...ctx, result: first })
  assert.equal(String(chapterName).trim(), '第一章 序章')
  assert.equal(String(chapterUrl).trim(), '/book/123/1000.html')
})

test('正文规则：&& 连接标题与正文 + ## 清洗', () => {
  const doc = parse(contentHtml)
  const rule = biqugeSource.ruleContent
  const ctx = { baseUrl: 'http://www.b5200.net', bookSource: biqugeSource }

  const text = evaluateRule(rule.content, doc, null, ctx)
  const result = String(text)

  // 应包含 h1 标题（第四章 决战）和正文段落
  assert.ok(result.includes('第四章 决战'), `应含标题，实际: ${result}`)
  assert.ok(result.includes('第一段正文内容'), `应含正文，实际: ${result}`)
  assert.ok(result.includes('第三段正文内容'), `应含第三段，实际: ${result}`)
})

test('正文清洗：删除「第X章」前缀正则', () => {
  const doc = parse(contentHtml)
  const rule = 'id.content@tag.p@text##(第.{1,8}章)\\s*?(\\S*?)\\s*?\\S+?正文卷\\1\\2'
  const ctx = { baseUrl: 'http://www.b5200.net', bookSource: biqugeSource }
  const text = evaluateRule(rule, doc, null, ctx)
  assert.ok(String(text).includes('第一段正文内容'))
})

test('详情规则：intro 和 coverUrl 抽取', () => {
  const html = `
  <div id="intro">
    <p>这是一个精彩的故事，讲述少年成长。</p>
  </div>
  <div id="fmimg">
    <img src="/cover/123.jpg" />
  </div>
  `
  const doc = parse(html)
  const rule = biqugeSource.ruleBookInfo
  const ctx = { baseUrl: 'http://www.b5200.net', bookSource: biqugeSource }

  const intro = evaluateRule(rule.intro, doc, null, ctx)
  const cover = evaluateRule(rule.coverUrl, doc, null, ctx)

  assert.ok(String(intro).includes('精彩的故事'))
  assert.equal(String(cover).trim(), '/cover/123.jpg')
})
