/**
 * Breeze 运行时 crypto / 编码工具的宿主实现。
 *
 * 插件运行在 QuickJS 里, 没有 WebCrypto / Node crypto。全局 crypto 对象与
 * bridge.call("crypto.*") 路由最终都落到这里的同步纯 JS 实现。
 *
 * 依据 Breeze 插件开发文档「加密 API」:
 *  - 哈希 md5 / sha1 / sha256 / sha512 返回 hex
 *  - HMAC hmacSha1 / hmacSha256 / hmacSha512 返回 hex
 *  - AES ECB / CBC 带 PKCS#7 填充, GCM 带 tag, 输入输出都是字节
 *  - 旧版 *B64 包装用 base64 字符串, 仍需兼容
 *
 * 本模块不依赖 Vue / Tauri, 可在 Node 回归测试里直接调用。
 */
import { ecb, cbc, gcm } from '@noble/ciphers/aes'
import { hmac } from '@noble/hashes/hmac'
import { sha1 } from '@noble/hashes/sha1'
import { sha256 } from '@noble/hashes/sha256'
import { sha512, sha384 } from '@noble/hashes/sha512'
import { md5 } from '@noble/hashes/legacy'
import { bytesToHex } from '@noble/hashes/utils'

export type CryptoInput = string | Uint8Array | ArrayBuffer | ArrayBufferView | number[] | null | undefined

/** 插件侧把字节打包成 {__b64} 再跨 QuickJS 边界传, 这里还原 */
function unpack(value: unknown): Uint8Array {
  if (value && typeof value === 'object' && '__b64' in (value as Record<string, unknown>)) {
    return base64ToBytes(String((value as Record<string, unknown>).__b64 ?? ''))
  }
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  if (value == null) return new Uint8Array()
  if (typeof value === 'object') {
    // QuickJS dump 出来的伪数组对象
    const obj = value as Record<string, number>
    const keys = Object.keys(obj).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))
    if (keys.length) return Uint8Array.from(keys.map(k => obj[k] & 0xff))
  }
  return new TextEncoder().encode(String(value))
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  return new TextDecoder().decode(unpack(value))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array {
  try {
    const s = atob(String(b64 ?? '').trim())
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  } catch {
    return new Uint8Array()
  }
}

type HashCtor = Parameters<typeof hmac>[0]

function hashCtor(algo: string): HashCtor {
  const a = String(algo || '').toLowerCase().replace(/[-_]/g, '')
  if (a === 'md5') return md5 as HashCtor
  if (a === 'sha1') return sha1 as HashCtor
  if (a === 'sha512') return sha512 as HashCtor
  if (a === 'sha384') return sha384 as HashCtor
  return sha256 as HashCtor
}

function encodeDigest(bytes: Uint8Array, enc: string): string {
  return String(enc).toLowerCase() === 'base64' ? bytesToBase64(bytes) : bytesToHex(bytes)
}

export function digest(algo: string, input: CryptoInput, enc = 'hex'): string {
  return encodeDigest(hashCtor(algo)(unpack(input)), enc)
}

export function hmacDigest(algo: string, key: CryptoInput, input: CryptoInput, enc = 'hex'): string {
  return encodeDigest(hmac(hashCtor(algo), unpack(key), unpack(input)), enc)
}

function pkcs7Pad(data: Uint8Array): Uint8Array {
  const n = 16 - (data.length % 16)
  const out = new Uint8Array(data.length + n)
  out.set(data)
  out.fill(n, data.length)
  return out
}

function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (!data.length) return data
  const n = data[data.length - 1]
  if (n < 1 || n > 16 || n > data.length) return data
  return data.slice(0, data.length - n)
}

/** 保证 AES key / iv 是合法长度; 不足则右侧补 0, 超长截断 */
function fitKey(raw: Uint8Array, size: number): Uint8Array {
  if (raw.length === size) return raw
  const out = new Uint8Array(size)
  out.set(raw.subarray(0, size))
  return out
}

interface CipherLike { encrypt(data: Uint8Array): Uint8Array; decrypt(data: Uint8Array): Uint8Array }

function aesCipher(mode: 'ecb' | 'cbc' | 'gcm', keyRaw: Uint8Array, ivRaw?: Uint8Array, aad?: Uint8Array): CipherLike {
  const key = fitKey(keyRaw, keyRaw.length === 24 || keyRaw.length === 32 ? keyRaw.length : 16)
  if (mode === 'ecb') return ecb(key) as CipherLike
  if (mode === 'cbc') return cbc(key, fitKey(ivRaw ?? new Uint8Array(), 16)) as CipherLike
  return gcm(key, ivRaw ?? new Uint8Array(12), aad) as CipherLike
}

function aesPadded(mode: 'ecb' | 'cbc', op: 'encrypt' | 'decrypt', input: CryptoInput, key: CryptoInput, iv?: CryptoInput): Uint8Array {
  const cipher = aesCipher(mode, unpack(key), iv == null ? undefined : unpack(iv))
  const data = unpack(input)
  if (op === 'encrypt') return cipher.encrypt(pkcs7Pad(data))
  return pkcs7Unpad(cipher.decrypt(data))
}

/** crypto 对象上的方法: 返回值统一用 {type, value} 描述, 由 prelude 转成 hex 字符串或 Uint8Array */
export interface CryptoResult { type: 'text' | 'bytes'; value: string }

function bytesResult(bytes: Uint8Array): CryptoResult {
  return { type: 'bytes', value: bytesToBase64(bytes) }
}
function textResult(text: string): CryptoResult {
  return { type: 'text', value: text }
}

export function runCryptoMethod(method: string, args: unknown[]): CryptoResult {
  const a = (args ?? []) as CryptoInput[]
  switch (method) {
    case 'md5': case 'sha1': case 'sha256': case 'sha512':
      return textResult(digest(method, a[0]))
    case 'hmacSha1': case 'hmacSha256': case 'hmacSha512':
      return textResult(hmacDigest(method.replace('hmacSha', 'sha'), a[0], a[1]))
    case 'hash':
      return textResult(digest(String(a[0]), a[1], String(a[2] ?? 'hex')))
    case 'hmac':
      return textResult(hmacDigest(String(a[0]), a[1], a[2], String(a[3] ?? 'hex')))
    case 'randomBytes': {
      const n = Math.max(0, Math.min(65536, Number(a[0]) || 0))
      const out = new Uint8Array(n)
      if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(out)
      else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256)
      return bytesResult(out)
    }
    case 'aesEcbPkcs7Encrypt': return bytesResult(aesPadded('ecb', 'encrypt', a[0], a[1]))
    case 'aesEcbPkcs7Decrypt': return bytesResult(aesPadded('ecb', 'decrypt', a[0], a[1]))
    case 'aesCbcPkcs7Encrypt': return bytesResult(aesPadded('cbc', 'encrypt', a[0], a[1], a[2]))
    case 'aesCbcPkcs7Decrypt': return bytesResult(aesPadded('cbc', 'decrypt', a[0], a[1], a[2]))
    case 'aesGcmEncrypt': {
      const c = aesCipher('gcm', unpack(a[1]), a[2] == null ? undefined : unpack(a[2]), a[3] == null ? undefined : unpack(a[3]))
      return bytesResult(c.encrypt(unpack(a[0])))
    }
    case 'aesGcmDecrypt': {
      const c = aesCipher('gcm', unpack(a[1]), a[2] == null ? undefined : unpack(a[2]), a[3] == null ? undefined : unpack(a[3]))
      return bytesResult(c.decrypt(unpack(a[0])))
    }
    // 旧版 base64 包装: 入参是 base64 字符串, 返回同样是 base64 字符串
    case 'aesEcbPkcs7DecryptB64':
      return textResult(bytesToBase64(aesPadded('ecb', 'decrypt', base64ToBytes(asText(a[0])), a[1])))
    case 'aesEcbPkcs7EncryptB64':
      return textResult(bytesToBase64(aesPadded('ecb', 'encrypt', base64ToBytes(asText(a[0])), a[1])))
    case 'aesCbcPkcs7EncryptB64':
      return textResult(bytesToBase64(aesPadded('cbc', 'encrypt', base64ToBytes(asText(a[0])), a[1], a[2])))
    case 'aesCbcPkcs7DecryptB64':
      return textResult(bytesToBase64(aesPadded('cbc', 'decrypt', base64ToBytes(asText(a[0])), a[1], a[2])))
    case 'aesGcmEncryptB64': {
      const c = aesCipher('gcm', unpack(a[1]), a[2] == null ? undefined : unpack(a[2]), a[3] == null ? undefined : unpack(a[3]))
      return textResult(bytesToBase64(c.encrypt(base64ToBytes(asText(a[0])))))
    }
    case 'aesGcmDecryptB64': {
      const c = aesCipher('gcm', unpack(a[1]), a[2] == null ? undefined : unpack(a[2]), a[3] == null ? undefined : unpack(a[3]))
      return textResult(bytesToBase64(c.decrypt(base64ToBytes(asText(a[0])))))
    }
    default:
      throw new Error('未实现的 crypto 方法: ' + method)
  }
}

/** bridge.call("crypto.*") 旧路由, 返回纯字符串 */
export function runCryptoBridge(name: string, args: unknown[]): string {
  const a = (args ?? []) as CryptoInput[]
  const hashHex = (algo: string) => digest(algo, a[0])
  const hmacHex = (algo: string) => hmacDigest(algo, a[0], a[1])
  switch (name) {
    case 'crypto.md5_hex': return hashHex('md5')
    case 'crypto.sha1_hex': return hashHex('sha1')
    case 'crypto.sha256_hex': return hashHex('sha256')
    case 'crypto.sha512_hex': return hashHex('sha512')
    case 'crypto.hmac_sha1_hex': return hmacHex('sha1')
    case 'crypto.hmac_sha256_hex': return hmacHex('sha256')
    case 'crypto.hmac_sha512_hex': return hmacHex('sha512')
    case 'crypto.aes_ecb_pkcs7_decrypt_b64': return runCryptoMethod('aesEcbPkcs7DecryptB64', a).value
    case 'crypto.aes_ecb_pkcs7_encrypt_b64': return runCryptoMethod('aesEcbPkcs7EncryptB64', a).value
    case 'crypto.aes_cbc_pkcs7_encrypt_b64': return runCryptoMethod('aesCbcPkcs7EncryptB64', a).value
    case 'crypto.aes_cbc_pkcs7_decrypt_b64': return runCryptoMethod('aesCbcPkcs7DecryptB64', a).value
    case 'crypto.aes_gcm_encrypt_b64': return runCryptoMethod('aesGcmEncryptB64', a).value
    case 'crypto.aes_gcm_decrypt_b64': return runCryptoMethod('aesGcmDecryptB64', a).value
    default: throw new Error('未实现的 crypto 路由: ' + name)
  }
}
