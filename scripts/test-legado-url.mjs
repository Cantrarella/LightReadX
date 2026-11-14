import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  sourceHeaders,
  urlHost,
  resolveUrl,
  legadoCssToSelector,
  strVal,
} from '../src/services/legado/url.ts'

// ---------------------------------------------------------------------------
// urlHost
// ---------------------------------------------------------------------------

test('urlHost 提取协议+域名', () => {
  assert.equal(urlHost('https://66shuba.com/book/123'), 'https://66shuba.com')
  assert.equal(urlHost('http://www.b5200.net/x/y'), 'http://www.b5200.net')
})

test('urlHost 非法 URL 返回空', () => {
  assert.equal(urlHost('not-a-url'), '')
})

// ---------------------------------------------------------------------------
// resolveUrl
// ---------------------------------------------------------------------------

test('resolveUrl 相对路径', () => {
  assert.equal(
    resolveUrl('https://66shuba.com/book/123/', '/soushu/abc.html'),
    'https://66shuba.com/soushu/abc.html',
  )
})

test('resolveUrl 绝对路径原样返回', () => {
  assert.equal(resolveUrl('https://a.com', 'https://b.com/x'), 'https://b.com/x')
})

test('resolveUrl 协议相对 //', () => {
  assert.equal(resolveUrl('https://66shuba.com', '//m.qidian.com/x'), 'https://m.qidian.com/x')
  assert.equal(resolveUrl('http://66shuba.com', '//m.qidian.com/x'), 'http://m.qidian.com/x')
})

test('resolveUrl 空值原样返回', () => {
  assert.equal(resolveUrl('https://a.com', ''), '')
})

// ---------------------------------------------------------------------------
// legadoCssToSelector
// ---------------------------------------------------------------------------

test('class.xxx → .xxx', () => {
  assert.equal(legadoCssToSelector('class.grid@tag.tr'), '.grid')
})

test('@css: 标准 CSS 直接取', () => {
  assert.equal(legadoCssToSelector('@css:div.y-list__content>div.y-list__item'), 'div.y-list__content>div.y-list__item')
})

test('id.xxx → #xxx', () => {
  assert.equal(legadoCssToSelector('id.content@tag.p'), '#content')
})

test('tag.xxx → xxx', () => {
  assert.equal(legadoCssToSelector('tag.dd'), 'dd')
})

test('裸选择器（52书库 .excerpt）', () => {
  assert.equal(legadoCssToSelector('.excerpt'), '.excerpt')
})

test('去掉索引和排除符', () => {
  assert.equal(legadoCssToSelector('class.box_con@tag.dd!0:1:2'), '.box_con')
})

// ---------------------------------------------------------------------------
// strVal
// ---------------------------------------------------------------------------

test('strVal 空值返回空串', () => {
  assert.equal(strVal(null), '')
  assert.equal(strVal(undefined), '')
})

test('strVal 数组拼接', () => {
  assert.equal(strVal(['a', 'b', 'c']), 'abc')
})

test('strVal 字符串 trim', () => {
  assert.equal(strVal('  hello  '), 'hello')
})

// ---------------------------------------------------------------------------
// sourceHeaders
// ---------------------------------------------------------------------------

test('sourceHeaders 解析 JSON 字符串', () => {
  const source = { header: '{"User-Agent": "Mozilla/5.0"}' }
  assert.deepEqual(sourceHeaders(source), { 'User-Agent': 'Mozilla/5.0' })
})

test('sourceHeaders 无 header 返回空', () => {
  assert.deepEqual(sourceHeaders({}), {})
})

test('sourceHeaders 非法 JSON 返回空', () => {
  assert.deepEqual(sourceHeaders({ header: 'not json' }), {})
})
