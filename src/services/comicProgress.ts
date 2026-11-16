/**
 * 漫画阅读进度的换算 (纯函数, 可在 node 里测试).
 *
 * 书库只认 (location, progress) 两个字段: progress 是 0~1 的位置比例, location 是阅读器自己的定位串
 * (小说存 cfi, PDF/DjVu 存页码)。漫画的定位就是页码, 统一写成 `page:<1-based>`,
 * 和 existing 的 DjVu/PDF 一致, 也方便从旧进度兜底。
 *
 * 约定: 读完最后一页 = 1, 停在第 1 页 = 1/total (刚打开也有非零进度, 卡片进度条不会一直是 0)。
 */

/** 页码索引 (0-based) → 书库进度 (0~1) */
export function comicProgressOf(index: number, total: number): number {
  if (!Number.isFinite(index) || !Number.isFinite(total) || total <= 0) return 0
  const page = Math.min(Math.max(Math.floor(index) + 1, 1), total)
  return page / total
}

/** 书库进度 (0~1) → 页码索引 (0-based, 夹在有效范围内) */
export function comicPageFromProgress(progress: number, total: number): number {
  if (!Number.isFinite(progress) || !Number.isFinite(total) || total <= 0) return 0
  const page = Math.round(Math.min(Math.max(progress, 0), 1) * total)
  return Math.min(Math.max(page - 1, 0), Math.round(total) - 1)
}

/** 页码索引 (0-based) → 书库 location */
export function comicLocationOf(index: number): string {
  const safe = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0
  return `page:${safe + 1}`
}

/** 书库 location → 页码索引; 不是 `page:N` 形式返回 null (让调用方退回 progress) */
export function comicPageFromLocation(location: string | undefined | null): number | null {
  if (!location) return null
  const m = /^page:(\d{1,7})$/.exec(location.trim())
  if (!m) return null
  const page = Number(m[1])
  return page >= 1 ? page - 1 : null
}

/**
 * 续读页码: 优先 location, 退回 progress, 都没有就第 1 页; 结果夹在 [0, total-1]。
 * total 未知(0)时返回 0。
 */
export function comicResumeIndex(
  location: string | undefined | null,
  progress: number | undefined | null,
  total: number,
): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  const max = Math.round(total) - 1
  const fromLocation = comicPageFromLocation(location)
  if (fromLocation != null) return Math.min(Math.max(fromLocation, 0), max)
  if (progress != null && Number.isFinite(progress)) return comicPageFromProgress(progress, total)
  return 0
}
