/**
 * 漫画插件注册表 (本地持久化)。
 *
 * 插件 bundle 与配置存在 localStorage: 桌面 / 网页 / 安卓三端通用,
 * 不进书库、也不参与 WebDAV 同步 (插件属于设备本地设置)。
 */
import type { InstalledComicPlugin } from './types'

const PLUGINS_KEY = 'lightread.comicPlugins.v1'
const CONFIG_KEY = 'lightread.comicPlugin.config.v1.'
/** 单个插件源码上限, 超了基本是选错文件 */
export const MAX_PLUGIN_CODE_BYTES = 2 * 1024 * 1024

function readPlugins(): InstalledComicPlugin[] {
  try {
    const raw = localStorage.getItem(PLUGINS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writePlugins(list: InstalledComicPlugin[]): void {
  const raw = JSON.stringify(list)
  localStorage.setItem(PLUGINS_KEY, raw)
}

export function listPlugins(): InstalledComicPlugin[] {
  return readPlugins()
}

export function getPlugin(uuid: string): InstalledComicPlugin | undefined {
  return readPlugins().find(p => p.uuid === uuid)
}

/** 同 uuid 视为同一个插件, 重复安装即更新 */
export function savePlugin(plugin: InstalledComicPlugin): void {
  if (plugin.code.length > MAX_PLUGIN_CODE_BYTES) {
    throw new Error('插件文件过大 (超过 2MB), 请确认选择的是插件 bundle 而不是别的资源')
  }
  const list = readPlugins().filter(p => p.uuid !== plugin.uuid)
  list.push(plugin)
  writePlugins(list)
}

export function removePlugin(uuid: string): void {
  writePlugins(readPlugins().filter(p => p.uuid !== uuid))
  try { localStorage.removeItem(CONFIG_KEY + uuid) } catch { /* 忽略 */ }
}

export function setPluginEnabled(uuid: string, enabled: boolean): void {
  const list = readPlugins()
  const item = list.find(p => p.uuid === uuid)
  if (!item) return
  item.enabled = enabled
  writePlugins(list)
}

export function getPluginConfig(uuid: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(CONFIG_KEY + uuid)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function setPluginConfigValue(uuid: string, key: string, value: unknown): void {
  const config = { ...getPluginConfig(uuid), [key]: value }
  try { localStorage.setItem(CONFIG_KEY + uuid, JSON.stringify(config)) } catch { /* 容量满时忽略 */ }
}
