/**
 * 本地漫画 (CBZ / CBR) 阅读加载: 从书库拿文件, 共用 comicMeta.ts 的 zip.js 条目解析，
 * 按具体 ZIP 条目按页按需解包成图片 object URL 交给漫画阅读器渲染。
 *
 * CBR 先用原生缓存或 cbrToCbz (unrar wasm) 转成 CBZ 再按页读取。
 * 配合阅读器 LRU 回收策略，只保留当前页附近的少量图片在内存中。
 */
import { getStorage } from '../storage'
import { cbrToCbz } from './comic'
import { openComicZipSession, readComicZipImageBlob, type ComicZipSession } from './comicMeta'
import { t } from '../i18n'

export interface LocalComicPage {
  id: string
  url: string
}

export interface LocalComic {
  title: string
  pages: LocalComicPage[]
}

export interface LocalComicArchive {
  title: string
  pageIds: string[]
  /** 按具体 ZIP 条目按需解压单页并返回 object URL（由调用方负责 revoke） */
  readPageUrl(index: number): Promise<string>
  /** 释放 ZIP 读取会话 */
  close(): void
}

async function resolveComicZipBlob(bookId: string): Promise<{ title: string; file: Blob }> {
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
  return { title: book.title, file }
}

/** 打开本地漫画归档：使用 zip.js 扫描目录结构并保存具体条目引用，阅读时按页按需解压 */
export async function openLocalComicArchive(bookId: string): Promise<LocalComicArchive> {
  const { title, file } = await resolveComicZipBlob(bookId)
  let session: ComicZipSession | null
  try {
    session = await openComicZipSession(file)
  } catch {
    throw new Error(t('library.rarNoImages'))
  }
  if (!session.imageEntries.length) {
    await session.close()
    throw new Error(t('library.rarNoImages'))
  }

  const pageIds = session.imageEntries.map(entry => entry.filename)

  return {
    title,
    pageIds,
    async readPageUrl(index: number): Promise<string> {
      if (!session) throw new Error('Local comic archive closed')
      const entry = session.imageEntries[index]
      if (!entry) throw new Error('Invalid comic page index')
      const blob = await readComicZipImageBlob(entry)
      return URL.createObjectURL(blob)
    },
    close() {
      const current = session
      session = null
      if (current) void current.close()
    },
  }
}

/** 加载本地漫画: 返回标题与图片页 (object URL, 用后需 revoke) */
export async function loadLocalComic(bookId: string): Promise<LocalComic> {
  const { title, file } = await resolveComicZipBlob(bookId)
  let session: ComicZipSession
  try {
    session = await openComicZipSession(file)
  } catch {
    throw new Error(t('library.rarNoImages'))
  }
  try {
    if (!session.imageEntries.length) {
      throw new Error(t('library.rarNoImages'))
    }
    const pages: LocalComicPage[] = []
    for (const entry of session.imageEntries) {
      const blob = await readComicZipImageBlob(entry)
      pages.push({ id: entry.filename, url: URL.createObjectURL(blob) })
    }
    return { title, pages }
  } finally {
    await session.close()
  }
}

/** 释放一批本地漫画页的 object URL */
export function revokeLocalPages(pages: LocalComicPage[]): void {
  for (const p of pages) URL.revokeObjectURL(p.url)
}
