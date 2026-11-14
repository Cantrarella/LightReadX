/** 漫画格式: 书库里这些格式只在「漫画」页展示, 藏书页不显示 */
export const COMIC_FORMATS = ['cbz', 'cbr'] as const

export function isComicFormat(format: string): boolean {
  return (COMIC_FORMATS as readonly string[]).includes((format || '').toLowerCase())
}
