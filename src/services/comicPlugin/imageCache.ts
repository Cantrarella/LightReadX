/**
 * 在线阅读图片缓存 (IndexedDB)。
 *
 * 在线漫画一页动辄几百 KB, 同一话重看 / 网络抖动重试都要重新走插件抓一遍, 很浪费。
 * 这里把抓到的字节按图片 URL 落盘, 下次直接读缓存。
 * 只缓存「在线阅读」用到的页图, 不含封面 (封面小且经常变)。
 */

const DB_NAME = 'lightread-comic-cache'
const STORE = 'pages'
const VERSION = 1
/** 攒够这么多条再考虑按体积裁剪, 免得每次都全表扫 */
const PRUNE_EVERY = 24
/** 缓存上限: 超过就按最后访问时间淘汰 */
const MAX_BYTES = 320 * 1024 * 1024

interface CacheRecord {
  key: string
  bytes: Uint8Array
  at: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null
let putCounter = 0

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('at', 'at')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(db => {
    if (!db) return null
    return new Promise<T | null>(resolve => {
      try {
        const transaction = db.transaction(STORE, mode)
        const request = fn(transaction.objectStore(STORE))
        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  })
}

export async function cacheGet(url: string): Promise<Uint8Array | null> {
  const record = await tx<CacheRecord>('readonly', store => store.get(url) as IDBRequest<CacheRecord>)
  if (!record?.bytes?.length) return null
  return record.bytes
}

export async function cachePut(url: string, bytes: Uint8Array): Promise<void> {
  if (!bytes?.length) return
  const record: CacheRecord = { key: url, bytes, at: Date.now() }
  await tx('readwrite', store => store.put(record))
  if (++putCounter % PRUNE_EVERY === 0) void prune()
}

export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  const db = await openDb()
  if (!db) return { count: 0, bytes: 0 }
  return new Promise(resolve => {
    try {
      const transaction = db.transaction(STORE, 'readonly')
      const store = transaction.objectStore(STORE)
      let count = 0
      let bytes = 0
      const cursorRequest = store.openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) { resolve({ count, bytes }); return }
        count++
        bytes += (cursor.value as CacheRecord)?.bytes?.length ?? 0
        cursor.continue()
      }
      cursorRequest.onerror = () => resolve({ count, bytes })
    } catch {
      resolve({ count: 0, bytes: 0 })
    }
  })
}

export async function cacheClear(): Promise<void> {
  await tx('readwrite', store => store.clear())
  putCounter = 0
}

/** 超过体积上限就按最后访问时间从旧到新删 */
export async function prune(): Promise<void> {
  const { bytes } = await cacheStats()
  if (bytes <= MAX_BYTES) return
  const db = await openDb()
  if (!db) return
  let remaining = bytes - MAX_BYTES
  await new Promise<void>(resolve => {
    try {
      const transaction = db.transaction(STORE, 'readwrite')
      const index = transaction.objectStore(STORE).index('at')
      const cursorRequest = index.openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor || remaining <= 0) { resolve(); return }
        remaining -= (cursor.value as CacheRecord)?.bytes?.length ?? 0
        cursor.delete()
        cursor.continue()
      }
      cursorRequest.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}
