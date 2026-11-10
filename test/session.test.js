import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createSessionBridge, textOf } from '../src/session.js'
import { createStore } from '../src/store.js'

function fakeCtx ({ reply = '好的，已经跑完了', emit = true, createFails = false } = {}) {
  const listeners = new Map()
  const prompted = []
  const sessions = new Map()
  const ctx = {
    on (name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
    emit (name, ...args) {
      for (const fn of listeners.get(name) ?? []) fn(...args)
    },
    sessions: {
      get: (id) => sessions.get(id),
      prepare: (id) => {
        if (createFails) throw new Error('nope')
        const session = { id }
        sessions.set(id, session)
        return session
      }
    },
    agents: {},
    sessionController: {
      async prompt (request) {
        prompted.push(request)
        if (emit) {
          setTimeout(() => {
            ctx.emit('session/event', { id: request.sessionId }, {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: reply }] } }
            })
            ctx.emit('api-session/status', request.sessionId, false)
          }, 5)
        }
        return { accepted: true }
      }
    }
  }
  return { ctx, prompted, sessions }
}

test('把指令投进会话并拿回答复', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-session-'))
  try {
    const store = await createStore({ dir })
    const { ctx, prompted } = fakeCtx()
    const bridge = createSessionBridge({ ctx, store })
    const peer = { deviceId: 'peer-1', name: 'B', sessionId: undefined }

    const result = await bridge.deliver(peer, '查一下 node 版本', { waitMs: 3000 })
    assert.equal(result.reply, '好的，已经跑完了')
    assert.equal(prompted.length, 1)
    assert.equal(prompted[0].mode, 'queue')
    assert.equal(prompted[0].content[0].text, '查一下 node 版本')
    assert.ok(peer.sessionId)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('给了 sessionId 就投到那一条，不再自己建会话', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-session-'))
  try {
    const store = await createStore({ dir })
    const { ctx, prompted, sessions } = fakeCtx()
    const bridge = createSessionBridge({ ctx, store })
    const peer = { deviceId: 'peer-9', name: 'E', sessionId: undefined }

    const result = await bridge.deliver(peer, '投到指定会话', { waitMs: 3000, sessionId: 'session-remote-1' })
    assert.equal(result.reply, '好的，已经跑完了')
    assert.equal(result.sessionId, 'session-remote-1')
    assert.equal(prompted.length, 1)
    assert.equal(prompted[0].sessionId, 'session-remote-1')
    assert.equal(peer.sessionId, undefined, '定向投递不该改这条连接的固定会话')
    assert.equal(sessions.size, 0, '定向投递不该顺手建会话')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('没答复时按时返回空字符串，不卡死', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-session-'))
  try {
    const store = await createStore({ dir })
    const { ctx } = fakeCtx({ emit: false })
    const bridge = createSessionBridge({ ctx, store })
    const startedAt = Date.now()
    const result = await bridge.deliver({ deviceId: 'peer-2', name: 'C' }, '在吗', { waitMs: 1200 })
    assert.equal(result.reply, '')
    assert.ok(Date.now() - startedAt >= 1000)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('建不了会话时给出明确错误', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-session-'))
  try {
    const store = await createStore({ dir })
    const { ctx } = fakeCtx({ createFails: true })
    const bridge = createSessionBridge({ ctx, store })
    await assert.rejects(() => bridge.deliver({ deviceId: 'peer-3', name: 'D' }, 'hi'), /创建跨端会话失败|prepare/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('待送通知会拼在下一条指令前面', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-session-'))
  try {
    const store = await createStore({ dir })
    const { ctx, prompted } = fakeCtx()
    const bridge = createSessionBridge({ ctx, store })
    await bridge.queueNotice('peer-4', '收到 B 的文件：a.txt')
    await bridge.deliver({ deviceId: 'peer-4', name: 'E' }, '继续', { waitMs: 3000 })
    assert.ok(prompted[0].content[0].text.startsWith('收到 B 的文件：a.txt'))
    assert.ok(prompted[0].content[0].text.includes('继续'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('textOf 只取文本块', () => {
  assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(textOf({ content: 'plain' }), 'plain')
  assert.equal(textOf(null), '')
})
