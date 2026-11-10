import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * 入口层的接线测试：工具、命令、本地路由、以及"停用时能不能一起摘掉"。
 *
 * 这一层最容易出的事故是：`ctx.effect` 只卸载了服务，却把工具和路由留在进程里，
 * 于是重装一次就多一份 handler。这里用一个会拒绝重复路径的假 webServer 把那条路堵死。
 */
async function boot ({ ports = { discovery: 45931, rpc: 45933 } } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-plugin-'))
  const workspace = path.join(home, 'ws')
  await fs.mkdir(workspace, { recursive: true })

  const tools = []
  const commands = []
  const routes = new Map()
  let teardown = null
  const listeners = new Map()

  const ctx = {
    logger: { warn: () => {} },
    workingDirectory: { defaultDirectory: workspace },
    on (name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
    tools: {
      register (definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index !== -1) tools.splice(index, 1)
        }
      }
    },
    commands: {
      register (definition) {
        commands.push(definition)
        return () => {
          const index = commands.indexOf(definition)
          if (index !== -1) commands.splice(index, 1)
        }
      }
    },
    webServer: {
      register (route) {
        if (routes.has(route.path)) throw new Error(`webserver: duplicate prefix route "${route.path}"`)
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      }
    },
    sessions: { get: () => undefined, prepare: (id) => ({ id }) },
    agents: {},
    sessionController: { prompt: async () => ({ accepted: true }) },
    effect (factory) {
      teardown = factory()
      return () => {}
    }
  }

  const { apply } = await import('../index.js')
  await apply(ctx, {
    home,
    discoveryPort: ports.discovery,
    port: ports.rpc,
    displayName: '接线测试',
    inboxDir: path.join(home, 'inbox'),
    shareDir: path.join(home, 'share'),
    registryDir: path.join(home, 'instances')
  })

  return {
    home,
    tools,
    commands,
    routes,
    async stop () {
      try {
        teardown?.()
      } catch {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      await fs.rm(home, { recursive: true, force: true })
    }
  }
}

function fakeRequest (method, url) {
  return {
    method,
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on () {},
    destroy () {}
  }
}

function fakeResponse () {
  const chunks = []
  return {
    writableEnded: false,
    writeHead (status, headers) {
      this.status = status
      this.headers = headers
    },
    end (payload) {
      if (payload !== undefined) chunks.push(Buffer.from(payload))
      this.writableEnded = true
      this.body = Buffer.concat(chunks).toString('utf8')
    }
  }
}

test('原始定义对象也能编译出合法的 parameters schema', async () => {
  const app = await boot()
  try {
    const ask = app.tools.find((tool) => tool.name === 'peer_ask')
    assert.equal(ask.parameters.type, 'object')
    assert.deepEqual(ask.parameters.required, ['peer', 'text'])
    assert.equal(ask.parameters.properties.peer.type, 'string')
    assert.equal(ask.parameters.properties.wait_ms.type, 'number')
  } finally {
    await app.stop()
  }
})

test('apply 注册 7 个工具、1 个命令、1 条本地路由', async () => {
  const app = await boot()
  try {
    assert.deepEqual(app.tools.map((tool) => tool.name).sort(), [
      'peer_ask', 'peer_file_fetch', 'peer_file_send', 'peer_list', 'peer_session_create', 'peer_tool', 'peer_tools'
    ])
    assert.deepEqual(app.commands.map((command) => command.name), ['cross-agent'])
    assert.ok(app.routes.has('/cross-agent'))
  } finally {
    await app.stop()
  }
})

test('GET /cross-agent/state 走通了整条接线', async () => {
  const app = await boot()
  try {
    const handler = app.routes.get('/cross-agent')
    const res = fakeResponse()
    await handler(fakeRequest('GET', '/cross-agent/state'), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.state.self.name, '接线测试')
    assert.deepEqual(body.state.ports, { discovery: 45931, rpc: 45933 })
    assert.ok(Array.isArray(body.state.peers))
    assert.ok(Array.isArray(body.state.paths.shares))
    assert.deepEqual(body.state.capabilities.exposedTools, [])
    assert.deepEqual(body.state.audit, [], '启动不该往审计里写东西')
    assert.ok(Number.isFinite(body.state.startedAt))
  } finally {
    await app.stop()
  }
})

test('POST /cross-agent/action 改名字生效', async () => {
  const app = await boot()
  try {
    const handler = app.routes.get('/cross-agent')
    const req = fakeRequest('POST', '/cross-agent/action')
    const payload = Buffer.from(JSON.stringify({ action: 'rename', name: '新名字' }))
    req.on = (event, fn) => {
      if (event === 'data') fn(payload)
      if (event === 'end') fn()
      return req
    }
    const res = fakeResponse()
    await handler(req, res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.state.self.name, '新名字')
  } finally {
    await app.stop()
  }
})

test('非回环来源一律 403', async () => {
  const app = await boot()
  try {
    const handler = app.routes.get('/cross-agent')
    const req = fakeRequest('GET', '/cross-agent/state')
    req.socket.remoteAddress = '192.168.1.9'
    const res = fakeResponse()
    await handler(req, res)
    assert.equal(res.status, 403)
  } finally {
    await app.stop()
  }
})

test('停用后工具、命令、路由都被摘掉', async () => {
  const app = await boot()
  try {
    assert.equal(app.tools.length, 7)
    app.stop().then(() => {})
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(app.tools.length, 0)
    assert.equal(app.commands.length, 0)
    assert.equal(app.routes.size, 0)
  } finally {
    await fs.rm(app.home, { recursive: true, force: true })
  }
})
