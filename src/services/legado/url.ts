/**
 * 书源抓取的纯工具函数（无外部依赖，可单独在 Node 测试）。
 */
import type { BookSource } from './types'

/** 从书源 JSON 字符串解析请求头 */
export function sourceHeaders(source: BookSource): Record<string, string> {
  if (!source.header) return {}
  try {
    return JSON.parse(source.header) as Record<string, string>
  } catch {
    return {}
  }
}

/** 从 URL 提取 host（如 https://66shuba.com/path → https://66shuba.com） */
export function urlHost(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

/** 相对 URL 转绝对 URL */
export function resolveUrl(base: string, url: string): string {
  if (!url) return url
  // 已含协议
  if (/^https?:\/\//i.test(url)) return url
  // 协议相对 //xxx
  if (url.startsWith('//')) {
    const proto = base.startsWith('https') ? 'https:' : 'http:'
    return proto + url
  }
  // 相对路径
  try {
    return new URL(url, base).href
  } catch {
    return url
  }
}

/** 把 Legado CSS 规则转成标准 CSS 选择器（用于 bookList 定位元素列表） */
export function legadoCssToSelector(rule: string): string {
  let s = rule.trim()
  if (s.startsWith('@css:')) return s.slice(5)
  // 只取第一个 @ 之前的部分（bookList 通常不含取值指令）
  s = s.split('@')[0]
  s = s.replace(/^class\./, '.').replace(/^id\./, '#').replace(/^tag\./, '')
  // 去掉索引 .N 和排除 !N
  s = s.replace(/\.\d+$/, '').replace(/![\d:]+$/, '')
  return s
}

/** 未知值转字符串（数组拼接） */
export function strVal(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map(x => String(x)).join('').trim()
  return String(v).trim()
}
