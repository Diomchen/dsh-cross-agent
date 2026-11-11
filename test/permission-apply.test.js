import assert from 'node:assert/strict'
import test from 'node:test'

import { createSessionBridge } from '../src/session.js'

/**
 * `applyPreset` 的假宿主：`gets` 按调用顺序返回（最后一项会重复），
 * `current` 是 set 之后复核时读到的实际档。
 */
function makeBridge ({ gets = [], current = 'danger-full-access', setImpl } = {}) {
  let getCalls = 0
  const setCalls = []
  const ctx = {
    sessions: {
      async get () {
        const value = gets[Math.min(getCalls, gets.length - 1)]
        getCalls += 1
        if (value instanceof Error) throw value
        return value
      }
    }
  }
  if (setImpl !== 'missing') {
    ctx.permissionPresets = {
      async set (session, preset) {
        setCalls.push({ session, preset })
        if (typeof setImpl === 'function') await setImpl(session, preset)
      },
      current () {
        return typeof current === 'function' ? current() : current
      }
    }
  }
  return { bridge: createSessionBridge({ ctx }), setCalls, getCalls: () => getCalls }
}

test('等会话注册后再设权限，并用 current 复核为已生效', async () => {
  const { bridge, setCalls, getCalls } = makeBridge({ gets: [null, null, { id: 'session-1' }] })
  const result = await bridge.applyPreset('session-1', 'danger-full-access', { retries: 5, retryMs: 1 })

  assert.equal(result.applied, true)
  assert.equal(result.effective, 'danger-full-access')
  assert.equal(result.verified, true)
  assert.equal(setCalls.length, 1)
  assert.equal(setCalls[0].preset, 'danger-full-access')
  assert.equal(getCalls(), 3, '应当重试到会话出现为止')
})

test('会话一直没出现：不调用 set，明确报 session-not-ready', async () => {
  const { bridge, setCalls } = makeBridge({ gets: [null] })
  const result = await bridge.applyPreset('session-1', 'danger-full-access', { retries: 3, retryMs: 1 })

  assert.equal(result.applied, false)
  assert.equal(result.reason, 'session-not-ready')
  assert.equal(setCalls.length, 0)
})

test('set 之后 current 仍是 workspace-write：报未生效并带实际值', async () => {
  const { bridge } = makeBridge({ gets: [{ id: 'session-1' }], current: 'workspace-write' })
  const result = await bridge.applyPreset('session-1', 'danger-full-access', { retries: 2, retryMs: 1 })

  assert.equal(result.applied, false)
  assert.equal(result.effective, 'workspace-write')
  assert.equal(result.verified, true)
  assert.equal(result.reason, 'preset-not-effective')
})

test('current 晚一拍才更新时，轮询能等到生效', async () => {
  let reads = 0
  const { bridge } = makeBridge({
    gets: [{ id: 'session-1' }],
    current: () => (reads++ === 0 ? 'workspace-write' : 'danger-full-access')
  })
  const result = await bridge.applyPreset('session-1', 'danger-full-access', { retries: 2, retryMs: 1 })

  assert.equal(result.applied, true)
  assert.equal(result.effective, 'danger-full-access')
})

test('宿主没有 permissionPresets：报 unavailable，不假装成功', async () => {
  const bridge = createSessionBridge({
    ctx: { sessions: { async get () { return { id: 'session-1' } } } }
  })
  const result = await bridge.applyPreset('session-1', 'danger-full-access', { retries: 2, retryMs: 1 })

  assert.equal(result.applied, false)
  assert.equal(result.reason, 'permission-presets-unavailable')
})

test('set 抛错：报 set-failed，并把原始错误留下', async () => {
  const { bridge } = makeBridge({
    gets: [{ id: 'session-1' }],
    setImpl: async () => { throw new Error('cannot set while running') }
  })
  const result = await bridge.applyPreset('session-1', 'danger-full-access', { retries: 2, retryMs: 1 })

  assert.equal(result.applied, false)
  assert.equal(result.reason, 'set-failed')
  assert.equal(result.error, 'cannot set while running')
})

test('current 读不出来：报 verify-failed，不把 set 当成已生效', async () => {
  const { bridge } = makeBridge({
    gets: [{ id: 'session-1' }],
    current: () => { throw new Error('permissions projection missing') }
  })
  const result = await bridge.applyPreset('session-1', 'danger-full-access', { retries: 2, retryMs: 1 })

  assert.equal(result.applied, false)
  assert.equal(result.reason, 'verify-failed')
  assert.equal(result.error, 'permissions projection missing')
})
