/**
 * 书源存储 (Pinia store)。
 *
 * 管理 Legado JSON 书源：导入（单文件/批量/远程订阅）、列表。
 * 数据持久化到 localStorage（桌面 Tauri 与网页版共用），键名 lrx-book-sources。
 *
 * 说明：书源数据量小（通常几百条 JSON），用 localStorage 足够；
 * 若后续需要跨设备同步，可再接入 sync 层或 SQLite。
 */
import { defineStore } from 'pinia'
import type { BookSource } from '../services/legado/types'

const STORAGE_KEY = 'lrx-book-sources'

/** 书源记录 */
export interface BookSourceRecord {
  /** 本地唯一 id（由 bookSourceUrl 或随机生成） */
  id: string
  /** 完整书源 JSON */
  source: BookSource
  /** 是否启用 */
  enabled: boolean
  /** 导入时间 */
  addedAt: number
}

interface BookSourceState {
  /** 全部书源记录 */
  records: BookSourceRecord[]
  /** 是否已从 localStorage 加载 */
  loaded: boolean
}

function loadFromStorage(): BookSourceRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persist(records: BookSourceRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  } catch (err) {
    console.warn('[book-source] 持久化失败', err)
  }
}

/** 由书源生成稳定 id（优先 bookSourceUrl，重复时加序号） */
function sourceId(source: BookSource, existing: BookSourceRecord[]): string {
  const base = source.bookSourceUrl || source.bookSourceName || 'unknown'
  let id = base
  let i = 2
  while (existing.some(r => r.id === id)) {
    id = `${base}#${i++}`
  }
  return id
}

export const useBookSourceStore = defineStore('bookSources', {
  state: (): BookSourceState => ({
    records: [],
    loaded: false,
  }),

  getters: {
    /** 启用的书源 */
    enabledSources(state): BookSourceRecord[] {
      return state.records.filter(r => r.enabled)
    },
    /** 书源总数 */
    count(state): number {
      return state.records.length
    },
  },

  actions: {
    /** 从 localStorage 加载（幂等） */
    load() {
      if (this.loaded) return
      this.records = loadFromStorage()
      this.loaded = true
    },

    /**
     * 导入书源。支持：
     *  - 单个书源对象
     *  - 书源数组
     *  - 带 bookSourceUrl 的旧格式（自动规范化）
     * @returns 导入数量
     */
    importSources(input: unknown): number {
      const list: BookSource[] = []
      if (Array.isArray(input)) {
        for (const item of input) {
          if (item && typeof item === 'object' && (item as BookSource).bookSourceUrl) {
            list.push(item as BookSource)
          }
        }
      } else if (input && typeof input === 'object' && (input as BookSource).bookSourceUrl) {
        list.push(input as BookSource)
      }

      if (list.length === 0) return 0

      let added = 0
      for (const source of list) {
        // 去重：同 bookSourceUrl 且同名则跳过
        const dup = this.records.some(
          r => r.source.bookSourceUrl === source.bookSourceUrl && r.source.bookSourceName === source.bookSourceName,
        )
        if (dup) continue
        this.records.push({
          id: sourceId(source, this.records),
          source,
          enabled: source.enabled ?? true,
          addedAt: Date.now(),
        })
        added++
      }
      if (added > 0) persist(this.records)
      return added
    },

    /** 清空所有书源 */
    clearAll() {
      this.records = []
      persist(this.records)
    },

    /** 删除单个书源（按本地 id） */
    removeSource(id: string) {
      const before = this.records.length
      this.records = this.records.filter(r => r.id !== id)
      if (this.records.length !== before) persist(this.records)
    },

    /** 启用 / 停用单个书源 */
    setEnabled(id: string, enabled: boolean) {
      const rec = this.records.find(r => r.id === id)
      if (!rec || rec.enabled === enabled) return
      rec.enabled = enabled
      persist(this.records)
    },

    /** 切换单个书源启用状态，返回新状态 */
    toggleEnabled(id: string): boolean {
      const rec = this.records.find(r => r.id === id)
      if (!rec) return false
      rec.enabled = !rec.enabled
      persist(this.records)
      return rec.enabled
    },

    /** 导出全部书源为 JSON 文本（供备份/分享） */
    exportSources(): string {
      const list = this.records.map(r => r.source)
      return JSON.stringify(list, null, 2)
    },
  },
})

/** 解析 JSON 文本为书源（自动识别单个/数组/带 data 字段的订阅包） */
export function parseBookSourceJson(text: string): unknown {
  const parsed = JSON.parse(text)
  // 订阅包常见格式：{ data: [...] } 或直接数组
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.data)) return obj.data
    if (Array.isArray(obj.bookSources)) return obj.bookSources
    if (Array.isArray(obj.sources)) return obj.sources
  }
  return parsed
}
