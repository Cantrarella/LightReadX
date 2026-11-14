import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(process.argv[2])
const installer4 = resolve(process.argv[3])
const installer5 = resolve(process.argv[4])
const installDir = join(root, 'installed')
const port = 19157
const uuid = 'upgrade-fixture'
const username = 'Upgrade Fixture Account'
const bookTitle = 'Upgrade Fixture Book'
const comicTitle = 'Upgrade Fixture Comic'
const env = { ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
}
const image = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const fixture = `module.exports.default = {
  getInfo: () => ({name:'Upgrade Fixture Source',uuid:'${uuid}',version:'1'}),
  getSettingsBundle: () => ({data:{canLogin:true,canShowUserInfo:true}}),
  getLoginBundle: () => ({scheme:{
    title:'Fixture login', fields:[{key:'account',label:'Account'}],
    action:{fnPath:'login',submitText:'Submit fixture sign-in'}
  }}),
  login: async ({account}) => {
    if(account !== '${username}') return {ok:false};
    await bridge.call('save_plugin_config','fixtureSession',JSON.stringify(account));
    return {ok:true};
  },
  getUserInfoBundle: async () => {
    const saved=await bridge.call('load_plugin_config','fixtureSession','');
    if(!saved) return {};
    const value=typeof saved==='object' ? saved.value : saved;
    return {data:{userInfo:{username:JSON.parse(value)}}};
  },
  getComicDetail: () => ({
    comicInfo:{id:'test-comic',title:'${comicTitle}'},eps:[{id:'one',name:'Fixture Chapter'}]
  }),
  getChapter: () => ({data:{
    comic:{title:'${comicTitle}'},chapter:{name:'Fixture Chapter',
    pages:[{id:'one',url:'https://upgrade-fixture.invalid/page.gif'}]}
  }}),
  fetchImageBytes: () => Uint8Array.from(atob('${image}'),char=>char.charCodeAt(0))
}`

async function processExit(exe, args, options = {}) {
  const child = spawn(exe, args, { windowsHide: true, ...options })
  return new Promise((ok, no) => {
    child.once('error', no)
    child.once('exit', (code, signal) => code === 0 ? ok() : no(new Error(exe + ': ' + code + '/' + signal)))
  })
}

async function install(installer) {
  await processExit(installer, ['/S', '/D=' + installDir], { windowsVerbatimArguments: true })
  const files = await readdir(installDir)
  assert.ok(files.includes('LightRead.exe') || files.includes('lightread.exe'), files.join(', '))
  return join(installDir, files.find(f => f.toLowerCase() === 'lightread.exe'))
}

async function launch(exe) {
  const child = spawn(exe, [], { env, windowsHide: true })
  let browser
  try {
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error('LightRead exited with ' + child.exitCode)
      const response = await fetch('http://127.0.0.1:' + port + '/json/version').catch(() => null)
      if (response?.ok) {
        browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
        const context = browser.contexts()[0]
        if (!context.pages().some(p => /tauri\.localhost/.test(p.url()))) {
          await context.waitForEvent('page', { timeout: 3000 }).catch(() => {})
        }
        const page = context.pages().find(p => /tauri\.localhost/.test(p.url()))
        if (page) return { child, browser, page }
        await browser.close()
        browser = undefined
      }
      await new Promise(ok => setTimeout(ok, 500))
    }
    throw new Error('WebView2 did not expose the installed application')
  } catch (error) {
    await browser?.close()
    child.kill()
    throw error
  }
}

async function close(app) {
  if (app.child.exitCode !== null) return
  const exited = new Promise(ok => app.child.once('exit', ok))
  await app.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })).catch(() => {})
  await Promise.race([exited, new Promise(ok => setTimeout(ok, 5000))])
  if (app.child.exitCode === null) {
    app.child.kill()
    await exited
  }
  await app.browser.close().catch(() => {})
  for (let i = 0; i < 40; i++) {
    const r = await fetch('http://127.0.0.1:' + port + '/json/version').catch(() => null)
    if (!r?.ok) return
    await new Promise(ok => setTimeout(ok, 250))
  }
  throw new Error('Old WebView2 is still running')
}

async function goto(page, route) {
  await page.evaluate(route => { location.hash = '#'+route }, route)
  await page.waitForFunction(r => location.hash === '#'+r, route)
}

async function snapshot(page, version) {
  await goto(page, '/library')
  await page.locator('.book-card').filter({ hasText: bookTitle }).first().waitFor()
  await goto(page, '/comics/settings/' + uuid)
  await page.locator('.user-row').filter({ hasText: username }).waitFor()
  await goto(page, '/downloads')
  const taskCard = page.locator('.task.done').filter({ hasText: comicTitle })
  await taskCard.waitFor()
  await taskCard.getByRole('button', { name: /^(Open|打开)$/ }).click()
  await page.locator('.comic-reader img').first().waitFor()
  await page.waitForFunction(() => {
    const img = document.querySelector('.comic-reader img')
    return img?.complete && img.naturalWidth > 0
  })
  assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:app|version')), version)
  const data = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const db = 'sqlite:lightread.db'
    const books = await invoke('plugin:sql|select', { db, query: 'SELECT id,title,file_name,description FROM books ORDER BY id', values: [] })
    const tasks = JSON.parse(localStorage.getItem('lightread.comicDownloads.v1') ?? '[]')
    const session = JSON.parse(localStorage.getItem('lightread.comicPlugin.config.v1.upgrade-fixture') ?? '{}')
    return { books, tasks, session }
  })
  const { books, tasks, session } = data
  assert.ok(books.some(b => b.title === bookTitle))
  assert.ok(tasks.some(t => t.status === 'done' && books.some(b => b.id === t.bookId)))
  assert.equal(session.__loggedIn, true)
  assert.ok(JSON.stringify(session.fixtureSession).includes(username))
  const directory = join(process.env.APPDATA, 'com.cantrarella.lightreadx', 'books')
  const hashes = {}
  for (const name of await readdir(directory)) {
    const data = await readFile(join(directory, name))
    hashes[name] = createHash('sha256').update(data).digest('hex')
  }
  await page.screenshot({ path: join(root, 'installed-' + version + '.png') })
  return { books, tasks: tasks.map(({ id, bookId, status }) => ({ id, bookId, status })), session, hashes }
}

await mkdir(root, { recursive: true })
const taskUser = process.env.USERNAME?.toLowerCase()
assert.ok(taskUser?.startsWith('runneradmin'), 'Run in the disposable GitHub Windows runner')
const oldExe = await install(installer4)
const old = await launch(oldExe)
let before
try {
  await goto(old.page, '/library')
  await old.page.locator('input[type=file][multiple]').first().setInputFiles({
    name: bookTitle + '.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(bookTitle + '\n\n' + 'A test paragraph that should persist across installer upgrades. '.repeat(100)),
  })
  await old.page.locator('.book-card').filter({ hasText: bookTitle }).first().waitFor()
  await goto(old.page, '/comics')
  await old.page.getByRole('tab', { name: /Comic sources|漫画源/ }).click()
  await old.page.getByRole('button', { name: /^(Add source|添加源|添加漫画源|安装漫画源)$/ }).first().click()
  await old.page.locator('.install-body input[type=file]').setInputFiles({
    name: 'upgrade-fixture.js', mimeType: 'text/javascript', buffer: Buffer.from(fixture),
  })
  await old.page.getByText('Upgrade Fixture Source', { exact: true }).first().waitFor()
  await goto(old.page, '/comics/settings/' + uuid)
  await old.page.getByRole('button', { name: /^(Sign in|登录)$/ }).click()
  await old.page.locator('.login-form input').fill(username)
  await old.page.getByRole('button', { name: 'Submit fixture sign-in' }).click()
  await old.page.locator('.user-row').filter({ hasText: username }).waitFor()
  await goto(old.page, '/comics/source/' + uuid + '?comicId=test-comic')
  await old.page.locator('.chapter-row').getByRole('button', { name: /^(Download|下载)$/ }).click()
  before = await snapshot(old.page, '2.10.4')
  console.log('2.10.4: imported book, downloaded and opened a CBZ, signed in')
} finally {
  await close(old)
}

const newExe = await install(installer5)
assert.equal(newExe.toLowerCase(), oldExe.toLowerCase())
const afterApp = await launch(newExe)
try {
  const after = await snapshot(afterApp.page, '2.10.5')
  assert.deepEqual(after, before)
  await writeFile(join(root, 'upgrade-results.json'), JSON.stringify({ from: '2.10.4', to: '2.10.5', before, after }, null, 2))
  console.log('2.10.5: original book and CBZ bytes, download record, and active plugin session all preserved')
} finally {
  await close(afterApp)
}
