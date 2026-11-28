/**
 * 本地漫画 (CBZ / CBR) 内嵌书名、封面提取与可读图片格式判断。
 *
 * 书名优先级：
 * 1. 包内 ComicInfo.xml 的非空 <Title>（忽略文件名大小写，支持子目录，根目录优先；支持 UTF-8 / UTF-16LE / UTF-16BE，要求 ZIP 条目 CRC 校验通过）
 * 2. (仅 CBZ) ZIP 注释中 ComicBookInfo/1.0.title
 * 3. 调用方回退到原文件名去掉扩展名后的主名
 */
import { openBookWithFileFallback } from './foliateBook'

/** 导入与阅读器共用的可读漫画图片扩展名（忽略大小写，不含阅读器不支持的 SVG / JXL） */
export const COMIC_IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i

/** 需要向用户直接展示具体原因的漫画导入校验错误（如重复图片路径） */
export class ComicImportError extends Error {}

export function isComicImagePath(name: string): boolean {
  return COMIC_IMAGE_RE.test(name)
}

/** 导入与阅读器共用的漫画页自然排序规则（保证导入校验的实际首页与阅读器第一页严格一致） */
export function compareComicImageNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

export function comicImageMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'png': return 'image/png'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'avif': return 'image/avif'
    case 'jpg':
    case 'jpeg':
    default: return 'image/jpeg'
  }
}

function hasValidBitmapSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b)
  return at(0, 0xff, 0xd8, 0xff) // JPEG
    || at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) // PNG
    || at(0, 0x47, 0x49, 0x46, 0x38) // GIF
    || at(0, 0x42, 0x4d) // BMP
    || (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) // WebP
    || (bytes.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70)) // AVIF
}

/**
 * 用 Windows WebView 的图片解码能力验证实际首页 Blob 能正常打开，并在结束后释放临时 Object URL。
 */
export async function verifyDecodableComicImage(blob: Blob): Promise<void> {
  if (!blob || blob.size === 0) {
    throw new Error('Corrupt or empty comic image')
  }
  if (typeof Image !== 'undefined' && typeof URL?.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Failed to decode first comic page image'))
        img.src = url
      })
      if (typeof img.decode === 'function') {
        await img.decode()
      }
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) {
        throw new Error('Invalid comic image dimensions')
      }
    } finally {
      URL.revokeObjectURL(url)
    }
    return
  }
  // Node 命令行测试环境下无 DOM Image 时回退校验位图文件签名
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (!hasValidBitmapSignature(bytes)) {
    throw new Error('Failed to decode first comic page image')
  }
}

/** 判断包内路径是否为 ComicInfo.xml（忽略大小写，支持任意子目录） */
export function isComicInfoPath(path: string): boolean {
  const cleaned = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!cleaned) return false
  const base = cleaned.split('/').pop() ?? ''
  return base.toLowerCase() === 'comicinfo.xml'
}

function pathDepth(path: string): number {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).length
}

/** 按根目录优先、浅层子目录次之的顺序排列 ComicInfo.xml 候选路径 */
export function sortComicInfoCandidates<T>(items: T[], getPath: (item: T) => string): T[] {
  return items
    .filter(item => isComicInfoPath(getPath(item)))
    .map((item, index) => ({ item, index, depth: pathDepth(getPath(item)) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map(entry => entry.item)
}

function matchXmlDeclaredEncoding(headText: string): string | null {
  const decl = headText.replace(/^\uFEFF/, '').match(/^\s*<\?xml\b([\s\S]*?)\?>/i)
  if (!decl) return null
  const enc = decl[1].match(/\bencoding\s*=\s*["']([^"']+)["']/i)
  return enc ? enc[1].trim() : null
}

/**
 * 将 ComicInfo.xml 原始字节按 BOM 或可识别的 XML 编码信息解码为字符串。
 * 覆盖 UTF-8、UTF-16LE 和 UTF-16BE（含/不含 BOM），解码失败或含非法 NUL 字节时返回 null。
 */
export function decodeComicInfoXml(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length === 0) return null
  try {
    // 1. UTF-8 BOM (EF BB BF)
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3))
      return text.includes('\u0000') ? null : text
    }

    // 2. UTF-16LE BOM (FF FE)
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      if (bytes.length % 2 !== 0) return null
      const text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
      return text.includes('\u0000') ? null : text
    }

    // 3. UTF-16BE BOM (FE FF)
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      if (bytes.length % 2 !== 0) return null
      const text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2))
      return text.includes('\u0000') ? null : text
    }

    // 4. 无 BOM 的 UTF-16LE / UTF-16BE（按 XML 1.0 附录 F 双字节前导零字节检测）
    if (bytes.length >= 4 && bytes.length % 2 === 0) {
      if (bytes[0] !== 0x00 && bytes[1] === 0x00 && bytes[2] !== 0x00 && bytes[3] === 0x00) {
        const text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
        if (text.includes('\u0000')) return null
        const declEnc = matchXmlDeclaredEncoding(text)
        if (declEnc && !/^utf-?16(le)?$/i.test(declEnc)) return null
        return text
      }
      if (bytes[0] === 0x00 && bytes[1] !== 0x00 && bytes[2] === 0x00 && bytes[3] !== 0x00) {
        const text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
        if (text.includes('\u0000')) return null
        const declEnc = matchXmlDeclaredEncoding(text)
        if (declEnc && !/^utf-?16(be)?$/i.test(declEnc)) return null
        return text
      }
    }

    // 5. 单字节前导：读取 <?xml ... encoding="..." ?> 声明，默认 UTF-8
    const headAscii = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 256)))
    const declared = matchXmlDeclaredEncoding(headAscii)
    if (declared) {
      if (/^utf-?16(le|be)$/i.test(declared)) return null
      const label = /^utf-?16$/i.test(declared) ? 'utf-8' : declared.toLowerCase()
      const text = new TextDecoder(label, { fatal: true }).decode(bytes)
      return text.includes('\u0000') ? null : text
    }

    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.includes('\u0000') ? null : text
  } catch {
    return null
  }
}

/**
 * 用 Windows WebView 自带的 DOMParser (application/xml) 解析 ComicInfo.xml 中的 <Title>：
 * - 整份 XML 解析成功（无 parsererror），根节点为 ComicInfo
 * - 读取直接子节点中非空的 Title（不含子元素标签）
 * - 遇到重复属性、未闭合标签、解码/解析错误或空标题时返回 null
 */
export function parseComicInfoTitle(input: string | Uint8Array): string | null {
  const raw = typeof input === 'string' ? input : decodeComicInfoXml(input)
  if (!raw) return null
  const xmlText = raw.replace(/^\uFEFF/, '').trim()
  if (!xmlText || typeof DOMParser === 'undefined') return null

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  } catch {
    return null
  }
  if (doc.getElementsByTagName('parsererror').length > 0 || doc.querySelector?.('parsererror')) {
    return null
  }

  const root = doc.documentElement
  if (!root || (root.localName || root.tagName) !== 'ComicInfo') {
    return null
  }

  const children = root.children
    ? Array.from(root.children)
    : Array.from(root.childNodes ?? []).filter((n): n is Element => n.nodeType === 1)
  for (const child of children) {
    if ((child.localName || child.tagName) !== 'Title') continue
    const hasChildElements = child.children
      ? child.children.length > 0
      : Array.from(child.childNodes ?? []).some(n => n.nodeType === 1)
    if (hasChildElements) continue
    const title = (child.textContent ?? '').trim()
    if (title.length > 0) return title
  }
  return null
}

/** 从 ZIP 注释解析 ComicBookInfo/1.0.title */
export function parseComicBookInfoCommentTitle(comment: string): string | null {
  const trimmedComment = comment.trim()
  if (!trimmedComment) return null
  try {
    const parsed = JSON.parse(trimmedComment)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const info = (parsed as Record<string, unknown>)['ComicBookInfo/1.0']
    if (!info || typeof info !== 'object' || Array.isArray(info)) return null
    const rawTitle = (info as Record<string, unknown>).title
    if (typeof rawTitle !== 'string') return null
    const title = rawTitle.trim()
    return title.length > 0 ? title : null
  } catch {
    return null
  }
}

/** 从 ZIP 尾部 EOCD 记录读取 UTF-8 注释文本（最多只读末尾 ~64 KB） */
export async function readZipComment(blob: Blob): Promise<string> {
  const tailSize = Math.min(blob.size, 22 + 0xffff)
  if (tailSize < 22) return ''
  const tail = new Uint8Array(await blob.slice(blob.size - tailSize).arrayBuffer())
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      const commentLen = tail[i + 20] | (tail[i + 21] << 8)
      if (i + 22 + commentLen <= tail.length) {
        if (commentLen === 0) return ''
        return new TextDecoder('utf-8').decode(tail.subarray(i + 22, i + 22 + commentLen))
      }
    }
  }
  return ''
}

/** 同一 ZIP 归档中通过 zip.js 解析出的图片条目（与阅读器共用） */
export interface ComicZipImageEntry {
  filename: string
  rawFilename?: Uint8Array
  getData: (writer: unknown, options?: { checkSignature?: boolean }) => Promise<any>
}

export interface ComicZipSession {
  entries: Array<{
    filename: string
    rawFilename?: Uint8Array
    directory?: boolean
    getData: (writer: unknown, options?: { checkSignature?: boolean }) => Promise<any>
  }>
  imageEntries: ComicZipImageEntry[]
  close(): Promise<void>
}

/**
 * 使用 zip.js 打开 CBZ（或转换后的 CBZ），按统一规则筛选并自然排序可读图片条目。
 * 导入校验与阅读器逐页读取共用此函数，避免不同 ZIP 库对 Unicode Path 扩展字段解码不一致。
 */
export async function openComicZipSession(blob: Blob): Promise<ComicZipSession> {
  // @ts-expect-error foliate-js internal vendor module has no TypeScript declarations
  const { configure, ZipReader, BlobReader } = await import('foliate-js/vendor/zip.js')
  configure({ useWebWorkers: false })
  const reader = new ZipReader(new BlobReader(blob))
  try {
    const entries: ComicZipSession['entries'] = await reader.getEntries()
    const imageEntries = entries
      .filter(e => !e.directory && isComicImagePath(e.filename))
      .sort((a, b) => compareComicImageNames(a.filename, b.filename))
    return {
      entries,
      imageEntries,
      close: () => reader.close().catch(() => {}),
    }
  } catch (e) {
    await reader.close().catch(() => {})
    throw e
  }
}

/** 按具体 ZIP 条目按需读取图片 Blob，并启用 ZIP CRC-32 校验 */
export async function readComicZipImageBlob(entry: ComicZipImageEntry): Promise<Blob> {
  // @ts-expect-error foliate-js internal vendor module has no TypeScript declarations
  const { BlobWriter } = await import('foliate-js/vendor/zip.js')
  const blob: Blob = await entry.getData(
    new BlobWriter(comicImageMime(entry.filename)),
    { checkSignature: true },
  )
  if (!blob || blob.size === 0) {
    throw new Error('Empty comic page')
  }
  return blob
}

function rawZipPathKey(entry: ComicZipImageEntry): string {
  if (entry.rawFilename?.length) {
    return new TextDecoder('latin1').decode(entry.rawFilename)
  }
  return entry.filename
}

function rawZipPathLabel(entry: ComicZipImageEntry): string {
  if (entry.rawFilename?.length) {
    return new TextDecoder('utf-8', { fatal: false }).decode(entry.rawFilename)
  }
  return entry.filename
}

/** 检查原始路径与解码后路径是否重复（防止 Unicode Path 扩展字段伪装不同名称导致条目歧义） */
export function assertNoDuplicateComicImagePaths(imageEntries: ComicZipImageEntry[]): void {
  const seenRaw = new Set<string>()
  const seenDecoded = new Set<string>()
  for (const entry of imageEntries) {
    const rawKey = rawZipPathKey(entry)
    if (seenRaw.has(rawKey)) {
      throw new ComicImportError(`压缩包内存在重复图片路径: ${rawZipPathLabel(entry)}`)
    }
    seenRaw.add(rawKey)

    if (seenDecoded.has(entry.filename)) {
      throw new ComicImportError(`压缩包内存在重复图片路径: ${entry.filename}`)
    }
    seenDecoded.add(entry.filename)
  }
}

/**
 * 读取 CBZ（或由 CBR 转换得到的 CBZ）的内嵌书名与首页封面。
 * - 按阅读器的图片筛选和排序规则取实际首页，用 WebView 图片解码能力验证其可正常打开；解码失败则抛错。
 * - 读取 ComicInfo.xml 候选时启用 ZIP CRC 校验 (`checkSignature: true`)，只有 CRC 校验与 XML 解析都成功才采用该标题。
 */
export async function extractComicMeta(
  file: File,
  options: { allowZipComment: boolean },
): Promise<{ title: string; cover?: Blob }> {
  return openBookWithFileFallback(file, async target => {
    // @ts-expect-error foliate-js internal vendor module has no TypeScript declarations
    const { BlobWriter } = await import('foliate-js/vendor/zip.js')
    const session = await openComicZipSession(target)
    try {
      const { entries, imageEntries } = session
      if (!imageEntries.length) {
        throw new Error('No supported image files in archive')
      }

      assertNoDuplicateComicImagePaths(imageEntries)

      const firstCoverBlob = await readComicZipImageBlob(imageEntries[0])
      await verifyDecodableComicImage(firstCoverBlob)
      const cover: Blob = firstCoverBlob

      let title = ''
      const xmlCandidates = sortComicInfoCandidates(
        entries.filter(e => !e.directory),
        e => e.filename,
      )
      for (const candidate of xmlCandidates) {
        try {
          const xmlBlob: Blob = await candidate.getData(
            new BlobWriter('application/xml'),
            { checkSignature: true },
          )
          const xmlBytes = new Uint8Array(await xmlBlob.arrayBuffer())
          const parsedTitle = parseComicInfoTitle(xmlBytes)
          if (parsedTitle) {
            title = parsedTitle
            break
          }
        } catch {
          /* 单个 ComicInfo.xml CRC 校验、解压或解析失败，跳过当前候选继续尝试其他候选 */
        }
      }

      if (!title && options.allowZipComment) {
        try {
          const comment = await readZipComment(target)
          const commentTitle = parseComicBookInfoCommentTitle(comment)
          if (commentTitle) title = commentTitle
        } catch {
          /* 注释读取失败继续回退文件名 */
        }
      }

      return { title, cover }
    } finally {
      await session.close()
    }
  })
}
