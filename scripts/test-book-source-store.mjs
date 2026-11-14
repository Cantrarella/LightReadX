import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPinia } from 'pinia'
import { useBookSourceStore, parseBookSourceJson } from '../src/stores/bookSource.ts'

// localStorage 桩（Node 环境）
const mem = new Map()
globalThis.localStorage = {
  getItem: k => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
}

const makeSource = (url, name) => ({
  bookSourceUrl: url,
  bookSourceName: name,
  searchUrl: `https://x.com/search?q={{key}}`,
  ruleSearch: {
    bookList: 'class.grid@tag.tr',
    name: 'class.odd.0@tag.a.0@text',
    author: 'class.odd.1@text',
    bookUrl: 'class.odd.0@tag.a.0@href',
  },
})

test('导入单个书源', () => {
  const store = useBookSourceStore(createPinia())
  const n = store.importSources(makeSource('https://a.com', '源A'))
  assert.equal(n, 1)
  assert.equal(store.count, 1)
  assert.equal(store.records[0].source.bookSourceName, '源A')
})

test('导入数组（批量）', () => {
  const store = useBookSourceStore(createPinia())
  const n = store.importSources([
    makeSource('https://a.com', '源A'),
    makeSource('https://b.com', '源B'),
    makeSource('https://c.com', '源C'),
  ])
  assert.equal(n, 3)
  assert.equal(store.count, 3)
})

test('重复导入去重（同 url + 同名）', () => {
  const store = useBookSourceStore(createPinia())
  store.importSources(makeSource('https://a.com', '源A'))
  const n = store.importSources(makeSource('https://a.com', '源A'))
  assert.equal(n, 0)
  assert.equal(store.count, 1)
})

test('同 url 不同名可共存', () => {
  const store = useBookSourceStore(createPinia())
  store.importSources(makeSource('https://a.com', '源A'))
  const n = store.importSources(makeSource('https://a.com', '源A改版'))
  assert.equal(n, 1)
  assert.equal(store.count, 2)
})

test('解析订阅包格式（{data: [...]}）', () => {
  const parsed = parseBookSourceJson(JSON.stringify({
    data: [makeSource('https://a.com', '源A')],
  }))
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed.length, 1)
})

test('解析直接数组', () => {
  const parsed = parseBookSourceJson(JSON.stringify([
    makeSource('https://a.com', '源A'),
  ]))
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed.length, 1)
})

test('非法 JSON 抛错', () => {
  assert.throws(() => parseBookSourceJson('not json'))
})

test('持久化：重载后数据保留', () => {
  const pinia = createPinia()
  const store = useBookSourceStore(pinia)
  store.importSources(makeSource('https://a.com', '源A'))
  // 模拟重新加载：新实例从 localStorage 读
  const store2 = useBookSourceStore(createPinia())
  store2.loaded = false
  store2.load()
  assert.equal(store2.count, 1)
  assert.equal(store2.records[0].source.bookSourceName, '源A')
})
