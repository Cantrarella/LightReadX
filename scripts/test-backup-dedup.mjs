import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { build } from 'esbuild'
import { strToU8, zipSync } from 'fflate'

const stubs = {
  '../storage': 'export const getStorage = async () => globalThis.__backupFixture.storage; export const getLibraryRoot = () => ""; export const newId = () => "id-" + Math.random().toString(36).slice(2)',
  '../stores/booklists': 'export const useBooklists = () => ({ refresh: async () => {} })',
  '../i18n': 'export const t = k => k',
  './readingLog.ts': 'export const importReadingLogRows = async () => 0; export const listReadingLog = async () => []; export const normalizeRow = r => r; export const rowKey = () => ""',
  '@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__backupFixture.invoke(...args)',
}

const { outputFiles } = await build({
  entryPoints: ['src/services/backup.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  banner: { js: `import { createRequire as __lrCreateRequire } from 'node:module'; const require = __lrCreateRequire(${JSON.stringify(import.meta.url)});` },
  minifyWhitespace: true,
  plugins: [{
    name: 'backup-dedup-fixture',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args =>
        Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args =>
        ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})

const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
const { importBackup, importBackupFromFile } = await import(moduleUrl)

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function createMemoryStorage({ withNativeHash = false } = {}) {
  const books = []
  const files = new Map()
  const annotations = []
  const sources = []
  const hashCalls = []
  const getBookFileCalls = []
  let seq = 1

  const storage = {
    async listBooks() { return [...books] },
    async addBook(meta, blob) {
      const id = `book-${seq++}`
      const bytes = new Uint8Array(await blob.arrayBuffer())
      books.push({ ...meta, id })
      files.set(id, bytes)
      return id
    },
    async getBookFile(id) {
      getBookFileCalls.push(id)
      const bytes = files.get(id)
      return new Blob([bytes])
    },
    async listAnnotations(bookId) {
      return annotations.filter(a => a.bookId === bookId)
    },
    async addAnnotation(ann) {
      const rec = { ...ann, id: `ann-${seq++}` }
      annotations.push(rec)
      return rec
    },
    async listSources() { return [...sources] },
    async addSource(s) { sources.push({ ...s, id: `src-${seq++}` }) },
  }

  if (withNativeHash) {
    storage.hashBookFile = async id => {
      hashCalls.push(id)
      return sha256Hex(files.get(id))
    }
  }

  return { storage, books, annotations, hashCalls, getBookFileCalls }
}

function makeManifestBackup(entriesMeta, includeSha256 = true) {
  const zipEntries = {}
  const books = entriesMeta.map((item, idx) => {
    const path = `books/item-${idx}.txt`
    zipEntries[path] = item.bytes
    const base = {
      id: item.id,
      title: item.title,
      author: item.author ?? 'Author',
      fileName: item.fileName,
      format: 'txt',
      tags: [],
      addedAt: 1000 + idx,
      lastReadAt: 0,
      progress: 0,
    }
    return includeSha256
      ? {
          ...base,
          content: {
            path,
            mediaType: 'text/plain',
            byteLength: item.bytes.byteLength,
            sha256: sha256Hex(item.bytes),
          },
        }
      : { ...base, fileEntry: path }
  })

  const annotations = entriesMeta.flatMap(item =>
    (item.annotations ?? []).map((text, idx) => ({
      id: `${item.id}-a-${idx}`,
      bookId: item.id,
      kind: 'highlight',
      cfi: `cfi-${item.id}-${idx}`,
      text,
      color: 'yellow',
      createdAt: 2000 + idx,
    })),
  )

  zipEntries['manifest.json'] = strToU8(JSON.stringify(
    includeSha256
      ? {
          version: 2,
          format: 'org.lightread.library',
          exportedAt: 5000,
          books,
          annotations,
          sources: [],
        }
      : {
          app: 'lightread',
          version: 1,
          books,
          annotations,
          sources: [],
        },
  ))

  const zipped = zipSync(zipEntries, { level: 0 })
  return new File([zipped], 'backup.lightread', { type: 'application/zip' })
}

test('空书库恢复同名不同内容两本书并各自保留标注，重复恢复幂等', async () => {
  const mem = createMemoryStorage()
  globalThis.__backupFixture = { storage: mem.storage }

  const file = makeManifestBackup([
    { id: 'old-1', title: '同名书', fileName: 'same.txt', bytes: strToU8('内容版本一'), annotations: ['笔记一'] },
    { id: 'old-2', title: '同名书', fileName: 'same.txt', bytes: strToU8('内容版本二'), annotations: ['笔记二'] },
  ], true)

  const first = await importBackup(file)
  assert.equal(first.books, 2)
  assert.equal(first.annotations, 2)
  assert.equal(mem.books.length, 2)

  const [b1, b2] = mem.books
  assert.deepEqual(mem.annotations.filter(a => a.bookId === b1.id).map(a => a.text), ['笔记一'])
  assert.deepEqual(mem.annotations.filter(a => a.bookId === b2.id).map(a => a.text), ['笔记二'])

  const second = await importBackup(file)
  assert.equal(second.books, 0)
  assert.equal(second.annotations, 0)
  assert.equal(mem.books.length, 2)
})

test('已有同名书时按 SHA-256 判重并优先使用原生 hashBookFile（含无校验值旧备份）', async () => {
  const mem = createMemoryStorage({ withNativeHash: true })
  globalThis.__backupFixture = { storage: mem.storage }

  const existingId = await mem.storage.addBook({
    title: '同名书',
    author: 'Author',
    fileName: 'same.txt',
    format: 'txt',
    addedAt: 900,
    lastReadAt: 0,
    progress: 0,
  }, new Blob([strToU8('已有内容')]))

  // 旧版无 sha256 备份：包含一本同内容书 + 一本同名不同内容书
  const legacyFile = makeManifestBackup([
    { id: 'old-same', title: '同名书', fileName: 'same.txt', bytes: strToU8('已有内容'), annotations: ['关联到已有书'] },
    { id: 'old-diff', title: '同名书', fileName: 'same.txt', bytes: strToU8('全新内容'), annotations: ['关联到新书'] },
  ], false)

  const res = await importBackup(legacyFile)
  assert.equal(res.books, 1)
  assert.equal(res.annotations, 2)
  assert.equal(mem.books.length, 2)
  assert.ok(mem.hashCalls.includes(existingId), '应优先调用 storage.hashBookFile')
  assert.equal(mem.getBookFileCalls.length, 0, '有 hashBookFile 时不应再读整本文件进 WebView')

  const newBook = mem.books.find(b => b.id !== existingId)
  assert.deepEqual(mem.annotations.filter(a => a.bookId === existingId).map(a => a.text), ['关联到已有书'])
  assert.deepEqual(mem.annotations.filter(a => a.bookId === newBook.id).map(a => a.text), ['关联到新书'])

  // 再次恢复同一份旧备份，不再新增副本
  const repeat = await importBackup(legacyFile)
  assert.equal(repeat.books, 0)
  assert.equal(repeat.annotations, 0)
})

test('本地同名候选原文件缺失时跳过继续匹配或恢复，其它 I/O 错误保留上下文', async () => {
  const mem = createMemoryStorage({ withNativeHash: true })
  globalThis.__backupFixture = { storage: mem.storage }

  // 情况 A：只有一个缺文件的同名候选 -> 恢复书和标注，重复恢复不新增副本
  const missingOnlyId = await mem.storage.addBook({
    title: '缺文件书',
    author: 'Author',
    fileName: 'missing.txt',
    format: 'txt',
    tags: [],
    addedAt: 800,
    lastReadAt: 0,
    progress: 0,
  }, new Blob([strToU8('将被删掉')]))
  const origHash = mem.storage.hashBookFile
  mem.storage.hashBookFile = async id => {
    if (id === missingOnlyId) {
      throw new Error('not_found: The system cannot find the path specified. (os error 3)')
    }
    return origHash(id)
  }

  const fileA = makeManifestBackup([
    { id: 'src-a', title: '缺文件书', fileName: 'missing.txt', bytes: strToU8('有效备份正文'), annotations: ['恢复后标注'] },
  ], true)
  const resA = await importBackup(fileA)
  assert.equal(resA.books, 1)
  assert.equal(resA.annotations, 1)
  assert.equal(mem.books.length, 2)
  const restoredA = mem.books.find(b => b.id !== missingOnlyId)
  assert.deepEqual(mem.annotations.filter(a => a.bookId === restoredA.id).map(a => a.text), ['恢复后标注'])
  assert.equal((await importBackup(fileA)).books, 0)

  // 情况 B：先遇到缺文件候选，再遇到可用且同内容候选 -> 匹配后者，不新增副本
  const missingIdB = await mem.storage.addBook({
    title: '双候选书',
    author: 'Author',
    fileName: 'dup.txt',
    format: 'txt',
    tags: [],
    addedAt: 810,
    lastReadAt: 0,
    progress: 0,
  }, new Blob([strToU8('待删除')]))
  const validIdB = await mem.storage.addBook({
    title: '双候选书',
    author: 'Author',
    fileName: 'dup.txt',
    format: 'txt',
    tags: [],
    addedAt: 820,
    lastReadAt: 0,
    progress: 0,
  }, new Blob([strToU8('真实一致正文')]))
  mem.storage.hashBookFile = async id => {
    if (id === missingOnlyId || id === missingIdB) throw new Error('not_found: The system cannot find the file specified. (os error 2)')
    return origHash(id)
  }

  const fileB = makeManifestBackup([
    { id: 'src-b', title: '双候选书', fileName: 'dup.txt', bytes: strToU8('真实一致正文'), annotations: ['匹配到可用候选'] },
  ], true)
  const resB = await importBackup(fileB)
  assert.equal(resB.books, 0)
  assert.equal(resB.annotations, 1)
  assert.deepEqual(mem.annotations.filter(a => a.bookId === validIdB).map(a => a.text), ['匹配到可用候选'])
  assert.equal((await importBackup(fileB)).books, 0)

  // 情况 C：非缺失文件的真实 I/O 错误（如权限错误）不得吞掉
  mem.storage.hashBookFile = async () => {
    const err = new Error('file: 拒绝访问 (os error 5)')
    err.code = 'EACCES'
    throw err
  }
  await assert.rejects(() => importBackup(fileB), /拒绝访问/)
})

test('桌面端恢复无校验值旧备份时调用 backup_hash_entry，不通过 backup_read_entry 传正文进 WebView', async () => {
  const mem = createMemoryStorage({ withNativeHash: true })
  const stagedFiles = new Map()
  const invokeCalls = []
  let stageSeq = 1

  mem.storage.stageBookFile = async tag => ({ kind: 'local-file', root: '', rel: `books/staged-${tag}-${stageSeq++}` })
  mem.storage.discardStaged = async staged => { stagedFiles.delete(staged.rel) }
  mem.storage.addBookFromStaged = async (meta, staged) => {
    const bytes = stagedFiles.get(staged.rel)
    stagedFiles.delete(staged.rel)
    return mem.storage.addBook(meta, new Blob([bytes]))
  }

  const existingId = await mem.storage.addBook({
    title: '桌面同名书',
    author: 'Author',
    fileName: 'desktop.txt',
    format: 'txt',
    tags: [],
    addedAt: 700,
    lastReadAt: 0,
    progress: 0,
  }, new Blob([strToU8('已有桌面正文')]))

  const entriesMap = {
    'books/same.txt': strToU8('已有桌面正文'),
    'books/diff.txt': strToU8('不同桌面正文'),
  }
  const legacyManifest = JSON.stringify({
    app: 'lightread',
    version: 1,
    books: [
      { id: 'd-1', title: '桌面同名书', author: 'Author', fileName: 'desktop.txt', format: 'txt', tags: [], addedAt: 701, fileEntry: 'books/same.txt' },
      { id: 'd-2', title: '桌面同名书', author: 'Author', fileName: 'desktop.txt', format: 'txt', tags: [], addedAt: 702, fileEntry: 'books/diff.txt' },
    ],
    annotations: [
      { id: 'da-1', bookId: 'd-1', kind: 'highlight', cfi: 'c1', text: '旧书标注', color: 'yellow', createdAt: 710 },
      { id: 'da-2', bookId: 'd-2', kind: 'highlight', cfi: 'c2', text: '新书标注', color: 'yellow', createdAt: 711 },
    ],
    sources: [],
  })

  globalThis.__backupFixture = {
    storage: mem.storage,
    async invoke(cmd, args) {
      invokeCalls.push({ cmd, path: args?.path })
      if (cmd === 'backup_open') return { texts: { 'manifest.json': legacyManifest } }
      if (cmd === 'backup_verify') {
        return args.checks.map(c => ({
          error: '',
          sha256: sha256Hex(entriesMap[c.path]),
        }))
      }
      if (cmd === 'backup_hash_entry') throw new Error(`判重阶段不应再调用 backup_hash_entry: ${args?.path}`)
      if (cmd === 'backup_extract') {
        stagedFiles.set(args.rel, entriesMap[args.path])
        return sha256Hex(entriesMap[args.path])
      }
      if (cmd === 'backup_read_entry') throw new Error(`不应在判重阶段通过 backup_read_entry 读取正文: ${args?.path}`)
      throw new Error(`unexpected invoke: ${cmd}`)
    },
  }

  const res = await importBackupFromFile('C:\\mock\\legacy.lightread')
  assert.equal(res.books, 1)
  assert.equal(res.annotations, 2)
  assert.equal(mem.books.length, 2)
  assert.equal(invokeCalls.filter(c => c.cmd === 'backup_verify').length, 1)
  assert.equal(invokeCalls.some(c => c.cmd === 'backup_hash_entry'), false)
  assert.equal(invokeCalls.some(c => c.cmd === 'backup_read_entry'), false)

  const addedBook = mem.books.find(b => b.id !== existingId)
  assert.deepEqual(mem.annotations.filter(a => a.bookId === existingId).map(a => a.text), ['旧书标注'])
  assert.deepEqual(mem.annotations.filter(a => a.bookId === addedBook.id).map(a => a.text), ['新书标注'])
})

test('书库 books/covers 子目录被移走后恢复备份可按需重建目录并写入书、封面与标注', async () => {
  const mem = createMemoryStorage({ withNativeHash: true })
  const existingDirs = new Set()
  const stagedFiles = new Map()
  const savedCovers = new Map()
  let stageSeq = 1

  mem.storage.stageBookFile = async tag => ({ kind: 'local-file', root: '', rel: `books/staged-${tag}-${stageSeq++}` })
  mem.storage.discardStaged = async staged => { stagedFiles.delete(staged.rel) }
  mem.storage.addBookFromStaged = async (meta, staged, cover) => {
    existingDirs.add('books')
    if (cover?.size) existingDirs.add('covers')
    const bytes = stagedFiles.get(staged.rel)
    stagedFiles.delete(staged.rel)
    const id = await mem.storage.addBook(meta, new Blob([bytes]), cover)
    if (cover?.size) savedCovers.set(id, new Uint8Array(await cover.arrayBuffer()))
    return id
  }

  // 预存一条同书名但原文件及 books/covers 目录均已移走的数据库记录
  const orphanId = await mem.storage.addBook({
    title: '重建目录测试书',
    author: 'Author',
    fileName: 'rebuild.txt',
    format: 'txt',
    tags: [],
    addedAt: 600,
    lastReadAt: 0,
    progress: 0,
  }, new Blob([strToU8('旧正文')]))
  existingDirs.clear()
  const origHash = mem.storage.hashBookFile
  mem.storage.hashBookFile = async id => {
    if (id === orphanId) throw new Error('not_found: The system cannot find the path specified. (os error 3)')
    return origHash(id)
  }

  const entriesMap = {
    'books/rebuild.txt': strToU8('恢复后的正文'),
    'covers/rebuild.jpg': strToU8('jpeg-bytes'),
  }
  const manifest = JSON.stringify({
    app: 'lightread',
    version: 1,
    books: [{
      id: 'b-rebuild',
      title: '重建目录测试书',
      author: 'Author',
      fileName: 'rebuild.txt',
      format: 'txt',
      tags: [],
      addedAt: 601,
      fileEntry: 'books/rebuild.txt',
      coverEntry: 'covers/rebuild.jpg',
    }],
    annotations: [{
      id: 'a-rebuild',
      bookId: 'b-rebuild',
      kind: 'highlight',
      cfi: 'cfi-1',
      text: '重建后标注',
      color: 'yellow',
      createdAt: 610,
    }],
    sources: [],
  })

  globalThis.__backupFixture = {
    storage: mem.storage,
    async invoke(cmd, args) {
      if (cmd === 'backup_open') return { texts: { 'manifest.json': manifest } }
      if (cmd === 'backup_verify') return args.checks.map(c => ({ error: '', sha256: sha256Hex(entriesMap[c.path]) }))
      if (cmd === 'backup_extract') {
        existingDirs.add('books')
        stagedFiles.set(args.rel, entriesMap[args.path])
        return sha256Hex(entriesMap[args.path])
      }
      if (cmd === 'backup_read_entry') return entriesMap[args.path].buffer
      throw new Error(`unexpected invoke: ${cmd}`)
    },
  }

  const res = await importBackupFromFile('C:\\mock\\rebuild.lightread')
  assert.equal(res.books, 1)
  assert.equal(res.annotations, 1)
  assert.equal(existingDirs.has('books'), true)
  assert.equal(existingDirs.has('covers'), true)
  const restored = mem.books.find(b => b.id !== orphanId)
  assert.ok(savedCovers.has(restored.id))
  assert.deepEqual(mem.annotations.filter(a => a.bookId === restored.id).map(a => a.text), ['重建后标注'])
  assert.equal((await importBackupFromFile('C:\\mock\\rebuild.lightread')).books, 0)
})

test('桌面端恢复拒绝重复 ZIP 路径与无 SHA-256 旧备份的 CRC-32 损坏，且写库前零污染', async () => {
  const mem = createMemoryStorage({ withNativeHash: true })
  let extractCalled = false

  // 1. 含两条 books/same.txt 的重复路径 ZIP：在打开/校验阶段即被拒绝，不写入任何数据
  globalThis.__backupFixture = {
    storage: mem.storage,
    async invoke(cmd) {
      if (cmd === 'backup_open') throw new Error('archive: 重复的包内路径 books/same.txt')
      if (cmd === 'backup_extract') extractCalled = true
      throw new Error(`unexpected invoke: ${cmd}`)
    },
  }
  await assert.rejects(
    () => importBackupFromFile('C:\\mock\\dup-path.lightread'),
    /重复的包内路径 books\/same\.txt/,
  )
  assert.equal(mem.books.length, 0)
  assert.equal(mem.annotations.length, 0)
  assert.equal(extractCalled, false)

  // 2. 无 SHA-256 旧备份中某条目等长单字节损坏（CRC-32 不符）：在 verifyAll 阶段即报错，不落盘不写库
  const legacyManifest = JSON.stringify({
    app: 'lightread',
    version: 1,
    books: [
      { id: 'c-1', title: '损坏书', author: 'Author', fileName: 'corrupt.txt', format: 'txt', tags: [], addedAt: 900, fileEntry: 'books/corrupt.txt' },
    ],
    annotations: [
      { id: 'ca-1', bookId: 'c-1', kind: 'highlight', cfi: 'c1', text: '不应写入的标注', color: 'yellow', createdAt: 905 },
    ],
    sources: [],
  })
  globalThis.__backupFixture = {
    storage: mem.storage,
    async invoke(cmd) {
      if (cmd === 'backup_open') return { texts: { 'manifest.json': legacyManifest } }
      if (cmd === 'backup_verify') return [{ error: 'archive: books/corrupt.txt CRC-32 校验失败' }]
      if (cmd === 'backup_extract') extractCalled = true
      throw new Error(`unexpected invoke: ${cmd}`)
    },
  }
  await assert.rejects(
    () => importBackupFromFile('C:\\mock\\crc-corrupt.lightread'),
    /CRC-32|backup\.invalid/,
  )
  assert.equal(mem.books.length, 0)
  assert.equal(mem.annotations.length, 0)
  assert.equal(extractCalled, false)
})
