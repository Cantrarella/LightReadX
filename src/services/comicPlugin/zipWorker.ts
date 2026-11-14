/**
 * CBZ 打包放进 Worker: 110 页 × 几百 KB 的 zip 在主线程做会把界面卡死几秒,
 * 期间连进度条都不跳, 看起来像卡住了。
 */
import { zipSync } from 'fflate'

export interface ZipRequest {
  id: number
  entries: Array<{ name: string; bytes: Uint8Array }>
}

export interface ZipResponse {
  id: number
  zipped?: Uint8Array
  error?: string
}

self.onmessage = (event: MessageEvent<ZipRequest>) => {
  const { id, entries } = event.data
  try {
    const map: Record<string, Uint8Array> = {}
    for (const entry of entries) map[entry.name] = entry.bytes
    // 图片本身已是 JPEG/PNG/WebP, 存储模式即可, 再 deflate 纯浪费 CPU
    const zipped = zipSync(map, { level: 0 })
    const response: ZipResponse = { id, zipped }
    ;(self as unknown as Worker).postMessage(response, [zipped.buffer as ArrayBuffer])
  } catch (e: any) {
    const response: ZipResponse = { id, error: e?.message ?? String(e) }
    ;(self as unknown as Worker).postMessage(response)
  }
}
