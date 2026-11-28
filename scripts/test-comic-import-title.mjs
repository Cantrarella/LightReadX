import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { build } from 'esbuild'
import { strToU8, zipSync } from 'fflate'
import { DOMParser as LinkedomDOMParser } from 'linkedom'

// Node 测试环境下为 linkedom 的 DOMParser 补齐 XML 1.0 良构性校验（含重复属性、未闭合标签、非法实体等），
// 与 Windows WebView2 (Chromium) 原生 DOMParser('application/xml') 产出的 <parsererror> 行为一致。
const XML_NAME_RE = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/

function isWellFormedXml(xmlText) {
  const s = xmlText.replace(/^\uFEFF/, '').trim()
  if (!s) return false
  const stack = []
  let rootSeen = false
  let i = 0
  const n = s.length

  const validEntities = raw => {
    let idx = 0
    while (idx < raw.length) {
      if (raw[idx] === '<') return false
      if (raw[idx] !== '&') { idx++; continue }
      const semi = raw.indexOf(';', idx + 1)
      if (semi === -1) return false
      const ent = raw.slice(idx + 1, semi)
      if (!['amp', 'lt', 'gt', 'quot', 'apos'].includes(ent)
        && !/^#\d+$/.test(ent)
        && !/^#x[0-9a-fA-F]+$/.test(ent)) {
        return false
      }
      idx = semi + 1
    }
    return true
  }

  const validAttributes = attrText => {
    const seen = new Set()
    let k = 0
    const len = attrText.length
    while (k < len) {
      while (k < len && /\s/.test(attrText[k])) k++
      if (k >= len) break
      const start = k
      while (k < len && !/[\s=/>"']/.test(attrText[k])) k++
      const name = attrText.slice(start, k)
      if (!XML_NAME_RE.test(name) || seen.has(name)) return false
      seen.add(name)
      while (k < len && /\s/.test(attrText[k])) k++
      if (k >= len || attrText[k] !== '=') return false
      k++
      while (k < len && /\s/.test(attrText[k])) k++
      if (k >= len || (attrText[k] !== '"' && attrText[k] !== "'")) return false
      const quote = attrText[k++]
      const valStart = k
      while (k < len && attrText[k] !== quote) {
        if (attrText[k] === '<') return false
        k++
      }
      if (k >= len) return false
      if (!validEntities(attrText.slice(valStart, k))) return false
      k++
    }
    return true
  }

  while (i < n) {
    if (s[i] !== '<') {
      const next = s.indexOf('<', i)
      const text = next === -1 ? s.slice(i) : s.slice(i, next)
      i = next === -1 ? n : next
      if (stack.length === 0) {
        if (text.trim().length > 0) return false
        continue
      }
      if (text.includes(']]>') || !validEntities(text)) return false
      continue
    }
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      if (end === -1 || s.slice(i + 4, end).includes('--')) return false
      i = end + 3
      continue
    }
    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i + 2)
      if (end === -1) return false
      i = end + 2
      continue
    }
    if (s.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) return false
      const end = s.indexOf(']]>', i + 9)
      if (end === -1) return false
      i = end + 3
      continue
    }
    if (s.startsWith('<!DOCTYPE', i)) {
      if (rootSeen || stack.length > 0) return false
      const end = s.indexOf('>', i + 9)
      if (end === -1) return false
      i = end + 1
      continue
    }
    if (s.startsWith('</', i)) {
      const end = s.indexOf('>', i + 2)
      if (end === -1) return false
      const closeName = s.slice(i + 2, end).trim()
      if (!XML_NAME_RE.test(closeName) || stack.length === 0) return false
      if (stack.pop() !== closeName) return false
      i = end + 1
      continue
    }
    let j = i + 1
    let quote = null
    while (j < n) {
      const c = s[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      } else if (c === '<') {
        return false
      }
      j++
    }
    if (j >= n) return false
    let inner = s.slice(i + 1, j).trim()
    const selfClosing = inner.endsWith('/')
    if (selfClosing) inner = inner.slice(0, -1).trim()
    const m = inner.match(/^([^\s/>]+)([\s\S]*)$/)
    if (!m) return false
    const [, tagName, attrPart] = m
    if (!XML_NAME_RE.test(tagName) || !validAttributes(attrPart)) return false
    if (stack.length === 0) {
      if (rootSeen) return false
      rootSeen = true
    }
    if (!selfClosing) stack.push(tagName)
    i = j + 1
  }
  return rootSeen && stack.length === 0
}

globalThis.DOMParser = class StrictXmlDOMParser {
  parseFromString(str, type) {
    const parser = new LinkedomDOMParser()
    if (type === 'application/xml' && !isWellFormedXml(str)) {
      return parser.parseFromString('<parsererror>Invalid XML</parsererror>', 'application/xml')
    }
    return parser.parseFromString(str, type)
  }
}

const unrarWasmBase64 = readFileSync(
  new URL('../node_modules/node-unrar-js/esm/js/unrar.wasm', import.meta.url),
).toString('base64')

const stubs = {
  '../storage': 'export const getStorage = async () => globalThis.__comicImportFixture.storage',
  '../storage/types': 'export const isTauri = () => globalThis.__comicImportFixture?.isTauri ?? true',
  '../i18n': 'export const t = k => k',
  './pdfium': 'export const PdfiumDoc = {}',
  './djvu': 'export const djvuCover = async () => undefined',
  './textToEpub': 'export const convertToEpub = async () => ({ title: "" })',
  'node-unrar-js/esm/js/unrar.wasm?url': `export default "data:application/wasm;base64,${unrarWasmBase64}"`,
}

const { outputFiles } = await build({
  stdin: {
    contents: `
      export * from './src/services/comicMeta.ts'
      export { cbrToCbz } from './src/services/comic.ts'
      export { openLocalComicArchive, loadLocalComic, revokeLocalPages } from './src/services/comicLocal.ts'
      export { importFiles, importFile, importNativeFile } from './src/services/importer.ts'
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  banner: {
    js: `import { createRequire as __lrCr } from 'node:module'; const require = __lrCr(${JSON.stringify(import.meta.url)});`,
  },
  minifyWhitespace: true,
  plugins: [{
    name: 'comic-import-fixture',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args =>
        Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args =>
        ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})

const modUrl = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
const {
  cbrToCbz,
  decodeComicInfoXml,
  extractComicMeta,
  isComicImagePath,
  isComicInfoPath,
  loadLocalComic,
  openLocalComicArchive,
  parseComicBookInfoCommentTitle,
  parseComicInfoTitle,
  readZipComment,
  revokeLocalPages,
  sortComicInfoCandidates,
  importFiles,
} = await import(modUrl)

// 1x1 透明 PNG
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

export function encodeUtf16(str, endian = 'le', withBom = true) {
  const bomLen = withBom ? 2 : 0
  const out = new Uint8Array(bomLen + str.length * 2)
  if (withBom) {
    if (endian === 'le') {
      out[0] = 0xff
      out[1] = 0xfe
    } else {
      out[0] = 0xfe
      out[1] = 0xff
    }
  }
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    const offset = bomLen + i * 2
    if (endian === 'le') {
      out[offset] = code & 0xff
      out[offset + 1] = (code >> 8) & 0xff
    } else {
      out[offset] = (code >> 8) & 0xff
      out[offset + 1] = code & 0xff
    }
  }
  return out
}

function makeCbzFile(fileName, entries, zipComment = '') {
  const rawZip = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [k, [typeof v === 'string' ? strToU8(v) : v, { level: 0 }]]),
    ),
  )
  if (!zipComment) {
    return new File([rawZip], fileName, { type: 'application/vnd.comicbook+zip' })
  }
  const commentBytes = strToU8(zipComment)
  const withComment = new Uint8Array(rawZip.length + commentBytes.length)
  withComment.set(rawZip, 0)
  withComment[rawZip.length - 2] = commentBytes.length & 0xff
  withComment[rawZip.length - 1] = (commentBytes.length >> 8) & 0xff
  withComment.set(commentBytes, rawZip.length)
  return new File([withComment], fileName, { type: 'application/vnd.comicbook+zip' })
}

// CRC-32 (IEEE 802.3) 用于构造未压缩 RAR4 样本（支持对指定条目注入 CRC 损坏）
const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  CRC_TABLE[i] = c >>> 0
}
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export function buildStoreRar4(files) {
  const chunks = [new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])]
  const archBody = new Uint8Array([0x73, 0x00, 0x00, 0x0d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  const archCrc = crc32(archBody) & 0xffff
  chunks.push(new Uint8Array([archCrc & 0xff, (archCrc >> 8) & 0xff]), archBody)

  for (const [name, content, opts] of files) {
    const nameBytes = strToU8(name)
    const data = typeof content === 'string' ? strToU8(content) : content
    const headSize = 32 + nameBytes.length
    const body = new Uint8Array(30 + nameBytes.length)
    const view = new DataView(body.buffer)
    body[0] = 0x74 // FILE_HEAD
    view.setUint16(1, 0x8000, true) // LONG_BLOCK
    view.setUint16(3, headSize, true)
    view.setUint32(5, data.length, true) // PACK_SIZE
    view.setUint32(9, data.length, true) // UNP_SIZE
    body[13] = 2 // Win32
    let fileCrc = crc32(data)
    if (opts?.corruptCrc) fileCrc = (fileCrc ^ 0xdeadbeef) >>> 0
    view.setUint32(14, fileCrc, true) // FILE_CRC
    view.setUint32(18, 0, true) // FTIME
    body[22] = 20 // UNP_VER
    body[23] = 0x30 // METHOD = store
    view.setUint16(24, nameBytes.length, true)
    view.setUint32(26, 0x20, true) // ATTR
    body.set(nameBytes, 30)
    const headCrc = crc32(body) & 0xffff
    chunks.push(new Uint8Array([headCrc & 0xff, (headCrc >> 8) & 0xff]), body, data)
  }

  const endBody = new Uint8Array([0x7b, 0x00, 0x40, 0x07, 0x00])
  const endCrc = crc32(endBody) & 0xffff
  chunks.push(new Uint8Array([endCrc & 0xff, (endCrc >> 8) & 0xff]), endBody)

  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

test('ComicInfo.xml 路径识别、根目录优先排序与可读图片格式统一判断', () => {
  assert.equal(isComicInfoPath('ComicInfo.xml'), true)
  assert.equal(isComicInfoPath('comicinfo.XML'), true)
  assert.equal(isComicInfoPath('vol1/sub/COMICINFO.xml'), true)
  assert.equal(isComicInfoPath('ComicInfo.xml.bak'), false)

  const sorted = sortComicInfoCandidates(
    ['a/b/ComicInfo.xml', 'sub/comicinfo.xml', 'COMICINFO.XML'],
    x => x,
  )
  assert.deepEqual(sorted, ['COMICINFO.XML', 'sub/comicinfo.xml', 'a/b/ComicInfo.xml'])

  // 统一图片格式：忽略大小写，支持 jpg/jpeg/png/gif/webp/bmp/avif，排除 svg 和 jxl
  for (const ok of ['001.jpg', '002.JPEG', '003.png', '004.PNG', '005.gif', '006.WEBP', '007.bmp', '008.AVIF']) {
    assert.equal(isComicImagePath(ok), true, `${ok} 应判定为可读图片`)
  }
  for (const no of ['000.svg', '000.SVG', '000.jxl', '000.JXL', 'ComicInfo.xml', 'readme.txt']) {
    assert.equal(isComicImagePath(no), false, `${no} 不应判定为可读图片`)
  }
})

test('UTF-8 / UTF-16LE / UTF-16BE 解码与 DOMParser XML 严格校验（含重复属性拒绝）', () => {
  const xmlZh = '<?xml version="1.0" encoding="utf-16"?><ComicInfo><Title>  镖人 第一卷  </Title></ComicInfo>'
  const xmlJa = '<?xml version="1.0" encoding="utf-16be"?><ComicInfo><Title>  ぼっち・ざ・ろっく！ 第1巻  </Title></ComicInfo>'

  // UTF-16LE (带 BOM 与无 BOM)
  const u16leBom = encodeUtf16(xmlZh, 'le', true)
  const u16leNoBom = encodeUtf16(xmlZh, 'le', false)
  assert.equal(parseComicInfoTitle(u16leBom), '镖人 第一卷')
  assert.equal(parseComicInfoTitle(u16leNoBom), '镖人 第一卷')

  // UTF-16BE (带 BOM 与无 BOM)
  const u16beBom = encodeUtf16(xmlJa, 'be', true)
  const u16beNoBom = encodeUtf16(xmlJa, 'be', false)
  assert.equal(parseComicInfoTitle(u16beBom), 'ぼっち・ざ・ろっく！ 第1巻')
  assert.equal(parseComicInfoTitle(u16beNoBom), 'ぼっち・ざ・ろっく！ 第1巻')

  // 非法字节序列（奇数长度 UTF-16、损坏的 UTF-8）应安全返回 null
  assert.equal(decodeComicInfoXml(new Uint8Array([0xff, 0xfe, 0x3c])), null)
  assert.equal(decodeComicInfoXml(new Uint8Array([0xfe, 0xff, 0x00])), null)
  assert.equal(decodeComicInfoXml(new Uint8Array([0x80, 0xfe, 0xff])), null)

  // 重复属性、未闭合标签、空标题、错误根节点均返回 null
  assert.equal(parseComicInfoTitle('<ComicInfo a="1" a="2"><Title>重复属性根</Title></ComicInfo>'), null)
  assert.equal(parseComicInfoTitle('<ComicInfo><Title lang="zh" lang="en">重复属性标题</Title></ComicInfo>'), null)
  assert.equal(parseComicInfoTitle('<ComicInfo><Title>   </Title></ComicInfo>'), null)
  assert.equal(parseComicInfoTitle('<ComicInfo><Title/></ComicInfo>'), null)
  assert.equal(parseComicInfoTitle('<ComicInfo><Title>未闭合标题</ComicInfo>'), null)
  assert.equal(parseComicInfoTitle('<NotComicInfo><Title>错误根</Title></NotComicInfo>'), null)

  assert.equal(
    parseComicBookInfoCommentTitle(JSON.stringify({ 'ComicBookInfo/1.0': { title: '  注释里的漫画标题  ' } })),
    '注释里的漫画标题',
  )
})

test('无效 XML（含重复属性）不覆盖有效的其他 XML 候选或 ZIP 注释标题，无注释时回退文件名主名', async () => {
  // 1. 含重复属性的 ComicInfo.xml + 有效 ZIP 注释 → 使用注释标题
  const dupAttrWithComment = makeCbzFile(
    'dup_attr_with_comment.cbz',
    {
      'ComicInfo.xml': '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><Title>无效的重复属性标题</Title></ComicInfo>',
      '001.png': TINY_PNG,
    },
    JSON.stringify({ 'ComicBookInfo/1.0': { title: '有效的ZIP注释标题' } }),
  )
  assert.equal((await extractComicMeta(dupAttrWithComment, { allowZipComment: true })).title, '有效的ZIP注释标题')

  // 2. 移除注释后 → 返回空串，交由导入流程回退到文件名主名
  const dupAttrNoComment = makeCbzFile(
    'dup_attr_no_comment.cbz',
    {
      'ComicInfo.xml': '<ComicInfo Version="1" Version="2"><Title>无效的重复属性标题</Title></ComicInfo>',
      '001.png': TINY_PNG,
    },
  )
  assert.equal((await extractComicMeta(dupAttrNoComment, { allowZipComment: true })).title, '')

  // 3. 根目录 ComicInfo.xml 含重复属性损坏，但子目录 ComicInfo.xml 合法 → 继续尝试子目录候选并命中
  const rootBadSubGood = makeCbzFile(
    'root_bad_sub_good.cbz',
    {
      'ComicInfo.xml': '<ComicInfo dup="1" dup="2"><Title>损坏的根XML</Title></ComicInfo>',
      'sub/ComicInfo.xml': '<ComicInfo><Title>子目录合法XML标题</Title></ComicInfo>',
      '001.png': TINY_PNG,
    },
    JSON.stringify({ 'ComicBookInfo/1.0': { title: '注释标题' } }),
  )
  assert.equal((await extractComicMeta(rootBadSubGood, { allowZipComment: true })).title, '子目录合法XML标题')

  // 4. 合法的 XML 与不同的注释标题 → XML 标题优先
  const validXmlVsComment = makeCbzFile(
    'valid_xml_vs_comment.cbz',
    {
      'ComicInfo.xml': '<ComicInfo><Title>合法的XML标题优先</Title></ComicInfo>',
      '001.png': TINY_PNG,
    },
    JSON.stringify({ 'ComicBookInfo/1.0': { title: '不同的注释标题' } }),
  )
  assert.equal((await extractComicMeta(validXmlVsComment, { allowZipComment: true })).title, '合法的XML标题优先')
})

test('CBR 元数据 CRC 损坏时回退仅图片路径（仍可导入并打开第一页），图片损坏或无可读图片时报错', async () => {
  // 1. 仅 ComicInfo.xml 条目 CRC 损坏、图片完好的 CBR
  const cbrBadXmlGoodImg = new File([
    buildStoreRar4([
      ['ComicInfo.xml', '<ComicInfo><Title>CRC损坏的标题</Title></ComicInfo>', { corruptCrc: true }],
      ['001.png', TINY_PNG],
    ]),
  ], 'CRC损坏回退主名.cbr')

  const convertedBlob = await cbrToCbz(cbrBadXmlGoodImg)
  const meta = await extractComicMeta(new File([convertedBlob], 'CRC损坏回退主名.cbz'), { allowZipComment: false })
  assert.equal(meta.title, '')
  assert.ok(meta.cover && meta.cover.size > 0)

  // 2. 图片本身 CRC 损坏的 CBR → 必须抛错拒绝
  const cbrBadImg = new File([
    buildStoreRar4([
      ['ComicInfo.xml', '<ComicInfo><Title>好XML</Title></ComicInfo>'],
      ['001.png', TINY_PNG, { corruptCrc: true }],
    ]),
  ], '图片损坏.cbr')
  await assert.rejects(() => cbrToCbz(cbrBadImg))

  // 3. 无可读图片的 CBR（例如只含 SVG / JXL）→ 必须抛错拒绝
  const cbrNoImg = new File([
    buildStoreRar4([
      ['ComicInfo.xml', '<ComicInfo><Title>无可读图片</Title></ComicInfo>'],
      ['001.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
      ['002.jxl', new Uint8Array([0xff, 0x0a])],
    ]),
  ], '仅SVG_JXL.cbr')
  await assert.rejects(() => cbrToCbz(cbrNoImg))
})

test('importFiles + openLocalComicArchive 全链路：覆盖 4 项补修的所有关键样本', async () => {
  const books = new Map()
  const bookFiles = new Map()
  const covers = new Map()
  let seq = 1

  const storage = {
    async addBook(meta, file, cover) {
      const id = `comic-${seq++}`
      books.set(id, { ...meta, id, hasCover: !!cover })
      bookFiles.set(id, file)
      if (cover) covers.set(id, cover)
      return id
    },
    async stageBookFromPath(absPath) {
      const file = globalThis.__comicImportFixture.diskFiles.get(absPath)
      return { kind: 'local-file', root: '', rel: `books/staged-${seq}`, blob: async () => file }
    },
    async addBookFromStaged(meta, staged, cover) {
      return this.addBook(meta, await staged.blob(), cover)
    },
    async discardStaged() {},
    async updateBook(id, patch) {
      books.set(id, { ...books.get(id), ...patch })
    },
    async setCover(id, cover) {
      covers.set(id, cover)
      books.set(id, { ...books.get(id), hasCover: true })
    },
    async getBook(id) {
      return books.get(id)
    },
    async getBookFile(id) {
      return bookFiles.get(id)
    },
    async getComicCbz(id) {
      const file = bookFiles.get(id)
      return cbrToCbz(file)
    },
    async deleteBook(id) {
      books.delete(id)
      bookFiles.delete(id)
      covers.delete(id)
    },
    async listBooks() {
      return [...books.values()]
    },
  }

  const diskFiles = new Map()
  globalThis.__comicImportFixture = { storage, diskFiles, isTauri: true }

  // (1) 只有 ComicInfo.xml CRC 损坏、图片完好的 CBR：导入成功，显示文件名主名与封面，阅读器能读到第一页
  const cbrCorruptXml = new File([
    buildStoreRar4([
      ['ComicInfo.xml', '<ComicInfo><Title>不该读出的损坏条目</Title></ComicInfo>', { corruptCrc: true }],
      ['001.png', TINY_PNG],
    ]),
  ], '元数据CRC损坏_回退主名.cbr')
  const [resCorruptXmlCbr] = await importFiles([cbrCorruptXml])
  assert.equal(resCorruptXmlCbr.ok, true)
  assert.equal(books.get(resCorruptXmlCbr.bookId).title, '元数据CRC损坏_回退主名')
  assert.equal(books.get(resCorruptXmlCbr.bookId).hasCover, true)
  const archive1 = await openLocalComicArchive(resCorruptXmlCbr.bookId)
  assert.deepEqual(archive1.pageIds, ['001.png'])
  const page1Url = await archive1.readPageUrl(0)
  assert.ok(page1Url.startsWith('blob:'))
  URL.revokeObjectURL(page1Url)
  archive1.close()

  // 图片损坏或无图片的 CBR：导入报错且不残留记录
  const cbrCorruptImg = new File([
    buildStoreRar4([
      ['ComicInfo.xml', '<ComicInfo><Title>图片损坏</Title></ComicInfo>'],
      ['001.png', TINY_PNG, { corruptCrc: true }],
    ]),
  ], '图片CRC损坏.cbr')
  const [resCorruptImgCbr] = await importFiles([cbrCorruptImg])
  assert.equal(resCorruptImgCbr.ok, false)

  // (2) 带 BOM 的 UTF-16LE 与 UTF-16BE 元数据制作 CBZ 和 CBR（外部文件名乱码，内嵌中日文标题）
  const u16leBytes = encodeUtf16('<?xml version="1.0" encoding="utf-16"?><ComicInfo><Title>镖人 UTF16LE 卷一</Title></ComicInfo>', 'le', true)
  const u16beBytes = encodeUtf16('<?xml version="1.0" encoding="utf-16be"?><ComicInfo><Title>ぼっち・ざ・ろっく！ UTF16BE</Title></ComicInfo>', 'be', true)

  const cbzU16le = makeCbzFile('Ã¤Â¹Â±_u16le.cbz', { 'ComicInfo.xml': u16leBytes, '001.png': TINY_PNG })
  const cbzU16be = makeCbzFile('Ã¤Â¹Â±_u16be.cbz', { 'ComicInfo.xml': u16beBytes, '001.png': TINY_PNG })
  const cbrU16le = new File([buildStoreRar4([['ComicInfo.xml', u16leBytes], ['001.png', TINY_PNG]])], 'Ã¦Â\x96Â\x87_u16le.cbr')
  const cbrU16be = new File([buildStoreRar4([['ComicInfo.xml', u16beBytes], ['001.png', TINY_PNG]])], 'Ã¦Â\x96Â\x87_u16be.cbr')

  const u16Results = await importFiles([cbzU16le, cbzU16be, cbrU16le, cbrU16be])
  assert.equal(u16Results.every(r => r.ok), true)
  assert.equal(books.get(u16Results[0].bookId).title, '镖人 UTF16LE 卷一')
  assert.equal(books.get(u16Results[1].bookId).title, 'ぼっち・ざ・ろっく！ UTF16BE')
  assert.equal(books.get(u16Results[2].bookId).title, '镖人 UTF16LE 卷一')
  assert.equal(books.get(u16Results[3].bookId).title, 'ぼっち・ざ・ろっく！ UTF16BE')

  // (3) 重复属性 ComicInfo.xml + 有效 ZIP 注释 → 注释标题；移除注释 → 文件名主名
  const cbzDupWithComment = makeCbzFile(
    '回退主名_含注释.cbz',
    { 'ComicInfo.xml': '<ComicInfo x="1" x="2"><Title>错误XML</Title></ComicInfo>', '001.png': TINY_PNG },
    JSON.stringify({ 'ComicBookInfo/1.0': { title: '注释回退成功' } }),
  )
  const cbzDupNoComment = makeCbzFile(
    '回退主名_无注释.cbz',
    { 'ComicInfo.xml': '<ComicInfo x="1" x="2"><Title>错误XML</Title></ComicInfo>', '001.png': TINY_PNG },
  )
  const [resDupComment, resDupNoComment] = await importFiles([cbzDupWithComment, cbzDupNoComment])
  assert.equal(resDupComment.ok, true)
  assert.equal(books.get(resDupComment.bookId).title, '注释回退成功')
  assert.equal(resDupNoComment.ok, true)
  assert.equal(books.get(resDupNoComment.bookId).title, '回退主名_无注释')

  // (4) 只含 SVG 或 JXL 的 CBZ 在导入阶段报错；混有 SVG/JXL 和 PNG 的 CBZ 正常入库且封面和第一页都用可读图片；大写 .PNG 正常导入和打开
  const cbzOnlySvg = makeCbzFile('only_svg.cbz', {
    '001.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  })
  const cbzOnlyJxl = makeCbzFile('only_jxl.cbz', {
    '001.jxl': new Uint8Array([0xff, 0x0a, 0x00]),
  })
  const [resOnlySvg, resOnlyJxl] = await importFiles([cbzOnlySvg, cbzOnlyJxl])
  assert.equal(resOnlySvg.ok, false)
  assert.equal(resOnlyJxl.ok, false)

  const cbzMixedSvgPng = makeCbzFile('mixed_svg_png.cbz', {
    '000_cover.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '000_alt.JXL': new Uint8Array([0xff, 0x0a, 0x00]),
    '001_page.png': TINY_PNG,
  })
  const cbzUpperPng = makeCbzFile('upper_ext.cbz', {
    '001.PNG': TINY_PNG,
  })
  const [resMixed, resUpper] = await importFiles([cbzMixedSvgPng, cbzUpperPng])
  assert.equal(resMixed.ok, true)
  assert.equal(covers.get(resMixed.bookId).type, 'image/png')
  assert.equal(covers.get(resMixed.bookId).size, TINY_PNG.length)
  const mixedArchive = await openLocalComicArchive(resMixed.bookId)
  assert.deepEqual(mixedArchive.pageIds, ['001_page.png'])
  mixedArchive.close()
  const mixedLoaded = await loadLocalComic(resMixed.bookId)
  assert.deepEqual(mixedLoaded.pages.map(p => p.id), ['001_page.png'])
  revokeLocalPages(mixedLoaded.pages)

  assert.equal(resUpper.ok, true)
  assert.equal(covers.get(resUpper.bookId).type, 'image/png')
  const upperArchive = await openLocalComicArchive(resUpper.bookId)
  assert.deepEqual(upperArchive.pageIds, ['001.PNG'])
  upperArchive.close()

  // (5) 无法解码的图片（压缩包与 CRC 完好，但 001.png 实际是文本）：CBZ 与 CBR 均报错拒绝，且无残留记录
  const textAsPng = strToU8('this is plain text masquerading as a PNG image')
  const cbzFakePng = makeCbzFile('fake_png.cbz', { '001.png': textAsPng })
  const cbrFakePng = new File([buildStoreRar4([['001.png', textAsPng]])], 'fake_png.cbr')
  const countBeforeFake = books.size
  const [resFakeCbz, resFakeCbr] = await importFiles([cbzFakePng, cbrFakePng])
  assert.equal(resFakeCbz.ok, false)
  assert.equal(resFakeCbr.ok, false)
  assert.equal(books.size, countBeforeFake, '伪装 PNG 的 CBZ/CBR 不应残留任何书库记录')

  // (6) CBZ 的 ComicInfo.xml 修改标题字节但保留原 ZIP CRC（XML 仍良构但 CRC 不符）→ 跳过该 XML，回退到注释或文件名主名
  const makeCorruptXmlCrcCbz = (fileName, zipComment = '') => {
    const originalTitle = '<Title>Original Title A</Title>'
    const tamperedTitle = '<Title>Original Title B</Title>'
    const baseFile = makeCbzFile(
      fileName,
      {
        'ComicInfo.xml': `<ComicInfo>${originalTitle}</ComicInfo>`,
        '001.png': TINY_PNG,
      },
      zipComment,
    )
    return baseFile.arrayBuffer().then(buf => {
      const bytes = new Uint8Array(buf)
      const needle = strToU8(originalTitle)
      const replacement = strToU8(tamperedTitle)
      let hit = -1
      for (let i = 0; i <= bytes.length - needle.length; i++) {
        let match = true
        for (let j = 0; j < needle.length; j++) {
          if (bytes[i + j] !== needle[j]) { match = false; break }
        }
        if (match) { hit = i; break }
      }
      assert.ok(hit >= 0, '应定位到 ZIP 内的原始 XML 字节')
      bytes.set(replacement, hit)
      return new File([bytes], fileName, { type: 'application/vnd.comicbook+zip' })
    })
  }

  const cbzXmlCrcBadWithComment = await makeCorruptXmlCrcCbz(
    'crc_bad_with_comment.cbz',
    JSON.stringify({ 'ComicBookInfo/1.0': { title: 'CRC损坏后回退注释标题' } }),
  )
  const cbzXmlCrcBadNoComment = await makeCorruptXmlCrcCbz('CRC损坏无注释_回退主名.cbz')
  const cbzXmlCrcGood = makeCbzFile(
    'crc_good_control.cbz',
    {
      'ComicInfo.xml': '<ComicInfo><Title>未损坏对照XML优先</Title></ComicInfo>',
      '001.png': TINY_PNG,
    },
    JSON.stringify({ 'ComicBookInfo/1.0': { title: '对照注释标题' } }),
  )

  const [resCrcBadComment, resCrcBadNoComment, resCrcGood] = await importFiles([
    cbzXmlCrcBadWithComment,
    cbzXmlCrcBadNoComment,
    cbzXmlCrcGood,
  ])
  assert.equal(resCrcBadComment.ok, true)
  assert.equal(books.get(resCrcBadComment.bookId).title, 'CRC损坏后回退注释标题')
  assert.equal(resCrcBadNoComment.ok, true)
  assert.equal(books.get(resCrcBadNoComment.bookId).title, 'CRC损坏无注释_回退主名')
  assert.equal(resCrcGood.ok, true)
  assert.equal(books.get(resCrcGood.bookId).title, '未损坏对照XML优先')

  // (7) 重名图片路径与 Unicode Path 扩展字段校验：支持 Info-ZIP Unicode Path (0x7075)
  const buildStoreZip = entries => {
    const locals = []
    const centrals = []
    let offset = 0
    for (const [name, raw, opts] of entries) {
      const nameBytes = strToU8(name)
      const data = typeof raw === 'string' ? strToU8(raw) : raw
      const crc = crc32(data)
      let extra = new Uint8Array(0)
      if (opts?.unicodePath) {
        const uBytes = strToU8(opts.unicodePath)
        extra = new Uint8Array(9 + uBytes.length)
        const xv = new DataView(extra.buffer)
        xv.setUint16(0, 0x7075, true) // Info-ZIP Unicode Path Extra Field
        xv.setUint16(2, 5 + uBytes.length, true)
        extra[4] = 1 // version
        xv.setUint32(5, crc32(nameBytes), true)
        extra.set(uBytes, 9)
      }

      const local = new Uint8Array(30 + nameBytes.length + extra.length)
      const lv = new DataView(local.buffer)
      lv.setUint32(0, 0x04034b50, true)
      lv.setUint16(4, 20, true)
      lv.setUint16(6, 0, true)
      lv.setUint16(8, 0, true)
      lv.setUint32(14, crc, true)
      lv.setUint32(18, data.length, true)
      lv.setUint32(22, data.length, true)
      lv.setUint16(26, nameBytes.length, true)
      lv.setUint16(28, extra.length, true)
      local.set(nameBytes, 30)
      if (extra.length) local.set(extra, 30 + nameBytes.length)
      locals.push(local, data)

      const central = new Uint8Array(46 + nameBytes.length + extra.length)
      const cv = new DataView(central.buffer)
      cv.setUint32(0, 0x02014b50, true)
      cv.setUint16(4, 20, true)
      cv.setUint16(6, 20, true)
      cv.setUint16(8, 0, true)
      cv.setUint16(10, 0, true)
      cv.setUint32(16, crc, true)
      cv.setUint32(20, data.length, true)
      cv.setUint32(24, data.length, true)
      cv.setUint16(28, nameBytes.length, true)
      cv.setUint16(30, extra.length, true)
      cv.setUint32(42, offset, true)
      central.set(nameBytes, 46)
      if (extra.length) central.set(extra, 46 + nameBytes.length)
      centrals.push(central)

      offset += local.length + data.length
    }
    const cdSize = centrals.reduce((s, c) => s + c.length, 0)
    const eocd = new Uint8Array(22)
    const ev = new DataView(eocd.buffer)
    ev.setUint32(0, 0x06054b50, true)
    ev.setUint16(8, entries.length, true)
    ev.setUint16(10, entries.length, true)
    ev.setUint32(12, cdSize, true)
    ev.setUint32(16, offset, true)
    const parts = [...locals, ...centrals, eocd]
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
    let pos = 0
    for (const p of parts) { out.set(p, pos); pos += p.length }
    return out
  }

  let discardedStagedCount = 0
  const origDiscardStaged = storage.discardStaged
  storage.discardStaged = async staged => {
    discardedStagedCount++
    return origDiscardStaged(staged)
  }

  const badImgBytes = strToU8('corrupt second image bytes')
  const dupGoodThenBadBytes = buildStoreZip([['001.png', TINY_PNG], ['001.png', badImgBytes]])
  const dupBadThenGoodBytes = buildStoreZip([['001.png', badImgBytes], ['001.png', TINY_PNG]])
  const dupBothGoodBytes = buildStoreZip([['001.png', TINY_PNG], ['001.png', TINY_PNG]])
  // 复现包：两条原始路径均为 001.png，第一条好图，第二条坏图且 Unicode Path 为 002.png
  const dupRawUnicodeBytes = buildStoreZip([
    ['001.png', TINY_PNG],
    ['001.png', badImgBytes, { unicodePath: '002.png' }],
  ])

  const dupPick = new File([dupGoodThenBadBytes], 'dup_good_bad.cbz')
  diskFiles.set('C:\\comics\\dup_good_bad.cbz', dupPick)
  const dupSwapped = new File([dupBadThenGoodBytes], 'dup_bad_good.cbz')
  const dupBothGood = new File([dupBothGoodBytes], 'dup_both_good.cbz')
  const dupUnicodePick = new File([dupRawUnicodeBytes], 'dup_raw_unicode.cbz')
  diskFiles.set('C:\\comics\\dup_raw_unicode.cbz', dupUnicodePick)

  const countBeforeDup = books.size
  const [resDupPick, resDupDrop, resDupSwapped, resDupBothGood, resUniPick, resUniDrop] = await importFiles([
    dupPick,
    { name: 'dup_good_bad.cbz', absPath: 'C:\\comics\\dup_good_bad.cbz' },
    dupSwapped,
    dupBothGood,
    dupUnicodePick,
    { name: 'dup_raw_unicode.cbz', absPath: 'C:\\comics\\dup_raw_unicode.cbz' },
  ])
  for (const [label, res] of [
    ['文件选择(先好后坏)', resDupPick],
    ['原生拖入(先好后坏)', resDupDrop],
    ['交换顺序(先坏后好)', resDupSwapped],
    ['两条均完好', resDupBothGood],
    ['文件选择(原始重名+UnicodePath伪装002)', resUniPick],
    ['原生拖入(原始重名+UnicodePath伪装002)', resUniDrop],
  ]) {
    assert.equal(res.ok, false, `${label} 应拒绝导入`)
    assert.ok(res.error && res.error.includes('001.png'), `${label} 错误信息应包含冲突路径 001.png，实际: ${res.error}`)
  }
  assert.equal(books.size, countBeforeDup, '重名图片 CBZ 不应留下任何书库记录')
  assert.equal(discardedStagedCount, 2, '原生拖入失败后均应清理暂存文件')

  // 正常 Unicode Path 对照包：原始路径不同，解码后分别为不同日文/中文名且内容不同
  const TINY_PNG_2 = new Uint8Array(TINY_PNG)
  TINY_PNG_2[TINY_PNG_2.length - 1] ^= 0x00 // 保持合法 PNG，仅用不同内容区分页
  const PNG_PAGE_2 = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d,
    0x24, 0x00, 0x00, 0x00, 0x0e, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x60, 0x18, 0x05, 0xa3,
    0x60, 0x14, 0x00, 0x00, 0x00, 0x24, 0x00, 0x01,
    0xb2, 0x79, 0xc3, 0x4d, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])
  const unicodeOkCbz = new File([
    buildStoreZip([
      ['p_b.png', PNG_PAGE_2, { unicodePath: '02_中文页.png' }],
      ['p_a.png', TINY_PNG, { unicodePath: '01_日本語ページ.png' }],
    ]),
  ], 'unicode_ok_control.cbz')
  const [resUnicodeOk] = await importFiles([unicodeOkCbz])
  assert.equal(resUnicodeOk.ok, true)
  assert.deepEqual(new Uint8Array(await covers.get(resUnicodeOk.bookId).arrayBuffer()), TINY_PNG)
  const uniArchive = await openLocalComicArchive(resUnicodeOk.bookId)
  assert.deepEqual(uniArchive.pageIds, ['01_日本語ページ.png', '02_中文页.png'])
  uniArchive.close()

  // 不同子目录中的同名图片（ch01/001.png 与 ch02/001.png）应正常导入并按顺序打开两页
  const subDirSameBase = new File([
    buildStoreZip([['ch01/001.png', TINY_PNG], ['ch02/001.png', PNG_PAGE_2]]),
  ], 'subdir_same_basename.cbz')
  const [resSubDir] = await importFiles([subDirSameBase])
  assert.equal(resSubDir.ok, true)
  assert.equal(books.get(resSubDir.bookId).hasCover, true)
  const subArchive = await openLocalComicArchive(resSubDir.bookId)
  assert.deepEqual(subArchive.pageIds, ['ch01/001.png', 'ch02/001.png'])
  subArchive.close()
})
