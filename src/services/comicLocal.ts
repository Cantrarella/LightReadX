/**
 * 本地漫画 (CBZ / CBR) 阅读加载: 从书库拿文件, 解包成图片页列表, 交给漫画阅读器渲染。
 *
 * CBZ 用 fflate 直接解 zip; CBR 先用现有的 cbrToCbz (unrar wasm) 转成 CBZ 再解。
 * 与 foliate 的 makeComicBook 不同, 这里直接产出图片的 object URL, 供 <img> 使用,
 * 复用漫画阅读器那一套缩放 / 单页 / 长条 UI。
 */
import { unzipSync, type Unzipped } from 'fflate'
import { getStorage } from '../storage'
import { cbrToCbz } from './comic'
import { t } from '../i18n'

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i

export interface LocalComicPage {
  id: string
  url: string
}

export interface LocalComic {
  title: string
  pages: LocalComicPage[]
}

/** 从 zip 字节里挑出图片条目, 按文件名排序 (维持阅读顺序) */
function imagesFromZip(data: Uint8Array): LocalComicPage[] {
  let unzipped: Unzipped
  try {
    unzipped = unzipSync(data)
  } catch {
    throw new Error(t('library.rarNoImages'))
  }
  const names = Object.keys(unzipped)
    .filter(name => IMAGE_RE.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  if (!names.length) throw new Error(t('library.rarNoImages'))

  return names.map(name => {
    const bytes = unzipped[name]
    const blob = new Blob([bytes], { type: mimeFor(name) })
    return { id: name, url: URL.createObjectURL(blob) }
  })
}

function mimeFor(name: string): string {
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

/** 加载本地漫画: 返回标题与图片页 (object URL, 用后需 revoke) */
export async function loadLocalComic(bookId: string): Promise<LocalComic> {
  const storage = await getStorage()
  const book = await storage.getBook(bookId)
  if (!book) throw new Error(t('library.bookMissing'))

  let file: Blob
  if (book.format === 'cbr') {
    // 桌面原生缓存优先, 否则 wasm 现场转换
    const cached = await storage.getComicCbz?.(bookId)
    if (cached) file = cached
    else file = await cbrToCbz(await storage.getBookFile(bookId))
  } else {
    file = await storage.getBookFile(bookId)
  }

  const data = new Uint8Array(await file.arrayBuffer())
  const pages = imagesFromZip(data)
  return { title: book.title, pages }
}

/** 释放一批本地漫画页的 object URL */
export function revokeLocalPages(pages: LocalComicPage[]): void {
  for (const p of pages) URL.revokeObjectURL(p.url)
}
