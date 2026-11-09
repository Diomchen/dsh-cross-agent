import crypto from 'node:crypto'

import { APPROVAL_TTL_MS, GRANT_TTL_MS } from './protocol.js'

/**
 * 待审核队列：`confirm` 模式下的唯一入口。
 *
 * 两条不变量：
 *   1. 一条待办只有一个有效状态（pending → approved | rejected | expired）；
 *   2. "记住 24h" 只作用于 `peerId + kind`，不是全局、不是永久。
 */
export function createApprovals ({
  store,
  audit,
  now = () => Date.now(),
  ttlMs = APPROVAL_TTL_MS,
  grantTtlMs = GRANT_TTL_MS,
  max = 200
} = {}) {
  const items = new Map()
  const waiters = new Map()
  const hooks = new Map()

  async function open () {
    for (const { key, value } of await store.entries('approvals')) {
      if (value?.id === key) items.set(key, value)
    }
    await expire()
    return items.size
  }

  function isExpired (item, at = now()) {
    return item.status === 'pending' && at > item.expiresAt
  }

  async function enqueue ({ kind, peerId, peerName = '', summary, payload = {} }) {
    for (const item of items.values()) {
      if (item.status === 'pending' && item.kind === kind && item.peerId === peerId) {
        return item
      }
    }
    const at = now()
    const item = {
      id: crypto.randomUUID(),
      kind,
      peerId,
      peerName,
      summary: String(summary ?? '').slice(0, 300),
      payload,
      status: 'pending',
      createdAt: at,
      expiresAt: at + ttlMs,
      decidedAt: null,
      remember: false
    }
    items.set(item.id, item)
    await store.put('approvals', item.id, item)
    await trim()
    return item
  }

  async function trim () {
    if (items.size <= max) return
    const sorted = [...items.values()].sort((a, b) => a.createdAt - b.createdAt)
    for (const item of sorted.slice(0, items.size - max)) {
      if (item.status === 'pending') continue
      items.delete(item.id)
      await store.delete('approvals', item.id)
    }
  }

  function get (id) {
    const item = items.get(id)
    if (item === undefined) return null
    if (isExpired(item)) return { ...item, status: 'expired' }
    return item
  }

  function list ({ status = 'pending' } = {}) {
    const rows = [...items.values()]
      .filter((item) => (status === 'all' ? true : item.status === status))
      .map((item) => (isExpired(item) ? { ...item, status: 'expired' } : item))
    return rows.sort((a, b) => b.createdAt - a.createdAt)
  }

  async function resolve (id, decision, { remember = false, actor = 'human' } = {}) {
    const item = items.get(id)
    if (item === undefined) throw new Error('没有这条待办')
    if (item.status !== 'pending') throw new Error(`这条待办已经 ${item.status}`)
    if (isExpired(item)) {
      item.status = 'expired'
      await store.put('approvals', item.id, item)
      throw new Error('这条待办已经过期')
    }
    item.status = decision === 'approved' ? 'approved' : 'rejected'
    item.decidedAt = now()
    item.remember = remember === true && item.status === 'approved'
    await store.put('approvals', item.id, item)

    if (item.remember) await rememberGrant(item.peerId, item.kind)

    await audit?.record({
      peerId: item.peerId,
      peerName: item.peerName,
      kind: 'review',
      outcome: item.status,
      detail: `${item.kind}${item.remember ? ' (remember 24h)' : ''} by=${actor}`
    })

    const waiter = waiters.get(id)
    if (waiter !== undefined) {
      waiters.delete(id)
      waiter(item)
    }
    const hook = hooks.get(id)
    if (hook !== undefined) {
      hooks.delete(id)
      try {
        hook(item)
      } catch {
        // 回调坏掉不能把审核弄坏
      }
    }
    return item
  }

  async function resolveByPeer (peerId, kind, decision) {
    for (const item of items.values()) {
      if (item.peerId !== peerId || item.kind !== kind || item.status !== 'pending') continue
      try {
        await resolve(item.id, decision, { actor: 'system' })
      } catch {
        // 过期了就跳过
      }
    }
  }

  async function expire () {
    const at = now()
    for (const item of items.values()) {
      if (!isExpired(item, at)) continue
      item.status = 'expired'
      await store.put('approvals', item.id, item)
      await audit?.record({
        peerId: item.peerId,
        peerName: item.peerName,
        kind: 'review',
        outcome: 'expired',
        detail: item.kind
      })
      const waiter = waiters.get(item.id)
      if (waiter !== undefined) {
        waiters.delete(item.id)
        waiter(item)
      }
    }
  }

  async function rememberGrant (peerId, kind) {
    await store.put('grants', `${peerId}:${kind}`, { peerId, kind, expiresAt: now() + grantTtlMs })
  }

  async function hasGrant (peerId, kind) {
    const grant = await store.get('grants', `${peerId}:${kind}`)
    if (grant === undefined || grant === null) return false
    if (grant.expiresAt <= now()) {
      await store.delete('grants', `${peerId}:${kind}`)
      return false
    }
    return true
  }

  function waitFor (id, timeoutMs) {
    const item = items.get(id)
    if (item === undefined) return Promise.resolve(null)
    if (item.status !== 'pending') return Promise.resolve(item)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        resolve(null)
      }, Math.max(0, timeoutMs))
      waiters.set(id, (decided) => {
        clearTimeout(timer)
        resolve(decided)
      })
    })
  }

  /**
   * 超时之后才被处理的那条待办：发起方早就走了，但人可以晚点点同意。
   * 回调会在 resolve/expire 时各触发一次（谁先到算谁）。
   */
  function onResolve (id, callback) {
    if (typeof callback !== 'function') return
    const item = items.get(id)
    if (item !== undefined && item.status !== 'pending') {
      try {
        callback(item)
      } catch {
        // ignore
      }
      return
    }
    hooks.set(id, callback)
  }

  return {
    open,
    enqueue,
    get,
    list,
    resolve,
    resolveByPeer,
    expire,
    hasGrant,
    waitFor,
    onResolve,
    get size () {
      return items.size
    }
  }
}
