import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createApprovals } from './approvals.js'
import { createAudit } from './audit.js'
import { createClockGuard } from './clock.js'
import { createDiscovery } from './discovery.js'
import { createFiles } from './files.js'
import { createIdentity } from './identity.js'
import { createLimiters } from './limits.js'
import { createPeers } from './peers.js'
import { DEFAULT_SESSION_PRESET, normalizeRules, resolveSessionPreset } from './presets.js'
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
  const log = logger(ctx, config)
  const home = resolveHome(config)
  const workspace = workspaceDir(ctx)

  const store = await createStoreSafe(home, log)
  const identity = createIdentity({ store })
  await identity.open()
  if (typeof config.displayName === 'string' && config.displayName.trim() !== '') {
    await identity.rename(config.displayName)
  }

  const audit = createAudit({ store })
  const clock = createClockGuard()
  const limits = createLimiters()
  const approvals = createApprovals({ store, audit })
  await approvals.open()

  const inboxRoot = config.inboxDir || path.join(workspace ?? home, '.cross-agent', 'inbox')
  const shareRoots = resolveShareRoots(config, workspace ?? home)
  const exposedTools = Array.isArray(config.exposedTools)
    ? [...new Set(config.exposedTools.filter((name) => typeof name === 'string' && name !== ''))]
    : []
  /** 按目录的会话权限上限：远端可以更紧，不能更松（见 src/presets.js）。 */
  const sessionPermissionRules = normalizeRules(config.sessionPermissionRules)
  const sessionPermissionDefault = typeof config.sessionPermissionDefault === 'string' && config.sessionPermissionDefault !== ''
    ? config.sessionPermissionDefault
    : DEFAULT_SESSION_PRESET
  const allowRemotePermissionRaise = config.allowRemotePermissionRaise === true
  const allowRemoteSessions = config.allowRemoteSessions !== false

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
  // 配置里的静态对端优先；否则读 $DSH_HOME/dsh-cross-agent/peers.json
  //（那个文件不用重启宿主就能靠插件重载生效，广播被挡的网段靠它维持心跳）。
  const configuredTargets = normalizeProbeTargets(config.peerAddresses)
  const probeTargets = configuredTargets.length > 0 ? configuredTargets : normalizeProbeTargets(await readPeerFile(home))
  const discovery = createDiscovery({
    identity,
    port: discoveryPort,
    servicePort: rpcPort,
    registryDir: config.registryDir || path.join(home, 'instances'),
    probeTargets,
    limits,
    log,
    // 对端 beacon 里的 ts 就是它的墙钟：这是我们要对齐的那个钟（见 src/clock.js）。
    onPacket: (packet) => clock.observe(packet.deviceId, packet.ts)
  })

  rpcClient = createRpcClient({
    identity,
    peers,
    clock,
    resolve: (deviceId) => discovery.addressOf(deviceId),
    log
  })

  const files = createFiles({
    store,
    rpc: rpcClient,
    audit,
    log,
    inboxRoot,
    shareRoot: shareRoots[0] ?? path.join(workspace ?? home, '.cross-agent', 'share'),
    shareRoots
  })
  const session = createSessionBridge({ ctx, store, log })

  const rpcServer = createRpcServer({
    identity,
    port: rpcPort,
    peers,
    limits,
    audit,
    clock,
    log,
    routes: buildRoutes()
  })

  const approvedTransfers = new Map()

  let startedAt = null
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
      },
      'GET /ca/v1/tools': {
        auth: 'key',
        handler: async ({ auth }) => {
          const peer = peers.get(auth.deviceId)
          if (peer === null || peer.state !== 'admitted') throw httpFail(403, 'not-admitted')
          return { ok: true, tools: exposedTools.map((name) => ({ name })) }
        }
      },
      'POST /ca/v1/tool': {
        auth: 'key',
        handler: async ({ body, auth }) => handleToolCall(body, auth)
      },
      'POST /ca/v1/session/create': {
        auth: 'key',
        handler: async ({ body, auth }) => handleSessionCreate(body, auth)
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

    const target = await resolveAskTarget(peerId, body?.sessionId)
    const correlationId = crypto.randomUUID()
    const budget = clampWait(body?.waitMs)
    const decision = await review('ask', peer, {
      summary: target.sessionId === null ? firstLine(text) : `→ ${target.label}：${firstLine(text)}`,
      payload: { text, correlationId, sessionId: target.sessionId },
      timeoutMs: reviewTimeout(budget)
    })

    if (decision === 'awaiting-review') {
      const item = approvals.list({ status: 'pending' }).find((row) => row.peerId === peerId && row.kind === 'ask')
      if (item !== undefined) {
        approvals.onResolve(item.id, (decided) => {
          if (decided.status !== 'approved') return
          deliverAndStore(peer, text, correlationId, { sessionId: target.sessionId }).catch(() => {})
        })
      }
      return { ok: false, reason: 'awaiting-review', correlationId }
    }
    if (decision !== 'approved') return { ok: false, reason: decision, correlationId }

    const result = await deliverAndStore(peer, text, correlationId, { waitMs: budget, sessionId: target.sessionId })
    return { ok: true, correlationId, ...result }
  }

  /**
   * 决定这条指令投到哪儿。
   *
   * 不给 `sessionId` → 这条连接的固定跨端会话（历史行为）。
   * 给了 → 只允许投到**这个对端自己建出来的**会话。没有这层限制，被放行的对端
   * 就能往本机任意会话（包括人自己的聊天）里塞话——那不是"跨端会话"，那是偷听。
   */
  async function resolveAskTarget (peerId, requested) {
    if (requested === undefined || requested === null || requested === '') return { sessionId: null, label: '' }
    if (typeof requested !== 'string') throw httpFail(400, 'bad-session')
    const record = await store.get('sessions', requested)
    if (record === null || record === undefined) throw httpFail(403, 'session-not-allowed')
    if (record.peerId !== peerId) {
      await audit.record({ peerId, kind: 'denied', outcome: 'session-not-mine', detail: requested })
      throw httpFail(403, 'session-not-allowed')
    }
    try {
      if (typeof ctx?.sessions?.get === 'function') {
        const live = await ctx.sessions.get(requested)
        if (live === undefined || live === null) throw httpFail(404, 'session-not-found')
      }
    } catch (error) {
      if (error?.status === 404) throw error
      // 宿主读不出来时不拦：真投不进去会在 prompt 那一步报错
    }
    return { sessionId: requested, label: record.title || record.path || requested }
  }

  async function deliverAndStore (peer, text, correlationId, { waitMs = ASK_WAIT_MAX_MS, sessionId = null } = {}) {
    const outcome = await session.deliver(peer, text, sessionId === null ? { waitMs } : { waitMs, sessionId })
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
    const opened = await files.openShared({ shareRoots, relPath })
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

  /**
   * 跨端工具调用：只有本机 `exposedTools` 里点名过的工具能被调。
   * 默认是空列表 —— 装上这个插件不等于把本机的能力簿打开。
   */
  async function handleToolCall (body, auth) {
    const peerId = auth.deviceId
    const peer = peers.get(peerId)
    if (peer === null || peer.state !== 'admitted') throw httpFail(403, 'not-admitted')

    const tool = typeof body?.tool === 'string' ? body.tool : ''
    if (tool === '') throw httpFail(400, 'missing-tool')
    if (!exposedTools.includes(tool)) {
      await audit.record({
        peerId,
        peerName: peer.name,
        kind: 'denied',
        outcome: 'tool-not-exposed',
        detail: tool
      })
      throw httpFail(403, 'tool-not-exposed')
    }

    const budget = clampWait(body?.waitMs)
    const decision = await review('tool', peer, {
      summary: `${tool}(${shortArgs(body?.args)})`,
      payload: { tool, args: body?.args ?? null },
      timeoutMs: reviewTimeout(budget)
    })
    if (decision !== 'approved') return { ok: false, reason: decision }

    const result = await runPeerTool(peer, tool, body?.args ?? {}, budget)
    await audit.record({
      peerId,
      peerName: peer.name,
      kind: 'instruction',
      outcome: result.ok ? 'tool-ok' : 'tool-failed',
      detail: `${tool}${result.error ? ` · ${result.error}` : ''}`
    })
    return result
  }

  /**
   * 远端请求"在某台机器的某个目录下建一条会话"。目录决定项目分组：
   * 已经注册过的目录会复用它（宿主的 workspace/create 是幂等的），
   * 新目录则当场注册成新的分组。
   *
   * 权限由**接收方**说了算：远端带的 permission 只能往紧里调（见 src/presets.js）。
   */
  async function handleSessionCreate (body, auth) {
    const peerId = auth.deviceId
    const peer = peers.get(peerId)
    if (peer === null || peer.state !== 'admitted') throw httpFail(403, 'not-admitted')
    if (!allowRemoteSessions) {
      await audit.record({ peerId, peerName: peer.name, kind: 'denied', outcome: 'sessions-disabled', detail: 'session/create' })
      throw httpFail(403, 'sessions-disabled')
    }

    const dir = typeof body?.path === 'string' ? body.path.trim() : ''
    if (dir === '' || !path.isAbsolute(dir)) throw httpFail(400, 'bad-path')
    try {
      const stat = await fs.stat(dir)
      if (!stat.isDirectory()) throw new Error('not-a-directory')
    } catch {
      throw httpFail(400, 'bad-path')
    }

    const title = clampTitle(body?.title) || path.basename(dir)
    const decision = await review('session', peer, {
      summary: `新建会话：${dir} · ${title}`,
      payload: { path: dir, title, permission: body?.permission ?? null },
      timeoutMs: reviewTimeout(clampWait(body?.waitMs))
    })
    if (decision !== 'approved') return { ok: false, reason: decision }

    const resolved = resolveSessionPreset({
      dir,
      requested: typeof body?.permission === 'string' ? body.permission : null,
      rules: sessionPermissionRules,
      fallback: sessionPermissionDefault,
      allowRaise: allowRemotePermissionRaise
    })

    const created = await createSessionIn(dir, title, resolved.preset)
    try {
      await store.put('sessions', created.sessionId, {
        sessionId: created.sessionId,
        peerId,
        peerName: peer.name,
        path: dir,
        workspaceId: created.workspaceId,
        title: created.title,
        permission: resolved.preset,
        createdAt: Date.now()
      })
    } catch (error) {
      log.warn(`[dsh-cross-agent] 记录远端会话失败：${error?.message ?? error}`)
    }
    await audit.record({
      peerId,
      peerName: peer.name,
      kind: 'session',
      outcome: 'created',
      detail: `${dir} · ${title} · ${resolved.preset}${resolved.clamped ? ` (请求 ${resolved.requested} 被夹住)` : ''}`
    })
    return {
      ok: true,
      sessionId: created.sessionId,
      workspaceId: created.workspaceId,
      title: created.title,
      permission: resolved.preset,
      requestedPermission: resolved.requested,
      clamped: resolved.clamped
    }
  }

  /** 在宿主里真的把这条会话建出来：分组 → 会话 → 权限 → 标题。 */
  async function createSessionIn (dir, title, preset) {
    const workspaces = ctx?.workspaceController
    const controller = ctx?.sessionController
    if (typeof workspaces?.create !== 'function' || typeof controller?.create !== 'function') {
      throw httpFail(501, 'sessions-unavailable')
    }
    const registered = await workspaces.create({ path: dir })
    const workspaceId = registered?.workspace?.workspaceId ?? registered?.workspaceId
    if (typeof workspaceId !== 'string' || workspaceId === '') throw httpFail(500, 'workspace-failed')

    const created = await controller.create({ workspaceId })
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') throw httpFail(500, 'session-failed')

    if (typeof preset === 'string' && preset !== '') {
      try {
        const session = await ctx?.sessions?.get?.(sessionId)
        if (session !== undefined && session !== null) await ctx?.permissionPresets?.set?.(session, preset)
      } catch (error) {
        // 权限没设上不该让整条请求失败，但要留下痕迹
        log.warn(`[dsh-cross-agent] 设置会话权限失败（${preset}）：${error?.message ?? error}`)
      }
    }
    try {
      await controller.rename({ sessionId, title })
    } catch (error) {
      log.warn(`[dsh-cross-agent] 会话改名失败：${error?.message ?? error}`)
    }
    return { sessionId, workspaceId, title, permission: preset }
  }

  async function runPeerTool (peer, tool, args, budget) {
    const tools = ctx?.tools
    if (typeof tools?.execute !== 'function') throw httpFail(501, 'tools-unavailable')
    const agent = await session.agentFor(peer)
    if (agent === undefined || agent === null) throw httpFail(409, 'session-not-ready')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    try {
      const batch = await tools.execute({
        calls: [{
          type: 'tool-call',
          id: crypto.randomUUID(),
          name: tool,
          arguments: JSON.stringify(args ?? {})
        }],
        signal: controller.signal,
        agent
      })
      const first = Array.isArray(batch?.results) ? batch.results[0] : undefined
      if (first === undefined) return { ok: false, reason: 'no-result' }
      const isError = first.isError === true
      const text = textFromResult(first)
      return {
        ok: !isError,
        isError,
        text: text.slice(0, 16 * 1024),
        error: isError ? (first?.error?.message ?? 'tool-error') : ''
      }
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) }
    } finally {
      clearTimeout(timer)
    }
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
      startedAt,
      ports: {
        discovery: discovery.port || discoveryPort,
        rpc: rpcServer.port || rpcPort
      },
      paths: { inbox: inboxRoot, share: shareRoots[0] ?? null, shares: shareRoots },
      capabilities: { exposedTools },
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
      // 旧版本把"插件启动"也记进审计，那些行不是"谁对我们做了什么"，不回放到面板上。
      audit: (await audit.recent(100)).filter((row) => row.outcome !== 'started')
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
      case 'probe': {
        const address = typeof payload.address === 'string' ? payload.address.trim() : ''
        if (address === '') throw new Error('probe 需要一个地址')
        const port = Number.isInteger(payload.port) ? payload.port : discovery.port || discoveryPort
        if (!discovery.probe(address, port)) throw new Error('发现服务没在跑，探针发不出去')
        return { ok: true, result: { address, port } }
      }
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

  /**
   * 让对端在它那台机器的某个目录下建一条会话。目录既是"项目分组"的身份，
   * 也是新会话的 cwd——已经存在就复用，不存在就当场注册。
   */
  async function createPeerSession ({ peer: ref, path: remotePath, title = '', permission = '', waitMs } = {}) {
    const target = resolvePeer(ref)
    if (!discovery.isOnline(target.deviceId)) throw new Error('这个对端现在不在线')
    if (typeof remotePath !== 'string' || remotePath.trim() === '') throw new Error('需要一个对端的目录（绝对路径）')
    const budget = clampWait(waitMs)
    const response = await rpcClient.call(target.deviceId, 'POST', '/ca/v1/session/create', {
      path: remotePath.trim(),
      title: typeof title === 'string' ? title : '',
      permission: typeof permission === 'string' ? permission : '',
      waitMs: budget
    }, { timeoutMs: Math.max(reviewTimeout(budget), 20_000) + 10_000 })
    if (response?.ok !== true) {
      return { ok: false, reason: response?.reason ?? 'unknown' }
    }
    return {
      ok: true,
      sessionId: response.sessionId,
      workspaceId: response.workspaceId,
      title: response.title,
      permission: response.permission,
      requestedPermission: response.requestedPermission ?? null,
      clamped: response.clamped === true
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

  async function listPeerTools ({ peer: ref }) {
    const target = resolvePeer(ref)
    if (!discovery.isOnline(target.deviceId)) throw new Error('这个对端现在不在线')
    const response = await rpcClient.call(target.deviceId, 'GET', '/ca/v1/tools', undefined, { timeoutMs: 10_000 })
    return { ok: response?.ok === true, tools: Array.isArray(response?.tools) ? response.tools.map((row) => row.name) : [] }
  }

  async function callTool ({ peer: ref, tool, args, waitMs }) {
    const target = resolvePeer(ref)
    if (typeof tool !== 'string' || tool === '') throw new Error('tool 不能为空')
    if (!discovery.isOnline(target.deviceId)) throw new Error('这个对端现在不在线')
    const gate = limits.toolHour.allow(target.deviceId)
    if (!gate.ok) throw new Error('调这个对端的工具太频繁，稍后再试')

    const budget = clampWait(waitMs)
    const response = await rpcClient.call(target.deviceId, 'POST', '/ca/v1/tool', {
      tool,
      args: args ?? {},
      waitMs: budget
    }, { timeoutMs: budget + 15_000 })

    if (response?.ok === true) {
      await audit.record({
        peerId: target.deviceId,
        peerName: target.name,
        kind: 'instruction',
        outcome: 'tool-ok',
        detail: tool
      })
      return { ok: true, text: response.text ?? '' }
    }
    await audit.record({
      peerId: target.deviceId,
      peerName: target.name,
      kind: 'instruction',
      outcome: 'tool-failed',
      detail: `${tool} · ${response?.reason ?? response?.error ?? 'unknown'}`
    })
    return { ok: false, reason: response?.reason ?? response?.error ?? 'unknown', text: response?.text ?? '' }
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
    startedAt = Date.now()
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
    createPeerSession,
    sendFile,
    fetchFile,
    callTool,
    listPeerTools,
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

function logger (ctx, config = {}) {
  const warn = (message) => {
    /**
     * 运行期告警（例如"投递失败：..."）在宿主日志里，而人排查时手里只有插件自己的
     * bootstrap.log——远端机器尤其如此。所以这里同时抄一份过去。
     */
    try {
      config.onWarn?.(String(message))
    } catch {
      // 抄一份失败不能反过来影响告警本身
    }
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
/** 会话标题：去掉控制字符，太长的截断——它会出现在对端的会话列表里。 */
function clampTitle (value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text.length > 120 ? text.slice(0, 120) : text
}

function reviewTimeout (budget) {
  return Math.max(1000, Math.min(REVIEW_WINDOW_MS, budget - 1500))
}

function clampWait (value) {
  if (!Number.isFinite(value)) return ASK_WAIT_DEFAULT_MS
  return Math.max(1000, Math.min(ASK_WAIT_MAX_MS, Math.trunc(value)))
}

const OFFLINE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'])

function resolveShareRoots (config, base) {
  const list = Array.isArray(config.shareRoots) && config.shareRoots.length > 0
    ? config.shareRoots
    : [config.shareDir || path.join(base, '.cross-agent', 'share')]
  const resolved = []
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.trim() === '') continue
    const value = path.isAbsolute(entry) ? entry : path.resolve(base, entry)
    if (!resolved.includes(value)) resolved.push(value)
  }
  if (resolved.length === 0) resolved.push(path.join(base, '.cross-agent', 'share'))
  return resolved
}

/**
 * 读 `$DSH_HOME/dsh-cross-agent/peers.json`：`["10.0.0.9"]` 或 `{ "peers": [...] }`。
 * 读不到 / 解析失败都当成"没有静态对端"，不影响广播发现。
 */
async function readPeerFile (home) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(home, 'peers.json'), 'utf8'))
    if (Array.isArray(parsed)) return parsed
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.peers)) return parsed.peers
    return []
  } catch {
    return []
  }
}

/**
 * 静态对端地址：广播被 Wi-Fi 抑制（客户端隔离 / 广播过滤）时，靠每拍单播探针维持心跳。
 * 接受 "10.0.0.9" 或 "10.0.0.9:45881"。
 */
function normalizeProbeTargets (value) {
  if (!Array.isArray(value)) return []
  const targets = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (text === '') continue
    const cut = text.lastIndexOf(':')
    const tail = cut > 0 ? text.slice(cut + 1) : ''
    const hasPort = tail !== '' && /^\d+$/.test(tail)
    const address = hasPort ? text.slice(0, cut) : text
    if (address === '') continue
    targets.push(hasPort ? { address, port: Number(tail) } : { address })
  }
  return targets
}

function shortArgs (args) {
  try {
    const text = JSON.stringify(args ?? {})
    return text.length > 80 ? `${text.slice(0, 77)}...` : text
  } catch {
    return '…'
  }
}

function textFromResult (result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (text !== '') return text
  if (result?.value !== undefined) {
    try {
      return JSON.stringify(result.value).slice(0, 16 * 1024)
    } catch {
      return ''
    }
  }
  return ''
}

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
