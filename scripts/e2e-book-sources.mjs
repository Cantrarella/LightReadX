/**
 * Legado 书源页 E2E：导入书源、搜索、换源、打开正文（使用 Playwright route mock，不依赖外站）。
 * 入口：npm run e2e:book-sources
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const port = Number(process.env.BOOK_SOURCES_E2E_PORT || 4205)
const base = process.env.E2E_BASE ?? `http://127.0.0.1:${port}`
const ownServer = !process.env.E2E_BASE

const server = ownServer
  ? spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
        detached: process.platform !== 'win32',
      },
    )
  : null

async function waitForServer() {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const response = await fetch(base)
      if (response.ok) return
    } catch { /* Vite 尚未监听 */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Vite 启动超时')
}

const mockSources = [
  {
    bookSourceUrl: 'https://source-a.test',
    bookSourceName: '测试源A',
    searchUrl: 'https://source-a.test/search?q={{key}}',
    ruleSearch: {
      bookList: 'class.result-list@tag.li',
      name: 'class.title@text',
      author: 'class.author@text',
      lastChapter: 'class.last@text',
      bookUrl: 'class.title@href',
    },
    ruleToc: {
      chapterList: 'class.toc@tag.li',
      chapterName: 'tag.a@text',
      chapterUrl: 'tag.a@href',
    },
    ruleContent: {
      content: 'id.content@textNodes',
    },
  },
  {
    bookSourceUrl: 'https://source-b.test',
    bookSourceName: '测试源B',
    searchUrl: 'https://source-b.test/search?q={{key}}',
    ruleSearch: {
      bookList: 'class.result-list@tag.li',
      name: 'class.title@text',
      author: 'class.author@text',
      lastChapter: 'class.last@text',
      bookUrl: 'class.title@href',
    },
    ruleToc: {
      chapterList: 'class.toc@tag.li',
      chapterName: 'tag.a@text',
      chapterUrl: 'tag.a@href',
    },
    ruleContent: {
      content: 'id.content@textNodes',
    },
  },
]

let browser
try {
  if (ownServer) await waitForServer()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))

  await page.route('**/*', async route => {
    const requestUrl = route.request().url()
    if (requestUrl.startsWith(base + '/') || requestUrl === base) return route.continue()

    if (requestUrl.startsWith('https://source-a.test/search')) {
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<ul class="result-list"><li><a class="title" href="/book/1">测试长生</a><span class="author">甲作者</span><span class="last">第100章</span></li></ul>',
      })
    }
    if (requestUrl.startsWith('https://source-b.test/search')) {
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<ul class="result-list"><li><a class="title" href="/book/1">测试长生</a><span class="author">甲作者</span><span class="last">第102章</span></li></ul>',
      })
    }
    if (requestUrl === 'https://source-a.test/book/1') {
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<ul class="toc"><li><a href="/book/1/1.html">源A-第一章</a></li><li><a href="/book/1/2.html">源A-第二章</a></li></ul>',
      })
    }
    if (requestUrl === 'https://source-b.test/book/1') {
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<ul class="toc"><li><a href="/book/1/1.html">源B-第一章</a></li><li><a href="/book/1/2.html">源B-第二章</a></li><li><a href="/book/1/3.html">源B-第三章</a></li></ul>',
      })
    }
    if (requestUrl === 'https://source-b.test/book/1/1.html') {
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<div id="content">源B正文第一段。<br><br>源B正文第二段。</div>',
      })
    }
    return route.abort()
  })

  await page.goto(`${base}/#/catalogs`, { waitUntil: 'networkidle' })

  // 1. 导入书源（粘贴 JSON）
  const pasteBox = page.locator('.import-textarea').first()
  await pasteBox.waitFor()
  await pasteBox.fill(JSON.stringify(mockSources))
  await page.locator('.import-actions button').first().click()
  await page.locator('.search-input').waitFor()

  // 2. 搜索并聚合同名同作者结果
  await page.locator('.search-input').fill('测试长生')
  await page.locator('.search-row button.btn-primary').click()
  const bookItem = page.locator('.book-item').first()
  await bookItem.waitFor()
  assert.ok((await bookItem.innerText()).includes('测试长生'))
  assert.ok((await bookItem.locator('.src-badge').innerText()).includes('2'))

  // 3. 进入详情页并验证初始书源目录，随后换源
  await bookItem.click()
  await page.locator('.chapter-item').first().waitFor()
  const firstTocText = await page.locator('.chapter-list').innerText()
  assert.ok(firstTocText.includes('源A-第一章'), `expected 源A-第一章, got ${firstTocText}`)

  await page.locator('.source-chips .chip', { hasText: '测试源B' }).click()
  await page.locator('.chapter-item', { hasText: '源B-第三章' }).waitFor()
  const switchedTocText = await page.locator('.chapter-list').innerText()
  assert.ok(switchedTocText.includes('源B-第一章'))

  // 4. 打开正文并验证内容渲染
  await page.locator('.chapter-item', { hasText: '源B-第一章' }).click()
  await page.locator('.reader-content').waitFor()
  const readerText = await page.locator('.reader-content').innerText()
  assert.ok(readerText.includes('源B正文第一段。'), `expected chapter text, got ${readerText}`)

  assert.deepEqual(errors, [])
  console.log('e2e-book-sources: all Legado book-source UI assertions passed')
} finally {
  await browser?.close()
  if (server?.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try { process.kill(-server.pid) } catch { server.kill() }
    }
  }
}
