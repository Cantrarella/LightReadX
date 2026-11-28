import type { BookMeta } from '../storage/types.ts'

function storedExt(fileName: string, fallbackFormat: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.fb2.zip')) return 'fb2.zip'
  const dot = fileName.lastIndexOf('.')
  if (dot !== -1 && dot < fileName.length - 1) return fileName.slice(dot + 1)
  return fallbackFormat || 'bin'
}

/** 计算书库文件在存储根目录下的相对路径（与 TauriStorage.bookPath 一致） */
export function bookStoredRelPath(book: Pick<BookMeta, 'id' | 'fileName' | 'format'>): string {
  const ext = book.fileName.toLowerCase().endsWith('.fb2.zip')
    ? 'fb2.zip'
    : book.fileName.split('.').pop() || book.format || 'bin'
  return `books/${book.id}.${ext}`
}

/** 按漫画/书籍标题生成安全的导出文件名（替换 Windows 非法字符，保留原文件扩展名） */
const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i

export function exportFileName(book: Pick<BookMeta, 'title' | 'fileName' | 'format'>): string {
  const ext = storedExt(book.fileName, book.format)
  const rawBase = (book.title || '').trim()
  const fallbackBase = book.fileName.replace(/\.[^.]+$/, '').trim() || 'book'
  const cleaned = (rawBase || fallbackBase)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120)
  const base = cleaned || 'book'
  const suffix = `.${ext}`
  const withExt = base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : `${base}${suffix}`
  const firstDot = withExt.indexOf('.')
  const head = (firstDot === -1 ? withExt : withExt.slice(0, firstDot)).replace(/ +$/g, '')
  return WINDOWS_RESERVED_NAME_RE.test(head) ? `_${withExt}` : withExt
}

export interface BatchExportResult {
  exported: number
  failed: number
  firstError?: string
  dir: string
}

/** 单本导出：弹出系统「另存为」框，默认填好与书名一致的文件名，Rust 端直接复制源文件（零内存占用） */
export async function exportSingleBook(book: BookMeta): Promise<boolean> {
  const defaultName = exportFileName(book)
  const ext = storedExt(book.fileName, book.format)
  const filterExt = ext === 'fb2.zip' ? 'zip' : ext
  const [{ save }, { invoke }, { getLibraryRoot }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/api/core'),
    import('../storage'),
  ])
  const dest = await save({
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [filterExt] }],
  })
  if (!dest) return false
  await invoke('library_file_export', {
    root: getLibraryRoot(),
    rel: bookStoredRelPath(book),
    dest,
  })
  return true
}

/** 批量导出到指定文件夹：只选一次目标目录，重名自动追加 (2)/(3) 后缀；单本失败不阻塞其余文件 */
export async function exportBooksToFolder(
  books: BookMeta[],
): Promise<BatchExportResult | null> {
  if (!books.length) return null
  const [{ open }, { invoke }, { getLibraryRoot }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/api/core'),
    import('../storage'),
  ])
  const selected = await open({ directory: true, multiple: false })
  if (!selected || typeof selected !== 'string') return null
  const root = getLibraryRoot()
  let exported = 0
  let failed = 0
  let firstError: string | undefined
  for (const book of books) {
    try {
      await invoke<string>('library_file_export_to_dir', {
        root,
        rel: bookStoredRelPath(book),
        dir: selected,
        fileName: exportFileName(book),
      })
      exported++
    } catch (err) {
      failed++
      if (!firstError) firstError = err instanceof Error ? err.message : String(err)
    }
  }
  return { exported, failed, firstError, dir: selected }
}
