import { nextTick, onBeforeUnmount, reactive, type Ref } from 'vue'
import { openPlugin, type ComicPluginHost } from '../services/comicPlugin'
import { bytesToObjectUrl } from '../services/comicPlugin/download'

export interface UseComicCoversOptions {
  /** 预取上限（首屏同步队列长度） */
  prefetchLimit?: number
  /** 并发拉取协程数 */
  workers?: number
  /** 内存缓存最大封面数，超出按 FIFO 淘汰并 revokeObjectURL */
  maxCached?: number
  /** 限定封面 DOM 查询范围（避免同页多个面板互相观察） */
  container?: () => HTMLElement | null | undefined
}

/**
 * 漫画源封面并发拉取与懒加载管理：
 * - 单飞宿主锁 + 卸载/切源自动 dispose，防止并发或竞态泄漏 QuickJS 实例
 * - 超出上限自动 revokeObjectURL，防止长时间浏览内存无限增长
 */
export function useComicCovers(
  getUuid: () => string,
  options: UseComicCoversOptions = {},
) {
  const prefetchLimit = options.prefetchLimit ?? 12
  const workers = options.workers ?? 3
  const maxCached = options.maxCached ?? 150

  const covers = reactive<Record<string, string>>({})
  const coverOrder: string[] = []
  const coverUrls = new Map<string, string>()
  const coverInFlight = new Set<string>()

  let host: ComicPluginHost | null = null
  let hostPromise: Promise<ComicPluginHost> | null = null
  let hostUuid = ''
  let disposed = false
  let seq = 0
  let observer: IntersectionObserver | null = null

  function setCover(key: string, objectUrl: string) {
    if (disposed) {
      URL.revokeObjectURL(objectUrl)
      return
    }
    const existing = covers[key]
    if (existing && existing !== objectUrl) URL.revokeObjectURL(existing)
    covers[key] = objectUrl
    const idx = coverOrder.indexOf(key)
    if (idx !== -1) coverOrder.splice(idx, 1)
    coverOrder.push(key)
    while (coverOrder.length > maxCached) {
      const oldest = coverOrder.shift()
      if (oldest && covers[oldest]) {
        URL.revokeObjectURL(covers[oldest])
        delete covers[oldest]
      }
    }
  }

  async function ensureHost(): Promise<ComicPluginHost> {
    const targetUuid = getUuid()
    if (host && hostUuid === targetUuid) return host
    if ((host || hostPromise) && hostUuid !== targetUuid) {
      host?.dispose()
      host = null
      hostPromise = null
    }
    if (!hostPromise) {
      hostUuid = targetUuid
      hostPromise = openPlugin(targetUuid).then(created => {
        if (disposed || getUuid() !== targetUuid) {
          created.dispose()
          throw new Error('Comic cover host disposed before ready')
        }
        host = created
        return created
      }).catch(err => {
        if (hostUuid === targetUuid) hostPromise = null
        throw err
      })
    }
    return hostPromise
  }

  async function fetchOne(key: string, url: string, timeoutMs = 20_000): Promise<void> {
    if (!url || covers[key] || disposed) return
    const h = await ensureHost()
    if (disposed) return
    const bytes = await h.callBytes('fetchImageBytes', { url }, { timeoutMs })
    if (bytes?.length) setCover(key, bytesToObjectUrl(bytes, url))
  }

  function watchSelector(selector: string) {
    if (typeof IntersectionObserver === 'undefined' || disposed) return
    observer?.disconnect()
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const key = (entry.target as HTMLElement).dataset.coverId
        const url = key ? coverUrls.get(key) : undefined
        if (!key || !url || covers[key] || coverInFlight.has(key)) continue
        coverInFlight.add(key)
        observer?.unobserve(entry.target)
        void fetchOne(key, url)
          .catch(() => { /* 失败留占位图 */ })
          .finally(() => coverInFlight.delete(key))
      }
    }, { rootMargin: '300px' })
    void nextTick(() => {
      if (disposed) return
      const scope = options.container?.() ?? document
      scope.querySelectorAll<HTMLElement>(selector).forEach(el => observer?.observe(el))
    })
  }

  async function loadList(
    items: Array<{ key: string; url: string }>,
    selector: string,
  ) {
    observer?.disconnect()
    const seen = new Set<string>()
    const queue: Array<{ key: string; url: string }> = []
    for (const item of items) {
      if (!item.key || !item.url) continue
      coverUrls.set(item.key, item.url)
      if (seen.has(item.key) || covers[item.key] || coverInFlight.has(item.key)) continue
      seen.add(item.key)
      if (queue.length < prefetchLimit) queue.push(item)
    }
    const currentSeq = ++seq
    if (!queue.length) {
      watchSelector(selector)
      return
    }
    let h: ComicPluginHost
    try {
      h = await ensureHost()
    } catch {
      return
    }
    if (currentSeq !== seq || disposed) return
    let cursor = 0
    const runWorker = async () => {
      while (currentSeq === seq && !disposed && cursor < queue.length) {
        const item = queue[cursor++]
        if (covers[item.key] || coverInFlight.has(item.key)) continue
        coverInFlight.add(item.key)
        try {
          const bytes = await h.callBytes('fetchImageBytes', { url: item.url }, { timeoutMs: 20_000 })
          if (currentSeq === seq && !disposed && bytes?.length) {
            setCover(item.key, bytesToObjectUrl(bytes, item.url))
          }
        } catch { /* 单张封面失败用占位图 */ }
        finally {
          coverInFlight.delete(item.key)
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, () => runWorker()))
    if (currentSeq === seq && !disposed) watchSelector(selector)
  }

  function cancelPending() {
    seq++
    observer?.disconnect()
  }

  function dispose() {
    disposed = true
    seq++
    observer?.disconnect()
    observer = null
    host?.dispose()
    host = null
    hostPromise = null
    for (const url of Object.values(covers)) URL.revokeObjectURL(url)
    for (const key of Object.keys(covers)) delete covers[key]
    coverOrder.length = 0
    coverUrls.clear()
    coverInFlight.clear()
  }

  onBeforeUnmount(dispose)

  return {
    covers,
    fetchOne,
    loadList,
    cancelPending,
    dispose,
  }
}

export function bindUuidRef(uuidRef: Ref<string>) {
  return () => uuidRef.value
}
