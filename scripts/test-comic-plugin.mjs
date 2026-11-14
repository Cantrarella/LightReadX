/**
 * 漫画插件运行时回归测试 (不联网、不依赖外部插件文件)。
 *
 * 用 esbuild 把 host.ts 打成临时 ESM, 再用一个内置迷你 Breeze 插件验证宿主能力:
 * fnPath 调用、bridge 配置读写、任务取消、crypto(HMAC/Hash)、URL、fetch、二进制回传、错误与超时。
 * 真实插件的联网全链路验证见 plugin-lab (开发期), 不进 CI 以免受站点风控影响。
 */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightread-comic-plugin-'))
const outfile = path.join(tmp, 'host.mjs')

try {
  await build({
    entryPoints: [path.join(root, 'src/services/comicPlugin/host.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  })
  const { createComicPluginHost } = await import(pathToFileURL(outfile).href)

  const MINI_PLUGIN = `
module.exports.default = {
  getInfo: async () => ({ name: 'Mini', uuid: 'mini-test', version: '1.0.0' }),
  echo: async (p) => p,
  hmac: async () => globalThis.crypto.createHmac('sha1', 'key').update('msg').digest('hex'),
  hmacB64: async () => globalThis.crypto.createHmac('sha256', 'key').update('msg').digest('base64'),
  hash: async () => globalThis.crypto.createHash('md5').update('msg').digest('hex'),
  url: async (p) => new URL(p.url).searchParams.get('q'),
  cfg: async () => bridge.call('load_plugin_config', 'lang', 'en'),
  save: async () => { await bridge.call('save_plugin_config', 'lang', 'zh'); return 'saved' },
  cancelled: async (p) => bridge.call('runtime.is_task_group_cancelled', p.key),
  fetchText: async (p) => (await fetch(p.url, { headers: { 'x-test': '1' } })).text(),
  bytes: async () => new Uint8Array([255, 216, 255, 224, 0, 1]),
  md5: async () => globalThis.crypto.md5('msg'),
  sha256: async () => globalThis.crypto.sha256('msg'),
  randomBytes: async () => globalThis.crypto.randomBytes(8).length,
  aesRoundTrip: async () => {
    var key = '1234567890abcdef', iv = 'abcdef1234567890';
    var enc = globalThis.crypto.aesCbcPkcs7Encrypt('hello breeze', key, iv);
    var dec = globalThis.crypto.aesCbcPkcs7Decrypt(enc, key, iv);
    return new TextDecoder().decode(dec);
  },
  aesBridge: async () => {
    var key = '1234567890abcdef';
    var enc = await bridge.call('crypto.aes_ecb_pkcs7_encrypt_b64', btoa('payload'), key);
    var dec = await bridge.call('crypto.aes_ecb_pkcs7_decrypt_b64', enc, key);
    return atob(dec);
  },
  cache: async () => {
    await bridge.call('cache.set', 'k', 'v');
    var a = await bridge.call('cache.get', 'k', '');
    await bridge.call('cache.delete', 'k');
    var b = await bridge.call('cache.get', 'k', '');
    return { a: a, b: b };
  },
  appVersion: async () => bridge.call('dart.getAppVersion'),
  toast: async () => bridge.call('flutter.showToast', JSON.stringify({ message: 'hi' })),
  syncAdd: async () => bridge.callSync('math.add', 2, 3),
  timer: async () => new Promise(function (r) { setTimeout(function () { r('tick'); }, 10); }),
  configWrapped: async () => bridge.call('load_plugin_config', 'existing', '{}'),
  unauthorized: async () => { throw Error(JSON.stringify({ type: 'unauthorized', message: '登录已失效' })); },
  boom: async () => { throw new Error('boom from plugin') },
  slow: async () => new Promise(() => {}),
  // 绅士漫画那类插件在模块顶层就要求 BreezeHtml, 少一个全局直接加载失败
  htmlPick: async () => {
    var html = '<div class="sr_compact"><a href="/c/1" data-src="//img/1.jpg">标题一</a>' +
               '<a href="/c/2"><img src="/img/2.jpg"></a></div><ul id="classTit"><li>乙</li></ul>';
    var $ = BreezeHtml.load(html);
    var links = $('.sr_compact a').toArray().map(function (el) {
      var n = $(el);
      return n.attr('href') + '|' + (n.attr('data-src') || n.find('img').attr('src') || '') + '|' + n.text();
    });
    return { links: links, id: $('#classTit li').text(), tag: $('li').length };
  },
  procEnv: async () => ({ d: process.env.BAOZIMH_DOMAIN || '', p: typeof process.nextTick }),
  headerJson: async () => JSON.stringify(new Headers({ 'X-Test': 'ok' })),
  // 绅士漫画的 ky 在模块顶层就探测这些全局, 缺一个整包加载即抛
  // "invalid 'instanceof' right operand"
  // ky 的写法: new URL(...) 之后改 .search / .searchParams 再 toString()
  urlMutate: async () => {
    var u = new URL('/search/', 'https://www.wnacg.com/');
    u.search = '?q=' + encodeURIComponent('催眠') + '&f=_all';
    var a = u.toString();
    var v = new URL('https://a.com/x');
    v.searchParams.set('q', 'y');
    v.searchParams.append('p', '2');
    return { a: a, b: v.toString(), get: v.searchParams.get('q'), has: v.searchParams.has('p') };
  },
  kyProbe: async () => ({
    req: typeof Request, res: typeof Response, fd: typeof FormData,
    perf: typeof performance.now(), any: typeof AbortSignal.any,
  }),
  reqRoundTrip: async (p) => {
    var r = new Request(p.url, { method: 'POST', body: 'payload' });
    var res = await fetch(r, { headers: { 'x-test': '2' } });
    return {
      url: r.url, method: r.method, status: res.status, ok: res.ok,
      text: await res.text(), bodyIsNull: r.body === null, cloneUrl: r.clone().url,
    };
  },
  resCloneJson: async () => {
    var res = await fetch('https://example.com/json');
    var text = await res.text();
    var again = await res.clone().text();
    return { text: text, again: again, json: await res.clone().json() };
  },
  abortAny: async () => {
    var a = new AbortController(), b = new AbortController();
    var s = AbortSignal.any([a.signal, b.signal]);
    var fired = 0;
    s.addEventListener('abort', function () { fired++ });
    b.abort();
    return { aborted: s.aborted, fired: fired };
  },
  urlBase: async () => new URL('/statics/js/slider.js', 'https://18comic.vip/comic/1').href,
  formBody: async () => {
    var f = new FormData();
    f.append('user', 'a b');
    f.append('pass', '1');
    var res = await fetch('https://example.com/login', { method: 'POST', body: f });
    return { text: await res.text() };
  },
  // 同一宿主上并发调用: 各自必须拿到自己的结果
  identityLater: async p => {
    await new Promise(function (r) { setTimeout(r, p.delay); });
    return p.value;
  },
};
`

  const requests = []
  const saved = {}
  const toasts = []
  const request = async init => {
    requests.push(init)
    const body = Buffer.from(
      init.url.endsWith('/json') ? '{"ok":true}' : 'hello:' + init.url,
      'utf8',
    )
    return {
      status: 200, ok: true, url: init.url,
      headers: { 'content-type': init.url.endsWith('/json') ? 'application/json' : 'text/plain' },
      bodyBase64: body.toString('base64'),
    }
  }

  const host = await createComicPluginHost({
    code: MINI_PLUGIN,
    request,
    pluginConfig: { existing: 'value' },
    onConfigSave: (key, value) => { saved[key] = value },
    onToast: message => { toasts.push(message) },
  })

  assert.equal(host.hasFn('getInfo'), true, 'getInfo 应存在')
  assert.equal(host.hasFn('nope'), false, '不存在的 fnPath 应返回 false')

  const info = await host.call('getInfo', {})
  assert.equal(info.name, 'Mini')
  assert.equal(info.uuid, 'mini-test')

  assert.deepEqual(await host.call('echo', { a: 1, b: 'x' }), { a: 1, b: 'x' })

  assert.equal(
    await host.call('hmac'),
    createHmac('sha1', 'key').update('msg').digest('hex'),
    'HMAC-SHA1 必须与 Node 一致 (WEBTOON 用它签名)',
  )
  assert.equal(
    await host.call('hmacB64'),
    createHmac('sha256', 'key').update('msg').digest('base64'),
    'HMAC-SHA256 base64',
  )
  assert.equal(await host.call('hash'), createHash('md5').update('msg').digest('hex'))

  assert.equal(await host.call('url', { url: 'https://example.com/p?q=abc&lang=zh' }), 'abc')
  assert.equal(await host.call('cfg'), 'en', '未配置时返回默认值')
  assert.equal(await host.call('save'), 'saved')
  assert.equal(saved.lang, 'zh', '插件写配置应回调宿主')

  assert.equal(await host.call('cancelled', { key: 'group-1' }), false)
  host.cancelGroup('group-1')
  assert.equal(await host.call('cancelled', { key: 'group-1' }), true)

  assert.equal(await host.call('fetchText', { url: 'https://example.com/a' }), 'hello:https://example.com/a')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].headers['x-test'], '1', '插件自定义请求头要透传')

  const bytes = await host.callBytes('bytes')
  assert.ok(bytes instanceof Uint8Array, 'callBytes 应返回 Uint8Array')
  assert.deepEqual([...bytes], [255, 216, 255, 224, 0, 1])

  // ---- Breeze 全套运行时能力 ----
  assert.equal(await host.call('md5'), createHash('md5').update('msg').digest('hex'), 'crypto.md5')
  assert.equal(await host.call('sha256'), createHash('sha256').update('msg').digest('hex'), 'crypto.sha256')
  assert.equal(await host.call('randomBytes'), 8, 'crypto.randomBytes (kit 校验必需)')
  assert.equal(await host.call('aesRoundTrip'), 'hello breeze', 'AES-CBC PKCS#7 加解密')
  assert.equal(await host.call('aesBridge'), 'payload', '旧版 crypto.*_b64 路由')
  assert.deepEqual(await host.call('cache'), { a: 'v', b: '' }, 'cache.get/set/delete')
  assert.equal(await host.call('appVersion'), '3.0.40', 'dart.getAppVersion')
  assert.equal(await host.call('toast'), null, 'flutter.showToast')
  assert.deepEqual(toasts, ['hi'], '插件提示应回调宿主')
  assert.equal(await host.call('syncAdd'), 5, 'bridge.callSync 不再直接抛错')
  assert.equal(await host.call('timer', {}, { timeoutMs: 3000 }), 'tick', 'QuickJS 定时器')
  assert.deepEqual(JSON.parse(await host.call('configWrapped')), { ok: true, value: 'value' }, 'kit 风格配置读取')
  await assert.rejects(() => host.call('unauthorized', {}), e => e.code === 'unauthorized', '登录失效应可识别')

  await assert.rejects(() => host.call('boom', {}), /boom from plugin/)
  await assert.rejects(() => host.call('slow', {}, { timeoutMs: 300 }), /超时/)

  // ---- BreezeHtml / process / Headers: 缺任何一个, 商店里那两个插件都装不上 ----
  const picked = await host.call('htmlPick')
  assert.deepEqual(picked.links, [
    '/c/1|//img/1.jpg|标题一',
    '/c/2|/img/2.jpg|',
  ], 'BreezeHtml 解析 + .sr_compact a 选择器 + attr/text/find')
  assert.equal(picked.id, '乙', '#id 后代选择器')
  assert.equal(picked.tag, 1, '标签选择器')
  assert.deepEqual(await host.call('procEnv'), { d: '', p: 'function' }, 'process.env 兜底')
  assert.equal(await host.call('headerJson'), '{"x-test":"ok"}', 'Headers 要能摊平成字典给宿主 fetch')

  // ---- Request / Response / FormData / performance / AbortSignal.any ----
  // 绅士漫画用 ky 发请求, 上面任何一个缺失都会让整个插件包在加载阶段就抛错,
  // 表现为"这个源一条数据都没有, 别的源一起报失败"。
  assert.deepEqual(
    await host.call('kyProbe'),
    { req: 'function', res: 'function', fd: 'function', perf: 'number', any: 'function' },
    'ky 的能力探测全局必须齐全',
  )
  const rt = await host.call('reqRoundTrip', { url: 'https://example.com/post' })
  assert.equal(rt.url, 'https://example.com/post')
  assert.equal(rt.method, 'POST')
  assert.equal(rt.status, 200)
  assert.equal(rt.ok, true)
  assert.equal(rt.text, 'hello:https://example.com/post', 'fetch(new Request(...)) 要能拿到 body')
  assert.equal(rt.bodyIsNull, true, '.body 必须是 null, 否则 ky 会调字符串的 cancel()')
  assert.equal(rt.cloneUrl, 'https://example.com/post', 'Request.clone()')
  assert.equal(requests.at(-1).body, 'payload', 'Request 里的 body 要透传给宿主')
  assert.equal(requests.at(-1).headers['x-test'], '2', 'fetch 的第二参数 headers 仍要生效')

  const rc = await host.call('resCloneJson')
  assert.equal(rc.text, '{"ok":true}', 'Response.text()')
  assert.equal(rc.again, '{"ok":true}', 'Response.clone() 之后还能再读一次')
  assert.deepEqual(rc.json, { ok: true }, 'Response.json()')

  assert.deepEqual(await host.call('abortAny'), { aborted: true, fired: 1 }, 'AbortSignal.any 合并信号')
  assert.equal(
    await host.call('urlBase'),
    'https://18comic.vip/statics/js/slider.js',
    'new URL(path, base) 必须支持第二参数 (ky 用它拼相对地址)',
  )
  const um = await host.call('urlMutate')
  assert.equal(um.a, 'https://www.wnacg.com/search/?q=%E5%82%AC%E7%9C%A0&f=_all', 'URL.search 赋值要体现在 href 上')
  assert.equal(um.b, 'https://a.com/x?q=y&p=2', 'searchParams.set/append 要回写 url')
  assert.equal(um.get, 'y')
  assert.equal(um.has, true, 'searchParams.has')
  assert.equal(
    (await host.call('formBody')).text,
    'hello:https://example.com/login',
    'FormData 请求体',
  )
  assert.equal(requests.at(-1).body, 'user=a%20b&pass=1', 'FormData 要摊成 urlencoded')
  assert.equal(
    requests.at(-1).headers['content-type'],
    'application/x-www-form-urlencoded',
    'FormData 自动补 content-type',
  )

  // ---- 同一宿主并发调用: 结果不能互相覆盖 (并发拉封面时曾导致整页像卡死) ----
  const [fast, slowOne] = await Promise.all([
    host.call('identityLater', { delay: 10, value: 'fast' }, { timeoutMs: 5000 }),
    host.call('identityLater', { delay: 400, value: 'slow' }, { timeoutMs: 5000 }),
  ])
  assert.equal(fast, 'fast', '快调用要拿到自己的结果')
  assert.equal(slowOne, 'slow', '慢调用要拿到自己的结果')

  host.dispose()
  await assert.rejects(() => host.call('getInfo', {}), /已释放/)

  console.log('test-comic-plugin: OK (fnPath / bridge / crypto全套 / cache / timer / callSync / unauthorized / fetch / bytes / error / timeout / BreezeHtml / process / Headers / Request / Response / FormData / AbortSignal.any / URL base / 并发隔离 / dispose)')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
