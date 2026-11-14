/**
 * Breeze 插件账号 / 设置 / 云端收藏相关协议。
 *
 * 凭据完全由插件自己通过 save_plugin_config 存到本地, 宿主只负责:
 *   getSettingsBundle  → 渲染设置表单
 *   getLoginBundle     → 渲染登录表单, 提交 action.fnPath
 *   getUserInfoBundle  → 展示用户信息 (未登录会抛 unauthorized)
 *   getCapabilitiesBundle → clear_session 等动作
 *   getPluginCloudFavoritePagesBundle → 云端收藏 tab (在 discover.ts 合并)
 */
import { t } from '../../i18n'
import { withPlugin } from './index'
import * as registry from './registry'

export interface PluginSliderSpec {
  createFnPath: string
  verifyFnPath: string
}

export interface PluginSettingField {
  key: string
  kind: string
  label: string
  placeholder?: string
  description?: string
  options?: Array<{ label: string; value: unknown }>
  defaultValue?: unknown
  /** kind='slider-captcha' 时插件给的题目/校验函数 */
  slider?: PluginSliderSpec
}

export interface PluginSettingSection {
  id: string
  title: string
  fields: PluginSettingField[]
}

export interface PluginSettingsBundle {
  sections: PluginSettingSection[]
  values: Record<string, unknown>
  canLogin: boolean
  canShowUserInfo: boolean
}

export interface PluginLoginBundle {
  title: string
  fields: PluginSettingField[]
  fnPath: string
  submitText: string
  values: Record<string, unknown>
}

export interface PluginCapability {
  key: string
  title: string
  fnPath: string
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function normalizeField(raw: unknown): PluginSettingField {
  const f = obj(raw)
  const options = arr(f.options).map(option => {
    const o = obj(option)
    return { label: text(o.label) || text(o.title) || text(o.value), value: o.value ?? o.id }
  })
  // slider-captcha: 插件把出题/校验函数挂在 field.slider 上, 宿主据此渲染滑块
  const slider = obj(f.slider)
  const sliderSpec = {
    createFnPath: text(slider.createFnPath) || text(f.createFnPath),
    verifyFnPath: text(slider.verifyFnPath) || text(f.verifyFnPath),
  }
  return {
    key: text(f.key),
    kind: text(f.kind) || 'text',
    label: text(f.label) || text(f.key),
    ...(text(f.placeholder) ? { placeholder: text(f.placeholder) } : {}),
    ...(text(f.description) ? { description: text(f.description) } : {}),
    ...(options.length ? { options } : {}),
    ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
    ...(sliderSpec.createFnPath && sliderSpec.verifyFnPath ? { slider: sliderSpec } : {}),
  }
}

export async function loadPluginSettings(uuid: string): Promise<PluginSettingsBundle> {
  return withPlugin(uuid, async host => {
    if (!host.hasFn('getSettingsBundle')) {
      return { sections: [], values: {}, canLogin: false, canShowUserInfo: false }
    }
    const raw = await host.call('getSettingsBundle', {}, { timeoutMs: 30_000 })
    const root = obj(raw)
    const scheme = obj(root.scheme)
    const data = obj(root.data)
    const sections = arr(scheme.sections).map((section, index) => {
      const s = obj(section)
      return {
        id: text(s.id) || `section-${index}`,
        title: text(s.title),
        fields: arr(s.fields).map(normalizeField).filter(f => f.key),
      }
    })
    return {
      sections,
      values: obj(data.values),
      canLogin: data.canLogin === true,
      canShowUserInfo: data.canShowUserInfo === true,
    }
  })
}

export async function loadLoginBundle(uuid: string): Promise<PluginLoginBundle | null> {
  return withPlugin(uuid, async host => {
    if (!host.hasFn('getLoginBundle')) return null
    const raw = await host.call('getLoginBundle', {}, { timeoutMs: 30_000 })
    const root = obj(raw)
    const scheme = obj(root.scheme)
    const action = obj(scheme.action)
    const fnPath = text(action.fnPath) || text(scheme.submitFnPath)
    if (!fnPath) return null
    return {
      title: text(scheme.title) || '登录',
      fields: arr(scheme.fields).map(normalizeField).filter(f => f.key),
      fnPath,
      submitText: text(action.submitText) || text(scheme.submitText) || '登录',
      values: obj(obj(root.data).values),
    }
  })
}

/**
 * 登录表单提交; 插件内部会自己保存会话, 宿主不接触账号密码之外的逻辑。
 * 部分插件失败时只返回 {ok:false,message} 而不抛异常, 这里统一校验, 避免误报「登录成功」。
 */
export async function submitLogin(uuid: string, fnPath: string, values: Record<string, unknown>): Promise<unknown> {
  return withPlugin(uuid, async host => {
    const result = await host.call(fnPath, { ...values }, { timeoutMs: 60_000 })
    const root = obj(result)
    const data = obj(root.data)
    const message = text(root.message)
    const failure = text(root.error) || text(data.error)
    if (
      root.ok === false || root.success === false ||
      data.ok === false || data.success === false || failure
    ) {
      throw new Error(failure || message || t('comics.loginFailed'))
    }
    if (message && /失败|错误|无效|不正确|invalid|failed|incorrect/i.test(message)) {
      throw new Error(message)
    }
    // 登录成功, 本地打一个「已登录」标记。
    // 部分插件 (如绅士漫画) 的 getUserInfoBundle 返回结构不被宿主识别成「已登录」,
    // 导致登录后设置页仍显示未登录; 这里以「登录动作成功」为准兜底。
    try { registry.setPluginConfigValue(uuid, '__loggedIn', true) } catch { /* 忽略 */ }
    return result
  })
}

/**
 * Breeze 新版 getUserInfoBundle 给的是「渲染型」数据, 不含 username/nickname:
 *   { data: { title, avatar:{url}, lines:['用户名 (硬币: x)','Lv.x …','经验值: x/y'],
 *             extern:{uid} } }
 * 宿主把它摊平成设置页能直接读的字段, 同时保留 lines 原样展示。
 * 老插件的平铺字段 / data.userInfo 不做加工, 保持原样。
 */
export function renderedUserInfo(data: Record<string, unknown>): Record<string, unknown> {
  if (!(data.title || data.lines || data.avatar || data.extern)) return {}
  const out: Record<string, unknown> = {}
  const avatar = obj(data.avatar)
  const avatarUrl = text(avatar.url) || text(avatar.path) || text(data.avatar)
  const lines = arr(data.lines).map(text).filter(Boolean)
  const joined = lines.join(' · ')
  const uid = text(obj(data.extern).uid)
  const first = lines[0] ?? ''
  const name = text(data.username) || text(data.nickname) || text(data.name)
    || first.replace(/\s*[（(].*$/, '').trim()
  const coin = /硬币[:：]\s*([^)）\s·]+)/.exec(joined)?.[1]
  const level = /(Lv\.?\s*\d+[^·]*)/i.exec(joined)?.[1]?.trim()
  const exp = /经验值[:：]\s*([\d/]+)/.exec(joined)?.[1]
  if (avatarUrl) { out.avatar = avatarUrl; out.photo = avatarUrl }
  if (lines.length) out.lines = lines
  if (uid) out.uid = uid
  if (name) { out.username = name; out.name = name }
  if (coin) out.coin = coin
  if (level) out.levelName = level
  if (exp) out.exp = exp
  // 渲染型结构本身就是「已登录」的凭据, 不能再用有没有 username 判断
  if (name || lines.length || avatarUrl || uid) out.loggedIn = true
  return out
}

/** 清掉本地「已登录」标记 (退出登录 / 清除会话时调用) */
export function clearLocalLogin(uuid: string): void {
  try { registry.setPluginConfigValue(uuid, '__loggedIn', false) } catch { /* 忽略 */ }
}

/** 用户信息; 未登录时插件抛 unauthorized/普通错误, UI 层 catch 后显示登录入口 */
export async function loadUserInfo(uuid: string): Promise<Record<string, unknown>> {
  return withPlugin(uuid, async host => {
    // 本地「已登录」标记: 登录动作成功时写入, 用于兜底识别那些
    // getUserInfoBundle 返回结构不被宿主识别的插件 (登录成功但设置页误显未登录)。
    const locallyLoggedIn = registry.getPluginConfig(uuid)['__loggedIn'] === true
    if (!host.hasFn('getUserInfoBundle')) {
      return locallyLoggedIn ? { loggedIn: true } : {}
    }
    const raw = await host.call('getUserInfoBundle', {}, { timeoutMs: 30_000 })
    const root = obj(raw)
    const { userInfo, ...rest } = obj(root.data)
    // 插件有两种写法: data.userInfo 嵌套对象 / 字段直接平铺在 data 上。
    // 合并时要把 userInfo 本身摘掉, 否则设置页会把整个对象当字段渲染成 [object Object]。
    const base = { ...obj(userInfo), ...rest }
    const rendered = renderedUserInfo(base)
    // 插件没给可识别的用户信息, 但本地有登录标记 → 仍视为已登录 (避免误显未登录)
    if (!rendered.loggedIn && locallyLoggedIn && Object.keys(rendered).length === 0) {
      return { ...base, ...rendered, loggedIn: true }
    }
    return { ...base, ...rendered }
  })
}

export async function loadCapabilities(uuid: string): Promise<PluginCapability[]> {
  return withPlugin(uuid, async host => {
    if (!host.hasFn('getCapabilitiesBundle')) return []
    try {
      const raw = await host.call('getCapabilitiesBundle', {}, { timeoutMs: 20_000 })
      const actions = arr(obj(obj(raw).scheme).actions)
      return actions.map(action => {
        const a = obj(action)
        return { key: text(a.key), title: text(a.title) || text(a.key), fnPath: text(a.fnPath) }
      }).filter(a => a.key && a.fnPath)
    } catch { return [] }
  })
}

export async function runCapability(uuid: string, fnPath: string): Promise<unknown> {
  return withPlugin(uuid, host => host.call(fnPath, {}, { timeoutMs: 30_000 }))
}

/** 设置字段保存: 优先走插件自己的 onSettingChanged, 否则直接写本地插件配置 */
export async function saveSettingValue(uuid: string, key: string, value: unknown): Promise<void> {
  await withPlugin(uuid, async host => {
    if (host.hasFn('onSettingChanged')) {
      try {
        await host.call('onSettingChanged', { key, value }, { timeoutMs: 20_000 })
        return
      } catch { /* 插件不支持该字段时落到直接写入 */ }
    }
    registry.setPluginConfigValue(uuid, key, typeof value === 'string' ? value : JSON.stringify(value))
  })
}
