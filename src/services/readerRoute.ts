import type { BookMeta } from '../storage'
import { isComicFormat } from './comicFormat'

/** 书 → 阅读器路由: PDF 统一走论文阅读器, DjVu 走专用阅读器, 漫画 (CBZ/CBR) 走漫画阅读器, 其余走 foliate */
export function readerPath(book: Pick<BookMeta, 'id' | 'format'>): string {
  if (book.format === 'pdf') return `/read-paper/${book.id}`
  if (book.format === 'djvu') return `/read-djvu/${book.id}`
  if (isComicFormat(book.format)) return `/read/comic-local/${book.id}`
  return `/read/${book.id}`
}
