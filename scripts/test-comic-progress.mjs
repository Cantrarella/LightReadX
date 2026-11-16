// 漫画进度换算 (书库 location/progress ↔ 页码) 的纯函数测试.
// 背景: 藏书页/漫画页的「最近阅读」卡片读的是书库元数据的 lastReadAt + progress,
// 漫画阅读器必须把页码同步进去, 否则卡片不出现、百分比恒为 0。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  comicLocationOf, comicPageFromLocation, comicPageFromProgress, comicProgressOf, comicResumeIndex,
} from '../src/services/comicProgress.ts'

test('comicProgressOf: 第 1 页非零、最后一页为 1', () => {
  assert.equal(comicProgressOf(0, 20), 0.05)
  assert.equal(comicProgressOf(9, 20), 0.5)
  assert.equal(comicProgressOf(19, 20), 1)
  // 只有一页: 打开即读完
  assert.equal(comicProgressOf(0, 1), 1)
})

test('comicProgressOf: 越界与非法输入被夹紧', () => {
  assert.equal(comicProgressOf(-5, 20), 0.05)
  assert.equal(comicProgressOf(999, 20), 1)
  assert.equal(comicProgressOf(0, 0), 0)
  assert.equal(comicProgressOf(3, -1), 0)
  assert.equal(comicProgressOf(Number.NaN, 20), 0)
  // 小数页码向下取整
  assert.equal(comicProgressOf(1.9, 10), 0.2)
})

test('comicPageFromProgress: 与 comicProgressOf 互为逆运算', () => {
  for (const total of [1, 2, 10, 20, 237]) {
    for (let i = 0; i < total; i++) {
      const p = comicProgressOf(i, total)
      assert.equal(comicPageFromProgress(p, total), i, `total=${total} index=${i}`)
    }
  }
  assert.equal(comicPageFromProgress(0, 20), 0)
  assert.equal(comicPageFromProgress(1, 20), 19)
  assert.equal(comicPageFromProgress(2, 20), 19, '超范围进度夹到最后一页')
  assert.equal(comicPageFromProgress(-1, 20), 0, '负进度夹到第一页')
  assert.equal(comicPageFromProgress(Number.NaN, 20), 0)
  assert.equal(comicPageFromProgress(0.5, 0), 0, 'total 未知时退回第 1 页')
})

test('comicLocationOf / comicPageFromLocation 往返', () => {
  assert.equal(comicLocationOf(0), 'page:1')
  assert.equal(comicLocationOf(19), 'page:20')
  assert.equal(comicLocationOf(-3), 'page:1')
  assert.equal(comicLocationOf(Number.NaN), 'page:1')

  assert.equal(comicPageFromLocation('page:1'), 0)
  assert.equal(comicPageFromLocation('page:20'), 19)
  assert.equal(comicPageFromLocation(' page:7 '), 6)
  assert.equal(comicPageFromLocation('page:0'), null, 'page:0 不是合法 1-based 页码')
  assert.equal(comicPageFromLocation('page:'), null)
  assert.equal(comicPageFromLocation('cfi(/6/2!/4)'), null, '小说 cfi 不是漫画页码')
  assert.equal(comicPageFromLocation(''), null)
  assert.equal(comicPageFromLocation(undefined), null)
  assert.equal(comicPageFromLocation(null), null)

  for (let i = 0; i < 30; i++) assert.equal(comicPageFromLocation(comicLocationOf(i)), i)
})

test('comicResumeIndex: location 优先, 退回 progress, 最后第 1 页', () => {
  assert.equal(comicResumeIndex('page:5', 0.9, 20), 4, 'location 与 progress 冲突时用 location')
  assert.equal(comicResumeIndex(null, 0.5, 20), 9)
  assert.equal(comicResumeIndex(undefined, undefined, 20), 0)
  assert.equal(comicResumeIndex('garbage', 0.25, 20), 4, 'location 无效时退回 progress')
  assert.equal(comicResumeIndex('page:999', undefined, 20), 19, '页码超出总页数夹到最后一页')
  assert.equal(comicResumeIndex('page:1', undefined, 0), 0, 'total 未知时第 1 页')
})

test('刚打开的本地漫画: 第 1 页也留下非零进度 (卡片进度条不空)', () => {
  const total = 32
  const p = comicProgressOf(0, total)
  assert.ok(p > 0 && p < 0.05, `第 1 页进度应在 (0, 5%) 之间, 实际 ${p}`)
  assert.equal(Math.round(p * 100), 3)
  // 断点续读能回到同一页
  assert.equal(comicResumeIndex(comicLocationOf(0), p, total), 0)
})
