import crypto from 'node:crypto'

/**
 * 线协议 v1 的纯函数集合：编解码、签名、nonce 窗口、密钥派生。
 *
 * 这里**没有 IO**：不读文件、不开 socket。所有上限常量也在这里，
 * 其它模块只引用，不自己写数字。
 */

export const PROTOCOL_VERSION = 1

/** 发现报文最大字节数。超过就丢，不尝试解析。 */
export const MAX_PACKET_BYTES = 512

/** 一条指令消息的最大 UTF-8 字节数。 */
export const MAX_MESSAGE_BYTES = 8 * 1024

/** 单个文件上限。 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024

/** 收件箱总量与件数上限。 */
export const INBOX_MAX_BYTES = 1024 * 1024 * 1024
export const INBOX_MAX_FILES = 500

/** 允许的时钟偏移。 */
export const CLOCK_SKEW_MS = 60_000

/** 发现广播间隔。 */
export const BEACON_INTERVAL_MS = 5000

/** 一台机器上同一网络只能有一个发现端口。 */
export const DEFAULT_DISCOVERY_PORT = 45881
export const DEFAULT_PORT = 45883

/** 显示名长度上限（字符）。 */
export const MAX_NAME_LENGTH = 32

/** 指令频率：每对端每小时 / 每天。 */
export const MESSAGES_PER_HOUR = 20
export const MESSAGES_PER_DAY = 200

/** 文件频率：每对端每小时。 */
export const FILES_PER_HOUR = 20

/** 待审核项存活时间。 */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

/** 入站审核的响应窗口：超时对发起方回"未生效"。 */
export const REVIEW_WINDOW_MS = 5 * 60 * 1000

/** "记住"授权的有效期。 */
export const GRANT_TTL_MS = 24 * 60 * 60 * 1000

/** peer_ask 的等待时间。 */
export const ASK_WAIT_DEFAULT_MS = 120_000
export const ASK_WAIT_MAX_MS = 600_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid (value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function isPort (value) {
  return Number.isInteger(value) && value > 0 && value <= 65535
}

/** 把任意显示名收成一个安全的短名字：去控制字符、去首尾空白、截断。 */
export function clampName (value) {
  if (typeof value !== 'string') return ''
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('')
}

/** 文件名收窄：只保留基名，去掉路径分隔与危险字符。 */
export function safeFileName (value) {
  if (typeof value !== 'string') return ''
  const base = value.split(/[\\/]/).pop() ?? ''
  // Windows 上 `< > : " | ? *` 不能进文件名，结尾的点和空格也不允许；
  // Linux/macOS 能接受它们，但同一个名字会因此变得"只在某台机器上合法"，所以统一收窄。
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\.+$/, '')
    .trim()
    .replace(/^\.+/, '')
  const truncated = Array.from(cleaned).slice(0, 200).join('').replace(/[. ]+$/, '')
  if (truncated === '') return ''
  // Windows 保留设备名：CON、PRN、AUX、NUL、COM1-9、LPT1-9（带不带扩展名都保留）。
  const stem = truncated.split('.')[0].toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return `_${truncated}`
  return truncated
}

export function sha256Hex (buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export function encodeBeacon ({ type, deviceId, name, port, ts }) {
  if (type !== 'beacon' && type !== 'ack') throw new Error('protocol: bad beacon type')
  if (!isUuid(deviceId)) throw new Error('protocol: bad deviceId')
  if (!isPort(port)) throw new Error('protocol: bad port')
  const packet = {
    v: PROTOCOL_VERSION,
    t: type,
    deviceId,
    name: clampName(name),
    port,
    ts: Number.isFinite(ts) ? Math.trunc(ts) : Date.now()
  }
  const data = Buffer.from(JSON.stringify(packet), 'utf8')
  if (data.length > MAX_PACKET_BYTES) throw new Error('protocol: beacon too large')
  return data
}

export function parseBeacon (buffer) {
  if (!(buffer instanceof Uint8Array) || buffer.length === 0) return { ok: false, reason: 'empty' }
  if (buffer.length > MAX_PACKET_BYTES) return { ok: false, reason: 'oversize' }
  let raw
  try {
    raw = JSON.parse(Buffer.from(buffer).toString('utf8'))
  } catch {
    return { ok: false, reason: 'json' }
  }
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'shape' }
  if (raw.v !== PROTOCOL_VERSION) return { ok: false, reason: 'version' }
  if (raw.t !== 'beacon' && raw.t !== 'ack') return { ok: false, reason: 'type' }
  if (!isUuid(raw.deviceId)) return { ok: false, reason: 'deviceId' }
  if (!isPort(raw.port)) return { ok: false, reason: 'port' }
  return {
    ok: true,
    packet: {
      type: raw.t,
      deviceId: raw.deviceId,
      name: clampName(raw.name),
      port: raw.port,
      ts: Number.isFinite(raw.ts) ? Math.trunc(raw.ts) : 0
    }
  }
}

/**
 * 请求签名：`method \n path \n ts \n nonce \n sha256(body)`。
 * 用换行分隔是为了让各字段不会互相"拼接出"另一种合法组合。
 */
export function signingString ({ method, path, ts, nonce, bodyHash }) {
  return `${String(method).toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`
}

export function sign (key, parts) {
  return crypto.createHmac('sha256', key).update(signingString(parts), 'utf8').digest('hex')
}

export function verify (key, parts, signature) {
  if (typeof signature !== 'string' || signature.length !== 64) return false
  const expected = Buffer.from(sign(key, parts), 'hex')
  let given
  try {
    given = Buffer.from(signature, 'hex')
  } catch {
    return false
  }
  if (given.length !== expected.length) return false
  return crypto.timingSafeEqual(expected, given)
}

export function createNonce () {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * 重放窗口：同一个 nonce 在 `ttlMs` 内只接受一次。容量有界，最旧的先走。
 * 只记 nonce 本身，不记时间戳来源，避免被伪造 ts 撑爆。
 */
export function createNonceCache ({ max = 4096, ttlMs = 2 * CLOCK_SKEW_MS, now = () => Date.now() } = {}) {
  const seen = new Map()

  function sweep (at) {
    for (const [nonce, at0] of seen) {
      if (at - at0 <= ttlMs) break
      seen.delete(nonce)
    }
  }

  return {
    accept (nonce) {
      if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) return false
      const at = now()
      if (seen.size > max) sweep(at)
      const previous = seen.get(nonce)
      if (previous !== undefined) {
        if (at - previous <= ttlMs) return false
        seen.delete(nonce)
      }
      seen.set(nonce, at)
      while (seen.size > max) {
        const oldest = seen.keys().next()
        if (oldest.done) break
        seen.delete(oldest.value)
      }
      return true
    },
    clear () {
      seen.clear()
    },
    get size () {
      return seen.size
    }
  }
}

/** X25519 + HKDF-SHA256：两端对同一对 deviceId 必须派生出同一把钥匙。 */
export function deriveKey ({ privateKey, peerPublicKey, selfId, peerId }) {
  const shared = crypto.diffieHellman({ privateKey, publicKey: peerPublicKey })
  const salt = crypto.createHash('sha256')
    .update([selfId, peerId].sort().join(':'))
    .digest()
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, 'dsh-cross-agent/v1', 32))
}

export function keyFingerprint (key) {
  if (!Buffer.isBuffer(key) || key.length === 0) return ''
  return sha256Hex(key).slice(0, 8)
}

export function exportPublicKey (keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' }).toString('base64')
}

export function importPublicKey (base64) {
  return crypto.createPublicKey({ key: Buffer.from(base64, 'base64'), type: 'spki', format: 'der' })
}

export function exportPrivateKey (keyObject) {
  return keyObject.export({ type: 'pkcs8', format: 'der' }).toString('base64')
}

export function importPrivateKey (base64) {
  return crypto.createPrivateKey({ key: Buffer.from(base64, 'base64'), type: 'pkcs8', format: 'der' })
}

export function createKeyPair () {
  return crypto.generateKeyPairSync('x25519')
}
