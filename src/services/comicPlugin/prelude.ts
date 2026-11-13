/**
 * QuickJS 沙箱引导脚本 (Breeze 兼容宿主环境)。
 *
 * 插件是 CommonJS bundle, 运行在 QuickJS 里 —— 没有 DOM / URL / fetch / crypto / Buffer。
 * 这里补齐 Web 基础 API, 并把需要宿主能力的操作桥接到 __host* 函数上:
 *   __hostLog / __hostUrlParse / __hostHmac / __hostHash / __hostStart
 * host.ts 负责实现这些函数, 网络请求统一由宿主发出 (桌面端走 Tauri 原生 HTTP, 无跨域限制)。
 *
 * 注意: 本文件由 plugin-lab 里验证通过的原型移植而来, 改动后请跑 scripts/test-comic-plugin.mjs。
 */
export const PLUGIN_PRELUDE = `// ---- QuickJS 缺失的 Web 基础 API ----
globalThis.TextDecoder = class TextDecoder {
  constructor(label) { this.encoding = label || 'utf-8'; }
  decode(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    let out = '', i = 0;
    while (i < b.length) {
      const c = b[i++];
      if (c < 0x80) { out += String.fromCharCode(c); continue; }
      let cp, extra;
      if ((c & 0xe0) === 0xc0) { cp = c & 0x1f; extra = 1; }
      else if ((c & 0xf0) === 0xe0) { cp = c & 0x0f; extra = 2; }
      else if ((c & 0xf8) === 0xf0) { cp = c & 0x07; extra = 3; }
      else { out += '\\ufffd'; continue; }
      if (i + extra > b.length) { out += '\\ufffd'; break; }
      for (let j = 0; j < extra; j++) cp = (cp << 6) | (b[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
    return out;
  }
};
globalThis.TextEncoder = class TextEncoder {
  encode(str) {
    const out = [];
    for (const ch of String(str ?? '')) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return new Uint8Array(out);
  }
};
const __B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
globalThis.atob = function(s) {
  const clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = (__B64.indexOf(clean[i]) << 18) | (__B64.indexOf(clean[i+1]) << 12)
      | ((__B64.indexOf(clean[i+2]) & 63) << 6) | (__B64.indexOf(clean[i+3]) & 63);
    out.push((n >> 16) & 255);
    if (clean[i+2] !== undefined && i + 2 < clean.length) out.push((n >> 8) & 255);
    if (clean[i+3] !== undefined && i + 3 < clean.length) out.push(n & 255);
  }
  return out.map(x => String.fromCharCode(x)).join('');
};
globalThis.btoa = function(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 3) {
    const n = (s.charCodeAt(i) << 16) | ((s.charCodeAt(i+1) || 0) << 8) | (s.charCodeAt(i+2) || 0);
    out.push(__B64[(n >> 18) & 63], __B64[(n >> 12) & 63],
      i + 1 < s.length ? __B64[(n >> 6) & 63] : '=', i + 2 < s.length ? __B64[n & 63] : '=');
  }
  return out.join('');
};

globalThis.AbortSignal = class AbortSignal {
  constructor() { this.aborted = false; this.reason = undefined; this._timeoutMs = 0; }
  static timeout(ms) { const s = new AbortSignal(); s._timeoutMs = Number(ms) || 0; return s; }
  static abort(reason) { const s = new AbortSignal(); s.aborted = true; s.reason = reason; return s; }
  addEventListener() {} removeEventListener() {}
  throwIfAborted() { if (this.aborted) throw this.reason; }
};
globalThis.AbortController = class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort(reason) { this.signal.aborted = true; this.signal.reason = reason ?? new Error('abort'); }
};

// ---- Breeze crypto 兼容对象 (不是 WebCrypto / Node crypto) ----
// 字节参数打包成 {__b64} 跨 QuickJS 边界, 宿主侧用 runtime.ts 还原
function __cryptoPack(x) {
  if (x == null) return '';
  if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return String(x);
  var a;
  if (x instanceof Uint8Array || (x && x.buffer && x.BYTES_PER_ELEMENT === 1)) a = x;
  else if (x instanceof ArrayBuffer) a = new Uint8Array(x);
  else if (Array.isArray(x)) a = Uint8Array.from(x);
  else if (typeof x === 'object') {
    var keys = Object.keys(x).filter(function (k) { return /^[0-9]+$/.test(k); })
      .sort(function (m, n) { return Number(m) - Number(n); });
    a = Uint8Array.from(keys.map(function (k) { return x[k] & 255; }));
  } else return String(x);
  return { __b64: globalThis.__bytesToBase64(a) };
}
function __cryptoCall(method, args) {
  var packed = (args || []).map(__cryptoPack);
  var r = JSON.parse(__hostCrypto(method, JSON.stringify(packed)));
  if (r.error) throw new Error(r.error || 'crypto 调用失败');
  if (r.type === 'bytes') return Uint8Array.from(atob(r.value), function (c) { return c.charCodeAt(0); });
  return r.value;
}
globalThis.crypto = {
  createHmac(algo, key) {
    let data = '';
    return {
      update(d) { data += (typeof d === 'string' ? d : new TextDecoder().decode(d)); return this; },
      digest(enc) { return __hostHmac(algo, key, data, enc || 'hex'); },
    };
  },
  createHash(algo) {
    let data = '';
    return {
      update(d) { data += (typeof d === 'string' ? d : new TextDecoder().decode(d)); return this; },
      digest(enc) { return __hostHash(algo, data, enc || 'hex'); },
    };
  },
  getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; },
  randomUUID() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  }); },
  randomBytes(n) { return __cryptoCall('randomBytes', [n]); },
  md5(x) { return __cryptoCall('md5', [x]); },
  sha1(x) { return __cryptoCall('sha1', [x]); },
  sha256(x) { return __cryptoCall('sha256', [x]); },
  sha512(x) { return __cryptoCall('sha512', [x]); },
  hmacSha1(k, x) { return __cryptoCall('hmacSha1', [k, x]); },
  hmacSha256(k, x) { return __cryptoCall('hmacSha256', [k, x]); },
  hmacSha512(k, x) { return __cryptoCall('hmacSha512', [k, x]); },
  aesEcbPkcs7Encrypt(x, k) { return __cryptoCall('aesEcbPkcs7Encrypt', [x, k]); },
  aesEcbPkcs7Decrypt(x, k) { return __cryptoCall('aesEcbPkcs7Decrypt', [x, k]); },
  aesCbcPkcs7Encrypt(x, k, iv) { return __cryptoCall('aesCbcPkcs7Encrypt', [x, k, iv]); },
  aesCbcPkcs7Decrypt(x, k, iv) { return __cryptoCall('aesCbcPkcs7Decrypt', [x, k, iv]); },
  aesGcmEncrypt(x, k, nonce, aad) { return __cryptoCall('aesGcmEncrypt', [x, k, nonce, aad]); },
  aesGcmDecrypt(x, k, nonce, aad) { return __cryptoCall('aesGcmDecrypt', [x, k, nonce, aad]); },
  aesEcbPkcs7DecryptB64(x, k) { return __cryptoCall('aesEcbPkcs7DecryptB64', [x, k]); },
  aesEcbPkcs7EncryptB64(x, k) { return __cryptoCall('aesEcbPkcs7EncryptB64', [x, k]); },
  aesCbcPkcs7EncryptB64(x, k, iv) { return __cryptoCall('aesCbcPkcs7EncryptB64', [x, k, iv]); },
  aesCbcPkcs7DecryptB64(x, k, iv) { return __cryptoCall('aesCbcPkcs7DecryptB64', [x, k, iv]); },
  aesGcmEncryptB64(x, k, nonce, aad) { return __cryptoCall('aesGcmEncryptB64', [x, k, nonce, aad]); },
  aesGcmDecryptB64(x, k, nonce, aad) { return __cryptoCall('aesGcmDecryptB64', [x, k, nonce, aad]); },
  timingSafeEqual(a, b) {
    var x = String(a), y = String(b);
    if (x.length !== y.length) return false;
    var d = 0; for (var i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return d === 0;
  },
};

globalThis.console = { log:(...a)=>__hostLog(...a), warn:(...a)=>__hostLog(...a), error:(...a)=>__hostLog(...a) };
globalThis.module = { exports: {} };
globalThis.exports = globalThis.module.exports;

globalThis.__pending = {};
globalThis.__qjsFinish = function(p) {
  const slot = globalThis.__pending[p.id];
  if (!slot) return;
  delete globalThis.__pending[p.id];
  if (p.ok) slot.resolve(p.value); else slot.reject(new Error(p.error));
};
function __hostAsync(name, args) {
  return new Promise((resolve, reject) => {
    const id = __hostStart(name, JSON.stringify(args));
    globalThis.__pending[id] = { resolve, reject };
  });
}
globalThis.bridge = {
  call: (name, ...args) => __hostAsync(name, args),
  callSync: function (name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var r = JSON.parse(__hostSync(name, JSON.stringify(args)));
    if (!r.ok) throw new Error(r.error || 'callSync 失败');
    return r.value;
  },
  gzipCompress: function (x) { return JSON.parse(__hostSync('compression.gzip_compress', JSON.stringify([x]))).value; },
  gzipDecompress: function (x) { return JSON.parse(__hostSync('compression.gzip_decompress', JSON.stringify([x]))).value; },
};

// ---- URL / URLSearchParams ----
globalThis.URL = class URL {
  constructor(input, base) {
    const raw = String(input);
    const parsed = __hostUrlParse(raw);
    if (!parsed) throw new Error('Invalid URL: ' + raw);
    Object.assign(this, JSON.parse(parsed));
    this.searchParams = new URLSearchParams(this.search.replace(/^\\?/, ''));
  }
  toString() { return this.href; }
};
globalThis.URLSearchParams = class URLSearchParams {
  constructor(init) {
    this._items = [];
    if (typeof init === 'string') {
      for (const part of init.split('&')) {
        if (!part) continue;
        const i = part.indexOf('=');
        this._items.push([decodeURIComponent(i < 0 ? part : part.slice(0, i)), decodeURIComponent(i < 0 ? '' : part.slice(i + 1))]);
      }
    } else if (init && typeof init === 'object') {
      for (const [k, v] of Object.entries(init)) this._items.push([k, String(v)]);
    }
  }
  set(k, v) { this._items = this._items.filter(([key]) => key !== k); this._items.push([k, String(v)]); }
  get(k) { const f = this._items.find(([key]) => key === k); return f ? f[1] : null; }
  toString() { return this._items.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
};

// ---- fetch（宿主执行，二进制 base64 回传）----
globalThis.fetch = async function(url, init = {}) {
  const r = await __hostAsync('fetch', [{ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body, timeoutMs: init.signal && init.signal._timeoutMs }]);
  const bin = Uint8Array.from(atob(r.bodyBase64), c => c.charCodeAt(0));
  const dec = new TextDecoder();
  return {
    status: r.status, ok: r.ok, url: r.url,
    headers: { get: k => r.headers[String(k).toLowerCase()] ?? null, raw: r.headers },
    text: async () => dec.decode(bin),
    json: async () => JSON.parse(dec.decode(bin)),
    arrayBuffer: async () => bin.buffer,
    bytes: async () => bin,
  };
};

// ---- 宿主二进制回传 / 更完整的 Web API 兼容 ----
globalThis.__bytesToBase64 = function (b) {
  var a = (b && b.buffer && b.BYTES_PER_ELEMENT === 1) ? new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength)
        : new Uint8Array(b || []);
  var s = '';
  for (var i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
};
URLSearchParams.prototype.append = function (k, v) { this._items.push([k, String(v)]); };
URLSearchParams.prototype.has = function (k) { return this._items.some(function (x) { return x[0] === k; }); };
URLSearchParams.prototype.delete = function (k) { this._items = this._items.filter(function (x) { return x[0] !== k; }); };
URLSearchParams.prototype.getAll = function (k) { return this._items.filter(function (x) { return x[0] === k; }).map(function (x) { return x[1]; }); };
URLSearchParams.prototype.forEach = function (fn) { this._items.forEach(function (x) { fn(x[1], x[0]); }); };
URL.prototype.toJSON = function () { return this.href; };
URLSearchParams.prototype[Symbol.iterator] = function () { return this._items[Symbol.iterator](); };

// fetch 响应的 headers 补 forEach / has
var __origFetch = globalThis.fetch;
globalThis.fetch = async function (url, init) {
  const r = await __origFetch(url, init);
  r.headers.forEach = function (fn) { Object.keys(r.headers.raw || {}).forEach(function (k) { fn(r.headers.raw[k], k); }); };
  r.headers.has = function (k) { return (r.headers.raw || {})[String(k).toLowerCase()] != null; };
  r.blob = async function () { return { arrayBuffer: async () => (await r.arrayBuffer()), type: r.headers.get('content-type') || '' }; };
  return r;
};

// ---- Breeze 运行时全局工具 ----
globalThis.bytesToBase64 = function (b) { return globalThis.__bytesToBase64(b); };
globalThis.bytesFromBase64 = function (s) { return Uint8Array.from(atob(String(s)), function (c) { return c.charCodeAt(0); }); };
globalThis.uuidv4 = globalThis.crypto.randomUUID;
globalThis.base64 = { encode: globalThis.bytesToBase64, decode: globalThis.bytesFromBase64 };
globalThis.structuredClone = function (x) { return x == null ? x : JSON.parse(JSON.stringify(x)); };
var __timers = {}, __timerSeq = 0;
globalThis.setTimeout = function (fn, ms) {
  var id = ++__timerSeq;
  __timers[id] = true;
  __hostAsync('timer.sleep', [ms]).then(function () {
    if (!__timers[id]) return;
    delete __timers[id];
    try { fn(); } catch (e) { console.error(e); }
  });
  return id;
};
globalThis.clearTimeout = function (id) { delete __timers[id]; };
globalThis.queueMicrotask = function (fn) { Promise.resolve().then(fn); };
var __nativePool = {}, __nativeSeq = 0;
globalThis.native = {
  put: function (x) { var id = ++__nativeSeq; __nativePool[id] = x; return id; },
  take: function (id) { return __nativePool[id] ?? null; },
  free: function (id) { delete __nativePool[id]; },
};
globalThis.path = {
  join: function () { return Array.prototype.slice.call(arguments).join('/'); },
  basename: function (p) { var parts = String(p).split('/'); return parts[parts.length - 1] || ''; },
  dirname: function (p) { var parts = String(p).split('/'); parts.pop(); return parts.join('/') || '.'; },
};
`;
