/**
 * 漫画详情协议回归测试 (不联网): 按真实禁漫插件 getComicDetail 的返回形状,
 * 验证 Breeze 显示元素 —— titleMeta / metadata 分组 chips / 相关推荐 / 统计数字
 * —— 都能被解析出来, 且老插件的根节点写法与空数据不会炸。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightread-comic-detail-'))
const outfile = path.join(tmp, 'normalize.mjs')

const searchChip = (name, keyword) => ({
  name, onTap: keyword ? { type: 'openSearch', payload: { keyword } } : { type: 'openSearch', payload: {} },
})

try {
  await build({
    entryPoints: [path.join(root, 'src/services/comicPlugin/normalize.ts')],
    outfile, bundle: true, format: 'esm', platform: 'node',
    target: 'node22', logLevel: 'silent',
  })
  const n = await import(pathToFileURL(outfile).href)

  // ---- 1. Breeze 标准 data.normal ----
  const result = n.normalizeDetail({
    source: 'jm',
    data: {
      normal: {
        comicInfo: {
          id: '123', title: '测试漫画', description: '一段简介',
          cover: { id: '123', url: 'https://img.test/123.jpg', path: '123.jpg' },
          creator: { name: '' },
          titleMeta: [
            searchChip('浏览：1234'), searchChip('更新时间：2026-01-01'),
            searchChip('章节数：12'), searchChip('总页数：340'), searchChip('禁漫车：jm123'),
          ],
          metadata: [
            { type: 'author', name: '作者', value: [searchChip('作者A', '作者A'), searchChip('作者B', '作者B')] },
            { type: 'tags', name: '标签', value: [searchChip('同人', '同人')] },
            { type: 'works', name: '作品', value: [] },
          ],
        },
        eps: [{ id: 'c2', requestId: 'c2', name: '第2话', order: 2 }, { id: 'c1', requestId: 'c1', name: '第1话', order: 1 }],
        recommend: [{ id: 'r1', title: '相关推荐', cover: { url: 'https://img.test/r1.jpg' } }],
        totalViews: 1234, totalLikes: 56, totalComments: 7,
        allowDownload: true,
      },
    },
  })
  assert.equal(result.info.title, '测试漫画')
  assert.equal(n.coverUrl(result.info.cover), 'https://img.test/123.jpg')
  assert.equal(result.chapters.length, 2)
  assert.equal(n.chapterRequestId(result.chapters[0]), 'c2', '章节 id 优先用 requestId')
  assert.equal(result.allowDownload, true)
  assert.equal(result.titleMeta.length, 5)
  assert.equal(result.titleMeta[0].label, '浏览：1234')
  assert.equal(result.titleMeta[0].keyword, undefined, '纯展示元信息不该带搜索词')
  assert.equal(result.metadata.length, 2, '空分组要过滤掉')
  assert.equal(result.metadata[0].key, 'author')
  assert.equal(result.metadata[0].name, '作者')
  assert.deepEqual(result.metadata[0].chips, [
    { label: '作者A', keyword: '作者A' }, { label: '作者B', keyword: '作者B' },
  ], 'chip 要带 openSearch 的 keyword')
  assert.equal(result.recommend.length, 1)
  assert.equal(result.totalViews, 1234)
  assert.equal(result.totalLikes, 56)
  assert.equal(result.totalComments, 7)

  // ---- 2. 老插件根节点写法 / 缺字段不炸 ----
  const legacy = n.normalizeDetail({
    comicInfo: { id: 'x', title: 'Legacy' },
    eps: [{ id: 'e1', name: '第1话' }],
    recommend: [],
  })
  assert.equal(legacy.info.title, 'Legacy', '根节点 comicInfo 也要兼容')
  assert.equal(legacy.chapters.length, 1)
  assert.deepEqual(legacy.titleMeta, [])
  assert.deepEqual(legacy.metadata, [])
  assert.equal(legacy.totalLikes, 0)
  assert.equal(legacy.allowDownload, true, '没声明 allowDownload 时默认允许')

  // ---- 3. 字符串型 titleMeta / value, 以及空数据 ----
  const loose = n.normalizeDetail({
    data: { normal: {
      comicInfo: { id: 'y', title: 'Loose', titleMeta: ['浏览：9', ''], metadata: [
        { name: '标签', value: ['纯字符串'] },
      ] },
      totalLikes: '42', totalComments: 'n/a',
    } },
  })
  assert.deepEqual(loose.titleMeta, [{ label: '浏览：9' }], '空字符串元信息要过滤')
  assert.equal(loose.metadata[0].key, 'group-0', '缺 type 的分组自动编号')
  assert.deepEqual(loose.metadata[0].chips, [{ label: '纯字符串' }])
  assert.equal(loose.totalLikes, 42, '字符串数字要能转成数字')
  assert.equal(loose.totalComments, 0, '脏数据回落 0')

  const empty = n.normalizeDetail(null)
  assert.equal(empty.info, undefined)
  assert.deepEqual(empty.chapters, [])
  assert.deepEqual(empty.recommend, [])
  assert.deepEqual(empty.titleMeta, [])

  // ---- 4. CBZ 打包页名补零 ----
  assert.equal(n.pageFileName({ id: '1', url: 'https://x/1.JPEG' }, 0, 120), '001.jpg')
  assert.equal(n.pageFileName({ id: '2', url: 'https://x/2.webp?token=a' }, 11, 120), '012.webp')

  // ---- 5. ISO 时间戳人话化: 真插件 titleMeta 给的是 2026-11-12T02:33:48.000Z ----
  const d = new Date('2026-11-12T02:33:48.000Z')
  const pad = n => String(n).padStart(2, '0')
  const want = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  assert.equal(
    n.detailChip({ name: '更新时间：2026-11-12T02:33:48.000Z' }).label,
    `更新时间：${want}`,
  )
  assert.equal(n.detailChip({ name: '瀏覽：158715' }).label, '瀏覽：158715', '非时间文案原样保留')
  assert.equal(n.humanizeIsoText('not-a-date 2026-13-99T00:00:00Z'), 'not-a-date 2026-13-99T00:00:00Z')

  console.log('test-comic-detail: OK (titleMeta / metadata chips / recommend / stats / 老插件写法 / 脏数据 / 页名 / 时间人话化)')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
