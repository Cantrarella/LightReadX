import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { unzipSync } from 'fflate'

const fixtures = {
  '../importer': 'export const importFile = (...args) => globalThis.downloadFixture.importFile(...args)',
  './index': 'export const openPlugin = () => globalThis.downloadFixture.host; export const downloadConcurrency = () => 1',
  './downloadCache': 'export const cacheGetPage = async () => null; export const cachePutPage = async () => {}',
}
const { outputFiles } = await build({
  entryPoints: ['src/services/comicPlugin/download.ts'],
  bundle: true, write: false, format: 'esm', platform: 'node',
  define: { 'import.meta.url': JSON.stringify(import.meta.url) },
  plugins: [{
    name: 'download-fixture',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args =>
        Object.hasOwn(fixtures, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args =>
        ({ contents: fixtures[args.path], loader: 'js' }))
    },
  }],
})
const downloads = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'))

function fixture(title) {
  const imports = []
  globalThis.downloadFixture = {
    host: {
      call: async () => ({ data: { comic: { title }, pages: [{ id: '0', url: 'https://example.test/0.jpg' }] } }),
      callBytes: async () => new Uint8Array([1, 2, 3]),
      dispose() {},
    },
    importFile: async file => {
      imports.push(file)
      return { ok: file.name.endsWith('.cbz'), bookId: 'stored' }
    },
  }
  return imports
}

test('long titles still import as CBZ archives', async () => {
  const imports = fixture('长'.repeat(120))
  const result = await downloads.downloadChapterAsCbz('source', 'comic', { id: '1', name: 'One' })
  assert.equal(result.ok, true)
  assert.ok(result.fileName.length <= 120)
  assert.ok(result.fileName.endsWith('.cbz'))
  const files = unzipSync(new Uint8Array(await imports[0].arrayBuffer()))
  assert.deepEqual(Object.values(files), [new Uint8Array([1, 2, 3])])
  assert.equal(downloads.safeFileName('a'.repeat(115) + '📚.cbz').includes('\uD83D.cbz'), false)
})

class ControlledZipWorker extends EventTarget {
  postMessage({ id, entries }) {
    globalThis.finishPacking = () => this.dispatchEvent(new MessageEvent('message', {
      data: { id, zipped: entries[0].bytes },
    }))
  }
}

for (const [state, stop] of [['cancelled', downloads.cancelDownload], ['paused', downloads.pauseDownload]]) {
  test(state + ' while packing never imports the chapter', async () => {
    const imports = fixture('Title')
    globalThis.Worker = ControlledZipWorker
    const running = downloads.downloadChapterAsCbz('source', 'comic', { id: '1', name: 'One' }, {
      taskGroupKey: 'packing', concurrency: 1,
    })
    try {
      for (let i = 0; i < 100 && !globalThis.finishPacking; i++) await new Promise(resolve => setImmediate(resolve))
      assert.equal(typeof globalThis.finishPacking, 'function')
      stop('packing')
      globalThis.finishPacking()
      assert.deepEqual(await running, { ok: false, fileName: '', error: state })
      assert.deepEqual(imports, [])
    } finally {
      delete globalThis.Worker
      delete globalThis.finishPacking
    }
  })
}
