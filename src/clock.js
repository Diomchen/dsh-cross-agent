import { CLOCK_SKEW_MS } from './protocol.js'

/**
 * 对端时钟基准。
 *
 * 请求签名里的 `x-ca-ts` 只能是**发送方**读到的墙钟。两台机器各自校时，
 * 偏差通常只有毫秒；但一台机器不会自动校时（或根本没权限校时）时，偏差可能是
 * 一两分钟——那仍然是一次正常的时钟误差，不是攻击。
 *
 * 这里不去放宽窗口：窗口宽度始终是 `CLOCK_SKEW_MS`。我们只把窗口**平移**到
 * 对端自己的时钟上——依据是对端在发现层 beacon 里广播的 `ts`（同一个墙钟），
 * 以及它 HTTP 响应里的 `Date` 头。平移不改变"一条请求只能在 ±60s 内被接受"，
 * 所以防重放强度不变；伪造时间源最多让这个对端的请求验不过（DoS），
 * 过不了 HMAC 的东西照样进不来。
 *
 * 偏差超过 `MAX_OFFSET_MS` 的一律不采信：那已经不是"没校时"，而是坏掉了，
 * 这种对端的请求应该失败，而不是被我们猜着对齐。
 */
export const MAX_OFFSET_MS = 60 * 60 * 1000

export function createClockGuard ({ toleranceMs = CLOCK_SKEW_MS, maxOffsetMs = MAX_OFFSET_MS, now = () => Date.now() } = {}) {
  /** deviceId → { offset, at } */
  const offsets = new Map()

  function observe (deviceId, remoteTs) {
    if (typeof deviceId !== 'string' || deviceId === '') return false
    if (!Number.isFinite(remoteTs)) return false
    const at = now()
    const offset = remoteTs - at
    if (!Number.isFinite(offset) || Math.abs(offset) > maxOffsetMs) {
      offsets.delete(deviceId)
      return false
    }
    offsets.set(deviceId, { offset, at })
    while (offsets.size > 64) {
      const oldest = offsets.keys().next()
      if (oldest.done) break
      offsets.delete(oldest.value)
    }
    return true
  }

  function offsetFor (deviceId) {
    const entry = offsets.get(deviceId)
    if (entry === undefined) return 0
    return entry.offset
  }

  /** 这个 ts 在我们的钟上读作"对端的钟"时，离我们有多远。 */
  function skewOf (deviceId, ts) {
    if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY
    const absolute = Math.abs(now() - ts)
    const relative = Math.abs(now() + offsetFor(deviceId) - ts)
    return Math.min(absolute, relative)
  }

  function accepts (deviceId, ts) {
    if (!Number.isFinite(ts)) return false
    if (Math.abs(now() - ts) <= toleranceMs) return true
    const offset = offsetFor(deviceId)
    if (offset === 0) return false
    return Math.abs(now() + offset - ts) <= toleranceMs
  }

  /** 对端 HTTP 响应里的 `Date` 头：秒级精度，够用；读不出来就当没这回事。 */
  function observeDate (deviceId, headers) {
    const raw = headers?.date
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value !== 'string') return false
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) return false
    // Date 只到秒：把它当作这一秒的中点，避免系统性偏半个秒。
    return observe(deviceId, parsed + 500)
  }

  function clear () {
    offsets.clear()
  }

  return { observe, observeDate, offsetFor, skewOf, accepts, clear }
}
