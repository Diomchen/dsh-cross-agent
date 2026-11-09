import assert from 'node:assert/strict'
import test from 'node:test'

import { createLimiters, createRateLimiter } from '../src/limits.js'

test('窗口内的第 N+1 次被拒，并给出 retryAfterMs', () => {
  let at = 0
  const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => at })
  assert.equal(limiter.allow('peer').ok, true)
  at = 10
  assert.equal(limiter.allow('peer').ok, true)
  at = 20
  const denied = limiter.allow('peer')
  assert.equal(denied.ok, false)
  assert.equal(denied.retryAfterMs, 980)
  at = 1200
  assert.equal(limiter.allow('peer').ok, true)
})

test('不同 key 互不影响', () => {
  let at = 0
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => at })
  assert.equal(limiter.allow('a').ok, true)
  assert.equal(limiter.allow('b').ok, true)
  assert.equal(limiter.allow('a').ok, false)
})

test('钥匙数量有界', () => {
  let at = 0
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, maxKeys: 3, now: () => at })
  for (const key of ['a', 'b', 'c', 'd', 'e']) limiter.allow(key)
  assert.ok(limiter.size <= 3)
})

test('限流组用的是 SPEC 里的数字', () => {
  const limits = createLimiters()
  let allowed = 0
  for (let i = 0; i < 25; i += 1) if (limits.messageHour.allow('p').ok) allowed += 1
  assert.equal(allowed, 20)
})
