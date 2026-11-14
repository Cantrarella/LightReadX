/**
 * 插件商店网络层回归 (不联网): 桌面 WebView 原生 HTTP 挂起 / 失败时的兜底。
 *
 * 验证: 缓存优先渲染、原生失败回退 WebView fetch、并行拉多源且单源失败隔离、
 * 挂起请求的 JS 层硬超时 (不依赖 AbortSignal, 避免商店永远「正在拉取…」)。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightread-store-net-'))
const outfile = path.join(tmp, 'store.mjs')

// 内存 localStorage, 避免测试碰真实浏览器存储
const mem = new Map()
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
  clear: () => mem.clear(),
}
// 把硬超时压到 200ms, 否则「挂起」场景要等 12 秒
globalThis.__LR_STORE_TIMEOUT__ = 200

const SUBS_KEY = 'lightread.comicStore.subscriptions.v1'
const CACHE_KEY = 'lightread.comicStore.cache.v1'
const OFFICIAL = 'https://raw.githubusercontent.com/breeze-project-org/Breeze-plugin-list/main/plugins_data.json'

const stub = {
  name: 'store-net-stub',
  setup(b) {
    b.onResolve({ filter: /^\.\.\/net$/ }, () => ({ path: '../net', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\/index$/ }, () => ({ path: './index', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => {
      if (args.path === '../net') {
        return {
          loader: 'js',
          contents: `export async function fetchRemote(url, auth, init) {
            return globalThis.__storeNet.fetchRemote(url, auth, init)
          }`,
        }
      }
      return {
        loader: 'js',
        contents: `export async function installFromCode() { throw Error('not used in net test') }
          export function listPlugins() { return [] }`,
      }
    })
  },
}

function setSubs() {
  mem.set(SUBS_KEY, JSON.stringify([
    { id: 'breeze-official', name: 'official', url: OFFICIAL, enabled: false, addedAt: 0 },
    { id: 'a', name: 'A', url: 'https://a.test/index.json', enabled: true, addedAt: 0 },
    { id: 'b', name: 'B', url: 'https://b.test/index.json', enabled: true, addedAt: 0 },
  ]))
}
function jsonResponse(rows) {
  return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
}
function setNet(fetchRemote, browserFetch) {
  globalThis.__storeNet = { fetchRemote, browserFetch }
  globalThis.fetch = (url, init) => browserFetch(url, init)
}

try {
  await build({
    entryPoints: [path.join(root, 'src/services/comicPlugin/store.ts')],
    outfile, bundle: true, format: 'esm', platform: 'node',
    target: 'node22', logLevel: 'silent', plugins: [stub],
  })
  const store = await import(pathToFileURL(outfile).href)

  // ---- 1. 缓存优先: 不等网络就能把上次索引交给 UI ----
  setSubs()
  mem.set(CACHE_KEY, JSON.stringify({
    a: { at: Date.now(), entries: [{ uuid: 'cached-1', name: 'Cached comic' }] },
  }))
  assert.equal(store.loadCachedStore()[0].uuid, 'cached-1', '缓存要能先渲染出来')
  assert.equal(store.loadCachedStore().length, 1, '禁用源 / 空缓存不该混进来')

  // ---- 2. 原生请求失败 → WebView fetch 回退, 单源失败不拖全局 ----
  setNet(
    async url => {
      if (url.includes('a.test')) return jsonResponse([{ name: 'FromA', uuid: 'a1', version: '1.0.0' }])
      throw Error('native HTTP down')
    },
    async () => jsonResponse([{ name: 'FromB', uuid: 'b1', version: '1.0.0' }]),
  )
  const ok = await store.loadStore(true)
  assert.deepEqual(ok.entries.map(e => e.uuid).sort(), ['a1', 'b1'], 'A 走原生、B 走回退, 两边都要进列表')
  assert.equal(ok.errors.length, 0, '回退成功就不该报错')
  assert.equal(ok.fromCache, false)

  // ---- 3. 全部失败时用旧缓存顶上, 且每个源的失败都单独记录 ----
  // 上面成功拉取后缓存已被刷新成 a1/b1, 这里重新造一份「过期但仍可用」的缓存
  mem.set(CACHE_KEY, JSON.stringify({
    a: { at: 1, entries: [{ uuid: 'cached-1', name: 'Cached comic' }] },
  }))
  setNet(
    async () => { throw Error('native down') },
    async () => { throw Error('webview down') },
  )
  const fallback = await store.loadStore(true)
  assert.equal(fallback.errors.length, 2, '两个启用源各记一条错误')
  assert.ok(fallback.errors[0].includes('native down') && fallback.errors[0].includes('webview down'))
  assert.equal(fallback.fromCache, true)
  assert.ok(fallback.entries.some(e => e.uuid === 'cached-1'), '旧缓存必须兜底')

  // ---- 4. 没有缓存时也不能抛错, 交给 UI 显示明确错误 + 重试 ----
  mem.delete(CACHE_KEY)
  const empty = await store.loadStore(true)
  assert.equal(empty.entries.length, 0)
  assert.equal(empty.errors.length, 2)

  // ---- 5. 关键: 请求永远挂起时, JS 层硬超时必须让 loadStore 及时返回 ----
  setNet(
    () => new Promise(() => {}),
    () => new Promise(() => {}),
  )
  const started = Date.now()
  const hung = await store.loadStore(true)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 4000, `挂起请求必须在硬超时后返回, 实际 ${elapsed}ms`)
  assert.equal(hung.errors.length, 2, '超时也要给出可读的错误, 不能无限转圈')
  assert.ok(hung.errors.every(e => e.includes('超时')), '错误信息要带超时提示')

  console.log(`test-comic-store-net: OK (缓存优先 / WebView 回退 / 并行隔离 / 缓存兜底 / 挂起硬超时 ${elapsed}ms)`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
