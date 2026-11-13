/**
 * 插件设置 / 登录态 / 云端收藏协议回归测试 (不联网、不启动 QuickJS)。
 *
 * 用 esbuild 把 account.ts 打成临时 ESM, 并把 ./index (withPlugin) 与
 * ./registry (本地插件配置) 替换成内存桩, 验证 Breeze 协议的归一化边界:
 * 设置表单、登录表单 fnPath 兜底、用户信息合并、能力清单、设置保存回落。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightread-comic-account-'))
const outfile = path.join(tmp, 'account.mjs')

// 内存桩: fake host 的 fns 决定插件实现了哪些方法, calls 记录所有 fnPath 调用
const stub = {
  name: 'stub-plugin-runtime',
  setup(b) {
    b.onResolve({ filter: /^\.\/(index|registry)$/ }, args => ({ path: args.path, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => {
      if (args.path === './index') {
        return {
          loader: 'js',
          contents: `export async function withPlugin(uuid, fn) {
  const t = globalThis.__accountTest
  return fn({
    hasFn: (n) => Object.prototype.hasOwnProperty.call(t.fns, n),
    call: async (n, params, opts) => {
      t.calls.push({ n, params, opts })
      const f = t.fns[n]
      if (!f) throw Error('plugin has no function: ' + n)
      return f(params)
    },
  })
}`,
        }
      }
      return {
        loader: 'js',
        contents: `export function setPluginConfigValue(...args) {
  globalThis.__accountTest.saved.push(args)
}`,
      }
    })
  },
}

function reset(fns = {}) {
  globalThis.__accountTest = { fns, calls: [], saved: [] }
}

try {
  await build({
    entryPoints: [path.join(root, 'src/services/comicPlugin/account.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [stub],
  })
  const account = await import(pathToFileURL(outfile).href)

  // ---- 1. 插件没有 getSettingsBundle 时返回空壳, 不能抛错 ----
  reset({})
  assert.deepEqual(await account.loadPluginSettings('u'), {
    sections: [], values: {}, canLogin: false, canShowUserInfo: false,
  }, '老插件没有设置接口时应降级为空设置页')

  // ---- 2. 设置表单归一化: 分组 / 字段 / 下拉选项 / 默认值 / 脏字段 ----
  reset({
    getSettingsBundle: async () => ({
      scheme: {
        sections: [
          { title: '账号', fields: [
            { key: 'qa.token', kind: 'password', label: '令牌', placeholder: '留空即匿名' },
            { key: 'qa.lang', label: '', options: [
              { label: '简体中文', value: 'zh' }, { title: 'English', id: 'en' },
            ] },
            { label: '没有 key 的字段' },
          ] },
          { id: 'net', title: '', fields: [{ key: 'qa.timeout', defaultValue: 30 }] },
        ],
      },
      data: { values: { 'qa.token': 'abc' }, canLogin: true, canShowUserInfo: true },
    }),
  })
  const settings = await account.loadPluginSettings('u')
  assert.equal(settings.sections.length, 2)
  assert.equal(settings.sections[0].id, 'section-0', '缺 id 的分组应自动编号')
  assert.equal(settings.sections[0].title, '账号')
  assert.equal(settings.sections[0].fields.length, 2, '无 key 字段必须被过滤掉')
  assert.equal(settings.sections[0].fields[0].kind, 'password')
  assert.equal(settings.sections[0].fields[0].placeholder, '留空即匿名')
  assert.equal(settings.sections[0].fields[1].label, 'qa.lang', '缺 label 时回落到 key')
  assert.equal(settings.sections[0].fields[1].kind, 'text', '缺 kind 时默认 text')
  assert.deepEqual(settings.sections[0].fields[1].options, [
    { label: '简体中文', value: 'zh' }, { label: 'English', value: 'en' },
  ], '下拉项 label/value 要兼容 Breeze 的 title/id 写法')
  assert.equal(settings.sections[1].id, 'net')
  assert.equal(settings.sections[1].fields[0].defaultValue, 30)
  assert.deepEqual(settings.values, { 'qa.token': 'abc' })
  assert.equal(settings.canLogin, true)
  assert.equal(settings.canShowUserInfo, true)

  // ---- 3. 登录表单: action.fnPath / submitText, 旧写法 submitFnPath 兜底 ----
  reset({
    getLoginBundle: async () => ({
      scheme: {
        title: 'QA 登录',
        fields: [{ key: 'account', label: '用户名' }, { key: 'password', kind: 'password', label: '密码' }],
        action: { fnPath: 'loginWithPassword', submitText: '登录' },
      },
      data: { values: { account: 'saved-user' } },
    }),
  })
  const login = await account.loadLoginBundle('u')
  assert.equal(login.fnPath, 'loginWithPassword')
  assert.equal(login.submitText, '登录')
  assert.equal(login.title, 'QA 登录')
  assert.deepEqual(login.fields.map(f => f.key), ['account', 'password'])
  assert.deepEqual(login.values, { account: 'saved-user' })

  reset({
    getLoginBundle: async () => ({ scheme: { submitFnPath: 'legacyLogin', submitText: '' } }),
  })
  const legacyLogin = await account.loadLoginBundle('u')
  assert.equal(legacyLogin.fnPath, 'legacyLogin', '旧插件的 submitFnPath 也要能登录')
  assert.equal(legacyLogin.submitText, '登录')
  assert.equal(legacyLogin.title, '登录')

  reset({ getLoginBundle: async () => ({ scheme: { fields: [] } }) })
  assert.equal(await account.loadLoginBundle('u'), null, '没有提交 fnPath 就不该显示登录表单')
  reset({})
  assert.equal(await account.loadLoginBundle('u'), null, '插件没有登录接口时返回 null')

  // ---- 4. 登录提交: 插件自己存会话, 宿主只把表单值原样递过去 ----
  reset({ loginWithPassword: async p => ({ ok: p.account === 'qa-user' && p.password === 'pw123' }) })
  assert.deepEqual(
    await account.submitLogin('u', 'loginWithPassword', { account: 'qa-user', password: 'pw123' }),
    { ok: true },
  )
  assert.equal(globalThis.__accountTest.calls[0].n, 'loginWithPassword')
  assert.equal(globalThis.__accountTest.calls[0].opts.timeoutMs, 60_000, '登录允许慢速网络')
  assert.deepEqual(globalThis.__accountTest.calls[0].params, { account: 'qa-user', password: 'pw123' })

  // ---- 5. 用户信息: data.userInfo 与 data 平铺都要兼容 ----
  reset({ getUserInfoBundle: async () => ({ data: { userInfo: { username: 'qa-user' }, coin: '88' } }) })
  assert.deepEqual(await account.loadUserInfo('u'), { username: 'qa-user', coin: '88' })
  reset({})
  assert.deepEqual(await account.loadUserInfo('u'), {}, '插件无用户信息接口时返回空对象')

  // ---- 6. 能力清单: 缺字段的动作过滤, 插件抛错时静默降级 ----
  reset({
    getCapabilitiesBundle: async () => ({ scheme: { actions: [
      { key: 'clear_session', title: '清理插件会话', fnPath: 'clearPluginSession' },
      { key: 'no_title', fnPath: 'doThing' },
      { key: 'no_fn' },
    ] } }),
  })
  const caps = await account.loadCapabilities('u')
  assert.deepEqual(caps, [
    { key: 'clear_session', title: '清理插件会话', fnPath: 'clearPluginSession' },
    { key: 'no_title', title: 'no_title', fnPath: 'doThing' },
  ])
  reset({ getCapabilitiesBundle: async () => { throw Error('plugin crashed') } })
  assert.deepEqual(await account.loadCapabilities('u'), [], '能力清单失败不该拖垮设置页')

  reset({ clearPluginSession: async () => ({ ok: true }) })
  assert.deepEqual(await account.runCapability('u', 'clearPluginSession'), { ok: true })

  // ---- 7. 设置保存: 优先 onSettingChanged, 插件拒绝时回落到本地配置 ----
  reset({ onSettingChanged: async p => { if (p.key !== 'qa.lang') throw Error('unsupported'); return { ok: true } } })
  await account.saveSettingValue('u', 'qa.lang', 'zh')
  assert.equal(globalThis.__accountTest.calls[0].n, 'onSettingChanged')
  assert.equal(globalThis.__accountTest.saved.length, 0)

  reset({ onSettingChanged: async () => { throw Error('unsupported') } })
  await account.saveSettingValue('u', 'qa.timeout', 30)
  assert.deepEqual(globalThis.__accountTest.saved[0], ['u', 'qa.timeout', '30'], '回落时数字要序列化成字符串')

  reset({})
  await account.saveSettingValue('u', 'qa.token', 'abc')
  assert.deepEqual(globalThis.__accountTest.saved[0], ['u', 'qa.token', 'abc'])

  console.log('test-comic-account: OK (settings / login fnPath 兜底 / 提交 / userInfo / capabilities / 保存回落)')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
