/**
 * 章节正文缓存（离线阅读）。
 *
 * 只缓存「正文」（每章文字），存本地：
 *  - 桌面 (Tauri)：复用 lightread.db（tauri-plugin-sql），加表 book_chapters
 *  - Web：降级 localStorage（数据量小够用）
 *
 * 键：bookKey（书源 URL + 书名 + 作者）+ chapterUrl，正文按章存。
 */
import { isTauri, getLibraryRoot } from '../../storage/types.ts'

/** 缓存的章节正文 */
export interface CachedChapter {
  /** 章节名 */
  name: string
  /** 章节 URL（书源内的相对/绝对地址，作唯一键） */
  url: string
  /** 正文文本 */
  text: string
  /** 缓存时间 */
  cachedAt: number
}

const LS_PREFIX = 'lrx-chapter-cache:'

/** 存储后端统一接口 */
interface ChapterCacheBackend {
  init(): Promise<void>
  get(bookKey: string, chapterUrl: string): Promise<CachedChapter | undefined>
  put(bookKey: string, chapter: CachedChapter): Promise<void>
  /** 列出某本书已缓存的章节 */
  list(bookKey: string): Promise<CachedChapter[]>
  /** 删除某本书的全部缓存 */
  clear(bookKey: string): Promise<void>
  /** 删除单个章节缓存 */
  remove(bookKey: string, chapterUrl: string): Promise<void>
}

// ---------------------------------------------------------------------------
// 后端：localStorage（Web 兜底）
// ---------------------------------------------------------------------------

class LocalStorageCache implements ChapterCacheBackend {
  private key(bookKey: string) { return LS_PREFIX + bookKey }
  private map(bookKey: string): Record<string, CachedChapter> {
    try {
      const raw = localStorage.getItem(this.key(bookKey))
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  }
  private write(bookKey: string, m: Record<string, CachedChapter>) {
    try { localStorage.setItem(this.key(bookKey), JSON.stringify(m)) } catch { /* 满了忽略 */ }
  }
  async init() {}
  async get(bookKey: string, chapterUrl: string) {
    return this.map(bookKey)[chapterUrl]
  }
  async put(bookKey: string, chapter: CachedChapter) {
    const m = this.map(bookKey)
    m[chapter.url] = chapter
    this.write(bookKey, m)
  }
  async list(bookKey: string) {
    return Object.values(this.map(bookKey))
  }
  async clear(bookKey: string) {
    try { localStorage.removeItem(this.key(bookKey)) } catch { /* ignore */ }
  }
  async remove(bookKey: string, chapterUrl: string) {
    const m = this.map(bookKey)
    delete m[chapterUrl]
    this.write(bookKey, m)
  }
}

// ---------------------------------------------------------------------------
// 后端：SQLite（桌面 Tauri，复用 lightread.db）
// ---------------------------------------------------------------------------

type SqlDatabase = {
  execute(sql: string, values?: unknown[]): Promise<unknown>
  select<T>(sql: string, values?: unknown[]): Promise<T>
}

class SqliteCache implements ChapterCacheBackend {
  private db!: SqlDatabase

  async init() {
    const { default: Database } = await import('@tauri-apps/plugin-sql')
    const root = getLibraryRoot().replace(/\/+$/, '')
    this.db = await Database.load(
      root ? `sqlite:${root}/lightread.db` : 'sqlite:lightread.db')
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS book_chapters (
        book_key TEXT NOT NULL,
        chapter_url TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        cached_at INTEGER NOT NULL,
        PRIMARY KEY (book_key, chapter_url)
      );
      CREATE INDEX IF NOT EXISTS idx_book_chapters_book ON book_chapters(book_key);
    `)
  }

  async get(bookKey: string, chapterUrl: string) {
    const rows = await this.db.select<Array<{ name: string; text: string; cached_at: number }>>(
      'SELECT name, text, cached_at FROM book_chapters WHERE book_key = $1 AND chapter_url = $2',
      [bookKey, chapterUrl])
    if (!rows[0]) return undefined
    return { name: rows[0].name, url: chapterUrl, text: rows[0].text, cachedAt: rows[0].cached_at }
  }

  async put(bookKey: string, chapter: CachedChapter) {
    await this.db.execute(
      `INSERT OR REPLACE INTO book_chapters (book_key, chapter_url, name, text, cached_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [bookKey, chapter.url, chapter.name, chapter.text, chapter.cachedAt])
  }

  async list(bookKey: string) {
    const rows = await this.db.select<Array<{ chapter_url: string; name: string; text: string; cached_at: number }>>(
      'SELECT chapter_url, name, text, cached_at FROM book_chapters WHERE book_key = $1 ORDER BY cached_at',
      [bookKey])
    return rows.map(r => ({ name: r.name, url: r.chapter_url, text: r.text, cachedAt: r.cached_at }))
  }

  async clear(bookKey: string) {
    await this.db.execute('DELETE FROM book_chapters WHERE book_key = $1', [bookKey])
  }

  async remove(bookKey: string, chapterUrl: string) {
    await this.db.execute(
      'DELETE FROM book_chapters WHERE book_key = $1 AND chapter_url = $2',
      [bookKey, chapterUrl])
  }
}

// ---------------------------------------------------------------------------
// 单例封装
// ---------------------------------------------------------------------------

let ready: Promise<ChapterCacheBackend> | null = null

function getBackend(): Promise<ChapterCacheBackend> {
  if (!ready) {
    ready = (async () => {
      const b = isTauri() ? new SqliteCache() : new LocalStorageCache()
      await b.init()
      return b
    })()
  }
  return ready
}

/** 由书源 URL + 书名 + 作者生成缓存键，避免不同源的同名书共用正文缓存。 */
export function chapterCacheKey(name: string, author: string, sourceUrl: string): string {
  return JSON.stringify([sourceUrl, name, author])
}

export async function cacheChapter(bookKey: string, chapter: CachedChapter): Promise<void> {
  const b = await getBackend()
  await b.put(bookKey, chapter)
}

export async function getCachedChapter(bookKey: string, chapterUrl: string): Promise<CachedChapter | undefined> {
  const b = await getBackend()
  return b.get(bookKey, chapterUrl)
}

export async function listCachedChapters(bookKey: string): Promise<CachedChapter[]> {
  const b = await getBackend()
  return b.list(bookKey)
}

export async function clearBookCache(bookKey: string): Promise<void> {
  const b = await getBackend()
  await b.clear(bookKey)
}

export async function removeCachedChapter(bookKey: string, chapterUrl: string): Promise<void> {
  const b = await getBackend()
  await b.remove(bookKey, chapterUrl)
}
