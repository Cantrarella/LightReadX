import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const plugin = `
module.exports.default = {
  getInfo: () => ({ name: 'Reader fixture', uuid: 'reader-fixture' }),
  getComicDetail: () => ({
    comicInfo: { id: 'comic', title: 'Fixture' },
    eps: [{ id: 'many', name: 'Many' }, { id: 'odd', name: 'Odd' }, { id: 'last', name: 'Last' }],
  }),
  getChapter: ({chapterId}) => ({
    pages: Array.from({ length: chapterId === 'many' ? 30 : 3 }, (_, i) => ({
      id: String(i), url: 'https://reader-fixture.invalid/' + chapterId + '/' + i + '.gif',
    })),
  }),
  fetchImageBytes: async ({url}) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
}
`

test('online comic mode switches, page eviction and spread navigation', async t => {
  process.env.TAURI_ENV_PLATFORM = 'windows'
  const cacheDir = await mkdtemp(join(tmpdir(), 'lightread-comic-reader-'))
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
      const page = await browser.newPage({ viewport: { width: 900, height: 750 }, locale: 'en-US' })
      page.setDefaultTimeout(3500)
      const errors = []
      page.on('pageerror', err => errors.push(err.message))
      const waitForApp = () => page.waitForFunction(() => document.querySelector('#app')?.__vue_app__)
      await page.route('https://reader-fixture.invalid/**', route => route.fulfill({
        headers: { 'access-control-allow-origin': '*', 'content-type': 'image/gif' },
        body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
      }))
      await page.goto(base + '/#/library', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await waitForApp()
      await page.evaluate(async source => {
        const comics = await import('/src/services/comicPlugin/index.ts')
        await comics.installFromCode(source, 'file')
      }, plugin)

      const open = async (chapter, mode = 'paged', spread = 'single') => {
        await page.goto(base + '/#/library', { waitUntil: 'domcontentloaded', timeout: 30000 })
        await waitForApp()
        await page.evaluate(async ({ mode, spread }) => {
          localStorage.removeItem('lightread.comic.reader.v1')
          const { useSettings } = await import('/src/stores/settings.ts')
          useSettings().comicReader.pageMode = mode
          useSettings().comicReader.spreadMode = spread
        }, { mode, spread })
        await page.evaluate(chapter => { location.hash = '#/read/comic/reader-fixture/comic/' + chapter }, chapter)
        await page.locator('.comic-reader img[alt="1"]').first().waitFor({ state: 'attached' })
      }

      await t.test('the reading menu starts observing and loading later pages', async () => {
        await open('many')
        await page.locator('.bar.top .icon-btn').filter({ has: page.locator('path[d^="M12 2a10"]') }).click()
        await page.locator('.reader-mode .rm-segmented').nth(1).locator('button').nth(1).click()
        const target = page.locator('.long-page[data-page-index="20"]')
        await target.evaluate(el => el.scrollIntoView({ block: 'start' }))
        await target.locator('img').waitFor({ state: 'attached' })
      })

      await t.test('a previously evicted page reloads on scrolling back', async () => {
        await open('many', 'scroll')
        const row = i => page.locator('.long-page[data-page-index="' + i + '"]')
        for (const i of [3, 6, 9, 12, 15, 18, 21, 24]) {
          await row(i).evaluate(el => el.scrollIntoView({ block: 'start' }))
          await row(i).locator('img').waitFor({ state: 'attached' })
        }
        await row(0).locator('img').waitFor({ state: 'detached' })
        await row(0).evaluate(el => el.scrollIntoView({ block: 'start' }))
        await row(0).locator('img').waitFor({ state: 'attached' })
      })

      await t.test('from the second page of a spread the last page is reachable', async () => {
        await open('odd', 'paged', 'facing')
        await page.locator('.progress-slider').evaluate(el => {
          el.value = '1'
          el.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await page.keyboard.press('ArrowRight')
        await page.locator('.stage img[alt="3"]').waitFor({ state: 'attached' })
        assert.match(page.url(), /\/odd$/)
        await page.keyboard.press('ArrowLeft')
        await page.locator('.stage img[alt="1"]').waitFor({ state: 'attached' })
      })
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
})
