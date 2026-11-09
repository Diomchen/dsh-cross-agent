import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { createApprovals } from './approvals.js'
import { createAudit } from './audit.js'
import { createDiscovery } from './discovery.js'
import { createFiles } from './files.js'
import { createIdentity } from './identity.js'
import { createLimiters } from './limits.js'
import { createPeers } from './peers.js'
import { createRpcClient, createRpcServer } from './rpc.js'
import { createSessionBridge } from './session.js'
import {
  ASK_WAIT_DEFAULT_MS,
  ASK_WAIT_MAX_MS,
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_PORT,
  MAX_FILE_BYTES,
  MAX_MESSAGE_BYTES,
  REVIEW_WINDOW_MS,
  safeFileName
} from './protocol.js'

/**
 * 组合根：把身份、发现、连接、审核、会话、文件、审计、限流接成一个服务。
 *
 * 对外只暴露四样东西：
 *   `state()`  面板用的一份快照；
 *   `act()`    UI / 命令用的一组动作（审核、放行、改模式、改名）；
 *   `ask/list/sendFile/fetchFile`  工具用的四个业务方法；
 *   `start()/dispose()`  生命周期。
 */
export async function createService (ctx, config = {}) {
  const log = logger(ctx)
  const home = resolveHome(config)
  const workspace = workspaceDir(ctx)

  const store = await createStoreSafe(home, log)
  const identity = createIdentity({ store })
  await identity.open()
  if (typeof config.displayName === 'string' && config.displayName.trim() !== '') {
    await identity.rename(config.displayName)
  }

  const audit = createAudit({ store })
  const limits = createLimiters()
  const approvals = createApprovals({ store, audit })
  await approvals.open()

  const inboxRoot = config.inboxDir || path.join(workspace ?? home, '.cross-agent', 'inbox')
  const shareRoot = config.shareDir || path.join(workspace ?? home, '.cross-agent', 'share')

  let rpcClient = null
  const peers = createPeers({
    store,
    identity,
    audit,
    approvals,
    log,
    send: (deviceId, method, requestPath, body, options) =>
      rpcClient.call(deviceId, method, requestPath, body, options)
  })
  await peers.open()

  const discoveryPort = Number.isInteger(config.discoveryPort) ? config.discoveryPort : DEFAULT_DISCOVERY_PORT
  const rpcPort = Number.isInteger(config.port) ? config.port : DEFAULT_PORT
  const discovery = createDiscovery({
    identity,
    port: discoveryPort,
    servicePort: rpcPort,
    registryDir: config.registryDir || path.join(home, 'instances'),
    limits,
    log
  })

  rpcClient = createRpcClient({
    identity,
    peers,
    resolve: (deviceId) => discovery.addressOf(deviceId),
    log
  })

  const files = createFiles({ store, rpc: rpcClient, audit, log, inboxRoot, shareRoot })
  const session = createSessionBridge({ ctx, store, log })

  const rpcServer = createRpcServer({
    identity,
    port: rpcPort,
    peers,
    limits,
    audit,
    log,
    routes: buildRoutes()
  })

  const approvedTransfers = new Map()

  let started = false
  let discoveryStarted = false

  function buildRoutes () {
    return {
      'POST /ca/v1/hello': {
        auth: 'none',
        limit: 'helloBySource',
        handler: async ({ body, source }) => {
          const result = await peers.handleHello(body, { source })
          return { ...result, self: { deviceId: identity.deviceId, name: identity.name } }
        }
      },
      'POST /ca/v1/hello-confirm': {
        auth: 'derive',
        limit: 'helloConfirmBySource',
        handler: async ({ body, auth }) => peers.handleHelloConfirm(body, { context: auth })
      },
      'POST /ca/v1/ask': {
        auth: 'key',
        handler: async ({ body, auth }) => handleAsk(body, auth)
      },
      'POST /ca/v1/file/begin': {
        auth: 'key',
        handler: async ({ body, auth }) => handleFileBegin(body, auth)
      },
      'POST /ca/v1/file': {
        auth: 'key',
        stream: true,
        handler: async ({ req, auth }) => handleFileUpload(req, auth)
      },
      'GET /ca/v1/file': {
        auth: 'key',
        handler: async ({ url, res, auth }) => handleFileRead(url, res, auth)
      }
    }
  }

  async function handleAsk (body, auth) {
    const peerId = auth.deviceId
    const peer = peers.get(peerId)
    if (peer === null || peer.state !== 'admitted') throw httpFail(403, 'not-admitted')

    const text = typeof body?.text === 'string' ? body.text : ''
    if (text.trim() === '') throw httpFail(400, 'empty')
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) throw httpFail(413, 'text-too-large')

    const hour = limits.messageHour.allow(peerId)
    if (!hour.ok) throw httpFail(429, 'rate-limited')
    const day = limits.messageDay.allow(peerId)
    if (!day.ok) throw httpFail(429, 'rate-limited')

    const correlationId = crypto.randomUUID()
    const budget = clampWait(body?.waitMs)
    const decision = await review('ask', peer, {
      summary: firstLine(text),
      payload: { text, correlationId },
      timeoutMs: reviewTimeout(budget)
    })

    if (decision === 'awaiting-review') {
      const item = approvals.list({ status: 'pending' }).find((row) => row.peerId === peerId && row.kind === 'ask')
      if (item !== undefined) {
        approvals.onResolve(item.id, (decided) => {
          if (decided.status !== 'approved') return
          deliverAndStore(peer, text, correlationId).catch(() => {})
        })
      }
      return { ok: false, reason: 'awaiting-review', correlationId }
    }
    if (decision !== 'approved') return { ok: false, reason: decision, correlationId }

    const result = await deliverAndStore(peer, text, correlationId, { waitMs: budget })
    return { ok: true, correlationId, ...result }
  }

  async function deliverAndStore (peer, text, correlationId, { waitMs = ASK_WAIT_MAX_MS } = {}) {
    const outcome = await session.deliver(peer, text, { waitMs })
    await audit.record({
      peerId: peer.deviceId,
      peerName: peer.name,
      kind: 'instruction',
      outcome: outcome.reply === '' ? 'no-reply' : 'answered',
      detail: firstLine(text)
    })
    try {
      await store.put('results', correlationId, {
        correlationId,
        peerId: peer.deviceId,
        status: outcome.reply === '' ? 'no-reply' : 'answered',
        reply: outcome.reply,
        sessionId: outcome.sessionId,
        at: Date.now()
      })
    } catch {
      // 结果存不下也不影响这次返回
    }
    return { sessionId: outcome.sessionId, reply: outcome.reply }
  }

  /**
   * 两阶段上传的第一阶段：先说清楚"我要给你一个多大的什么文件"。
   * 审核在这里做完，批准后发一个 5 分钟有效的 token；真正的字节在第二阶段才过来。
   * 这样人在审的时候，那条 100 MiB 的连接不需要一直挂着。
   */
  async function handleFileBegin (body, auth) {
    const peerId = auth.deviceId
    const peer = peers.get(peerId)
    if (peer === null || peer.state !== 'admitted') throw httpFail(403, 'not-admitted')

    const name = safeName(body?.name)
    const size = Number(body?.size)
    const sha256 = String(body?.sha256 ?? '')
    const transferId = typeof body?.transferId === 'string' && body.transferId !== ''
      ? body.transferId
      : crypto.randomUUID()
    if (!Number.isFinite(size) || size < 0) throw httpFail(400, 'bad-size')
    if (size > MAX_FILE_BYTES) throw httpFail(413, 'too-large')
    if (!/^[0-9a-f]{64}$/i.test(sha256)) throw httpFail(400, 'bad-sha256')

    const gate = limits.fileHour.allow(peerId)
    if (!gate.ok) throw httpFail(429, 'rate-limited')

    const budget = clampWait(Number(body?.waitMs))
    const decision = await review('file', peer, {
      summary: `${name} · ${formatBytes(size)}`,
      payload: { name, size, sha256, transferId },
      timeoutMs: reviewTimeout(budget)
    })
    if (decision !== 'approved') return { ok: false, reason: decision }

    approvedTransfers.set(transferId, { peerId, size, sha256, expiresAt: Date.now() + 5 * 60 * 1000 })
    return { ok: true, transferId }
  }

  async function handleFileUpload (req, auth) {
    const peerId = auth.deviceId
    const peer = peers.get(peerId)
    if (peer === null || peer.state !== 'admitted') throw httpFail(403, 'not-admitted')

    const name = decodeURIComponent(String(req.headers['x-ca-name'] ?? 'file'))
    const size = Number(req.headers['x-ca-size'])
    const sha256 = String(req.headers['x-ca-sha256'] ?? '')
    const transferId = String(req.headers['x-ca-transfer'] ?? '')

    const approved = approvedTransfers.get(transferId)
    if (approved === undefined || approved.peerId !== peerId || approved.expiresAt <= Date.now()) {
      throw httpFail(403, 'not-approved')
    }
    if (approved.size !== size || approved.sha256 !== sha256) throw httpFail(400, 'metadata-mismatch')
    approvedTransfers.delete(transferId)

    const receipt = await files.receive({
      peerId,
      peerName: peer.name,
      name,
      size,
      sha256,
      transferId,
      stream: req
    })
    await session.queueNotice(peerId, `收到 ${peer.name} 的文件：${path.basename(receipt.path)}（${formatBytes(receipt.size)}）`)
    return receipt
  }

  async function handleFileRead (url, res, auth) {
    const peerId = auth.deviceId
    const peer = peers.get(peerId)
    if (peer === null || peer.state !== 'admitted') throw httpFail(403, 'not-admitted')
    const relPath = new URLSearchParams(url.search).get('path') ?? ''
    const opened = await files.openShared({ shareRoot, relPath })
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(opened.size),
      'x-ca-name': encodeURIComponent(opened.name),
      'x-ca-size': String(opened.size),
      'x-ca-sha256': opened.sha256
    })
    opened.stream.pipe(res)
    await audit.record({
      peerId,
      peerName: peer.name,
      kind: 'transfer',
      outcome: 'served',
      detail: `${opened.name} ${opened.size} bytes`
    })
  }

  /** 审核闸：open 或有 24h 授权直接过；confirm 入队并等 5 分钟。 */
  async function review (kind, peer, { summary, payload, timeoutMs = REVIEW_WINDOW_MS }) {
    if (peer.mode === 'open') return 'approved'
    if (await approvals.hasGrant(peer.deviceId, kind)) return 'approved'
    const item = await approvals.enqueue({
      kind,
      peerId: peer.deviceId,
      peerName: peer.name,
      summary,
      payload
    })
    const decided = await approvals.waitFor(item.id, timeoutMs)
    if (decided === null) {
      await approvals.expire()
      return 'awaiting-review'
    }
    return decided.status === 'approved' ? 'approved' : 'rejected-by-peer'
  }

  // ── 对外：状态与动作 ────────────────────────────────────────────────────

  async function state () {
    return {
      self: {
        deviceId: identity.deviceId,
        name: identity.name
      },
      ports: {
        discovery: discovery.port || discoveryPort,
        rpc: rpcServer.port || rpcPort
      },
      paths: { inbox: inboxRoot, share: shareRoot },
      peers: peers.list({ discovery }),
      pending: approvals.list({ status: 'pending' }).map((item) => ({
        id: item.id,
        kind: item.kind,
        peerId: item.peerId,
        peerName: item.peerName,
        summary: item.summary,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt
      })),
      transfers: await files.recent(50),
      audit: await audit.recent(100)
    }
  }

  async function act (action, payload = {}) {
    switch (action) {
      case 'connect':
        return { ok: true, result: await peers.beginAdmission(requireDeviceId(payload)) }
      case 'allow-peer':
        return { ok: true, result: await peers.approve(requireDeviceId(payload)) }
      case 'deny-peer':
        return { ok: true, result: await peers.reject(requireDeviceId(payload)) }
      case 'block':
        return { ok: true, result: await peers.block(requireDeviceId(payload)) }
      case 'remove':
        return { ok: true, result: await peers.remove(requireDeviceId(payload)) }
      case 'mode':
        return {
          ok: true,
          result: await peers.setMode(requireDeviceId(payload), payload.mode, { confirmed: payload.confirmed === true })
        }
      case 'approve':
        return { ok: true, result: await approvals.resolve(requireId(payload), 'approved', { remember: payload.remember === true }) }
      case 'reject':
        return { ok: true, result: await approvals.resolve(requireId(payload), 'rejected') }
      case 'rename':
        return { ok: true, result: { name: await identity.rename(payload.name) } }
      case 'refresh':
        return { ok: true, result: await state() }
      default:
        throw new Error(`未知动作：${action}`)
    }
  }

  // ── 对外：工具用的四个业务方法 ──────────────────────────────────────────

  function resolvePeer (ref) {
    if (typeof ref !== 'string' || ref.trim() === '') throw new Error('peer 不能为空')
    const value = ref.trim()
    const direct = peers.get(value)
    if (direct !== null) return direct
    const rows = peers.list({ discovery })
    const admitted = rows.filter((row) => row.state === 'admitted')
    const byName = admitted.find((row) => row.name === value) ??
      admitted.find((row) => row.name.toLowerCase() === value.toLowerCase())
    if (byName !== undefined) return peers.get(byName.deviceId)
    const candidates = admitted.map((row) => row.name).join('、') || '（还没有放行任何对端）'
    throw new Error(`找不到已放行的对端「${value}」。当前可用：${candidates}`)
  }

  async function ask ({ peer: ref, text, waitMs, sessionId, correlationId }) {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('text 不能为空')
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('text 超过 8 KiB')

    if (typeof correlationId === 'string' && correlationId !== '') {
      const result = await store.get('results', correlationId)
      if (result === undefined || result === null) return { ok: false, reason: 'no-result', correlationId }
      return { ok: result.status === 'answered', correlationId, reply: result.reply, sessionId: result.sessionId }
    }

    const target = resolvePeer(ref)
    if (target.key === null) throw new Error('这个对端还没完成握手，缺少共享密钥')
    if (!discovery.isOnline(target.deviceId)) throw new Error('这个对端现在不在线（局域网上没收到它的心跳）')

    const gate = limits.messageHour.allow(target.deviceId)
    if (!gate.ok) throw new Error(`发给这个对端的指令太频繁，约 ${Math.ceil(gate.retryAfterMs / 60000)} 分钟后再试`)
    const day = limits.messageDay.allow(target.deviceId)
    if (!day.ok) throw new Error('今天发给这个对端的指令到上限了')

    const wait = clampWait(waitMs)
    try {
      const response = await rpcClient.call(target.deviceId, 'POST', '/ca/v1/ask', {
        text,
        waitMs: wait,
        sessionId: typeof sessionId === 'string' ? sessionId : undefined
      }, { timeoutMs: wait + 15_000 })

      if (response?.ok === true) {
        await audit.record({
          peerId: target.deviceId,
          peerName: target.name,
          kind: 'instruction',
          outcome: response.reply === '' ? 'no-reply' : 'answered',
          detail: firstLine(text)
        })
        return {
          ok: true,
          reply: response.reply ?? '',
          sessionId: response.sessionId ?? null,
          correlationId: response.correlationId ?? null
        }
      }
      return {
        ok: false,
        reason: response?.reason ?? 'unknown',
        correlationId: response?.correlationId ?? null
      }
    } catch (error) {
      await audit.record({
        peerId: target.deviceId,
        peerName: target.name,
        kind: 'instruction',
        outcome: 'failed',
        detail: `${firstLine(text)} · ${error?.message ?? error}`
      })
      if (OFFLINE_CODES.has(error?.code)) {
        throw new Error(`这个对端现在不在线（${error.code}）`)
      }
      throw new Error(`投递失败：${error?.message ?? error}`)
    }
  }

  async function sendFile ({ peer: ref, path: filePath, note = '' }) {
    const target = resolvePeer(ref)
    if (!discovery.isOnline(target.deviceId)) throw new Error('这个对端现在不在线')
    const gate = limits.fileHour.allow(target.deviceId)
    if (!gate.ok) throw new Error('发给这个对端的文件太频繁，稍后再试')
    return files.send({ peerId: target.deviceId, peerName: target.name, absPath: filePath, note })
  }

  async function fetchFile ({ peer: ref, path: remotePath, dest }) {
    const target = resolvePeer(ref)
    if (!discovery.isOnline(target.deviceId)) throw new Error('这个对端现在不在线')
    const gate = limits.fileFetchHour.allow(target.deviceId)
    if (!gate.ok) throw new Error('拉取太频繁，稍后再试')
    return files.fetch({ peerId: target.deviceId, peerName: target.name, remotePath, destDir: dest })
  }

  function listPeers () {
    return peers.list({ discovery }).map((row) => ({
      name: row.name,
      deviceId: row.deviceId,
      state: row.state,
      mode: row.mode,
      online: row.online,
      fingerprint: row.fingerprint
    }))
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async function start () {
    if (started) return
    started = true
    await files.init()
    try {
      await rpcServer.start()
    } catch (error) {
      log.warn(`[dsh-cross-agent] RPC 端口 ${rpcPort} 起不来：${error?.message ?? error}`)
    }
    try {
      await discovery.start()
      discoveryStarted = true
    } catch (error) {
      log.warn(`[dsh-cross-agent] 发现端口 ${discoveryPort} 起不来：${error?.message ?? error}`)
    }
    await audit.record({
      kind: 'admit',
      outcome: 'started',
      detail: `device=${identity.deviceId} rpc=${rpcServer.port || rpcPort} discovery=${discovery.port || discoveryPort}`
    })
  }

  async function dispose () {
    started = false
    if (discoveryStarted) {
      discovery.stop()
      discoveryStarted = false
    }
    await rpcServer.stop()
    limits.clear()
    await store.close()
  }

  return {
    ctx,
    home,
    identity,
    peers,
    approvals,
    discovery,
    files,
    session,
    audit,
    state,
    act,
    ask,
    sendFile,
    fetchFile,
    listPeers,
    start,
    dispose,
    get rpcPort () {
      return rpcServer.port
    },
    get discoveryPort () {
      return discovery.port
    }
  }
}

async function createStoreSafe (home, log) {
  const { createStore } = await import('./store.js')
  try {
    return await createStore({ dir: path.join(home, 'data'), log })
  } catch (error) {
    log.warn(`[dsh-cross-agent] 数据目录 ${home} 不可写：${error?.message ?? error}`)
    throw error
  }
}

function resolveHome (config) {
  if (typeof config.home === 'string' && config.home !== '') return config.home
  if (typeof process.env.DSH_CROSS_AGENT_HOME === 'string' && process.env.DSH_CROSS_AGENT_HOME !== '') {
    return process.env.DSH_CROSS_AGENT_HOME
  }
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(base, 'dsh-cross-agent')
}

function workspaceDir (ctx) {
  try {
    const value = ctx?.workingDirectory?.defaultDirectory
    if (typeof value === 'string' && value !== '') return value
  } catch {
    // ignore
  }
  return null
}

function logger (ctx) {
  const warn = (message) => {
    try {
      if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
      else console.warn(message)
    } catch {
      // ignore
    }
  }
  return { warn }
}

function requireDeviceId (payload) {
  if (typeof payload?.deviceId !== 'string' || payload.deviceId === '') throw new Error('缺少 deviceId')
  return payload.deviceId
}

function requireId (payload) {
  if (typeof payload?.id !== 'string' || payload.id === '') throw new Error('缺少待办 id')
  return payload.id
}

/** 审核窗口不能超过发起方愿意等的时间：发起方早就走了还挂着审核没有意义。 */
function reviewTimeout (budget) {
  return Math.max(1000, Math.min(REVIEW_WINDOW_MS, budget - 1500))
}

function clampWait (value) {
  if (!Number.isFinite(value)) return ASK_WAIT_DEFAULT_MS
  return Math.max(1000, Math.min(ASK_WAIT_MAX_MS, Math.trunc(value)))
}

const OFFLINE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'])

function safeName (value) {
  const name = safeFileName(typeof value === 'string' ? value : '')
  return name === '' ? 'file' : name
}

function firstLine (text) {
  const value = String(text ?? '').trim().split('\n')[0] ?? ''
  return value.slice(0, 120)
}

function formatBytes (bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function httpFail (status, reason) {
  const error = new Error(reason)
  error.status = status
  error.reason = reason
  return error
}
