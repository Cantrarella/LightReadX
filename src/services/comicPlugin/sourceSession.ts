import type { ComicPaging, ComicSearchItem } from './types.ts'
import type { DiscoverHome, DiscoverItem, DiscoverPage, FilterField, ComicListScene } from './discover.ts'

export type DiscoverOverlaySnapshot =
  | { kind: 'scene'; scene: ComicListScene; title: string; items: DiscoverItem[]; page: number; max: boolean; extern?: Record<string, unknown>; filters: FilterField[]; filterSelection: Record<string, number>; childSelection: Record<string, number> }
  | { kind: 'function'; id: string; title: string; page: DiscoverPage | null }

export interface ComicSourceSession {
  detailOrigin: 'browse' | 'search'
  keyword: string
  page: number
  items: ComicSearchItem[]
  paging?: ComicPaging
  viewScrollTop: { browse: number; search: number }
  discoverHome?: DiscoverHome | null
  discoverTab?: string
  discoverOverlay?: DiscoverOverlaySnapshot | null
  discoverHomeScrollTop?: number
}

const MAX_SESSIONS = 4
const sessions = new Map<string, ComicSourceSession>()

function createDefault(): ComicSourceSession {
  return {
    detailOrigin: 'browse',
    keyword: '',
    page: 1,
    items: [],
    viewScrollTop: { browse: 0, search: 0 },
  }
}

/** 读取指定漫画源的会话快照 */
export function getSourceSession(uuid: string): ComicSourceSession | undefined {
  const existing = sessions.get(uuid)
  if (existing) {
    sessions.delete(uuid)
    sessions.set(uuid, existing)
  }
  return existing
}

/** 增量保存指定漫画源的会话快照（跳转阅读器返回后复原列表与滚动位置） */
export function saveSourceSession(uuid: string, patch: Partial<ComicSourceSession>): ComicSourceSession {
  const prev = sessions.get(uuid) ?? createDefault()
  const next: ComicSourceSession = {
    ...prev,
    ...patch,
    viewScrollTop: patch.viewScrollTop
      ? { ...prev.viewScrollTop, ...patch.viewScrollTop }
      : prev.viewScrollTop,
  }
  sessions.delete(uuid)
  sessions.set(uuid, next)
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value
    if (oldest !== undefined) sessions.delete(oldest)
    else break
  }
  return next
}

/** 彻底离开漫画源回到漫画列表时清理会话 */
export function clearSourceSession(uuid: string): void {
  sessions.delete(uuid)
}
