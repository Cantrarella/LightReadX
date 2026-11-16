// 本地漫画 (CBZ) 的「最近阅读」卡片与阅读进度落库 —— 真实浏览器 e2e.
//
// 复现的问题: 打开一本本地 cbz 并看了几页, 藏书页/漫画页的「最近阅读」卡片不出现,
// 因为漫画阅读器只写 localStorage 的续读位置, 从没写过书库元数据的 lastReadAt / progress.
// 这里不 mock 书库: 造一本真 cbz 放进 IndexedDB, 打开阅读器翻页, 再回漫画页看卡片.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { zipSync } from 'fflate'
import { createServer } from 'vite'

/** 1x1 透明 GIF: 足够让 <img> 触发 loaded, 又不占体积 */
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const PAGES = 5

/** 打成真 cbz (zip), 在 node 侧完成: 浏览器里的裸模块 import 解析不了 fflate */
function makeCbz(pages) {
  const bytes = Uint8Array.from(Buffer.from(GIF, 'base64'))
  const entries = {}
  for (let i = 0; i < pages; i++) entries[`p${String(i + 1).padStart(2, '0')}.gif`] = bytes
  return Buffer.from(zipSync(entries)).toString('base64')
}

test('本地 cbz: 打开即出现在最近阅读, 翻页后进度与百分比同步', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'lightread-comic-local-'))
  t.after(() => rm(cacheDir, { recursive: true, force: true, maxRetries: 3 }))
  const server = await createServer({
    configLoader: 'runner',
    cacheDir,
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['dexie'] },
  })
  try {
    await server.listen(0)
    const base = 'http://127.0.0.1:' + server.httpServer.address().port
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, locale: 'zh-CN' })
      page.setDefaultTimeout(8000)
      const errors = []
      page.on('pageerror', err => errors.push(err.message))
      const waitForApp = () => page.waitForFunction(() => document.querySelector('#app')?.__vue_app__)

      await page.goto(base + '/#/library', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await waitForApp()

      // 造一本 5 页的本地 cbz, 直接进书库 (等价于拖拽导入后的状态)
      const bookId = await page.evaluate(async ({ zipBase64 }) => {
        const { getStorage } = await import('/src/storage/index.ts')
        const { useLibrary } = await import('/src/stores/library.ts')
        const zip = Uint8Array.from(atob(zipBase64), c => c.charCodeAt(0))
        const storage = await getStorage()
        const id = await storage.addBook(
          {
            title: '本地漫画进度测试',
            author: '测试',
            format: 'cbz',
            fileName: 'comic-progress-test.cbz',
            tags: [],
            addedAt: Date.now(),
          },
          new Blob([zip], { type: 'application/zip' }),
        )
        // 导入流程会 refresh 书库, 这里手动写盘后同样要同步内存, 否则漫画页扫不到这本
        await useLibrary().refresh()
        return id
      }, { zipBase64: makeCbz(PAGES) })

      /** 读书库元数据里与「最近阅读」相关的三个字段 */
      const meta = () => page.evaluate(async id => {
        const { getStorage } = await import('/src/storage/index.ts')
        const book = await (await getStorage()).getBook(id)
        return book ? {
          lastReadAt: book.lastReadAt ?? 0,
          progress: book.progress ?? null,
          location: book.location ?? null,
        } : null
      }, bookId)

      /** 落库是异步的 (saveProgress 先改内存再写盘), 轮询到条件成立为止 */
      const waitMeta = async (predicate, label) => {
        for (let i = 0; i < 50; i++) {
          const value = await meta()
          if (value && predicate(value)) return value
          await page.waitForTimeout(120)
        }
        throw new Error(`${label}: 书库元数据未更新, 当前值 ${JSON.stringify(await meta())}`)
      }

      const before = await meta()
      assert.equal(before.lastReadAt, 0, '新导入的漫画不该有最近阅读时间')
      assert.equal(before.progress ?? 0, 0, '新导入的漫画进度应为 0')

      // 打开阅读器 (单页模式, 用滑杆翻页)
      await page.evaluate(async () => {
        localStorage.removeItem('lightread.comic.reader.v1')
        localStorage.removeItem('lightread.comics.tab.v1')
        const { useSettings } = await import('/src/stores/settings.ts')
        useSettings().comicReader.pageMode = 'paged'
        useSettings().comicReader.spreadMode = 'single'
      })
      await page.evaluate(id => { location.hash = '#/read/comic-local/' + id }, bookId)
      await page.locator('.comic-reader img').first().waitFor({ state: 'attached' })

      await t.test('刚打开就写入最近阅读时间 (不用翻页)', async () => {
        const opened = await waitMeta(m => m.lastReadAt > 0, '打开即记 lastReadAt')
        assert.equal(opened.location, 'page:1', '停在第 1 页')
        assert.ok(Math.abs(opened.progress - 1 / PAGES) < 1e-9, `第 1 页进度应为 1/${PAGES}, 实际 ${opened.progress}`)
      })

      await t.test('翻到第 3 页后进度与 location 跟着走', async () => {
        await page.locator('.progress-slider').evaluate(el => {
          el.value = '2'
          el.dispatchEvent(new Event('input', { bubbles: true }))
        })
        const moved = await waitMeta(m => m.location === 'page:3', '翻页后写 page:3')
        assert.ok(Math.abs(moved.progress - 3 / PAGES) < 1e-9, `第 3 页进度应为 3/${PAGES}, 实际 ${moved.progress}`)
      })

      await t.test('离开阅读器时补存最后的位置', async () => {
        await page.locator('.progress-slider').evaluate(el => {
          el.value = '4'
          el.dispatchEvent(new Event('input', { bubbles: true }))
        })
        // 不等待防抖, 立刻离开: 靠卸载时的强制补存
        await page.evaluate(() => { location.hash = '#/comics' })
        const left = await waitMeta(m => m.location === 'page:5', '离开时补存 page:5')
        assert.equal(left.progress, 1, '最后一页进度为 1')
      })

      await t.test('漫画页的最近阅读卡片出现并显示真实百分比', async () => {
        await page.locator('.comic-reader').waitFor({ state: 'detached' })
        await page.locator('.resume').waitFor({ state: 'visible' })
        const title = await page.locator('.resume .resume-title').innerText()
        assert.match(title, /本地漫画进度测试/, '卡片指向刚读的那本')
        const pct = await page.locator('.resume .resume-pct').innerText()
        assert.equal(pct.trim(), '100%', '最后一条断言: 进度条百分比与实际进度一致')
      })

      await t.test('再次打开从上次的位置续读', async () => {
        await page.evaluate(id => { location.hash = '#/read/comic-local/' + id }, bookId)
        await page.locator('.comic-reader img').first().waitFor({ state: 'attached' })
        const text = await page.locator('.comic-reader .counter').innerText()
        assert.match(text, /^5\s*\/\s*5$/, `应从第 5 页续读, 实际页码 ${text}`)
      })

      assert.deepEqual(errors, [], '页面不应有未捕获异常')
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
})

test('本地 cbz: 阅读时长计入今日统计', async t => {
  // 单独一条: 需要接管浏览器时钟快进 90 秒, 和上面的翻页断言放一起会互相干扰.
  // 时钟必须在阅读器挂载前接管, 否则 15s 心跳的 interval 已按真实时间注册, 快进推不动它.
  const cacheDir = await mkdtemp(join(tmpdir(), 'lightread-comic-time-'))
  t.after(() => rm(cacheDir, { recursive: true, force: true, maxRetries: 3 }))
  const server = await createServer({
    configLoader: 'runner',
    cacheDir,
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['dexie'] },
  })
  try {
    await server.listen(0)
    const base = 'http://127.0.0.1:' + server.httpServer.address().port
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, locale: 'zh-CN' })
      page.setDefaultTimeout(15000)
      const errors = []
      page.on('pageerror', err => errors.push(err.message))
      await page.goto(base + '/#/library', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__)

      const bookId = await page.evaluate(async ({ zipBase64 }) => {
        const { getStorage } = await import('/src/storage/index.ts')
        const { useLibrary } = await import('/src/stores/library.ts')
        const zip = Uint8Array.from(atob(zipBase64), c => c.charCodeAt(0))
        const id = await (await getStorage()).addBook(
          { title: '时长测试', author: '测试', format: 'cbz', fileName: 'time.cbz', tags: [], addedAt: Date.now() },
          new Blob([zip], { type: 'application/zip' }),
        )
        await useLibrary().refresh()
        return id
      }, { zipBase64: makeCbz(PAGES) })

      await page.clock.install()
      await page.evaluate(id => { location.hash = '#/read/comic-local/' + id }, bookId)
      await page.locator('.comic-reader img').first().waitFor({ state: 'attached' })

      // 15s 心跳, 满 60s 落库: 快进 90s 应至少落一分钟
      for (let i = 0; i < 6; i++) {
        await page.clock.fastForward(15_000)
        await page.mouse.move(500 + i, 400) // 每跳一次保持活动, 避免被判 5 分钟无操作
      }
      await page.waitForTimeout(1200)

      const seconds = await page.evaluate(async id => {
        const { getStorage } = await import('/src/storage/index.ts')
        const book = await (await getStorage()).getBook(id)
        return book?.readingSeconds ?? 0
      }, bookId)
      assert.ok(seconds >= 60, `90 秒阅读应至少落 60 秒, 实际 ${seconds}`)

      const today = await page.evaluate(async () => {
        const { loadDaily, localDay } = await import('/src/services/readingLog.ts')
        const daily = await loadDaily()
        return daily[localDay()]?.seconds ?? 0
      })
      assert.ok(today >= 60, `今日阅读记录应同步累加, 实际 ${today} 秒`)

      // 进度与时长同时存在: 卡片才既有百分比又有今日/本周
      const meta = await page.evaluate(async id => {
        const { getStorage } = await import('/src/storage/index.ts')
        const book = await (await getStorage()).getBook(id)
        return { lastReadAt: book?.lastReadAt ?? 0, location: book?.location ?? null }
      }, bookId)
      assert.ok(meta.lastReadAt > 0, '同时应记下最近阅读时间')
      assert.equal(meta.location, 'page:1')

      assert.deepEqual(errors, [], '页面不应有未捕获异常')
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
})
