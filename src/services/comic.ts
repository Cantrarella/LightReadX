/** CBR (RAR 漫画包) → CBZ 转换: unrar wasm 解包图片与可选的 ComicInfo.xml, fflate 重打包 zip */
import { zipSync } from 'fflate'
import { t } from '../i18n'
import { isComicImagePath, isComicInfoPath } from './comicMeta'

let wasmBinary: ArrayBuffer | null = null

async function extractRarEntries(
  data: ArrayBuffer,
  wasm: ArrayBuffer,
  includeComicInfo: boolean,
): Promise<Record<string, [Uint8Array, { level: 0 }]>> {
  const { createExtractorFromData } = await import('node-unrar-js/esm')
  const extractor = await createExtractorFromData({
    data,
    wasmBinary: wasm,
  })
  const { files } = extractor.extract({
    files: fileHeader =>
      !fileHeader.flags.directory
      && (isComicImagePath(fileHeader.name) || (includeComicInfo && isComicInfoPath(fileHeader.name))),
  })

  const entries: Record<string, [Uint8Array, { level: 0 }]> = {}
  let imageCount = 0
  for (const file of files) {
    if (file.fileHeader.flags.directory || !file.extraction) continue
    const isImg = isComicImagePath(file.fileHeader.name)
    if (!isImg && !(includeComicInfo && isComicInfoPath(file.fileHeader.name))) continue
    // 压缩包内路径拍平避免特殊字符问题, 保留原名以维持阅读顺序
    const name = file.fileHeader.name.replace(/\\/g, '/')
    if (name in entries) continue
    entries[name] = [file.extraction, { level: 0 }]
    if (isImg) imageCount++
  }
  if (!imageCount) throw new Error(t('library.rarNoImages'))
  return entries
}

export async function cbrToCbz(blob: Blob): Promise<Blob> {
  if (!wasmBinary) {
    const wasmUrl = (await import('node-unrar-js/esm/js/unrar.wasm?url')).default
    wasmBinary = await (await fetch(wasmUrl)).arrayBuffer()
  }
  const data = await blob.arrayBuffer()
  let entries: Record<string, [Uint8Array, { level: 0 }]>
  try {
    entries = await extractRarEntries(data, wasmBinary, true)
  } catch (err: any) {
    // ComicInfo.xml 视为可选条目：若读取该条目遇到 CRC 或解压错误，通过仅图片路径重新打开原始 RAR 并转换
    if (typeof err?.file === 'string' && isComicInfoPath(err.file)) {
      entries = await extractRarEntries(data, wasmBinary, false)
    } else {
      throw err
    }
  }
  const zipped = zipSync(entries)
  return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/vnd.comicbook+zip' })
}
