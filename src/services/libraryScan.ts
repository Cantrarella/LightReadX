/**
 * 书库根目录「散文件」扫描收录。
 *
 * 天哥的需求: 书库目录可以改, 往里面直接丢 cbz/epub/pdf 等, 应用能收进来读。
 * 策略 (2026-11-14 定): 手动触发 → 只扫根目录第一层的散文件 (不递归子目录),
 * 收进 books/<id>/ 后删掉原位 (「搬走」, 不是复制)。
 *
 * 只在桌面端 (Tauri) 提供: 移动端沙盒没有可遍历的目录。
 */
import { getLibraryRoot, isTauri } from '../storage/types'
import { detectReadableFormat } from './plainText'

interface LooseScannedFile {
  path: string
  name: string
  absPath: string
  size: number
  lastModified?: number
}

export interface LooseScanResult {
  /** 收进藏书的本数 */
  imported: number
  /** 跳过 (格式不支持) 的文件名 */
  skipped: string[]
  /** 收进失败 (入库报错) 的文件名 */
  failed: string[]
}

/** 书库根目录的绝对路径 (自定义优先, 否则默认应用数据目录) */
export async function libraryRootPath(): Promise<string> {
  const custom = getLibraryRoot().replace(/[\\/]+$/, '')
  if (custom) return custom
  const { appDataDir } = await import('@tauri-apps/api/path')
  return (await appDataDir()).replace(/[\\/]+$/, '')
}

/** 用 folder_scan (无 scope 校验, 只读文件系统) 扫书库根目录 */
async function scanLibraryRoot(root: string): Promise<LooseScannedFile[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  const res = await invoke<{ entries: LooseScannedFile[]; truncated: boolean }>('folder_scan', {
    root, maxFiles: 5000, maxDepth: 1, skipDirs: [],
  })
  return res.entries
}

/**
 * 扫书库根目录第一层, 收进可读格式的散文件, 成功后删原位。
 * onProgress(收进第几本/总数) 用于界面展示进度。
 */
export async function importLibraryLooseFiles(
  onProgress?: (done: number, total: number) => void,
): Promise<LooseScanResult> {
  const root = await libraryRootPath()

  const entries = await scanLibraryRoot(root)
  // 只取根目录第一层 (path 不含 `/`) 的散文件, 排除目录与 books/ 下的
  const loose = entries.filter(e => {
    if (!e.absPath) return false
    if (e.path.includes('/') || e.path.includes('\\')) return false
    return !!detectReadableFormat(e.name)
  })

  const result: LooseScanResult = { imported: 0, skipped: [], failed: [] }
  const skipped: string[] = []
  // 也统计一下根目录里不可读的文件 (供提示); 书库自身的 db 文件静默跳过
  for (const e of entries) {
    if (e.path.includes('/') || e.path.includes('\\')) continue
    if (isLooseInternal(e.name)) continue
    if (!detectReadableFormat(e.name)) skipped.push(e.name)
  }
  result.skipped = skipped

  const { importFile } = await import('./importer')
  const { readFile, remove } = await import('@tauri-apps/plugin-fs')

  let done = 0
  for (const entry of loose) {
    try {
      // 散文件本就在书库目录里, 直接读字节入库 (addBook 走 WebView, 不查 fs scope;
      // 走 stageBookFromPath 会卡在 library_import_copy 的 scope 校验上)。
      const bytes = await readFile(entry.absPath!)
      const file = new File([bytes as Uint8Array<ArrayBuffer>], entry.name, { lastModified: entry.lastModified })
      const r = await importFile(file, '本地导入')
      if (!r.ok) throw new Error(r.error)
      // 入库成功后搬走原位 (删掉)
      try { await remove(entry.absPath!) } catch { /* 删不掉就留着, 不阻断 */ }
      result.imported++
    } catch {
      result.failed.push(entry.name)
    }
    done++
    onProgress?.(done, loose.length)
  }
  return result
}

/** 书库自身的管理文件, 扫描时静默跳过 (不计入「不支持」) */
const LIBRARY_INTERNAL = new Set(['lightread.db', 'lightread.db-shm', 'lightread.db-wal'])

/** 供界面判断: 当前环境是否支持扫描书库散文件 (桌面端) */
export function canScanLibraryLoose(): boolean {
  return isTauri()
}

function isLooseInternal(name: string): boolean {
  return LIBRARY_INTERNAL.has(name.toLowerCase())
}
