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
};
`

  const requests = []
  const saved = {}
  const toasts = []
  const request = async init => {
    requests.push(init)
    const body = Buffer.from('hello:' + init.url, 'utf8')
    return {
      status: 200, ok: true, url: init.url,
      headers: { 'content-type': 'text/plain' },
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

  host.dispose()
  await assert.rejects(() => host.call('getInfo', {}), /已释放/)

  console.log('test-comic-plugin: OK (fnPath / bridge / crypto全套 / cache / timer / callSync / unauthorized / fetch / bytes / error / timeout / dispose)')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
