/**
 * Breeze 插件的滑块验证 (slider-captcha) 协议。
 *
 * 插件在登录表单里给一个 kind='slider-captcha' 的字段, 并附带:
 *   slider.createFnPath  取题目 → { token, bg, piece, y, w, h, s }
 *   slider.verifyFnPath  提交 x(原图坐标) + track(轨迹数组) → { pass }
 * 拿到 pass 后作为该字段的值一起提交登录。
 *
 * 轨迹格式以 witawan 站点前端为准: [[elapsedMs, x原图坐标, clientY], ...], 首项 [0,0,0]。
 */
import { t } from '../../i18n'
import { withPlugin, type ComicPluginHost } from './index'

export interface SliderChallenge {
  token: string
  /** 背景图, 通常是 data:image/...;base64 (少数插件给 http 地址) */
  bg: string
  /** 拼图块图 */
  piece: string
  y: number
  w: number
  h: number
  s: number
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/** data URI 直接用; http(s) 走插件 fetchImageBytes (带 Referer/UA, 避开防盗链) */
async function toImageUrl(host: ComicPluginHost, raw: string): Promise<string> {
  if (!raw) return ''
  if (raw.startsWith('data:')) return raw
  if (!/^https?:/i.test(raw)) return raw
  try {
    const bytes = await host.callBytes('fetchImageBytes', { url: raw }, { timeoutMs: 20_000 })
    if (bytes?.length) {
      const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' })
      return URL.createObjectURL(blob)
    }
  } catch { /* 落到原地址 */ }
  return raw
}

export async function createSliderChallenge(uuid: string, createFnPath: string): Promise<SliderChallenge> {
  return withPlugin(uuid, async host => {
    if (!createFnPath || !host.hasFn(createFnPath)) throw new Error(t('comics.sliderUnavailable'))
    const raw = obj(await host.call(createFnPath, {}, { timeoutMs: 30_000 }))
    const token = str(raw.token)
    if (!token) throw new Error(str(raw.error) || t('comics.sliderLoadFailed'))
    return {
      token,
      bg: await toImageUrl(host, str(raw.bg)),
      piece: await toImageUrl(host, str(raw.piece)),
      y: num(raw.y),
      w: num(raw.w, 320) || 320,
      h: num(raw.h, 180) || 180,
      s: num(raw.s, 52) || 52,
    }
  })
}

/** 提交滑动位置与轨迹, 返回一次性通行证 (slider_pass) */
export async function verifySliderChallenge(
  uuid: string,
  verifyFnPath: string,
  payload: { token: string; x: number; track: number[][] },
): Promise<string> {
  return withPlugin(uuid, async host => {
    if (!verifyFnPath || !host.hasFn(verifyFnPath)) throw new Error(t('comics.sliderUnavailable'))
    const raw = obj(await host.call(verifyFnPath, payload, { timeoutMs: 30_000 }))
    const pass = str(raw.pass)
    if (!pass) throw new Error(str(raw.error) || t('comics.sliderVerifyFailed'))
    return pass
  })
}
