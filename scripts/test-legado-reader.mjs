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
  const key = chapterCacheKey('斗破苍穹', '天蚕土豆')
  await cacheChapter(key, { name: '第一章', url: 'https://x/1.html', text: '正文内容A', cachedAt: Date.now() })
  await cacheChapter(key, { name: '第二章', url: 'https://x/2.html', text: '正文内容B', cachedAt: Date.now() })

  const c1 = await getCachedChapter(key, 'https://x/1.html')
  assert.equal(c1?.text, '正文内容A')

  const list = await listCachedChapters(key)
  assert.equal(list.length, 2)

  await clearBookCache(key)
  assert.equal((await listCachedChapters(key)).length, 0)
})

test('缓存键按书名|作者区分不同书', async () => {
  const k1 = chapterCacheKey('斗破苍穹', '天蚕土豆')
  const k2 = chapterCacheKey('斗破苍穹', '别人')
  assert.notEqual(k1, k2)
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
})
