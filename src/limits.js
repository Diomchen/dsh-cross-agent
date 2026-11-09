/**
 * 滑动窗口限流。所有"每对端/每来源"的闸都走这里，数字来自 protocol.js。
 *
 * `retryAfterMs` 是给调用方的：被拒时它该等多久，而不是"你去猜"。
 */
export function createRateLimiter ({
  windowMs,
  max,
  maxKeys = 256,
  now = () => Date.now()
}) {
  const hits = new Map()

  function sweep (at) {
    for (const [key, stamps] of hits) {
      const kept = stamps.filter((stamp) => at - stamp < windowMs)
      if (kept.length === 0) hits.delete(key)
      else hits.set(key, kept)
    }
  }

  return {
    allow (key, at = now()) {
      if (typeof key !== 'string' || key === '') return { ok: true, retryAfterMs: 0 }
      const stamps = (hits.get(key) ?? []).filter((stamp) => at - stamp < windowMs)
      if (stamps.length >= max) {
        hits.set(key, stamps)
        const oldest = stamps[0] ?? at
        return { ok: false, retryAfterMs: Math.max(0, windowMs - (at - oldest)) }
      }
      stamps.push(at)
      hits.set(key, stamps)
      if (hits.size > maxKeys) prune(at)
      return { ok: true, retryAfterMs: 0 }
    },

    remaining (key, at = now()) {
      const stamps = (hits.get(key) ?? []).filter((stamp) => at - stamp < windowMs)
      return Math.max(0, max - stamps.length)
    },

    clear () {
      hits.clear()
    },

    get size () {
      return hits.size
    }
  }

  function prune (at) {
    for (const [key, stamps] of hits) {
      if (stamps.length === 0 || at - stamps[stamps.length - 1] >= windowMs) hits.delete(key)
      if (hits.size <= maxKeys) return
    }
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next()
      if (oldest.done) return
      hits.delete(oldest.value)
    }
  }
}

/** 一组常用闸，集中构造，避免各模块自己写窗口。 */
export function createLimiters ({ now = () => Date.now() } = {}) {
  return {
    inboundPacket: createRateLimiter({ windowMs: 10_000, max: 20, now }),
    beaconAck: createRateLimiter({ windowMs: 4500, max: 1, now }),
    helloBySource: createRateLimiter({ windowMs: 60_000, max: 5, now }),
    helloConfirmBySource: createRateLimiter({ windowMs: 60_000, max: 20, now }),
    messageHour: createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, now }),
    messageDay: createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 200, now }),
    fileHour: createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, now }),
    fileFetchHour: createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, now }),
    clear () {
      for (const value of Object.values(this)) {
        if (value && typeof value.clear === 'function') value.clear()
      }
    }
  }
}
