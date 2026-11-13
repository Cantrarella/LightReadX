/**
 * Breeze 兼容漫画插件运行时 (QuickJS / WASM)。
 *
 * 插件 bundle 在 QuickJS 沙箱里执行, 宿主提供:
 *  - 网络请求: 由调用方注入 request (上层用 fetchRemote, 桌面端走 Tauri 原生 HTTP, 无跨域限制)
 *  - bridge: load_plugin_config / save_plugin_config / runtime.is_task_group_cancelled
 *  - crypto: 同步 HMAC / Hash (WEBTOON 等源用 HMAC-SHA1 签请求)
 *  - URL / URLSearchParams / TextEncoder / TextDecoder / atob / btoa / AbortSignal / console
 *
 * 本模块刻意不依赖 Vue / Pinia / Tauri, 便于在 Node 里用真实插件做回归测试
 * (见 scripts/test-comic-plugin.mjs)。
 */
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core'
import browserVariant from '@jitl/quickjs-singlefile-browser-release-sync'
import { PLUGIN_PRELUDE } from './prelude'
import { runCryptoMethod, runCryptoBridge, digest, hmacDigest } from './runtime'
import type { PluginRequestInit, PluginResponse } from './types'

// WASM 引擎只实例化一次, 后续每个插件用独立 Runtime/Context
let enginePromise: Promise<QuickJSWASMModule> | null = null
function getEngine(): Promise<QuickJSWASMModule> {
  if (!enginePromise) {
    enginePromise = newQuickJSWASMModuleFromVariant(
      browserVariant as Parameters<typeof newQuickJSWASMModuleFromVariant>[0],
    ).catch(err => {
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// 哈希 / HMAC / AES 统一由 runtime.ts 实现, 这里只负责跨 QuickJS 边界的字节编解码

export interface CallOptions {
  /** 默认 60s; 搜索 / 详情可短些, 图片下载可长些 */
  timeoutMs?: number
  /** 沙箱里对返回值求值的表达式, 结果必须是字符串 */
  mapResult?: string
  /** 结果为 base64 二进制, 宿主解码成 Uint8Array */
  binary?: boolean
}

export interface HostOptions {
  /** 插件 CommonJS bundle 源码 */
  code: string
  /** 宿主发请求 (桌面端由上层注入 fetchRemote 实现) */
  request: (init: PluginRequestInit) => Promise<PluginResponse>
  /** 插件 uuid, 用于隔离缓存与配置命名空间 */
  pluginUuid?: string
  pluginConfig?: Record<string, unknown>
  onConfigSave?: (key: string, value: unknown) => void
  /** 插件通过 flutter.showToast 发的提示 */
  onToast?: (message: string) => void
  /** 已取消的下载任务组, 插件会在每步前查询 */
  cancelledGroups?: Set<string>
  log?: (...args: unknown[]) => void
}

export interface ComicPluginHost {
  call<T = unknown>(fnPath: string, payload?: unknown, opts?: CallOptions): Promise<T>
  callBytes(fnPath: string, payload?: unknown, opts?: CallOptions): Promise<Uint8Array>
  hasFn(fnPath: string): boolean
  cancelGroup(key: string): void
  dispose(): void
}

export async function createComicPluginHost(options: HostOptions): Promise<ComicPluginHost> {
  const engine = await getEngine()
  const runtime = engine.newRuntime()
  const ctx = runtime.newContext()
  const unwrap = (r: any, label: string) => {
    if (r.error) {
      const detail = ctx.dump(r.error)
      r.error.dispose()
      throw new Error(`[comic-plugin] ${label}: ${JSON.stringify(detail)}`)
    }
    return r.value
  }
  const evalStr = (code: string, label: string): string => {
    const h = unwrap(ctx.evalCode(code, label), label)
    const value = ctx.getString(h)
    h.dispose()
    return value
  }
  const expose = (name: string, fn: (...args: any[]) => any) => {
    const h = ctx.newFunction(name, fn)
    ctx.setProp(ctx.global, name, h)
    h.dispose()
  }

  const config: Record<string, unknown> = { ...(options.pluginConfig ?? {}) }
  const cancelledGroups = options.cancelledGroups ?? new Set<string>()
  const pending = new Map<number, Promise<unknown>>()
  let seq = 0
  /** call() 的槽位号, 保证并发调用各有独立结果格 */
  let callSeq = 0
  let disposed = false

  // 插件缓存 (域名端点 / 响应等)。桌面与网页都落到 localStorage, 测试环境退化为内存。
  const cachePrefix = `lrx.comic.cache.${options.pluginUuid || 'default'}.`
  const memoryCache = new Map<string, string>()
  const cacheRead = (k: string) => {
    try { return localStorage.getItem(k) } catch { return memoryCache.get(k) ?? null }
  }
  const cacheWrite = (k: string, v: string) => {
    try { localStorage.setItem(k, v) } catch { memoryCache.set(k, v) }
  }
  const cacheRemove = (k: string) => {
    try { localStorage.removeItem(k) } catch { memoryCache.delete(k) }
  }

  /** Breeze kit 有两种配置读取写法: 老插件直接 JSON.parse 原值, 新插件期待 {ok,value} 包装 */
  function readConfig(key: string, def?: unknown): unknown {
    if (!Object.prototype.hasOwnProperty.call(config, key)) return def ?? ''
    const stored = config[key]
    const raw = typeof stored === 'string' ? stored : JSON.stringify(stored)
    const defText = typeof def === 'string' ? def : ''
    // Breeze kit 把默认值 JSON.stringify 后传入, 并期待 {ok,value} 包装;
    // 老插件 (WEBTOON) 直接传 "" 并自己 JSON.parse 原值, 两种写法都要兼容。
    let defIsJson = false
    if (defText) {
      try { JSON.parse(defText); defIsJson = true } catch { /* 非 JSON 默认值 */ }
    }
    if (!defIsJson) return raw
    let value: unknown = raw
    try { value = JSON.parse(raw) } catch { /* 保持字符串 */ }
    return JSON.stringify({ ok: true, value })
  }

  const nativePool = new Map<number, unknown>()
  let nativeSeq = 0

  const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {
    async load_plugin_config(key: string, def?: unknown) { return readConfig(key, def) },
    async save_plugin_config(key: string, value: unknown) {
      config[key] = value
      options.onConfigSave?.(key, value)
      return null
    },
    async 'runtime.is_task_group_cancelled'(key: string) { return cancelledGroups.has(String(key)) },
    async fetch(init: PluginRequestInit) { return options.request(init) },

    // ---- 缓存 ----
    async 'cache.get'(key: string, def?: unknown) {
      const raw = cacheRead(cachePrefix + String(key))
      if (raw == null) return def ?? ''
      try { return JSON.parse(raw) } catch { return raw }
    },
    async 'cache.set'(key: string, value: unknown) {
      cacheWrite(cachePrefix + String(key), JSON.stringify(value ?? null))
      return null
    },
    async 'cache.delete'(key: string) { cacheRemove(cachePrefix + String(key)); return null },
    async 'cache.clear'() { memoryCache.clear(); return null },

    // ---- 宿主信息 / 提示 ----
    async 'dart.getAppVersion'() { return '3.0.40' },
    async 'flutter.showToast'(payload: unknown) {
      let message = typeof payload === 'string' ? payload : ''
      try {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
        if (parsed && typeof parsed === 'object') {
          const p = parsed as Record<string, unknown>
          message = String(p.message ?? p.msg ?? p.text ?? message)
        } else if (parsed != null) message = String(parsed)
      } catch { /* 保留原字符串 */ }
      if (message) options.onToast?.(message)
      return null
    },
    async 'opencc.convert'(payload: unknown) {
      // LightReadX 内置简繁转换, 这里原样回传不影响功能
      const p = payload as Record<string, unknown> | string
      return typeof p === 'string' ? p : String((p && (p as Record<string, unknown>).text) ?? '')
    },

    // ---- 字节池 / 数学 ----
    async 'math.add'(a: unknown, b: unknown) { return Number(a) + Number(b) },
    async 'native.put'(value: unknown) { const id = ++nativeSeq; nativePool.set(id, value); return id },
    async 'native.take'(id: number) { return nativePool.get(Number(id)) ?? null },
    async 'native.free'(id: number) { nativePool.delete(Number(id)); return null },
    async 'native.exec'(...args: unknown[]) { return args },
    async 'compression.gzip_compress'(input: unknown) { return input },
    async 'compression.gzip_decompress'(input: unknown) { return input },

    // ---- QuickJS 没有定时器, 插件常用 setTimeout 做退避/超时 ----
    async 'timer.sleep'(ms: unknown) {
      const delay = Math.max(0, Math.min(60_000, Number(ms) || 0))
      await new Promise(resolve => setTimeout(resolve, delay))
      return null
    },
  }

  // ---- 加密路由 (旧版 bridge.call("crypto.*")) ----
  for (const name of [
    'crypto.md5_hex', 'crypto.sha1_hex', 'crypto.sha256_hex', 'crypto.sha512_hex',
    'crypto.hmac_sha1_hex', 'crypto.hmac_sha256_hex', 'crypto.hmac_sha512_hex',
    'crypto.aes_ecb_pkcs7_encrypt_b64', 'crypto.aes_ecb_pkcs7_decrypt_b64',
    'crypto.aes_cbc_pkcs7_encrypt_b64', 'crypto.aes_cbc_pkcs7_decrypt_b64',
    'crypto.aes_gcm_encrypt_b64', 'crypto.aes_gcm_decrypt_b64',
  ]) {
    handlers[name] = async (...args: unknown[]) => runCryptoBridge(name, args)
  }

  const finish = (id: number, ok: boolean, value: unknown) => {
    if (disposed) return
    try {
      const payload = JSON.stringify({ id, ok, value: ok ? value : null, error: ok ? null : value })
      unwrap(ctx.evalCode(`globalThis.__qjsFinish(${payload})`, 'finish'), 'finish').dispose()
    } catch (err) {
      options.log?.('[comic-plugin] 异步回调失败', err)
    }
  }

  expose('__hostLog', (...args: any[]) => {
    if (options.log) options.log('[plugin]', ...args.map(a => ctx.dump(a)))
  })
  expose('__hostUrlParse', (h: any, b?: any) => {
    try {
      const base = b ? ctx.getString(b) : undefined
      const u = new URL(ctx.getString(h), base || undefined)
      return ctx.newString(JSON.stringify({
        href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname,
        pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin,
      }))
    } catch {
      return ctx.newString('')
    }
  })
  expose('__hostHmac', (algo: any, key: any, data: any, enc: any) => {
    try {
      return ctx.newString(hmacDigest(ctx.getString(algo), ctx.getString(key), ctx.getString(data), ctx.getString(enc)))
    } catch {
      return ctx.newString('')
    }
  })
  expose('__hostHash', (algo: any, data: any, enc: any) => {
    try {
      return ctx.newString(digest(ctx.getString(algo), ctx.getString(data), ctx.getString(enc)))
    } catch {
      return ctx.newString('')
    }
  })
  /** crypto 对象方法: 返回 JSON {type: 'text'|'bytes', value}, 由 prelude 转成字符串或 Uint8Array */
  expose('__hostCrypto', (methodH: any, argsH: any) => {
    try {
      const args = JSON.parse(ctx.getString(argsH))
      return ctx.newString(JSON.stringify(runCryptoMethod(ctx.getString(methodH), args)))
    } catch (err) {
      return ctx.newString(JSON.stringify({ type: 'text', value: '', error: String(err) }))
    }
  })
  /** bridge.callSync 的同步路由, 只覆盖插件实际会用到的纯计算能力 */
  expose('__hostSync', (nameH: any, argsH: any) => {
    try {
      const name = ctx.getString(nameH)
      const args: unknown[] = JSON.parse(ctx.getString(argsH))
      let value: unknown = null
      if (name === 'math.add') value = Number(args[0]) + Number(args[1])
      else if (name.startsWith('crypto.')) value = runCryptoBridge(name, args)
      else if (name === 'compression.gzip_compress' || name === 'compression.gzip_decompress') value = args[0]
      return ctx.newString(JSON.stringify({ ok: true, value }))
    } catch (err) {
      return ctx.newString(JSON.stringify({ ok: false, error: String(err) }))
    }
  })
  expose('__hostStart', (nameH: any, argsH: any) => {
    const name = ctx.getString(nameH)
    let args: unknown[] = []
    try { args = JSON.parse(ctx.getString(argsH)) } catch { /* 忽略非法参数 */ }
    const fn = handlers[name] ?? handlers['bridge.' + name] ?? handlers[name.replace(/^bridge\./, '')]
    const id = ++seq
    const task = (async () => {
      if (!fn) throw new Error('宿主未实现: ' + name)
      return fn(...args)
    })()
    pending.set(id, task)
    task.then(
      value => { pending.delete(id); finish(id, true, value) },
      err => { pending.delete(id); finish(id, false, String(err?.stack || err)) },
    )
    return ctx.newNumber(id)
  })

  unwrap(ctx.evalCode(PLUGIN_PRELUDE, 'host-prelude'), 'host-prelude').dispose()
  unwrap(ctx.evalCode(options.code, 'plugin.cjs'), 'plugin-load').dispose()

  const fnAccess = (fnPath: string) =>
    fnPath.split('.').reduce(
      (acc, key) => `(${acc}||{})[${JSON.stringify(key)}]`,
      '(module.exports && (module.exports.default || module.exports)) || {}',
    )

  async function call<T = unknown>(fnPath: string, payload?: unknown, opts: CallOptions = {}): Promise<T> {
    if (disposed) throw new Error('插件宿主已释放')
    const mapResult = opts.mapResult ?? 'JSON.stringify(r === undefined ? null : r)'
    // 每次调用独立的槽位: 同一宿主上并发调用 (例如 4 路并发拉封面) 不会互相覆盖结果,
    // 否则先完成的调用会被后开始的调用重置成「未完成」, 表现为重复同样的等待甚至一直等到超时
    const callId = ++callSeq
    const slot = `globalThis.__calls[${callId}]`
    unwrap(ctx.evalCode(`
globalThis.__calls = globalThis.__calls || {};
(() => {
  const slot = { done: false, result: null, error: null };
  globalThis.__calls[${callId}] = slot;
  (async () => {
    try {
      const fn = ${fnAccess(fnPath)};
      if (typeof fn !== 'function') throw new Error('插件未提供 fnPath: ${fnPath}');
      const r = await fn(${JSON.stringify(payload ?? {})});
      slot.result = ${mapResult};
    } catch (e) {
      let detail;
      try { detail = JSON.stringify(e) } catch { detail = '' }
      slot.error = JSON.stringify({
        message: e && e.message, name: e && e.name, stack: e && e.stack,
        raw: String(e), detail,
      });
    } finally {
      slot.done = true;
    }
  })();
})();
`, 'call'), 'call').dispose()

    const timeoutMs = opts.timeoutMs ?? 60_000
    const deadline = Date.now() + timeoutMs
    let done = false
    try {
      while (Date.now() < deadline) {
        runtime.executePendingJobs()
        if (evalStr(`String(${slot}.done)`, 'done') === 'true') { done = true; break }
        await new Promise(resolve => setTimeout(resolve, 3))
      }
      const errJson = evalStr(`${slot}.error`, 'error')
      if (errJson && errJson !== 'null') {
        const detail = JSON.parse(errJson)
        const error = new Error(detail.message || detail.raw || `插件调用失败: ${fnPath}`) as Error & { code?: string }
        error.name = detail.name || 'ComicPluginError'
        if (detail.stack) error.stack = detail.stack
        const raw = [detail.raw, detail.message, detail.detail].map(v => String(v ?? '')).join(' ')
        if (/["']?type["']?\s*:\s*["']unauthorized["']/i.test(raw)
          || /UNAUTHORIZED|登录已失效|请先登录|未登录|登录过期/i.test(raw)) {
          error.code = 'unauthorized'
        }
        throw error
      }
      if (!done) throw new Error(`插件调用超时 (${fnPath}, ${timeoutMs}ms)`)
      const out = evalStr(`${slot}.result`, 'result')
      if (out == null || out === 'null') return null as T
      return (opts.binary ? base64ToBytes(out) : JSON.parse(out)) as T
    } finally {
      try { unwrap(ctx.evalCode(`delete globalThis.__calls[${callId}]`, 'cleanup'), 'cleanup').dispose() } catch { /* 忽略 */ }
    }
  }

  return {
    call,
    callBytes: (fnPath, payload, opts) => call<Uint8Array>(fnPath, payload, {
      ...opts,
      mapResult: 'globalThis.__bytesToBase64(r)',
      binary: true,
    }),
    hasFn: fnPath => evalStr(`String(typeof ${fnAccess(fnPath)} === 'function')`, 'hasFn') === 'true',
    cancelGroup: key => { cancelledGroups.add(key) },
    dispose: () => {
      if (disposed) return
      disposed = true
      pending.clear()
      // QuickJS-WASM 在句柄没清干净时 dispose 会 abort
      // (Assertion failed: list_empty(&rt->gc_obj_list)), 这只是收尾告警,
      // 不能让它把已经成功的整章下载判成失败
      try { ctx.dispose() } catch { /* 忽略 */ }
      try { runtime.dispose() } catch { /* 忽略 */ }
    },
  }
}
