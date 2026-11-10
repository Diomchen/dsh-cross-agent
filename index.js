import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createService } from './src/service.js'
import { registerTools } from './src/tools.js'
import { registerCommands } from './src/commands.js'
import { registerLocalApi } from './src/http-local.js'

export const name = 'dsh-cross-agent'

/**
 * `sessionController` / `sessions` / `agents` / `workingDirectory` 只用于
 * "把指令投进本机会话"，都是可选依赖：拿不到时插件仍然能启动（只是投不了信），
 * 所以只把真正必需的三个声明进 inject。
 */
export const inject = ['webServer', 'tools', 'commands']

const shape = {
  discoveryPort: { type: 'number', default: 45881, description: 'UDP 发现端口；同一网段的所有机器要一致。' },
  port: { type: 'number', default: 45883, description: 'RPC 与文件传输端口。' },
  displayName: { type: 'string', default: '', description: '本机在局域网里显示的名字；留空用主机名。' },
  inboxDir: { type: 'string', default: '', description: '收到的文件落到哪；留空用 <工作目录>/.cross-agent/inbox。' },
  shareDir: { type: 'string', default: '', description: '允许对端拉取的共享目录；留空用 <工作目录>/.cross-agent/share。' }
}

/**
 * Config 用 schemastery；拿不到它（例如在没有宿主运行时的单测环境里 require 本文件）
 * 就退回等价的 JSON Schema，两者字段一致。
 */
export const Config = await buildConfig()

async function buildConfig () {
  try {
    const module = await import('@deepseek-ai/schemastery')
    const z = module?.default ?? module
    if (z?.object === undefined) throw new Error('no z.object')
    return z.object({
      discoveryPort: z.number().default(45881).description('UDP 发现端口；同一网段的所有机器要一致。'),
      port: z.number().default(45883).description('RPC 与文件传输端口。'),
      displayName: z.string().default('').description('本机在局域网里显示的名字；留空用主机名。'),
      inboxDir: z.string().default('').description('收到的文件落到哪；留空用 <工作目录>/.cross-agent/inbox。'),
      shareDir: z.string().default('').description('允许对端拉取的共享目录；留空用 <工作目录>/.cross-agent/share。'),
      shareRoots: z.array(z.string()).default([]).description('共享目录白名单（多个根）。相对路径相对工作目录；留空则只有 shareDir。'),
      exposedTools: z.array(z.string()).default([]).description('允许对端通过 peer_tool 调用的本机工具名。默认空 = 不开放任何工具。')
    })
  } catch {
    return { type: 'object', additionalProperties: false, properties: shape }
  }
}

/**
 * 入口。整段包在 try/catch 里：插件坏掉时应该是一行警告，而不是让 DSH 起不来。
 */
export async function apply (ctx, config = {}) {
  const log = { warn: (message) => warn(ctx, message), note: (message) => note(ctx, message) }

  let service
  try {
    service = await createService(ctx, config)
  } catch (error) {
    warn(ctx, `初始化失败，跨端会话不可用：${describe(error)}`)
    return
  }

  try {
    await service.start()
  } catch (error) {
    warn(ctx, `启动失败：${describe(error)}`)
  }

  // 所有挂在宿主上的东西都要能一起摘掉：插件被停用/重载时，路由和工具不能留在原地。
  const teardowns = [() => service.dispose()]

  try {
    teardowns.push(await registerTools(ctx, service, { log }))
  } catch (error) {
    warn(ctx, `工具注册失败：${describe(error)}`)
  }

  try {
    teardowns.push(registerCommands(ctx, service, { log }))
  } catch (error) {
    warn(ctx, `命令注册失败：${describe(error)}`)
  }

  try {
    teardowns.push(registerLocalApi({ webServer: ctx.webServer, service, log }))
  } catch (error) {
    warn(ctx, `本地接口挂载失败：${describe(error)}`)
  }

  try {
    ctx.effect(() => () => {
      for (const teardown of teardowns.reverse()) {
        try {
          teardown()
        } catch {
          // 卸载时的问题不该再抛回去
        }
      }
    }, 'dsh-cross-agent: lifecycle')
  } catch (error) {
    warn(ctx, `生命周期挂载失败：${describe(error)}`)
    service.dispose().catch(() => {})
  }
}

function warn (ctx, message) {
  const line = `[dsh-cross-agent] ${message}`
  try {
    if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(line)
    else console.warn(line)
  } catch {
    // 日志本身也不能让插件崩掉
  }
  appendBootstrap(message)
}

/** 只写进 bootstrap.log，不进宿主日志：这是"知道了"，不是"出事了"。 */
function note (_ctx, message) {
  appendBootstrap(message)
}

function appendBootstrap (message) {
  const file = bootstrapPath()
  const line = `${new Date().toISOString()} ${message}\n`
  fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    .then(() => fs.appendFile(file, line, { mode: 0o600 }))
    .catch(() => {})
}

function bootstrapPath () {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(base, 'dsh-cross-agent', 'bootstrap.log')
}

function describe (error) {
  return error instanceof Error ? error.message : String(error)
}
