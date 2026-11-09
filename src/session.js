import crypto from 'node:crypto'

import { ASK_WAIT_DEFAULT_MS, ASK_WAIT_MAX_MS, MAX_MESSAGE_BYTES } from './protocol.js'

/**
 * 跨端会话桥：把"一条指令"变成"本机某个 DSH 会话里的一次 agent turn"，再把答复捞回来。
 *
 * 这一层是**唯一**依赖 DSH 内部接口的地方（`ctx.sessionController` / `ctx.on('session/event')`），
 * 其余模块只认这里的 `deliver` / `ask` / `queueNotice` 三个方法。票 01 的探针会把
 * 这一层换成实测过的字段名；在此之前，这里有两条退路：
 *   1. 会话已存在（`ctx.sessions.get`）→ 直接投递；
 *   2. 不存在 → 依次尝试 `agents.create` / `agentLoop.create` / `sessions.prepare`，
 *      第一个成功的写进 peers 记录（`sessionId`），之后再也不必猜。
 */
export function createSessionBridge ({ ctx, store, log, now = () => Date.now() } = {}) {
  const pending = new Map()
  const chains = new Map()
  let armed = false

  /**
   * 同一个会话一次只投一条：两条并发投递会让"这条答复属于谁"变得不可判定。
   * 队列按 sessionId 串行，失败不阻塞后面的。
   */
  function serial (sessionId, task) {
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    chains.set(sessionId, next.then(() => {}, () => {}))
    return next
  }

  function warn (message) {
    try {
      log?.warn?.(`[dsh-cross-agent] ${message}`)
    } catch {
      // ignore
    }
  }

  function arm () {
    if (armed) return
    armed = true
    try {
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'assistant/message') return
        const sessionId = session?.id
        if (typeof sessionId !== 'string') return
        const text = textOf(event.data?.message)
        if (text === '') return
        const entry = pending.get(sessionId)
        if (entry === undefined) return
        entry.reply = text
        entry.lastAt = now()
      })
      ctx.on('api-session/status', (sessionId, running) => {
        if (running === true) return
        const entry = pending.get(String(sessionId))
        if (entry === undefined || entry.reply === '') return
        entry.settle?.('idle')
      })
    } catch (error) {
      warn(`订阅会话事件失败，答复只能靠静默判定：${error?.message ?? error}`)
    }
  }

  function controllers () {
    return {
      sessions: ctx?.sessions,
      agents: ctx?.agents,
      loop: ctx?.agentLoop,
      controller: ctx?.sessionController
    }
  }

  async function ensure (peer) {
    arm()
    if (typeof peer.sessionId === 'string' && peer.sessionId !== '') {
      const existing = controllers().sessions?.get?.(peer.sessionId)
      if (existing !== undefined && existing !== null) return peer.sessionId
    }
    const sessionId = peer.sessionId ?? crypto.randomUUID()
    const created = await createSession(sessionId)
    if (!created) throw new Error('创建跨端会话失败：宿主没有可用的会话创建接口')
    peer.sessionId = sessionId
    if (peer.deviceId !== undefined) {
      try {
        await store.put('peers', peer.deviceId, peer)
      } catch {
        // 存不下也不影响这一次投递
      }
    }
    return sessionId
  }

  async function createSession (sessionId) {
    const { agents, loop, sessions } = controllers()
    const cwd = resolveCwd()
    const attempts = [
      () => agents?.create?.({ sessionId, cwd, title: '跨端' }),
      () => loop?.create?.(sessionId, {}, { cwd }),
      () => sessions?.prepare?.(sessionId, { cwd })
    ]
    for (const attempt of attempts) {
      try {
        const result = await attempt()
        if (result !== undefined && result !== null) return true
      } catch (error) {
        warn(`建会话的一种方式失败：${error?.message ?? error}`)
      }
    }
    return false
  }

  function resolveCwd () {
    try {
      const directory = ctx?.workingDirectory?.defaultDirectory
      if (typeof directory === 'string' && directory !== '') return directory
    } catch {
      // ignore
    }
    return undefined
  }

  async function deliver (peer, text, { waitMs = ASK_WAIT_DEFAULT_MS } = {}) {
    arm()
    const sessionId = await ensure(peer)
    return serial(sessionId, () => deliverNow(peer, sessionId, text, waitMs))
  }

  async function deliverNow (peer, sessionId, text, waitMs) {
    const controller = controllers().controller
    if (controller?.prompt === undefined) throw new Error('宿主没有 sessionController.prompt，无法投递指令')

    const body = buildText(await takeNotices(peer), text)
    if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BYTES + 32 * 1024) {
      throw new Error('投递内容太大')
    }

    const entry = { reply: '', startedAt: now(), lastAt: 0, settle: null }
    pending.set(sessionId, entry)

    const done = new Promise((resolve) => {
      let timer = null
      let quiet = null
      const finish = (reason) => {
        if (timer !== null) clearTimeout(timer)
        if (quiet !== null) clearTimeout(quiet)
        resolve(reason)
      }
      entry.settle = finish
      timer = setTimeout(() => finish('timeout'), Math.min(waitMs, ASK_WAIT_MAX_MS))
      const tick = setInterval(() => {
        if (entry.reply === '') return
        if (now() - entry.lastAt < 1200 && quiet === null) {
          quiet = setTimeout(() => finish('quiet'), 1200)
          clearInterval(tick)
        }
      }, 400)
      tick.unref?.()
    })

    await controller.prompt({
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: body }]
    }, undefined)

    const reason = await done
    pending.delete(sessionId)
    return { sessionId, reply: entry.reply, reason }
  }

  async function takeNotices (peer) {
    try {
      const key = peer.deviceId
      const value = await store.get('notices', key)
      if (value === undefined || value === null) return []
      await store.delete('notices', key)
      return Array.isArray(value.items) ? value.items : []
    } catch {
      return []
    }
  }

  async function queueNotice (peerId, text) {
    try {
      const current = await store.get('notices', peerId)
      const items = Array.isArray(current?.items) ? current.items : []
      items.push(String(text).slice(0, 500))
      await store.put('notices', peerId, { items: items.slice(-5) })
    } catch {
      // 通知丢了不影响主流程
    }
  }

  /** 跨端工具调用要一个 Agent，而不只是会话 id：拿不到就让调用方明确失败。 */
  async function agentFor (peer) {
    const sessionId = await ensure(peer)
    const agent = controllers().agents?.get?.(sessionId)
    return agent ?? null
  }

  return { ensure, agentFor, deliver, queueNotice, arm }
}

function buildText (notices, text) {
  if (!Array.isArray(notices) || notices.length === 0) return text
  return `${notices.join('\n')}\n\n---\n\n${text}`
}

export function textOf (message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}
