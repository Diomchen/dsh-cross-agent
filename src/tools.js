/**
 * 4 个 agent 工具。名字以 `peer_` 开头：模型选工具时第一眼读的就是它。
 *
 * 每个工具只做一件事，描述里必须出现跨端的两个代价：
 *   - 延迟 = 对方一次 agent turn（秒到分钟），不是 RPC；
 *   - `confirm` 模式下可能被对方的人拒绝或超时。
 *
 * 注意：`output.schema` 用的是宿主的"值 schema DSL"——必填写在属性上
 * （`required: true`），**没有**顶层的 `required` 数组。写成 JSON Schema 会被拒。
 */
let defineTool = null
let defineToolError = ''

/**
 * 宿主的 `defineTool` 在运行时由 DSH 提供；链接安装（link:）的包不一定能从自己的
 * node_modules 里解析到 `@deepseek-ai/dsh-tools`。解析不到就退回原始定义对象，
 * 并把原因记下来（`bootstrap.log`），免得"工具没出现"变成一个哑谜。
 */
async function factory () {
  if (defineTool !== null || defineToolError !== '') return defineTool
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    defineTool = module?.defineTool ?? module?.default ?? null
    if (typeof defineTool !== 'function') {
      defineTool = null
      defineToolError = 'no defineTool export'
    }
  } catch (error) {
    defineToolError = error?.code === 'ERR_MODULE_NOT_FOUND' ? 'ERR_MODULE_NOT_FOUND' : (error?.message ?? String(error))
  }
  return defineTool
}

export async function registerTools (ctx, service, { log } = {}) {
  const disposers = []
  const make = await factory()
  if (make === null) {
    log?.note?.(`defineTool 不可用（${defineToolError}）——链接安装的常见情况，参数已自行编译成 JSON Schema，工具照常可用`)
  }
  /**
   * 链接安装时 `@deepseek-ai/dsh-tools` 解析不到，只能交原始定义对象。宿主的注册表
   * 认的是 JSON Schema，所以参数声明要从"属性内联 required"的写法**自己编译**一份，
   * 否则模型看到的 parameters 会是一棵没有 type/properties 的树。
   */
  const define = (spec) => {
    if (make !== null) return make(spec)
    return { ...spec, parameters: toJsonSchema(spec.parameters ?? {}) }
  }

  disposers.push(ctx.tools.register(define({
    name: 'peer_list',
    description: '列出局域网里的 DSH 对端：显示名、是否在线、是否已放行、权限模式（open/confirm）。给对方下指令或用 peer_file_* 之前先看这里，确认名字与状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                deviceId: { type: 'string', required: true },
                state: { type: 'string', required: true },
                mode: { type: 'string', required: true },
                online: { type: 'boolean', required: true },
                fingerprint: { type: 'string' }
              }
            }
          }
        }
      },
      render: (_args, value) => [{ type: 'text', text: renderPeers(value.peers) }]
    },
    isConcurrencySafe: () => true,
    async execute () {
      return {
        peers: service.listPeers().map((peer) => ({
          name: peer.name,
          deviceId: peer.deviceId,
          state: peer.state,
          mode: peer.mode,
          online: peer.online,
          fingerprint: peer.fingerprint ?? ''
        }))
      }
    }
  })))

  disposers.push(ctx.tools.register(define({
    name: 'peer_ask',
    description: '给另一台机器上的 agent 下一条指令，并等它回答。文字会被投进对方那台机器上标题为「跨端 · 你的名字」的会话，由对方的 agent 自己决定怎么做；本插件不会在对方机器上执行 shell。对方要跑完一次 agent turn 才有答复，通常几秒到几分钟。对方是 confirm 模式时，它的人可能拒绝或超时（返回 ok:false）。超时后可以带 correlation_id 再查一次结果。',
    parameters: {
      peer: { type: 'string', required: true, description: '对方的显示名或 deviceId。先用 peer_list 查。' },
      text: { type: 'string', required: true, description: '要对方做什么，或要问它什么。一段话，最多 8 KiB。' },
      wait_ms: { type: 'number', description: '最多等多久，默认 120000，上限 600000。' },
      correlation_id: { type: 'string', description: '复查之前那次投递的结果；给了它就不重新投递（此时 peer/text 可省略）。' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reply: { type: 'string' },
          sessionId: { type: 'string' },
          correlationId: { type: 'string' },
          reason: { type: 'string' }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === true
          ? (value.reply === '' ? '（对方没有产出文字答复）' : value.reply)
          : `未送达：${value.reason === '' ? 'unknown' : value.reason}`
      }]
    },
    isConcurrencySafe: () => false,
    async execute (args) {
      const result = await service.ask({
        peer: args.peer,
        text: args.text,
        waitMs: args.wait_ms,
        correlationId: args.correlation_id
      })
      return {
        ok: result.ok === true,
        reply: result.reply ?? '',
        sessionId: result.sessionId ?? '',
        correlationId: result.correlationId ?? '',
        reason: result.reason ?? ''
      }
    }
  })))

  disposers.push(ctx.tools.register(define({
    name: 'peer_file_send',
    description: '把一个文件推给另一台机器上的 DSH，落到它工作目录的 .cross-agent/inbox/<你的名字>/。单件上限 100 MiB；同名不覆盖（加序号）。收到回执才算送到——回执里带 sha256 与实际路径。对方是 confirm 模式时要等它的人点同意。',
    parameters: {
      peer: { type: 'string', required: true, description: '对方的显示名或 deviceId。' },
      path: { type: 'string', required: true, description: '本机要发的文件的绝对路径或相对工作目录的路径。目录请先打包。' },
      note: { type: 'string', description: '给对方的一句话说明，最多 200 字。' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string' },
          bytes: { type: 'integer' },
          sha256: { type: 'string' },
          path: { type: 'string' }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === true
          ? `已送达 ${value.name}（${value.bytes} 字节，sha256 ${String(value.sha256).slice(0, 12)}…）`
          : '对方没有回执，文件可能没送到'
      }]
    },
    isConcurrencySafe: () => true,
    async execute (args) {
      const result = await service.sendFile({ peer: args.peer, path: args.path, note: args.note ?? '' })
      return {
        ok: result.ok === true,
        name: result.name ?? '',
        bytes: Number.isFinite(result.bytes) ? result.bytes : 0,
        sha256: result.sha256 ?? '',
        path: result.receipt?.path ?? ''
      }
    }
  })))

  disposers.push(ctx.tools.register(define({
    name: 'peer_file_fetch',
    description: '从另一台机器的共享目录 .cross-agent/share/ 里取一个文件到本机（只读，不能取共享目录以外的路径）。同名不覆盖；取回后按 sha256 校验，不一致就丢弃。',
    parameters: {
      peer: { type: 'string', required: true, description: '对方的显示名或 deviceId。' },
      path: { type: 'string', required: true, description: '相对于对方 .cross-agent/share/ 的路径，例如 reports/a.md。' },
      dest: { type: 'string', description: '本机落盘目录；默认落到工作目录的 .cross-agent/inbox/<对方名字>/。' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          sha256: { type: 'string' }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === true
          ? `已取回 ${value.path}（${value.bytes} 字节）`
          : '没有取到文件'
      }]
    },
    isConcurrencySafe: () => true,
    async execute (args) {
      const result = await service.fetchFile({ peer: args.peer, path: args.path, dest: args.dest })
      return {
        ok: result.ok === true,
        path: result.path ?? '',
        bytes: Number.isFinite(result.bytes) ? result.bytes : 0,
        sha256: result.sha256 ?? ''
      }
    }
  })))

  disposers.push(ctx.tools.register(define({
    name: 'peer_tools',
    description: '看另一台机器**当前对外开放**了哪些工具（对方在配置里点名过的才列得出来）。想用 peer_tool 调东西之前先用它确认名字，不要猜。',
    parameters: {
      peer: { type: 'string', required: true, description: '对方的显示名或 deviceId。' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tools: { type: 'array', required: true, items: { type: 'string' } }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tools.length === 0 ? '对方没有对外开放任何工具。' : `对方开放：${value.tools.join('、')}`
      }]
    },
    isConcurrencySafe: () => true,
    async execute (args) {
      const result = await service.listPeerTools({ peer: args.peer })
      return { ok: result.ok === true, tools: result.tools }
    }
  })))

  disposers.push(ctx.tools.register(define({
    name: 'peer_tool',
    description: '调用另一台机器上的一个工具。只有对方在配置里点名开放（exposedTools）的工具能调，名字先用 peer_tools 查；调用在对方那个跨端会话里、用对方的权限执行。对方是 confirm 模式时，每次调用都要它的人点头，可能被拒绝或超时（返回 ok:false）。不要用它去猜路径或试权限——被拒会记进对方的审计。',
    parameters: {
      peer: { type: 'string', required: true, description: '对方的显示名或 deviceId。' },
      tool: { type: 'string', required: true, description: '对方开放的工具名，例如 read_file。' },
      arguments: { type: 'object', additionalProperties: true, description: '传给那个工具的参数对象，形状按对方工具的 schema。' },
      wait_ms: { type: 'number', description: '最多等多久，默认 120000，上限 600000。' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string' },
          reason: { type: 'string' }
        }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === true
          ? (value.text === '' ? '（对方工具没有输出）' : value.text)
          : `没有被执行：${value.reason === '' ? 'unknown' : value.reason}`
      }]
    },
    isConcurrencySafe: () => false,
    async execute (args) {
      const result = await service.callTool({
        peer: args.peer,
        tool: args.tool,
        args: args.arguments,
        waitMs: args.wait_ms
      })
      return { ok: result.ok === true, text: result.text ?? '', reason: result.reason ?? '' }
    }
  })))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
  }
}

function toJsonSchema (parameters) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    if (spec === null || typeof spec !== 'object') {
      properties[name] = { type: 'string' }
      continue
    }
    const { required: isRequired, ...rest } = spec
    properties[name] = rest
    if (isRequired === true) required.push(name)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

function renderPeers (peers) {
  if (!Array.isArray(peers) || peers.length === 0) return '局域网上还没有看到任何对端。确认两台机器在同一网段、防火墙放行了 UDP 45881。'
  return peers.map((peer) => {
    const state = peer.state === 'admitted'
      ? `已放行 · ${peer.mode}`
      : peer.state === 'pending'
        ? '待确认'
        : peer.state === 'discovered'
          ? '已发现 · 未连接'
          : peer.state
    return `${peer.online ? '●' : '○'} ${peer.name}（${state}）`
  }).join('\n')
}
