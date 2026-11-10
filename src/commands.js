/**
 * 人的入口：`/cross-agent ...`。只做"看"和"同意/拒绝/放行/改模式"，
 * 不下达跨端指令——那是 agent 的工具。
 */
export function registerCommands (ctx, service, { log } = {}) {
  return ctx.commands.register({
    name: 'cross-agent',
    description: '跨端 agent 会话：查看连接与待办、放行对端、审核对方的指令与文件。',
    input: {
      hint: 'status | pending | approve <id> | reject <id> | connect <名字> | allow <名字> | mode <名字> open|confirm --yes | block <名字> | rename <新名字> | probe <地址> [端口]'
    },
    recordInput: false,
    async handler (invocation) {
      const raw = String(invocation?.rawInput ?? '').trim()
      const [verb = 'status', ...rest] = raw.split(/\s+/).filter((part) => part !== '')
      try {
        switch (verb) {
          case 'status':
            return ok(renderStatus(await service.state()))
          case 'pending':
            return ok(renderPending(await service.state()))
          case 'approve':
            return ok(`已同意 ${(await service.act('approve', { id: rest[0] })).result.id}`)
          case 'reject':
            return ok(`已拒绝 ${(await service.act('reject', { id: rest[0] })).result.id}`)
          case 'connect': {
            const deviceId = await resolve(service, rest[0])
            const result = await service.act('connect', { deviceId })
            return ok(`已向 ${rest[0]} 发起连接请求（当前 ${result.result.state}）`)
          }
          case 'allow': {
            const deviceId = await resolve(service, rest[0])
            const view = await service.act('allow-peer', { deviceId })
            return ok(`已放行 ${view.result.name}，模式 ${view.result.mode}，指纹 ${view.result.fingerprint}`)
          }
          case 'mode': {
            const deviceId = await resolve(service, rest[0])
            const mode = rest[1] === 'open' ? 'open' : 'confirm'
            const confirmed = rest.includes('--yes')
            const view = await service.act('mode', { deviceId, mode, confirmed })
            return ok(`${view.result.name} 的权限模式现在是 ${view.result.mode}`)
          }
          case 'block': {
            const deviceId = await resolve(service, rest[0])
            await service.act('block', { deviceId })
            return ok(`已封禁 ${rest[0]}`)
          }
          case 'probe': {
            const address = rest[0]
            if (typeof address !== 'string' || address === '') throw new Error('用法：/cross-agent probe <地址> [端口]')
            const port = rest[1] === undefined ? undefined : Number(rest[1])
            if (port !== undefined && !Number.isInteger(port)) throw new Error(`端口不像数字：${rest[1]}`)
            const result = await service.act('probe', port === undefined ? { address } : { address, port })
            return ok(`已向 ${result.result.address}:${result.result.port} 发探针；对端在线的话几秒内会出现在对端列表`)
          }
          case 'rename': {
            const name = rest.join(' ')
            const result = await service.act('rename', { name })
            return ok(`本机现在叫 ${result.result.name}`)
          }
          default:
            return fail(`未知子命令：${verb}`)
        }
      } catch (error) {
        return fail(error?.message ?? String(error))
      }
    }
  })

  async function resolve (svc, ref) {
    if (typeof ref !== 'string' || ref === '') throw new Error('缺少对端名字')
    const rows = svc.listPeers()
    const hit = rows.find((row) => row.name === ref || row.deviceId === ref) ??
      rows.find((row) => row.name.toLowerCase() === ref.toLowerCase())
    if (hit === undefined) {
      throw new Error(`找不到「${ref}」。目前看到：${rows.map((row) => row.name).join('、') || '（没有）'}`)
    }
    return hit.deviceId
  }

  function ok (text) {
    return { kind: 'success', text }
  }

  function fail (text) {
    return { kind: 'error', text }
  }
}

function renderStatus (state) {
  const lines = [
    `本机：${state.self.name}（${state.self.deviceId.slice(0, 8)}…）`,
    `端口：发现 ${state.ports.discovery}/udp · RPC ${state.ports.rpc}/tcp`,
    `收件箱：${state.paths.inbox}`,
    `共享目录：${state.paths.share}`,
    ''
  ]
  if (state.peers.length === 0) lines.push('对端：还没看到任何对端')
  else {
    lines.push('对端：')
    for (const peer of state.peers) {
      const mark = peer.online ? '●' : '○'
      const stateText = peer.state === 'admitted' ? `已放行 · ${peer.mode}` : peer.state
      lines.push(`  ${mark} ${peer.name}  ${stateText}${peer.fingerprint ? `  ${peer.fingerprint}` : ''}`)
    }
  }
  lines.push('', `待审核：${state.pending.length} 条`)
  lines.push(`最近传输：${state.transfers.length} 条`)
  return lines.join('\n')
}

function renderPending (state) {
  if (state.pending.length === 0) return '没有待审核的事。'
  return state.pending.map((item) => {
    const kind = item.kind === 'hello' ? '连接请求' : item.kind === 'ask' ? '指令' : '文件'
    return `${item.id.slice(0, 8)}…  ${kind}  ${item.peerName || item.peerId.slice(0, 8)}  ${item.summary}`
  }).join('\n')
}
