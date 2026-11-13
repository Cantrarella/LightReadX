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
import { withPlugin } from './index'
import * as registry from './registry'

export interface PluginSettingField {
  key: string
  kind: string
  label: string
  placeholder?: string
  description?: string
  options?: Array<{ label: string; value: unknown }>
  defaultValue?: unknown
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
  return {
    key: text(f.key),
    kind: text(f.kind) || 'text',
    label: text(f.label) || text(f.key),
    ...(text(f.placeholder) ? { placeholder: text(f.placeholder) } : {}),
    ...(text(f.description) ? { description: text(f.description) } : {}),
    ...(options.length ? { options } : {}),
    ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
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

/** 登录表单提交; 插件内部会自己保存会话, 宿主不接触账号密码之外的逻辑 */
export async function submitLogin(uuid: string, fnPath: string, values: Record<string, unknown>): Promise<unknown> {
  return withPlugin(uuid, host => host.call(fnPath, { ...values }, { timeoutMs: 60_000 }))
}

/** 用户信息; 未登录时插件抛 unauthorized, UI 层据此显示登录入口 */
export async function loadUserInfo(uuid: string): Promise<Record<string, unknown>> {
  return withPlugin(uuid, async host => {
    if (!host.hasFn('getUserInfoBundle')) return {}
    const raw = await host.call('getUserInfoBundle', {}, { timeoutMs: 30_000 })
    const root = obj(raw)
    const { userInfo, ...rest } = obj(root.data)
    // 插件有两种写法: data.userInfo 嵌套对象 / 字段直接平铺在 data 上。
    // 合并时要把 userInfo 本身摘掉, 否则设置页会把整个对象当字段渲染成 [object Object]。
    return { ...obj(userInfo), ...rest }
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
