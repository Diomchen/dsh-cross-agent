import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { createClockGuard, MAX_OFFSET_MS } from '../src/clock.js'
import { createRpcClient, createRpcServer } from '../src/rpc.js'

const CLIENT_ID = '11111111-1111-4111-8111-111111111111'
const SERVER_ID = '22222222-2222-4222-8222-222222222222'

function clockAt (offsetMs) {
  return () => Date.now() + offsetMs
}

async function startServer ({ clock, now } = {}) {
  const key = crypto.randomBytes(32)
  const peers = {
    get: (id) => ({ deviceId: id, name: '对端', publicKey: 'unused', state: 'admitted' }),
    keyFor: () => key
  }
  const server = createRpcServer({
    identity: { deviceId: SERVER_ID, name: 'B' },
    port: 0,
    peers,
    clock,
    now,
    routes: {
      'POST /ca/v1/echo': {
        auth: 'key',
        handler: async ({ body }) => ({ ok: true, text: body?.text ?? '' })
      }
    }
  })
  const { port } = await server.start()
  return { server, port, key }
}

function clientFor ({ port, key, clock, now, name = 'A' }) {
  return createRpcClient({
    identity: { deviceId: CLIENT_ID, name },
    peers: { keyFor: () => key },
    clock,
    now,
    resolve: () => ({ address: '127.0.0.1', port })
  })
}

test('时钟一致时：不知道偏差也照常通过', async () => {
  const { server, port, key } = await startServer()
  try {
    const clock = createClockGuard()
    const client = clientFor({ port, key, clock })
    const result = await client.call(CLIENT_ID === SERVER_ID ? '' : SERVER_ID, 'POST', '/ca/v1/echo', { text: 'hi' })
    assert.equal(result.ok, true)
    assert.equal(result.text, 'hi')
  } finally {
    await server.stop()
  }
})

test('对端快 118 秒：先被拒一次，从 Date 头学到偏差后自动重试成功', async () => {
  const { server, port, key } = await startServer()
  try {
    // 本机钟比真实时间慢 118 秒 —— 也就是"对端快 118 秒"的另一面。
    const now = clockAt(-118_000)
    const clock = createClockGuard({ now })
    const client = clientFor({ port, key, clock, now })
    const result = await client.call(SERVER_ID, 'POST', '/ca/v1/echo', { text: '重试' })
    assert.equal(result.ok, true)
    assert.equal(result.text, '重试')
    assert.ok(Math.abs(clock.offsetFor(SERVER_ID)) > 100_000, '应该学到了约 118 秒的偏差')
  } finally {
    await server.stop()
  }
})

test('偏差已知（来自 beacon）时，第一次请求就该对上对端的钟', async () => {
  const { server, port, key } = await startServer()
  try {
    const now = clockAt(-118_000)
    const clock = createClockGuard({ now })
    const client = clientFor({ port, key, clock, now })
    // 模拟发现层收到的 beacon：对端的 ts 在我们的钟上读作"+118 秒"。
    clock.observe(SERVER_ID, Date.now())
    const result = await client.call(SERVER_ID, 'POST', '/ca/v1/echo', { text: '直接' })
    assert.equal(result.ok, true)
  } finally {
    await server.stop()
  }
})

test('没有时钟对齐时，偏差过大的请求仍然是 401 clock-skew', async () => {
  const { server, port, key } = await startServer()
  try {
    const client = clientFor({ port, key, now: clockAt(5 * 60_000) })
    await assert.rejects(
      () => client.call(SERVER_ID, 'POST', '/ca/v1/echo', { text: 'no' }, { retryClockSkew: false }),
      (error) => error.status === 401 && error.reason === 'clock-skew'
    )
  } finally {
    await server.stop()
  }
})

test('服务端接受按对端钟算的 ts，但窗口宽度不变', async () => {
  const now = 1_000_000
  const clock = createClockGuard({ now: () => now })
  clock.observe('peer', now + 118_000)
  assert.equal(clock.accepts('peer', now + 118_000), true, '按对端的钟算，正中窗口')
  assert.equal(clock.accepts('peer', now + 118_000 + 59_000), true, '窗口内')
  assert.equal(clock.accepts('peer', now + 118_000 + 61_000), false, '窗口外依旧拒绝')
  assert.equal(clock.accepts('other', now + 118_000), false, '偏差只对那个对端生效')
})

test('偏差超过上限的不采信：那不是没校时，是坏掉了', () => {
  const clock = createClockGuard()
  assert.equal(clock.observe('peer', Date.now() + MAX_OFFSET_MS + 1000), false)
  assert.equal(clock.offsetFor('peer'), 0)
  assert.equal(clock.accepts('peer', Date.now() + MAX_OFFSET_MS + 1000), false)
})

test('Date 头只有秒级精度，也能用', () => {
  const clock = createClockGuard({ now: () => 1_000_000 })
  const date = new Date(1_000_000 + 90_000).toUTCString()
  assert.equal(clock.observeDate('peer', { date }), true)
  assert.ok(Math.abs(clock.offsetFor('peer') - 90_000) <= 1000)
  assert.equal(clock.observeDate('peer', {}), false)
  assert.equal(clock.observeDate('peer', { date: '不是日期' }), false)
})
