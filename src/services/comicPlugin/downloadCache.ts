/**
 * 下载断点缓存 (IndexedDB)。
 *
 * 单章下载途中取到的每一页图片字节都先落到这里, 而不是只留在内存里。
 * 这样断点续传 / 暂停恢复 / 失败重试都不用从第 1 页重下 —— 已下好的页直接从 DB 读回。
 * key = `${taskId}:${pageIndex}`。任务完成或移除时整组清掉, 不占多余空间。
 */

const DB_NAME = 'lightread-download-cache'
const STORE = 'pages'
const VERSION = 1

interface PageRecord {
  key: string
  bytes: Uint8Array
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
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

function pageKey(taskId: string, index: number): string {
  return `${taskId}:${index}`
}

export async function cachePutPage(taskId: string, index: number, bytes: Uint8Array): Promise<void> {
  if (!bytes?.length) return
  await tx('readwrite', store => store.put({ key: pageKey(taskId, index), bytes }))
}

export async function cacheGetPage(taskId: string, index: number): Promise<Uint8Array | null> {
  const record = await tx<PageRecord>('readonly', store => store.get(pageKey(taskId, index)) as IDBRequest<PageRecord>)
  return record?.bytes?.length ? record.bytes : null
}

/** 删除某个任务的所有断点页 */
export async function cacheDropTask(taskId: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  const prefix = `${taskId}:`
  await new Promise<void>(resolve => {
    try {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      const cursorRequest = store.openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) { resolve(); return }
        if (String(cursor.key).startsWith(prefix)) cursor.delete()
        cursor.continue()
      }
      cursorRequest.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}
