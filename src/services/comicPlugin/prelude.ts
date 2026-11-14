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
  constructor() { this.aborted = false; this.reason = undefined; this._timeoutMs = 0; this._listeners = []; }
  static timeout(ms) { const s = new AbortSignal(); s._timeoutMs = Number(ms) || 0; return s; }
  static abort(reason) { const s = new AbortSignal(); s.aborted = true; s.reason = reason; return s; }
  /** ky 会做 typeof AbortSignal.any === 'function' 的能力探测, 给了就走合并分支 */
  static any(signals) {
    const list = (signals || []).filter(Boolean);
    const merged = new AbortSignal();
    let ms = 0;
    for (const s of list) {
      if (s && s._timeoutMs && (!ms || s._timeoutMs < ms)) ms = s._timeoutMs;
    }
    merged._timeoutMs = ms;
    const already = list.find(function (s) { return s && s.aborted; });
    if (already) { merged.aborted = true; merged.reason = already.reason; }
    // 任一来源 abort 时, 合并信号自己也要变成 aborted 并通知自己的监听者
    // (ky 靠这个回调去 reject 正在等待的请求)
    list.forEach(function (src) {
      if (!src || typeof src.addEventListener !== 'function') return;
      src.addEventListener('abort', function () {
        if (merged.aborted) return;
        merged.aborted = true;
        merged.reason = src.reason;
        merged._emit('abort');
      });
    });
    return merged;
  }
  _emit(type) {
    const fns = this._listeners.slice();
    for (let i = 0; i < fns.length; i++) { try { fns[i]({ type: type, target: this }); } catch (e) {} }
  }
  addEventListener(type, fn) { if (typeof fn === 'function') this._listeners.push(fn); }
  removeEventListener(type, fn) {
    const i = this._listeners.indexOf(fn);
    if (i >= 0) this._listeners.splice(i, 1);
  }
  throwIfAborted() { if (this.aborted) throw this.reason; }
};
globalThis.AbortController = class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort(reason) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason ?? new Error('abort');
    this.signal._emit('abort');
  }
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
// ky 会 new URL(req.url) 之后改 u.search / u.searchParams 再 toString(),
// 所以这些字段必须是"活的": 改了就体现在 href 上。早期版本把 href 当普通属性存,
// 结果插件拼的 ?q=xxx 全被丢掉 (绅士漫画搜索永远 0 条就是这个)。
globalThis.URL = class URL {
  constructor(input, base) {
    this._reset(String(input), base == null ? '' : String(base));
  }
  _reset(raw, base) {
    const parsed = __hostUrlParse(raw, base);
    if (!parsed) throw new Error('Invalid URL: ' + raw);
    const o = JSON.parse(parsed);
    this.protocol = o.protocol || '';
    this.host = o.host || '';
    this.hostname = o.hostname || '';
    this.pathname = o.pathname || '/';
    this.origin = o.origin || '';
    this.hash = o.hash || '';
    this._search = o.search || '';
  }
  get href() { return this.protocol + '//' + this.host + this.pathname + this._search + this.hash; }
  set href(value) { this._reset(String(value), ''); }
  get search() { return this._search; }
  set search(value) {
    const s = String(value == null ? '' : value);
    this._search = !s ? '' : (s.charAt(0) === '?' ? s : '?' + s);
  }
  /** searchParams 的写操作要回写到 url 上 */
  get searchParams() {
    const self = this;
    return new URLSearchParams(this._search.replace(/^\\?/, ''), function (qs) {
      self._search = qs ? '?' + qs : '';
    });
  }
  toString() { return this.href; }
  toJSON() { return this.href; }
};
globalThis.URLSearchParams = class URLSearchParams {
  constructor(init, onChange) {
    this._items = [];
    this._onChange = typeof onChange === 'function' ? onChange : null;
    if (typeof init === 'string') {
      for (const part of init.replace(/^\\?/, '').split('&')) {
        if (!part) continue;
        const i = part.indexOf('=');
        this._items.push([
          decodeURIComponent(i < 0 ? part : part.slice(0, i)),
          decodeURIComponent(i < 0 ? '' : part.slice(i + 1)),
        ]);
      }
    } else if (init && typeof init === 'object') {
      for (const [k, v] of Object.entries(init)) this._items.push([k, String(v)]);
    }
  }
  _dirty() { if (this._onChange) this._onChange(this.toString()); }
  append(k, v) { this._items.push([String(k), String(v)]); this._dirty(); }
  set(k, v) {
    this._items = this._items.filter(([key]) => key !== String(k));
    this._items.push([String(k), String(v)]);
    this._dirty();
  }
  get(k) { const f = this._items.find(([key]) => key === String(k)); return f ? f[1] : null; }
  getAll(k) { return this._items.filter(([key]) => key === String(k)).map(e => e[1]); }
  has(k) { return this._items.some(([key]) => key === String(k)); }
  delete(k) { this._items = this._items.filter(([key]) => key !== String(k)); this._dirty(); }
  sort() { this._items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._dirty(); }
  get size() { return this._items.length; }
  entries() { return this._items.slice()[Symbol.iterator](); }
  keys() { return this._items.map(e => e[0])[Symbol.iterator](); }
  values() { return this._items.map(e => e[1])[Symbol.iterator](); }
  forEach(fn) { this._items.forEach(e => fn(e[1], e[0], this)); }
  toString() { return this._items.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
  get [Symbol.toStringTag]() { return 'URLSearchParams'; }
};

// ---- Request / Response / FormData: ky 等现代 HTTP 库在模块顶层就做能力探测 ----
// 缺了 Request 会让 x instanceof globalThis.Request 直接抛
// "invalid 'instanceof' right operand" (绅士漫画的 ky 请求层就栽在这)
if (typeof globalThis.FormData === 'undefined') {
  globalThis.FormData = class FormData {
    constructor() { this._entries = []; this.__isFormData = true; }
    append(k, v) { this._entries.push([String(k), v]); }
    set(k, v) { this.delete(k); this.append(k, v); }
    get(k) { for (var i = 0; i < this._entries.length; i++) if (this._entries[i][0] === String(k)) return this._entries[i][1]; return null; }
    getAll(k) { var out = []; for (var i = 0; i < this._entries.length; i++) if (this._entries[i][0] === String(k)) out.push(this._entries[i][1]); return out; }
    has(k) { return this.getAll(k).length > 0; }
    delete(k) { this._entries = this._entries.filter(function (e) { return e[0] !== String(k); }); }
    entries() { return this._entries.slice()[Symbol.iterator](); }
    keys() { return this._entries.map(function (e) { return e[0]; })[Symbol.iterator](); }
    values() { return this._entries.map(function (e) { return e[1]; })[Symbol.iterator](); }
    forEach(fn) { this._entries.forEach(function (e) { fn(e[1], e[0]); }); }
    get [Symbol.toStringTag]() { return 'FormData'; }
  };
}
if (typeof globalThis.Request === 'undefined') {
  var __reqFields = ['mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive', 'duplex'];
  globalThis.Request = class Request {
    constructor(input, init) {
      init = init || {};
      var base = (input && input.__isRequest) ? input : null;
      this.url = base ? base.url : String(input);
      this.method = String(init.method || (base ? base.method : 'GET')).toUpperCase();
      this.headers = new globalThis.Headers(init.headers || (base ? base.headers : {}));
      // 原始 body 存 _body; 对外的 .body 必须是 null —— ky 清理时会 body.cancel(),
      // 字符串 body 没有 cancel, 直接调会抛 "not a function"
      this._body = init.body !== undefined ? init.body
        : (base ? (base._body !== undefined ? base._body : base.body) : null);
      this.signal = init.signal || (base ? base.signal : null) || null;
      for (var i = 0; i < __reqFields.length; i++) {
        var k = __reqFields[i];
        this[k] = init[k] !== undefined ? init[k] : (base ? base[k] : undefined);
      }
      this.__isRequest = true;
    }
    clone() {
      return new globalThis.Request(this.url, {
        method: this.method,
        headers: this.headers && this.headers.toJSON ? this.headers.toJSON() : {},
        body: this._body,
        signal: this.signal,
      });
    }
    /** 非流式实现: 对外声明没有 body 流, 免得 ky 去 cancel 一个字符串 */
    get body() { return null; }
    get [Symbol.toStringTag]() { return 'Request'; }
  };
}
if (typeof globalThis.Response === 'undefined') {
  globalThis.Response = class Response {
    constructor(body, init) {
      init = init || {};
      this._body = body === undefined ? null : body;
      this.status = init.status === undefined ? 200 : Number(init.status);
      this.statusText = init.statusText === undefined ? '' : String(init.statusText);
      this.headers = new globalThis.Headers(init.headers || {});
      this.url = init.url || '';
      this.redirected = init.redirected === true;
      this.type = init.type || 'basic';
      this.bodyUsed = false;
      this.ok = this.status >= 200 && this.status < 300;
    }
    _bin() {
      var b = this._body;
      if (b == null) return new Uint8Array(0);
      if (typeof b === 'string') return new TextEncoder().encode(b);
      if (b.buffer && b.BYTES_PER_ELEMENT === 1) return new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
      return new TextEncoder().encode(String(b));
    }
    async text() { this.bodyUsed = true; return typeof this._body === 'string' ? this._body : new TextDecoder().decode(this._bin()); }
    async json() { return JSON.parse(await this.text()); }
    async arrayBuffer() { var b = this._bin(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    async bytes() { this.bodyUsed = true; return this._bin(); }
    async blob() {
      var b = this._bin();
      return { size: b.length, type: this.headers.get('content-type') || '', arrayBuffer: async function () { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
    }
    clone() {
      return new globalThis.Response(this._body, {
        status: this.status, statusText: this.statusText, url: this.url,
        headers: this.headers && this.headers.toJSON ? this.headers.toJSON() : {},
      });
    }
    get body() { return null; }
    get [Symbol.toStringTag]() { return 'Response'; }
    static error() { return new globalThis.Response(null, { status: 0 }); }
    static redirect(u, s) { return new globalThis.Response(null, { status: s || 302, headers: { location: u } }); }
  };
}
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: function () { return Date.now(); }, timeOrigin: Date.now() };
}

// ---- fetch（宿主执行，二进制 base64 回传）----
// 支持 fetch(url, init) 与 fetch(new Request(...)) 两种调用; 返回真 Response 实例,
// 因为 ky 用 response instanceof Response / body 流判断是否可用。
globalThis.fetch = async function (input, init) {
  var opts = init || {};
  var url, method = opts.method, headers = opts.headers, body = opts.body;
  var req = (input && typeof input === 'object' && input.__isRequest) ? input : null;
  if (req) {
    url = req.url;
    if (!method) method = req.method;
    if (!headers) headers = req.headers;
    if (body === undefined) body = req._body;
  } else {
    url = String(input);
  }
  var hdr = {};
  if (headers) {
    if (typeof headers.toJSON === 'function') hdr = headers.toJSON();
    else if (Array.isArray(headers)) headers.forEach(function (p) { hdr[String(p[0]).toLowerCase()] = String(p[1]); });
    else for (var hk in headers) hdr[String(hk).toLowerCase()] = String(headers[hk]);
  }
  var payload = body;
  if (payload != null && typeof payload !== 'string') {
    if (payload.__isFormData) {
      var parts = [];
      payload.forEach(function (v, k) { parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); });
      payload = parts.join('&');
      if (!hdr['content-type']) hdr['content-type'] = 'application/x-www-form-urlencoded';
    } else if (payload instanceof URLSearchParams) payload = payload.toString();
    else if (payload.buffer && payload.BYTES_PER_ELEMENT === 1) payload = new TextDecoder().decode(new Uint8Array(payload.buffer, payload.byteOffset || 0, payload.byteLength));
    else payload = JSON.stringify(payload);
  }
  var signalMs = (opts.signal && opts.signal._timeoutMs) || (req && req.signal && req.signal._timeoutMs) || 0;
  var r = await __hostAsync('fetch', [{ url: url, method: method || 'GET', headers: hdr, body: payload, timeoutMs: signalMs }]);
  var bin = Uint8Array.from(atob(r.bodyBase64), function (c) { return c.charCodeAt(0); });
  return new globalThis.Response(bin, {
    status: r.status, statusText: r.statusText, url: r.url, headers: r.headers,
  });
};

// ---- 宿主二进制回传 / 更完整的 Web API 兼容 ----
globalThis.__bytesToBase64 = function (b) {
  var a = (b && b.buffer && b.BYTES_PER_ELEMENT === 1) ? new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength)
        : new Uint8Array(b || []);
  var s = '';
  for (var i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
};
// URLSearchParams 的写操作已经在类里实现 (会回写 url), 这里只补一个迭代器,
// 不要再往原型上盖 append/delete —— 盖掉就丢了回写, 插件拼的参数会静默消失
URLSearchParams.prototype[Symbol.iterator] = function () { return this._items[Symbol.iterator](); };

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

// ---- process / Headers: 部分插件在模块顶层就读 process.env, 缺了会直接加载失败 ----
if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    env: {}, argv: [], platform: 'breeze', version: '20.0.0', browser: true,
    cwd: function () { return '/'; },
    nextTick: function (fn) { Promise.resolve().then(fn); },
    on: function () {}, off: function () {}, once: function () {},
    removeListener: function () {}, emit: function () {}, exit: function () {},
  };
}
if (typeof globalThis.Headers === 'undefined') {
  globalThis.Headers = function (init) {
    var map = {};
    var put = function (k, v) { map[String(k).toLowerCase()] = String(v); };
    if (init) {
      if (Array.isArray(init)) { init.forEach(function (p) { put(p[0], p[1]); }); }
      else if (typeof init.forEach === 'function' && typeof init.get === 'function') { init.forEach(function (v, k) { put(k, v); }); }
      else { Object.keys(init).forEach(function (k) { put(k, init[k]); }); }
    }
    var h = {
      get: function (k) { var v = map[String(k).toLowerCase()]; return v === undefined ? null : v; },
      set: function (k, v) { put(k, v); },
      append: function (k, v) { var kk = String(k).toLowerCase(); map[kk] = map[kk] ? map[kk] + ', ' + v : String(v); },
      has: function (k) { return map[String(k).toLowerCase()] !== undefined; },
      'delete': function (k) { delete map[String(k).toLowerCase()]; },
      forEach: function (fn) { Object.keys(map).forEach(function (k) { fn(map[k], k); }); },
      entries: function () { return Object.keys(map).map(function (k) { return [k, map[k]]; })[Symbol.iterator](); },
      keys: function () { return Object.keys(map)[Symbol.iterator](); },
      values: function () { return Object.keys(map).map(function (k) { return map[k]; })[Symbol.iterator](); },
      // 宿主 fetch 只认普通对象, 靠 toJSON 把 Headers 摊平成字典
      toJSON: function () { var o = {}; Object.keys(map).forEach(function (k) { o[k] = map[k]; }); return o; },
    };
    h[Symbol.iterator] = h.entries;
    return h;
  };
}

// ---- BreezeHtml: Breeze 提供给插件的 HTML 解析器 (cheerio 风格) ----
// 官方实现在 Dart 侧, 这里用纯 JS 复刻够用的子集: load(html) 返回 $,
// 支持 tag / .class / #id / [attr=value] 与后代、子元素组合, 以及
// toArray / attr / text / find / first / each / eq / parent / children。
if (typeof globalThis.BreezeHtml === 'undefined') {
  var __hVoid = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
  var __hRaw = { script: 1, style: 1, textarea: 1 };

  var __hDecode = function (s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, body) {
      if (body.charAt(0) === '#') {
        var code = (body.charAt(1) === 'x' || body.charAt(1) === 'X')
          ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return isNaN(code) ? m : String.fromCharCode(code);
      }
      var table = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      var v = table[body.toLowerCase()];
      return v === undefined ? m : v;
    });
  };

  var __hAttrs = function (raw) {
    var attrs = {};
    var re = /([^\\s=\\/]+)(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?/g;
    var m;
    while ((m = re.exec(raw))) {
      var k = m[1].toLowerCase();
      attrs[k] = __hDecode(m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : '')));
    }
    return attrs;
  };

  var __hFindEnd = function (html, from) {
    var quote = '';
    for (var k = from; k < html.length; k++) {
      var c = html.charAt(k);
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') return k;
    }
    return -1;
  };

  var __hParse = function (html) {
    var root = { tag: '#root', attrs: {}, children: [], parent: null, text: '' };
    var stack = [root];
    var lower = null;
    var i = 0, n = html.length;
    var pushText = function (t) {
      if (!t) return;
      stack[stack.length - 1].text += __hDecode(t);
    };
    while (i < n) {
      var lt = html.indexOf('<', i);
      if (lt < 0) { pushText(html.slice(i)); break; }
      if (lt > i) pushText(html.slice(i, lt));
      if (html.substr(lt, 4) === '<!--') {
        var cEnd = html.indexOf('-->', lt + 4);
        i = cEnd < 0 ? n : cEnd + 3;
        continue;
      }
      var nb = html.charAt(lt + 1);
      if (nb === '!' || nb === '?') {
        var dEnd = html.indexOf('>', lt);
        i = dEnd < 0 ? n : dEnd + 1;
        continue;
      }
      var gt = __hFindEnd(html, lt + 1);
      if (gt < 0) { pushText(html.slice(lt)); break; }
      var inner = html.slice(lt + 1, gt);
      if (inner.charAt(0) === '/') {
        var closeName = inner.slice(1).trim().toLowerCase();
        for (var s = stack.length - 1; s > 0; s--) {
          if (stack[s].tag === closeName) { stack.length = s; break; }
        }
        i = gt + 1;
        continue;
      }
      var mm = /^([a-zA-Z][\\w:.-]*)/.exec(inner);
      if (!mm) { i = gt + 1; continue; }
      var tag = mm[1].toLowerCase();
      var el = {
        tag: tag,
        attrs: __hAttrs(inner.slice(mm[1].length)),
        children: [], parent: stack[stack.length - 1], text: '',
      };
      el.parent.children.push(el);
      i = gt + 1;
      if (__hVoid[tag]) continue;
      if (__hRaw[tag]) {
        if (lower === null) lower = html.toLowerCase();
        var closeAt = lower.indexOf('</' + tag, i);
        el.text = __hDecode(closeAt < 0 ? html.slice(i) : html.slice(i, closeAt));
        if (closeAt < 0) { i = n; } else {
          var ce = html.indexOf('>', closeAt);
          i = ce < 0 ? n : ce + 1;
        }
        continue;
      }
      if (/\\/\\s*$/.test(inner)) continue;
      stack.push(el);
    }
    return root;
  };

  var __hCompound = function (tok) {
    var part = { tag: '', id: '', classes: [], attrs: [] };
    var i = 0;
    while (i < tok.length) {
      var c = tok.charAt(i);
      if (c === '*') { i++; continue; }
      if (c === '[') {
        var end = tok.indexOf(']', i);
        if (end < 0) break;
        var body = tok.slice(i + 1, end);
        var eq = body.indexOf('=');
        if (eq < 0) {
          part.attrs.push([body.trim().toLowerCase(), null]);
        } else {
          var key = body.slice(0, eq).trim().toLowerCase();
          var val = body.slice(eq + 1).trim();
          var q = val.charAt(0);
          if ((q === '"' || q === "'") && val.charAt(val.length - 1) === q) val = val.slice(1, -1);
          part.attrs.push([key, val]);
        }
        i = end + 1;
        continue;
      }
      var m = /^([.#]?)([\\w:\\-]+)/.exec(tok.slice(i));
      if (!m) { i++; continue; }
      if (m[1] === '.') part.classes.push(m[2]);
      else if (m[1] === '#') part.id = m[2];
      else if (!part.tag) part.tag = m[2].toLowerCase();
      i += m[0].length;
    }
    return part;
  };

  var __hMatch = function (el, part) {
    if (el.tag === '#root') return false;
    if (part.tag && el.tag !== part.tag) return false;
    if (part.id && el.attrs.id !== part.id) return false;
    var i;
    if (part.classes.length) {
      var cls = ' ' + (el.attrs['class'] || '') + ' ';
      for (i = 0; i < part.classes.length; i++) {
        if (cls.indexOf(' ' + part.classes[i] + ' ') < 0) return false;
      }
    }
    for (i = 0; i < part.attrs.length; i++) {
      var k = part.attrs[i][0], v = part.attrs[i][1];
      if (el.attrs[k] === undefined) return false;
      if (v !== null && el.attrs[k] !== v) return false;
    }
    return true;
  };

  var __hDescendants = function (el, out) {
    for (var i = 0; i < el.children.length; i++) {
      out.push(el.children[i]);
      __hDescendants(el.children[i], out);
    }
    return out;
  };

  var __hSteps = function (sel) {
    var groups = String(sel).split(',');
    var all = [];
    for (var g = 0; g < groups.length; g++) {
      var tokens = groups[g].trim().replace(/\\s*>\\s*/g, ' > ').split(/\\s+/).filter(Boolean);
      var steps = [], comb = ' ';
      for (var t = 0; t < tokens.length; t++) {
        if (tokens[t] === '>') { comb = '>'; continue; }
        if (tokens[t] === '+' || tokens[t] === '~') { comb = tokens[t]; continue; }
        steps.push({ comb: steps.length ? comb : '', part: __hCompound(tokens[t]) });
        comb = ' ';
      }
      if (steps.length) all.push(steps);
    }
    return all;
  };

  var __hQuery = function (root, sel) {
    var groups = __hSteps(sel);
    var out = [];
    for (var g = 0; g < groups.length; g++) {
      var steps = groups[g];
      var current = [root];
      for (var s = 0; s < steps.length; s++) {
        var step = steps[s];
        var next = [];
        for (var c = 0; c < current.length; c++) {
          var scope = current[c];
          var pool = step.comb === '>' ? scope.children : __hDescendants(scope, []);
          for (var p = 0; p < pool.length; p++) {
            if (__hMatch(pool[p], step.part) && next.indexOf(pool[p]) < 0) next.push(pool[p]);
          }
        }
        current = next;
        if (!current.length) break;
      }
      for (var q = 0; q < current.length; q++) {
        if (current[q] !== root && out.indexOf(current[q]) < 0) out.push(current[q]);
      }
    }
    return out;
  };

  var __hText = function (el) {
    var s = el.text || '';
    for (var i = 0; i < el.children.length; i++) s += __hText(el.children[i]);
    return s;
  };

  var __hOuter = function (el) {
    var s = '<' + el.tag;
    for (var k in el.attrs) {
      s += ' ' + k + '="' + String(el.attrs[k]).replace(/"/g, '&quot;') + '"';
    }
    s += '>' + __hText(el) + '</' + el.tag + '>';
    return s;
  };

  var __hWrap = function (nodes) {
    var api = {
      length: nodes.length,
      toArray: function () { return nodes.slice(); },
      get: function (i) { return i === undefined ? nodes.slice() : nodes[i < 0 ? nodes.length + i : i]; },
      eq: function (i) { return __hWrap(nodes.slice(i < 0 ? nodes.length + i : i, (i < 0 ? nodes.length + i : i) + 1)); },
      first: function () { return __hWrap(nodes.slice(0, 1)); },
      last: function () { return __hWrap(nodes.slice(-1)); },
      each: function (fn) {
        for (var i = 0; i < nodes.length; i++) fn.call(nodes[i], i, nodes[i]);
        return api;
      },
      forEach: function (fn) { return api.each(fn); },
      map: function (fn) {
        var out = [];
        for (var i = 0; i < nodes.length; i++) {
          var v = fn.call(nodes[i], i, nodes[i]);
          if (v !== null && v !== undefined) out.push(v);
        }
        return __hWrap(out);
      },
      filter: function (fn) {
        var out = [];
        for (var i = 0; i < nodes.length; i++) if (fn.call(nodes[i], i, nodes[i])) out.push(nodes[i]);
        return __hWrap(out);
      },
      find: function (sel) {
        var out = [];
        for (var i = 0; i < nodes.length; i++) {
          var hits = __hQuery(nodes[i], sel);
          for (var h = 0; h < hits.length; h++) if (out.indexOf(hits[h]) < 0) out.push(hits[h]);
        }
        return __hWrap(out);
      },
      children: function () {
        var out = [];
        for (var i = 0; i < nodes.length; i++) out = out.concat(nodes[i].children);
        return __hWrap(out);
      },
      parent: function () {
        var out = [];
        for (var i = 0; i < nodes.length; i++) {
          var p = nodes[i].parent;
          if (p && p.tag !== '#root' && out.indexOf(p) < 0) out.push(p);
        }
        return __hWrap(out);
      },
      next: function () {
        var out = [];
        for (var i = 0; i < nodes.length; i++) {
          var p = nodes[i].parent;
          if (!p) continue;
          var nxt = p.children[p.children.indexOf(nodes[i]) + 1];
          if (nxt) out.push(nxt);
        }
        return __hWrap(out);
      },
      attr: function (k, v) {
        var key = String(k).toLowerCase();
        if (v === undefined) return nodes.length ? nodes[0].attrs[key] : undefined;
        for (var i = 0; i < nodes.length; i++) nodes[i].attrs[key] = String(v);
        return api;
      },
      removeAttr: function (k) {
        for (var i = 0; i < nodes.length; i++) delete nodes[i].attrs[String(k).toLowerCase()];
        return api;
      },
      text: function (v) {
        if (v === undefined) {
          var s = '';
          for (var i = 0; i < nodes.length; i++) s += __hText(nodes[i]);
          return s;
        }
        for (var j = 0; j < nodes.length; j++) { nodes[j].children = []; nodes[j].text = String(v); }
        return api;
      },
      html: function (v) {
        if (v === undefined) return nodes.length ? __hText(nodes[0]) : '';
        for (var i = 0; i < nodes.length; i++) { nodes[i].children = []; nodes[i].text = String(v); }
        return api;
      },
      outerHtml: function () { return nodes.length ? __hOuter(nodes[0]) : ''; },
      hasClass: function (c) {
        for (var i = 0; i < nodes.length; i++) {
          if ((' ' + (nodes[i].attrs['class'] || '') + ' ').indexOf(' ' + c + ' ') >= 0) return true;
        }
        return false;
      },
      val: function () { return nodes.length ? (nodes[0].attrs.value || '') : ''; },
      is: function (sel) {
        for (var i = 0; i < nodes.length; i++) {
          if (__hMatch(nodes[i], __hCompound(String(sel)))) return true;
        }
        return false;
      },
    };
    return api;
  };

  globalThis.BreezeHtml = {
    load: function (html) {
      var root = __hParse(String(html == null ? '' : html));
      var $ = function (sel) {
        if (sel && typeof sel === 'object') return __hWrap([sel]);
        if (typeof sel === 'string') return __hWrap(__hQuery(root, sel));
        return __hWrap([]);
      };
      $.root = root;
      $.html = function () { return __hText(root); };
      $.find = function (sel) { return __hWrap(__hQuery(root, sel)); };
      return $;
    },
  };
}
`;
