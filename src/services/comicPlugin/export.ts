/**
 * 漫画导出: 把已下载的 CBZ 转成 PDF。
 *
 * 下载产物本身就是 CBZ (漫画 zip), 这里用 fflate 解开取图, 再把每页图片
 * 塞进 jspdf 生成 PDF。webp 图片 jspdf 不直接支持, 先经 canvas 转成 jpeg。
 * 图片→PDF 是纯前端重活, 大章节会卡界面, 所以按页拆分、让出主线程给进度条。
 */
import { unzipSync } from 'fflate'
import { jsPDF } from 'jspdf'
import { getStorage } from '../../storage'
import { revealStoredBook } from '../pdfFileActions'
import type { BookMeta } from '../../storage/types'

/** 支持的图片扩展名 (CBZ 里常见) */
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i

export interface ExportProgress {
  loaded: number
  total: number
  message?: string
}

export interface ExportResult {
  ok: boolean
  fileName?: string
  error?: string
}

/** 解码图片字节 → HTMLImageElement (img 支持 jpeg/png/webp/gif; bmp/avif 交给 canvas 兜底失败) */
function decodeImage(bytes: Uint8Array, mime: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes as BlobPart], { type: mime })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`图片解码失败 (${mime})`)) }
    img.src = url
  })
}

/** 把任意图片画到 canvas, 统一输出 jpeg (jspdf 最稳的嵌入格式) */
function toJpeg(img: HTMLImageElement): { data: string; width: number; height: number } {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 canvas')
  // 白底: 透明 PNG 直接转 jpeg 会变黑, 先铺白
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0)
  return {
    data: canvas.toDataURL('image/jpeg', 0.92),
    width: img.naturalWidth,
    height: img.naturalHeight,
  }
}

function extMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'avif') return 'image/avif'
  return 'image/jpeg'
}

/** 让出主线程, 给进度条一个刷新的机会 */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * 把一本 CBZ 转成 PDF Blob。
 * onProgress 每页回调一次 (loaded 递增, total 为图片总页数)。
 */
export async function cbzToPdfBlob(
  cbz: Blob,
  onProgress?: (p: ExportProgress) => void,
): Promise<Blob> {
  const bytes = new Uint8Array(await cbz.arrayBuffer())
  const entries = unzipSync(bytes)

  // 按文件名排序, 保证阅读顺序 (pageFileName 已带零填充序号)
  const pages = Object.keys(entries)
    .filter(name => IMAGE_EXT.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  if (!pages.length) throw new Error('这本漫画里没有图片')

  const pdf = new jsPDF({
    unit: 'px',
    format: 'a4',
    compress: true,
    hotfixes: ['px_scaling'],
  })

  for (let i = 0; i < pages.length; i++) {
    const name = pages[i]
    const mime = extMime(name)
    const img = await decodeImage(entries[name], mime)
    const { data, width, height } = toJpeg(img)

    // 第一页用 jsPDF 默认的那一页, 之后每页 addPage 一张
    if (i > 0) pdf.addPage([width, height], 'portrait')
    else pdf.setPage(1)
    // 页面尺寸贴合图片宽高 (px 单位), 图片铺满整页
    pdf.internal.pageSize.width = width
    pdf.internal.pageSize.height = height
    pdf.addImage(data, 'JPEG', 0, 0, width, height, undefined, 'FAST')

    onProgress?.({ loaded: i + 1, total: pages.length })
    // 每页让出主线程, 避免长章节卡死进度条
    await tick()
  }

  return pdf.output('blob')
}

/**
 * 按书名/章节名生成安全的 PDF 文件名 (去掉非法字符)。
 */
export function pdfFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120)
  return `${base || 'comic'}.pdf`
}

/** 单本导出: 读藏书文件 → 转 PDF → 弹系统另存为 */
export async function exportBookToPdf(
  bookId: string,
  onProgress?: (p: ExportProgress) => void,
): Promise<ExportResult> {
  try {
    const storage = await getStorage()
    const meta = await storage.getBook(bookId)
    if (!meta) return { ok: false, error: '书不存在' }
    const file = await storage.getBookFile(bookId)
    const blob = await cbzToPdfBlob(file, onProgress)
    const { savePdfAs } = await import('../pdfFileActions')
    const ok = await savePdfAs(blob, pdfFileName(meta.title))
    return ok ? { ok: true, fileName: pdfFileName(meta.title) } : { ok: false, error: '已取消' }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
}

/** 在资源管理器中定位已下载的 CBZ 文件 (「打开所在文件夹」) */
export async function openBookFolder(bookId: string): Promise<ExportResult> {
  try {
    const storage = await getStorage()
    const meta = await storage.getBook(bookId)
    if (!meta) return { ok: false, error: '书不存在' }
    await revealStoredBook(meta as BookMeta)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
}
