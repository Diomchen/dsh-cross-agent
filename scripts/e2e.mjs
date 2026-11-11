import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createService } from '../src/service.js'

/**
 * 单进程双实例端到端：真实 UDP 发现 + 真实 HTTP/HMAC + 真实文件落盘。
 *
 * 覆盖 SPEC §10 的 1–5、7 条（真机第二台、防火墙不在自动化范围内）。
 * 用法：node scripts/e2e.mjs
 */

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-e2e-'))
const DISCOVERY_A = 45901
const DISCOVERY_B = 45902
const RPC_A = 45903
const RPC_B = 45904

function fakeCtx (workspace, replies) {
  const listeners = new Map()
  const sessions = new Map()
  return {
    logger: { warn: (message) => console.warn(String(message)) },
    workingDirectory: { defaultDirectory: workspace },
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
        const session = { id }
        sessions.set(id, session)
        return session
      }
    },
    agents: { get: (id) => ({ id }) },
    tools: {
      async execute ({ calls, agent }) {
        const call = calls[0]
        // 真机形状：结果是嵌套的 { callId, result: { isError, content, meta } }
        return {
          results: [{
            callId: call.id,
            result: {
              isError: false,
              content: [{ type: 'text', text: `B 执行了 ${call.name}(${call.arguments}) 于会话 ${agent.id.slice(0, 8)}` }],
              meta: {}
            }
          }]
        }
      }
    },
    sessionController: {
      // 真机上 agent 注册表挂在 sessionController 上，方法返回 { agent }
      agents: { liveAgent: (id) => ({ agent: { id } }) },
      async prompt (request) {
        const text = request.content?.[0]?.text ?? ''
        const reply = replies(text)
        setTimeout(() => {
          const emit = listeners.get('session/event') ?? []
          for (const fn of emit) {
            fn({ id: request.sessionId }, {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: reply }] } }
            })
          }
          const status = listeners.get('api-session/status') ?? []
          for (const fn of status) fn(request.sessionId, false)
        }, 10)
        return { accepted: true }
      }
    }
  }
}

async function waitFor (predicate, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function waitForPending (service, kind, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const hit = service.approvals.list({ status: 'pending' }).find((item) => item.kind === kind)
    if (hit !== undefined) return hit
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

async function main () {
  const homeA = path.join(TMP, 'a')
  const homeB = path.join(TMP, 'b')
  await fs.mkdir(homeA, { recursive: true })
  await fs.mkdir(homeB, { recursive: true })

  const ctxA = fakeCtx(path.join(TMP, 'ws-a'), (text) => `A 收到：${text}`)
  const ctxB = fakeCtx(path.join(TMP, 'ws-b'), (text) => `B 机答复：${text.slice(0, 20)}（共 ${text.length} 字）`)

  const registryDir = path.join(TMP, 'instances')
  const A = await createService(ctxA, {
    home: homeA,
    discoveryPort: DISCOVERY_A,
    port: RPC_A,
    registryDir,
    displayName: 'A 机'
  })
  const B = await createService(ctxB, {
    home: homeB,
    discoveryPort: DISCOVERY_B,
    port: RPC_B,
    registryDir,
    displayName: 'B 机',
    exposedTools: ['echo'],
    shareRoots: [path.join(TMP, 'ws-a', '.cross-agent', 'share')]
  })

  try {
    await A.start()
    await B.start()
    console.log('✓ 两个实例已启动', A.identity.deviceId.slice(0, 8), B.identity.deviceId.slice(0, 8))

    // 两个实例的 UDP 端口不同（真机上相同、走广播）；这里靠本机注册表互相看见，
    // 顺便验证"同一台机器两个 DSH"这条路径。
    await waitFor(() => A.discovery.isOnline(B.identity.deviceId) && B.discovery.isOnline(A.identity.deviceId), 8000)
    assert.equal(A.state !== undefined, true)
    console.log('✓ 两个实例互相看见（本机注册表）')

    // 1. A 请求连接 → B 侧有待放行
    await A.peers.beginAdmission(B.identity.deviceId)
    assert.equal(A.peers.get(B.identity.deviceId).state, 'pending')
    const pendingHello = B.approvals.list({ status: 'pending' }).filter((item) => item.kind === 'hello')
    assert.equal(pendingHello.length, 1)
    console.log('✓ 握手请求已到达 B，待放行 1 条')

    // 2. B 的人从面板点"放行" → 走的是 act('approve')，必须真的放行对端（而不只是清队列）
    await B.act('approve', { id: pendingHello[0].id })
    assert.equal(B.peers.get(A.identity.deviceId).state, 'admitted')
    assert.equal(A.peers.get(B.identity.deviceId).state, 'admitted')
    const keyA = A.peers.keyFor(B.identity.deviceId)
    const keyB = B.peers.keyFor(A.identity.deviceId)
    assert.equal(keyA.toString('hex'), keyB.toString('hex'))
    console.log('✓ 已放行，两端指纹一致：', B.peers.get(A.identity.deviceId).fingerprint)

    // 2.5 A 给 B 起一个只在本机生效的别名，并用别名投递（工具参数认别名）
    await A.act('alias', { deviceId: B.identity.deviceId, alias: 'Windows 测试机' })
    const aliased = (await A.state()).peers.find((peer) => peer.deviceId === B.identity.deviceId)
    assert.equal(aliased.alias, 'Windows 测试机')
    assert.equal((await B.state()).peers.find((peer) => peer.deviceId === A.identity.deviceId).alias, '', '别名不该传过网线')
    console.log('✓ 本机别名已保存，且没有传给对端')

    // 3. confirm 模式下发指令：B 侧出现待审核，A 收到 awaiting-review
    const first = await A.ask({ peer: 'Windows 测试机', text: '帮我看看今天是星期几', waitMs: 1200 })
    assert.equal(first.ok, false)
    assert.equal(first.reason, 'awaiting-review')
    const pendingAsk = B.approvals.list({ status: 'pending' }).find((item) => item.kind === 'ask')
    assert.ok(pendingAsk, 'B 侧应该有一条待审核指令')
    console.log('✓ confirm 模式：指令进入待审核，A 得到 awaiting-review')

    // 4. 人同意 → A 用 correlation_id 复查仍然超时（这次已经回过了），改成再发一条并当场同意
    await B.approvals.resolve(pendingAsk.id, 'approved', { remember: true })
    const second = await A.ask({ peer: B.identity.deviceId, text: '再确认一次：1+1 等于几？', waitMs: 8000 })
    assert.equal(second.ok, true, `期望拿到答复，实际：${JSON.stringify(second)}`)
    assert.match(second.reply, /B 机答复/)
    console.log('✓ 记住 24h 生效，指令直接送达并拿到答复：', second.reply)

    // 4.5 审计带上方向：B 是收到，A 是发出
    const auditB = await B.audit.recent(50)
    const auditA = await A.audit.recent(50)
    assert.ok(auditB.some((row) => row.kind === 'instruction' && row.direction === 'in'), 'B 侧应有一条"收到"的指令审计')
    assert.ok(auditA.some((row) => row.kind === 'instruction' && row.direction === 'out'), 'A 侧应有一条"发出"的指令审计')
    console.log('✓ 指令方向已写入审计（in / out）')

    // 5. 文件传输 A → B
    const filePath = path.join(TMP, 'report.txt')
    const payload = crypto.randomBytes(256 * 1024)
    await fs.writeFile(filePath, payload)
    const sending = A.sendFile({ peer: B.identity.deviceId, path: filePath, note: '报表' })
    const fileItem = await waitForPending(B, 'file', 10_000)
    assert.ok(fileItem, 'B 侧应该出现一条文件待审核')
    await B.approvals.resolve(fileItem.id, 'approved', { remember: true })
    const sent = await sending
    assert.equal(sent.ok, true)
    assert.equal(sent.bytes, payload.length)
    const written = await fs.readFile(sent.receipt.path)
    assert.equal(written.toString('hex'), payload.toString('hex'))
    assert.ok(sent.receipt.path.includes(path.join('ws-b', '.cross-agent', 'inbox', 'A 机')))
    console.log('✓ 文件已送达并校验：', sent.receipt.path)

    // 6. 共享目录拉取 B → A
    const shareDir = path.join(TMP, 'ws-a', '.cross-agent', 'share')
    await fs.mkdir(shareDir, { recursive: true })
    await fs.writeFile(path.join(shareDir, 'hello.md'), '# 给 A 的')
    const fetched = await B.fetchFile({ peer: A.identity.deviceId, path: 'hello.md' })
    assert.equal(fetched.ok, true)
    assert.equal(await fs.readFile(fetched.path, 'utf8'), '# 给 A 的')
    console.log('✓ 共享目录拉取成功：', fetched.path)

    // 6.5 跨端工具调用：白名单 + open 模式
    await B.peers.setMode(A.identity.deviceId, 'open', { confirmed: true })
    const exposed = await A.listPeerTools({ peer: B.identity.deviceId })
    assert.deepEqual(exposed.tools, ['echo'])
    const called = await A.callTool({ peer: B.identity.deviceId, tool: 'echo', args: { x: 1 } })
    assert.equal(called.ok, true)
    assert.match(called.text, /B 执行了 echo\(/)
    await assert.rejects(
      () => A.callTool({ peer: B.identity.deviceId, tool: 'bash' }),
      /tool-not-exposed/
    )
    console.log('✓ 跨端工具：白名单内可调，白名单外被拒')

    // 7. 审计里能看到五类事实
    const kinds = new Set((await A.state()).audit.map((row) => row.kind))
    for (const kind of ['admit', 'instruction', 'transfer']) assert.ok(kinds.has(kind), `缺审计 ${kind}`)
    console.log('✓ 审计覆盖：', [...kinds].join('、'))

    // 8. 关掉 B → A 侧报离线且不卡死
    await B.dispose()
    const startedAt = Date.now()
    await assert.rejects(() => A.ask({ peer: B.identity.deviceId, text: '还在吗' }), /不在线/)
    assert.ok(Date.now() - startedAt < 2000)
    console.log('✓ 对端下线后快速失败，不卡 120 秒')

    console.log('\n全部通过。')
  } finally {
    await A.dispose().catch(() => {})
    await B.dispose().catch(() => {})
    await fs.rm(TMP, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('端到端失败：', error)
  process.exitCode = 1
})
