/**
 * 章节缓存 + 换源合并 回归（不联网）。
 * 缓存：localStorage 后端（Web 兜底路径）直接测；
 * 换源：searchAllSourcesMerged 用 esbuild stub 掉 net。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'
import { parseHTML } from 'linkedom'

const root = fileURLToPath(new URL('..', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightread-reader-'))
const outfile = path.join(tmp, 'reader.mjs')

const mem = new Map()
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
  clear: () => mem.clear(),
}
globalThis.__TAURI_INTERNALS__ = undefined // 强制走 Web localStorage 后端

const { document, DOMParser } = parseHTML('<!DOCTYPE html><body></body>')
globalThis.DOMParser = DOMParser
globalThis.document = document

// 测试缓存模块（Web 后端）
import {
  cacheChapter, getCachedChapter, listCachedChapters, clearBookCache, chapterCacheKey,
} from '../src/services/legado/chapterCache.ts'

import test from 'node:test'

test('缓存写入 + 读取 + 列表 + 清空', async () => {
  const key = chapterCacheKey('斗破苍穹', '天蚕土豆', 'https://srca.com')
  await cacheChapter(key, { name: '第一章', url: 'https://x/1.html', text: '正文内容A', cachedAt: Date.now() })
  await cacheChapter(key, { name: '第二章', url: 'https://x/2.html', text: '正文内容B', cachedAt: Date.now() })

  const c1 = await getCachedChapter(key, 'https://x/1.html')
  assert.equal(c1?.text, '正文内容A')

  const list = await listCachedChapters(key)
  assert.equal(list.length, 2)

  await clearBookCache(key)
  assert.equal((await listCachedChapters(key)).length, 0)
})

test('缓存键同时按书源、书名和作者隔离', () => {
  const base = chapterCacheKey('斗破苍穹', '天蚕土豆', 'https://srca.com')
  assert.notEqual(base, chapterCacheKey('斗破苍穹', '别人', 'https://srca.com'))
  assert.notEqual(base, chapterCacheKey('斗破苍穹', '天蚕土豆', 'https://srcb.com'))
})

test('同名同作者同章节 URL 在不同书源下不会串缓存', async () => {
  const keyA = chapterCacheKey('斗破苍穹', '天蚕土豆', 'https://srca.com')
  const keyB = chapterCacheKey('斗破苍穹', '天蚕土豆', 'https://srcb.com')
  const chapterUrl = 'https://shared.example/chapter-1'
  await cacheChapter(keyA, { name: '第一章', url: chapterUrl, text: '源A正文', cachedAt: Date.now() })
  await cacheChapter(keyB, { name: '第一章', url: chapterUrl, text: '源B正文', cachedAt: Date.now() })

  assert.equal((await getCachedChapter(keyA, chapterUrl))?.text, '源A正文')
  assert.equal((await getCachedChapter(keyB, chapterUrl))?.text, '源B正文')
  await clearBookCache(keyA)
  await clearBookCache(keyB)
})

// ---- 换源合并：esbuild stub net ----
const stub = {
  name: 'reader-net-stub',
  setup(b) {
    b.onResolve({ filter: /^\.\.\/net$/ }, () => ({ path: '../net', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      loader: 'js',
      contents: `export async function fetchRemote(url, auth, init) {
        return globalThis.__readerNet.fetchRemote(url, auth, init)
      }`,
    }))
  },
}

function mockResponse(status, html) {
  return { status, ok: status < 400, headers: { get: () => 'text/html' }, text: async () => html }
}

// 两个源，返回同一本书（书名|作者相同）+ 一本独有书
globalThis.__readerNet = {
  async fetchRemote(url) {
    const u = String(url)
    if (u.includes('srca.com')) {
      return mockResponse(200, `<html><body>
        <div class="r"><a href="/a/1">斗破苍穹</a><span>天蚕土豆</span></div>
        <div class="r"><a href="/a/2">独有书</a><span>某作者</span></div>
        <div class="r"><a href="/a/3">$.title</a><span>天蚕土豆</span></div>
        <div class="r"><a href="/a/4">{{bookName}}</a><span>某作者</span></div>
        <div class="r"><a href="/a/5">斗破苍穹</a><span>$.author_name</span></div>
      </body></html>`)
    }
    // srcb.com
    return mockResponse(200, `<html><body>
      <div class="r"><a href="/b/9">斗破苍穹</a><span>天蚕土豆</span></div>
    </body></html>`)
  },
}

const built = await build({
  entryPoints: [path.join(root, 'src/services/legado/crawler.ts')],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outfile,
  plugins: [stub],
  write: false,
})
const code = built.outputFiles[0].text
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const crawler = await import(dataUrl)

test('searchAllSourcesMerged 把同名书合并成多来源', async () => {
  const sources = [
    { bookSourceUrl: 'https://srca.com', bookSourceName: '源A', searchUrl: '/s?key={{key}}',
      ruleSearch: { bookList: '.r', name: 'a@text', author: 'span@text', bookUrl: 'a@href' } },
    { bookSourceUrl: 'https://srcb.com', bookSourceName: '源B', searchUrl: '/s?key={{key}}',
      ruleSearch: { bookList: '.r', name: 'a@text', author: 'span@text', bookUrl: 'a@href' } },
  ]
  const merged = await crawler.searchAllSourcesMerged(sources, '斗破苍穹')

  // 应该有两本：斗破苍穹（2源）+ 独有书（1源）
  assert.equal(merged.length, 2)

  const dp = merged.find(m => m.name === '斗破苍穹')
  assert.ok(dp)
  assert.equal(dp.sources.length, 2) // 两个源都命中
  assert.equal(dp.primary.sourceName, '源A')
  // 换源：切到第二个源
  const switched = dp.sources[1]
  assert.equal(switched.sourceName, '源B')
  assert.equal(switched.bookUrl, 'https://srcb.com/b/9')

  const alone = merged.find(m => m.name === '独有书')
  assert.ok(alone)
  assert.equal(alone.sources.length, 1)

  // 未解析成功的书名/作者模板不得进入结果，也不得污染同名书分组
  assert.equal(merged.some(m => m.name.startsWith('$') || m.name.startsWith('{{')), false)
  assert.equal(dp.sources.some(s => s.sourceName === '源A' && s.bookUrl === 'https://srca.com/a/5'), false)
})

const contentSource = {
  bookSourceUrl: 'https://content.example',
  bookSourceName: '分页源',
  ruleContent: { content: 'id.content@text', nextContentUrl: 'id.next@href' },
}

function contentPage(text, next) {
  return `<html><body><div id="content">${text}</div>${next ? `<a id="next" href="${next}">下一页</a>` : ''}</body></html>`
}

test('完整抓取分页正文并按顺序拼接', async () => {
  const original = globalThis.__readerNet.fetchRemote
  const requested = []
  globalThis.__readerNet.fetchRemote = async url => {
    const u = String(url)
    requested.push(u)
    if (u.endsWith('/1')) return mockResponse(200, contentPage('第一页', '/2'))
    if (u.endsWith('/2')) return mockResponse(200, contentPage('第二页', ''))
    throw new Error(`unexpected URL: ${u}`)
  }
  try {
    const result = await crawler.getFullContent(contentSource, 'https://content.example/1')
    assert.equal(result.text, '第一页\n第二页')
    assert.equal(result.nextUrl, undefined)
    assert.deepEqual(requested, ['https://content.example/1', 'https://content.example/2'])
  } finally {
    globalThis.__readerNet.fetchRemote = original
  }
})

test('分页循环会停止并标记正文未抓完', async () => {
  const original = globalThis.__readerNet.fetchRemote
  let requests = 0
  globalThis.__readerNet.fetchRemote = async url => {
    requests++
    return String(url).endsWith('/1')
      ? mockResponse(200, contentPage('第一页', '/2'))
      : mockResponse(200, contentPage('第二页', '/1'))
  }
  try {
    const result = await crawler.getFullContent(contentSource, 'https://content.example/1')
    assert.equal(result.text, '第一页\n第二页')
    assert.equal(result.nextUrl, 'https://content.example/1')
    assert.equal(requests, 2)
  } finally {
    globalThis.__readerNet.fetchRemote = original
  }
})

test('后续分页失败时保留已抓正文但不伪装成完整章节', async () => {
  const original = globalThis.__readerNet.fetchRemote
  globalThis.__readerNet.fetchRemote = async url => {
    if (String(url).endsWith('/1')) return mockResponse(200, contentPage('第一页', '/2'))
    throw new Error('第二页连接失败')
  }
  try {
    const result = await crawler.getFullContent(contentSource, 'https://content.example/1')
    assert.equal(result.text, '第一页')
    assert.equal(result.nextUrl, 'https://content.example/2')
  } finally {
    globalThis.__readerNet.fetchRemote = original
  }
})

const readerBuilt = await build({
  entryPoints: [path.join(root, 'src/services/legado/reader.ts')],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outfile,
  plugins: [stub],
  write: false,
})
const readerCode = readerBuilt.outputFiles[0].text
const readerDataUrl = 'data:text/javascript;base64,' + Buffer.from(readerCode).toString('base64')
const reader = await import(readerDataUrl)

test('阅读器缓存合并后的完整正文，后续离线可读', async () => {
  const original = globalThis.__readerNet.fetchRemote
  const key = chapterCacheKey('分页书', '作者', contentSource.bookSourceUrl)
  const chapter = { name: '第一章', url: 'https://content.example/1' }
  globalThis.__readerNet.fetchRemote = async url => String(url).endsWith('/1')
    ? mockResponse(200, contentPage('第一页', '/2'))
    : mockResponse(200, contentPage('第二页', ''))
  try {
    const first = await reader.getChapterCached(contentSource, '分页书', '作者', chapter)
    assert.equal(first.text, '第一页\n第二页')
    assert.equal((await getCachedChapter(key, chapter.url))?.text, '第一页\n第二页')

    globalThis.__readerNet.fetchRemote = async () => { throw new Error('离线') }
    const cached = await reader.getChapterCached(contentSource, '分页书', '作者', chapter)
    assert.equal(cached.text, '第一页\n第二页')
  } finally {
    await clearBookCache(key)
    globalThis.__readerNet.fetchRemote = original
  }
})

test('阅读器不缓存循环分页造成的残缺正文', async () => {
  const original = globalThis.__readerNet.fetchRemote
  const key = chapterCacheKey('残缺书', '作者', contentSource.bookSourceUrl)
  const chapter = { name: '第一章', url: 'https://content.example/1' }
  globalThis.__readerNet.fetchRemote = async url => String(url).endsWith('/1')
    ? mockResponse(200, contentPage('第一页', '/2'))
    : mockResponse(200, contentPage('第二页', '/1'))
  try {
    const result = await reader.getChapterCached(contentSource, '残缺书', '作者', chapter)
    assert.equal(result.text, '第一页\n第二页')
    assert.equal(result.nextUrl, 'https://content.example/1')
    assert.equal(await getCachedChapter(key, chapter.url), undefined)
  } finally {
    await clearBookCache(key)
    globalThis.__readerNet.fetchRemote = original
  }
})
