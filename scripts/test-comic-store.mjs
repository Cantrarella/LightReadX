/**
 * 插件商店 / 发现页协议回归测试 (不联网)。
 *
 * 用 esbuild 把纯逻辑模块打成临时 ESM, 用内置样本验证:
 * 索引解析 (官方 / 自定义 / 脏数据)、版本比较、bundle 地址候选与链接挖掘、
 * scheme 四种区块、首页 tab、scene / action 归一化。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightread-comic-store-'))

async function load(entry, outfile) {
  const target = path.join(tmp, outfile)
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: target, bundle: true, format: 'esm', platform: 'node',
    target: 'node22', logLevel: 'silent',
    // 数据层只在函数内部用 localStorage / fetchRemote, 测试不触发网络路径
  })
  return import(pathToFileURL(target).href)
}

const store = await load('src/services/comicPlugin/store.ts', 'store.mjs')
const discover = await load('src/services/comicPlugin/discover.ts', 'discover.mjs')

const sub = { id: 'test', name: 'Test index', url: 'https://example.com/index.json', enabled: true, addedAt: 0 }

// ---- 1. 官方索引格式 ----
const official = [
  {
    repo: 'deretame/Breeze-plugin-webtoon',
    manifest: {
      name: 'WEBTOON', uuid: 'uuid-webtoon', version: '0.1.0',
      iconUrl: 'https://example.com/favicon.ico', describe: 'Official App API',
      home: 'https://www.webtoons.com', updateUrl: '',
      npmName: 'breeze-plugin-webtoon', haveHome: true,
      creator: { name: 'deretame' },
    },
  },
  {
    repo: 'foo/Breeze-plugin-no-npm',
    manifest: {
      name: 'NoNpm', uuid: 'uuid-nonpm', version: '1.2.0',
      updateUrl: 'https://api.github.com/repos/foo/Breeze-plugin-no-npm/releases/latest',
    },
  },
]
const parsed = store.parseStoreIndex(official, sub)
assert.equal(parsed.length, 2)
assert.equal(parsed[0].name, 'WEBTOON')
assert.equal(parsed[0].npmName, 'breeze-plugin-webtoon')
assert.equal(parsed[0].author, 'deretame')
assert.equal(parsed[0].haveHome, true)
assert.equal(parsed[0].sourceId, 'test')
assert.equal(parsed[1].home, 'https://github.com/foo/Breeze-plugin-no-npm')

// ---- 2. 自定义索引形状 + 脏数据 + uuid 去重 ----
assert.equal(store.parseStoreIndex({ plugins: [{ name: 'Flat', uuid: 'u1', version: '2' }] }, sub).length, 1)
assert.equal(store.parseStoreIndex({ data: { plugins: [{ name: 'Nested', uuid: 'u2' }] } }, sub).length, 1)
const messy = store.parseStoreIndex([
  { name: 'A', uuid: 'dup' }, { name: 'B', uuid: 'dup' },
  null, 42, {}, { name: '', uuid: 'empty' },
], sub)
assert.equal(messy.length, 1, '重复 uuid / 无 name / 非对象都要过滤')
assert.equal(messy[0].name, 'A')
assert.equal(store.parseStoreIndex({}, sub).length, 0)
assert.equal(store.parseStoreIndex('nope', sub).length, 0)
assert.ok(store.parseStoreIndex([{ name: 'NoUuid', repo: 'a/b' }], sub)[0].uuid.startsWith('store-'))

// ---- 3. 版本比较 ----
assert.equal(store.compareVersion('1.2.0', '1.1.9'), 1)
assert.equal(store.compareVersion('0.1.0', '0.1.0'), 0)
assert.equal(store.compareVersion('v1.0', '1.0.1'), -1)
assert.equal(store.compareVersion('1.10.0', '1.9.9'), 1)
assert.equal(store.compareVersion('2.0.0-beta', '2.0.0'), -1)

// ---- 4. bundle 候选地址 ----
const cand = store.bundleCandidates(parsed[0])
assert.ok(cand[0] === 'https://cdn.jsdelivr.net/npm/breeze-plugin-webtoon@0.1.0/dist/breeze-plugin-webtoon.bundle.cjs')
assert.ok(cand.includes('https://cdn.jsdelivr.net/npm/breeze-plugin-webtoon/dist/breeze-plugin-webtoon.bundle.cjs'))

// 没有 npmName 的条目只能靠仓库路径; 仓库里文件名是小写, 两种大小写都要出候选
// (之前只猜 Breeze-plugin-mangadex.bundle.cjs → 全部 404, 商店里 8 个插件装不上)
const repoOnly = store.parseStoreIndex(
  [{ repo: 'k623615746/Breeze-plugin-mangadex', manifest: { name: 'MangaDex', version: '1.3.1' } }],
  sub,
)[0]
const repoCand = store.bundleCandidates(repoOnly)
assert.ok(
  repoCand.includes('https://cdn.jsdelivr.net/gh/k623615746/Breeze-plugin-mangadex@main/dist/breeze-plugin-mangadex.bundle.cjs'),
  '仓库里的小写文件名要能命中',
)
assert.ok(
  repoCand.includes('https://cdn.jsdelivr.net/gh/k623615746/Breeze-plugin-mangadex@main/dist/Breeze-plugin-mangadex.bundle.cjs'),
  '大写写法保留作兜底',
)
assert.equal(typeof store.repoBundleCandidates, 'function', 'jsDelivr 文件清单兜底')
assert.equal(typeof store.releaseBundleCandidates, 'function', 'Release 资源兜底')
assert.ok(cand.some(u => u.startsWith('https://cdn.jsdelivr.net/gh/deretame/Breeze-plugin-webtoon@main/dist/')))
assert.ok(cand.some(u => u.startsWith('https://raw.githubusercontent.com/deretame/Breeze-plugin-webtoon/main/dist/')))
assert.equal(new Set(cand).size, cand.length, '候选不能重复')
const noNpm = store.bundleCandidates(parsed[1])
assert.ok(noNpm.every(u => !u.includes('/npm/')), '没有 npmName 就不该拼 npm 地址')
assert.ok(noNpm.length >= 2)

// ---- 5. Release / latest.json 链接挖掘 ----
const releaseLinks = store.collectBundleLinks({
  tag_name: 'v1',
  assets: [
    { name: 'plugin.bundle.cjs.br', browser_download_url: 'https://github.com/x/y/releases/download/v1/plugin.bundle.cjs.br' },
    { name: 'plugin.bundle.cjs', browser_download_url: 'https://github.com/x/y/releases/download/v1/plugin.bundle.cjs' },
    { name: 'readme.txt', browser_download_url: 'https://github.com/x/y/releases/download/v1/readme.txt' },
  ],
})
assert.deepEqual(releaseLinks, ['https://github.com/x/y/releases/download/v1/plugin.bundle.cjs'])
assert.deepEqual(store.collectBundleLinks({ downloadUrl: 'https://cdn.example.com/p.cjs' }), ['https://cdn.example.com/p.cjs'])
assert.deepEqual(store.collectBundleLinks({ url: 'https://x/p.js', assets: [{ url: 'https://x/p.js' }] }), ['https://x/p.js'])
assert.deepEqual(store.collectBundleLinks(null), [])

// ---- 6. bundle 内容识别 ----
assert.equal(store.looksLikeBundle('(()=>{"use strict";module.exports.default={}})'), true)
assert.equal(store.looksLikeBundle('exports.default = { async getInfo() { return { name: "x" } } }'), true)
assert.equal(store.looksLikeBundle('<!doctype html><html>404</html>'), false)
assert.equal(store.looksLikeBundle('{"message":"Not Found"}'), false)
assert.equal(store.looksLikeBundle(''), false)

// ---- 7. 订阅源持久化 (内存 localStorage 桩) ----
const mem = new Map()
globalThis.localStorage = {
  getItem: k => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
}
assert.equal(store.listSubscriptions().length, 1)
assert.equal(store.listSubscriptions()[0].url, store.OFFICIAL_INDEX_URL)
const added = store.addSubscription('My list', 'https://example.com/p.json')
assert.equal(store.listSubscriptions().length, 2)
assert.throws(() => store.addSubscription('bad', 'ftp://x'), /http/)
store.setSubscriptionEnabled(added.id, false)
assert.equal(store.listSubscriptions().find(s => s.id === added.id).enabled, false)
store.removeSubscription(added.id)
assert.equal(store.listSubscriptions().length, 1)
assert.equal(store.listSubscriptions()[0].builtin, true, '内置源不能被删')

// ---- 8. 安装状态 (storeUuid 兜底) ----
mem.set('lightread.comicPlugins.v1', JSON.stringify([
  { uuid: 'plugin-uuid', storeUuid: 'index-uuid', name: 'X', version: '0.9.0', storeVersion: '0.9.0', code: '', enabled: true, installedAt: 0, source: 'store' },
]))
assert.equal(store.storeState({ ...parsed[0], uuid: 'new-plugin' }), 'new')
assert.equal(store.storeState({ ...parsed[0], uuid: 'index-uuid', version: '0.9.0' }), 'installed')
assert.equal(store.storeState({ ...parsed[0], uuid: 'index-uuid', version: '1.0.0' }), 'update')
assert.equal(store.storeState({ ...parsed[0], uuid: 'plugin-uuid', version: '0.9.0' }), 'installed')

// ---- 9. 发现页: 四种 scheme 区块 ----
const page = discover.normalizeFunctionPage({
  source: 'p',
  scheme: {
    version: '1.0.0', type: 'page', title: '发现',
    body: { type: 'list', children: [
      { type: 'chip-list', key: 'hot' },
      { type: 'action-grid', key: 'nav' },
      { type: 'comic-section-list', key: 'sections' },
      { type: 'comic-grid', key: 'grid' },
    ] },
  },
  data: {
    hot: { items: [{ label: '热血', action: { type: 'openSearch', payload: { keyword: '热血' } } }] },
    nav: { items: [{ title: '排行榜', cover: { url: 'https://x/nav.png' }, action: { type: 'openComicList', payload: { scene: { title: '排行榜', body: { request: { fnPath: 'getRankingData' } } } } } }] },
    sections: { sections: [{ title: '编辑推荐', subtitle: '每日更新', items: [
      { id: 'c1', title: '漫画一', subtitle: '第 10 话', cover: { url: 'https://x/c1.jpg' } },
    ] }] },
    grid: { title: '更多', items: [{ id: 'c2', title: '漫画二', cover: { url: 'https://x/c2.jpg' } }] },
    hasReachedMax: true,
  },
})
assert.equal(page.title, '发现')
assert.equal(page.hasReachedMax, true)
assert.equal(page.blocks.length, 4)
assert.equal(page.blocks[0].chips[0].label, '热血')
assert.equal(page.blocks[0].chips[0].action.type, 'openSearch')
assert.equal(page.blocks[1].tiles[0].cover, 'https://x/nav.png')
assert.equal(page.blocks[2].sections[0].items[0].id, 'c1')
assert.equal(page.blocks[3].items[0].title, '漫画二')
assert.equal(page.blocks[3].title, '更多')

// 真实插件写法: key 叫 items, data.items 本身就是数组 (WEBTOON 首页)
const realShape = discover.normalizeFunctionPage({
  source: 'webtoon',
  scheme: { type: 'page', title: 'Recommended', body: { type: 'list', children: [{ type: 'action-grid', key: 'items' }] } },
  data: {
    items: [{ title: 'Osora', cover: { url: 'https://x/o.jpg' }, action: { type: 'openComicInfo', payload: { comicId: 'en|webtoon|6202|' } } }],
    hasReachedMax: true,
  },
})
assert.equal(realShape.blocks[0].tiles.length, 1)
assert.equal(realShape.blocks[0].tiles[0].title, 'Osora')
assert.equal(realShape.blocks[0].tiles[0].cover, 'https://x/o.jpg')

// 未知区块按网格兜底, 不白屏
const fallback = discover.normalizeFunctionPage({
  scheme: { body: { children: [{ type: 'future-block', key: 'k' }] } },
  data: { k: { items: [{ id: 'f1', title: 'Future' }] } },
})
assert.equal(fallback.blocks[0].items.length, 1)

// 禁漫把 updatedAt 直接给成 unix 秒字符串, 卡片副标题不能原样摆一串数字
const tsPage = discover.normalizeFunctionPage({
  scheme: { body: { children: [{ type: 'comic-grid', key: 'items' }] } },
  data: { items: [
    { id: 't1', title: '漫画丁', updatedAt: '1794534613' },
    { id: 't2', title: '漫画戊', subtitle: '第 3 话', updatedAt: '1794534613' },
    { id: 't3', title: '漫画己', updatedAt: '2026-11-12T02:33:48.000Z' },
  ] },
})
assert.match(tsPage.blocks[0].items[0].subtitle, /^\d{4}-\d{2}-\d{2}$/, 'unix 秒要转成日期')
assert.equal(tsPage.blocks[0].items[1].subtitle, '第 3 话', '有 subtitle 就别动')
assert.equal(tsPage.blocks[0].items[2].subtitle, '2026-11-12T02:33:48.000Z', 'ISO 字符串原样留给上层处理')

// 禁漫推荐页: data.sections 直接就是分区数组 (外面没有再包一层 { sections })
const jmShape = discover.normalizeFunctionPage({
  scheme: { type: 'page', title: '推荐', body: { children: [{ type: 'comic-section-list', key: 'sections' }] } },
  data: {
    sections: [
      { id: '26', title: '連載更新', action: { type: 'openComicList', payload: { scene: { title: '连载更新' } } },
        items: [{ id: 'a1', title: '漫画甲', cover: { url: 'https://x/a1.jpg' } }] },
      { id: '27', title: '排行榜', items: [{ id: 'b1', title: '漫画乙' }] },
    ],
  },
})
assert.equal(jmShape.blocks[0].sections.length, 2, '分区数组不能被当成一堆漫画卡片')
assert.equal(jmShape.blocks[0].sections[0].title, '連載更新')
assert.equal(jmShape.blocks[0].sections[0].items[0].title, '漫画甲')
assert.equal(jmShape.blocks[0].sections[0].items[0].cover, 'https://x/a1.jpg')
assert.equal(jmShape.blocks[0].sections[0].action.type, 'openComicList')
assert.equal(jmShape.blocks[0].sections[1].items.length, 1)
assert.equal(jmShape.blocks[0].items.length, 0, '兜底网格不能被误填')

// 有的插件省掉分区层, data 直接是漫画数组 → 当成一个匿名分区
const flatShape = discover.normalizeFunctionPage({
  scheme: { body: { children: [{ type: 'comic-section-list', key: 'list' }] } },
  data: { list: [{ id: 'x1', title: '漫画丙' }] },
})
assert.equal(flatShape.blocks[0].sections.length, 1)
assert.equal(flatShape.blocks[0].sections[0].items[0].title, '漫画丙')

// ---- 10. 首页 bundle / scene / action ----
const home = discover.normalizeHomeBundle({
  source: 'p',
  data: { tabs: [
    { id: 'recommend', title: '推荐', page: { scheme: { body: { children: [{ type: 'action-grid', key: 'items' }] } }, data: { items: [{ title: 'A', action: { type: 'openComicInfo', payload: { comicId: 'a1' } } }] } } },
    { id: 'ranking', title: '排行榜', scene: { title: '排行榜', body: { type: 'pluginPagedComicList', request: { fnPath: 'getRankingData', core: { rank: 'day' }, extern: { source: 'ranking' } } }, filter: { fnPath: 'getRankingFilterBundle' } } },
  ] },
})
assert.equal(home.tabs.length, 2)
assert.equal(home.tabs[0].kind, 'page')
assert.equal(home.tabs[0].page.blocks[0].tiles.length, 1)
assert.equal(home.tabs[1].kind, 'scene')
assert.equal(home.tabs[1].scene.body.request.fnPath, 'getRankingData')
assert.equal(home.tabs[1].scene.filter.fnPath, 'getRankingFilterBundle')
assert.equal(discover.normalizeScene({ title: 'bad', body: {} }), null)

const item = discover.normalizeItem({ id: 'x', title: 'X', action: { type: 'openComicInfo', payload: { comicId: 'real-id' } } })
assert.equal(discover.comicIdOf(item), 'real-id')
assert.equal(discover.comicIdOf({ id: 'plain', title: 'P', subtitle: '', cover: '' }), 'plain')

// ---- 11. 筛选参数合并 ----
const merged = discover.mergeFilterResult([
  { result: { core: { type: 'comic' }, extern: { rankType: 'day' } } },
  { result: { extern: { lang: 'zh' } } },
])
assert.deepEqual(merged, { core: { type: 'comic' }, extern: { rankType: 'day', lang: 'zh' } })
assert.deepEqual(discover.mergeFilterResult([{}]), { core: {}, extern: {} })

// ---- 12. 老插件 scene.list 写法 (禁漫「最新」/「排行榜」按钮) ----
const legacy = discover.normalizeScene({
  title: '最新', source: 'jm',
  list: { fnPath: 'getLatestData', core: {}, extern: { source: 'latest' } },
  filter: { fnPath: 'getRankingFilterBundle', core: {}, extern: { source: 'ranking' } },
})
assert.ok(legacy, 'scene.list 必须能解析, 否则按钮点击无反应')
assert.equal(legacy.body.request.fnPath, 'getLatestData')
assert.deepEqual(legacy.body.request.extern, { source: 'latest' })
assert.equal(legacy.body.type, 'pluginPagedComicList')
assert.equal(legacy.filter.fnPath, 'getRankingFilterBundle')

// ---- 13. 云端收藏 tab (getPluginCloudFavoritePagesBundle 的 scene) ----
const cloudHome = discover.normalizeHomeBundle({
  data: { tabs: [{
    id: 'cloudFavorite', title: '云端收藏',
    scene: {
      title: '云端收藏', source: 'jm',
      body: { type: 'pluginPagedComicList', request: { fnPath: 'getCloudFavoriteData', extern: { source: 'cloudFavorite', folderId: '' } } },
      filter: { fnPath: 'getCloudFavoriteFilterBundle' },
    },
  }] },
})
assert.equal(cloudHome.tabs.length, 1)
assert.equal(cloudHome.tabs[0].kind, 'scene')
assert.equal(cloudHome.tabs[0].scene.body.request.fnPath, 'getCloudFavoriteData')
assert.equal(cloudHome.tabs[0].scene.filter.fnPath, 'getCloudFavoriteFilterBundle')

// ---- 14. 二级筛选的 result 要能和父级一起合并 ----
const nested = discover.mergeFilterResult([
  { result: { extern: { type: 'doujin' } } },
  { result: { extern: { type: 'doujin_chinese' } } },
])
assert.deepEqual(nested, { core: {}, extern: { type: 'doujin_chinese' } }, '子选项应覆盖父选项的同名参数')

console.log('test-comic-store: OK (index / version / bundle候选大小写 / 清单与Release兜底 / links / cache / state / scheme / tabs / scene.list / cloudFavorite / filter)')
fs.rmSync(tmp, { recursive: true, force: true })
