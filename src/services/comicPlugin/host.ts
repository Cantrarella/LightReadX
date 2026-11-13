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
import { hmac } from '@noble/hashes/hmac'
import { sha1 } from '@noble/hashes/sha1'
import { sha256 } from '@noble/hashes/sha256'
import { md5 } from '@noble/hashes/legacy'
import { bytesToHex } from '@noble/hashes/utils'
import { PLUGIN_PRELUDE } from './prelude'
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

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function hashOf(algo: string) {
  const a = String(algo || '').toLowerCase().replace(/[-_]/g, '')
  if (a === 'sha1') return sha1
  if (a === 'md5') return md5
  return sha256
}

function hmacDigest(algo: string, key: string, data: string, enc: string): string {
  const out = hmac(hashOf(algo), new TextEncoder().encode(key), new TextEncoder().encode(data))
  return enc === 'base64' ? bytesToBase64(out) : bytesToHex(out)
}

function hashDigest(algo: string, data: string, enc: string): string {
  const out = hashOf(algo)(new TextEncoder().encode(data))
  return enc === 'base64' ? bytesToBase64(out) : bytesToHex(out)
}

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
  pluginConfig?: Record<string, unknown>
  onConfigSave?: (key: string, value: unknown) => void
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
  let disposed = false

  const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {
    async load_plugin_config(key: string, def?: unknown) {
      return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : (def ?? '')
    },
    async save_plugin_config(key: string, value: unknown) {
      config[key] = value
      options.onConfigSave?.(key, value)
      return null
    },
    async 'runtime.is_task_group_cancelled'(key: string) {
      return cancelledGroups.has(String(key))
    },
    async fetch(init: PluginRequestInit) {
      return options.request(init)
    },
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
  expose('__hostUrlParse', (h: any) => {
    try {
      const u = new URL(ctx.getString(h))
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
      return ctx.newString(hashDigest(ctx.getString(algo), ctx.getString(data), ctx.getString(enc)))
    } catch {
      return ctx.newString('')
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
    unwrap(ctx.evalCode(`
globalThis.__done = false; globalThis.__result = null; globalThis.__error = null;
(async () => {
  try {
    const fn = ${fnAccess(fnPath)};
    if (typeof fn !== 'function') throw new Error('插件未提供 fnPath: ${fnPath}');
    const r = await fn(${JSON.stringify(payload ?? {})});
    globalThis.__result = ${mapResult};
  } catch (e) {
    let detail;
    try { detail = JSON.stringify(e) } catch { detail = '' }
    globalThis.__error = JSON.stringify({
      message: e && e.message, name: e && e.name, stack: e && e.stack,
      raw: String(e), detail,
    });
  }
  globalThis.__done = true;
})();
`, 'call'), 'call').dispose()

    const timeoutMs = opts.timeoutMs ?? 60_000
    const deadline = Date.now() + timeoutMs
    let done = false
    while (Date.now() < deadline) {
      runtime.executePendingJobs()
      if (evalStr('String(globalThis.__done)', 'done') === 'true') { done = true; break }
      await new Promise(resolve => setTimeout(resolve, 3))
    }
    const errJson = evalStr('globalThis.__error', 'error')
    if (errJson && errJson !== 'null') {
      const detail = JSON.parse(errJson)
      const error = new Error(detail.message || detail.raw || `插件调用失败: ${fnPath}`)
      error.name = detail.name || 'ComicPluginError'
      if (detail.stack) error.stack = detail.stack
      throw error
    }
    if (!done) throw new Error(`插件调用超时 (${fnPath}, ${timeoutMs}ms)`)
    const out = evalStr('globalThis.__result', 'result')
    if (out == null || out === 'null') return null as T
    return (opts.binary ? base64ToBytes(out) : JSON.parse(out)) as T
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
      ctx.dispose()
      runtime.dispose()
    },
  }
}
