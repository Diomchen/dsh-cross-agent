# 宿主接口笔记（票 01）

这份文件记"插件实际依赖了宿主的什么"，以及**哪些是实测过的、哪些还是照文档写的**。

## 已实测（单进程双实例 `scripts/e2e.mjs`）

这些路径跑通过，但它们用的是本仓库自己的协议，不依赖 DSH 内部：

- UDP 发现 + 本机实例注册表 → 互相看见；
- HTTP 45883 + HMAC 签名 + 时间窗 + nonce → 握手、`ask`、两阶段文件上传、共享目录下载；
- X25519 + HKDF → 两端派生同一把密钥、同一指纹；
- 待审核队列 → `awaiting-review`、同意、记住 24h；
- 文件落盘 + sha256 + 同名加序号 + 共享目录越界拒绝；
- 对端下线 → 快速失败（不用等超时）。

## 已在真实运行时确认

- `@deepseek-ai/dsh-tools` 的 `defineTool` **能解析**（链接安装也算），工具定义必须过它；
- `output.schema` 是"值 schema DSL"：必填写在属性上（`{ type:'string', required:true }`），
  顶层 `required: []` 会报 `unsupported JSON schema: schema.required is not supported by the value schema DSL`；
- `ctx.webServer.register` 对同一个 `(kind,path)` 第二次注册会抛
  `duplicate prefix route`，而且停用插件时不会自动回收；
- `apply` 里注册的一切（工具、命令、路由）都要自己塞进 `ctx.effect` 的卸载函数，
  否则重装会把旧 handler 留在进程里。
- **`dsh.client.inject` 不能留空**：空数组时模块会被加载，但 `ctx.slots` 拿不到，
  注册静默失败（我一开始就是这样，`main` 槽位里空空如也）。至少要声明
  `@deepseek-ai/dsh-client-ui-slots`，否则要用的服务不会被注入。
- 侧栏入口在 `sidebar.panellist` 注册：`{ id, order, label }`，**id 必须等于 `main` 的 key**，
  侧栏自己渲染按钮并 `selectPanel(id)`；组件只画图标，收到的 owner props 是 `{ size, active }`。

## 待验（还没在真实 DSH 进程里逐字段确认）

| 依赖 | 我写的形状 | 风险 | 退路 |
|---|---|---|---|
| `ctx.sessionController.prompt(request, signal)` | `{ requestId, sessionId, mode:'queue', content:[{type:'text',text}] }` | 字段名可能不同 | `src/session.js` 里 `deliverNow` 是唯一调用点 |
| 答复事件 | `ctx.on('session/event', (session, event) => event.type === 'assistant/message'`，取 `event.data.message` | 事件名/载荷可能不同 | 已加"静默 1.2 秒即收"的兜底判定 |
| 空闲事件 | `ctx.on('api-session/status', (sessionId, running) => running === false)` | 名称可能不同 | 同上 |
| 建会话 | 依次试 `agents.create` / `agentLoop.create` / `sessions.prepare` | 三条都可能不是这个形状 | 三条全挂会抛"创建跨端会话失败"，不会静默 |
| `ctx.webServer.register({kind:'prefix', path, handler})` | 前缀路由，处理 `/cross-agent/state` 与 `/cross-agent/action` | 低：dsh-zoo 用的同一形态 | 失败时只丢面板，工具仍可用 |
| `ctx.tools.register(definition)` | `{ name, description, parameters(内联 required), output:{schema,render}, execute }` | 中：`parameters` 的 DSL 是作者侧糖 | 退路是直接给 JSON Schema 形状 |
| `ctx.commands.register(definition)` | `{ name, description, input:{hint}, recordInput:false, handler }` | 低 | 失败只丢命令 |
| `Config` | 优先 `@deepseek-ai/schemastery`，拿不到退回 JSON Schema | 低 | 已实现回退 |
| `ctx.tools.execute({ calls:[{type:'tool-call',id,name,arguments}], signal, agent })` | v0.2 的 `peer_tool` 用它执行远端工具 | 返回形状未知，只按 `results[0]` 的 `isError` / `content` / `value` 宽松读取 | 读不到内容就退回 `value` 的 JSON |
| `ctx.workingDirectory.defaultDirectory` | 作为收件箱/共享目录的默认根 | 低 | 取不到退回 `$DSH_HOME/dsh-cross-agent/` |

## 刻意没用宿主的东西

- `ctx.approval`：它要求"当前有一个开着的 turn"，而跨端请求随时可能到达；而且会话策略是
  `never` 时它在 waterfall 之前就拒绝。审核队列因此是自己实现的（见 ADR 与 SPEC §5）。
- `ctx.storageDomain`：v0.1 先用 JSON 文件后端（`src/store.js`），接口保持一致，
  将来换后端只动一个文件。
- `ctx.actionCards`：卡片要绑在某个 tool call 上，而跨端待办没有调用方。
