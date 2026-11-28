import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const stubs = {
  '../../storage': 'export const getStorage = () => globalThis.comicFixture.storage',
  '../../stores/settings': 'export const useSettings = () => ({})',
  '../../stores/library': 'export const useLibrary = () => ({ refresh: async () => {} })',
  './notify': 'export const notifyDownloadDone = async () => {}',
  './downloadCache': 'export const cacheDropTask = async () => {}',
  './download': `
    export const cancelDownload = () => {}
    export const pauseDownload = () => {}
    export const clearPauseFlag = () => {}
    export const safeFileName = name => name
    export const downloadChapterAsCbz = (...args) => globalThis.comicFixture.download(...args)
  `,
}

const { outputFiles } = await build({
  entryPoints: ['src/services/comicPlugin/downloadCenter.ts'],
  bundle: true, write: false, format: 'esm', platform: 'node',
  minifyWhitespace: true,
  plugins: [{
    name: 'download-center-fixture',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args =>
        Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args =>
        ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
let instance = 0

async function setup(books = [], saved = []) {
  const deleted = []
  const downloads = []
  globalThis.localStorage = { getItem: () => JSON.stringify(saved), setItem() {}, removeItem() {} }
  globalThis.window = { clearTimeout() {}, setTimeout() {} }
  globalThis.comicFixture = {
    storage: { listBooks: async () => books, getBook: async id => books.find(b => b.id === id), deleteBook: async id => deleted.push(id) },
    download: async (...args) => {
      downloads.push(args)
      return { ok: true, bookId: 'fresh' }
    },
  }
  return { deleted, downloads, center: await import(moduleUrl + '#' + ++instance) }
}

const chapter = { uuid: 'source-b', comicId: 'comic', chapter: { id: '1', name: 'one' }, comicTitle: 'Shared' }
const fileName = 'Shared - one.cbz'
const downloadedBook = (id, description) => ({ id, description, source: '漫画源下载', fileName })

test('deduplication scopes legacy filenames to the same source and comic', async () => {
  const foreign = downloadedBook('foreign', 'source-a · comic · 1')
  const otherChapter = downloadedBook('other-chapter', 'source-b · comic · 2')
  const legacy = downloadedBook('legacy', 'source-b · comic')
  const books = [foreign, otherChapter]
  const { center } = await setup(books)
  assert.equal(await center.findDownloadedBook('source-b', 'comic', '1', fileName), undefined)
  books.push(legacy)
  assert.equal((await center.findDownloadedBook('source-b', 'comic', '1', fileName)).id, 'legacy')
  books.push(downloadedBook('exact', 'source-b · comic · 1'))
  assert.equal((await center.findDownloadedBook('source-b', 'comic', '1', fileName)).id, 'exact')
})

test('cleanup refuses an already mislinked download but deletes the matching chapter', async () => {
  const { center, deleted } = await setup([
    downloadedBook('foreign', 'source-a · comic · 1'),
    downloadedBook('exact', 'source-b · comic · 2'),
  ])
  center.downloadState.tasks = [
    { uuid: 'source-b', comicId: 'comic', chapterId: '1', comicTitle: 'Shared', chapterName: 'one', status: 'done', bookId: 'foreign' },
    { uuid: 'source-b', comicId: 'comic', chapterId: '2', comicTitle: 'Other title', chapterName: 'two', status: 'done', bookId: 'exact' },
  ]
  const [wrongTask, rightTask] = center.downloadState.tasks
  assert.equal(center.matchesDownloadedBook(wrongTask, downloadedBook('foreign', 'source-a · comic · 1')), false)
  assert.equal(center.matchesDownloadedBook(rightTask, downloadedBook('exact', 'source-b · comic · 2')), true)
  await center.clearFinished('done', true)
  assert.deepEqual(deleted, ['exact'])
})

test('overlapping requests share one task while the library lookup is pending', async () => {
  const { center } = await setup([downloadedBook('exact', 'source-b · comic · 1')])
  const results = await Promise.all([center.enqueue(chapter), center.enqueue(chapter)])
  assert.equal(results[0].task.id, results[1].task.id)
  assert.equal(center.downloadState.tasks.length, 1)
})

test('overlapping new downloads only start one worker', async () => {
  const { center, downloads } = await setup()
  await Promise.all([center.enqueue(chapter), center.enqueue(chapter)])
  assert.equal(center.downloadState.tasks.length, 1)
  assert.equal(downloads.length, 1)
})

test('loading old duplicate task IDs keeps one record', async () => {
  const task = { id: 'same', status: 'queued' }
  const { center } = await setup([], [task, { ...task }])
  center.initDownloads()
  assert.deepEqual(center.downloadState.tasks.map(t => t.status), ['interrupted'])
})

test('persist caps finished history at 200 while preserving all unfinished tasks across restart', async () => {
  let persistedRaw = '[]'
  const mixed = [
    ...Array.from({ length: 205 }, (_, i) => ({
      id: `done-${i}`,
      uuid: 'source-b',
      comicId: 'comic',
      chapterId: `d-${i}`,
      comicTitle: 'Done',
      chapterName: `D${i}`,
      status: i % 3 === 0 ? 'failed' : i % 3 === 1 ? 'cancelled' : 'done',
      done: 1,
      total: 1,
    })),
    { id: 'u-queued', uuid: 'source-b', comicId: 'comic', chapterId: 'q1', comicTitle: 'Q', chapterName: 'Q1', status: 'queued', done: 0, total: 5 },
    { id: 'u-running', uuid: 'source-b', comicId: 'comic', chapterId: 'r1', comicTitle: 'R', chapterName: 'R1', status: 'running', done: 2, total: 5 },
    { id: 'u-paused', uuid: 'source-b', comicId: 'comic', chapterId: 'p1', comicTitle: 'P', chapterName: 'P1', status: 'paused', done: 3, total: 5 },
    { id: 'u-interrupted', uuid: 'source-b', comicId: 'comic', chapterId: 'i1', comicTitle: 'I', chapterName: 'I1', status: 'interrupted', done: 1, total: 5 },
  ]

  const { center } = await setup([], mixed)
  globalThis.localStorage = {
    getItem: () => persistedRaw,
    setItem: (_k, v) => { persistedRaw = String(v) },
    removeItem() {},
  }
  globalThis.window = {
    clearTimeout() {},
    setTimeout(fn) { fn(); return 1 },
  }

  center.downloadState.tasks = mixed
  // 触发 persist(): 暂停 queued 任务会调用 persist()
  center.pause('u-queued')

  const saved = JSON.parse(persistedRaw)
  const savedFinished = saved.filter(t => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled')
  const savedUnfinished = saved.filter(t => ['queued', 'running', 'paused', 'interrupted'].includes(t.status))
  assert.equal(savedFinished.length, 200)
  assert.equal(savedUnfinished.length, 4)

  // 模拟重启恢复
  const { center: restarted } = await setup([], saved)
  restarted.initDownloads()
  const byId = new Map(restarted.downloadState.tasks.map(t => [t.id, t]))
  assert.equal(restarted.downloadState.tasks.length, 204)
  for (const id of ['u-queued', 'u-running', 'u-paused', 'u-interrupted']) {
    assert.equal(byId.get(id)?.status, 'interrupted')
  }

  // 验证重启后可继续操作
  restarted.retry('u-paused')
  assert.ok(['done', 'running', 'queued'].includes(byId.get('u-paused')?.status))
})
