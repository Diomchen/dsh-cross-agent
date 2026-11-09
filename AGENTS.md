# AGENTS.md

给后续 agent 的项目地图。先读 [CONTEXT.md](CONTEXT.md)（词）与
[.scratch/cross-agent/SPEC.md](.scratch/cross-agent/SPEC.md)（行为），再动代码。

## 这是什么

一个 DSH Host 插件（零运行时依赖，Node 内建）：局域网里两台机器的 DSH 互相发现、放行、
投递指令、传文件。宿主半侧 + Web UI 半侧。

## 模块 ↔ 职责

| 文件 | 职责 | 别放什么 |
|---|---|---|
| `index.js` | 入口：`apply`、`Config`、`inject`、把所有东西接起来 | 业务逻辑 |
| `src/service.js` | 组合根：`state()` / `act()` / `ask` / `sendFile` / `fetchFile` / 路由表 | IO 细节 |
| `src/protocol.js` | 常量、beacon 编解码、HMAC 签名、nonce 窗口、X25519+HKDF | 任何 IO |
| `src/identity.js` | deviceId、显示名、长期密钥 | 认识对端 |
| `src/discovery.js` | UDP beacon/ack、地址表、本机实例注册表 | 不写连接状态 |
| `src/peers.js` | 连接状态机、模式、放行、密钥派生 | 不碰会话与文件 |
| `src/rpc.js` | 45883 的 HTTP 服务端 + 客户端（签名在这里） | 不做业务判断 |
| `src/session.js` | 跨端会话：建会话、投递、抓答复、串行化 | 唯一依赖 DSH 内部接口的地方 |
| `src/approvals.js` | 待审核队列、TTL、记住 24h | 不执行动作 |
| `src/files.js` | 两阶段传输、sha256、收件箱、共享目录 | 不认识 agent |
| `src/limits.js` | 滑动窗口限流 | 不写审计 |
| `src/audit.js` | 1000 条环形审计 | 不做展示 |
| `src/store.js` | JSON 文件后端（原子写、0700） | 不定义表结构 |
| `src/tools.js` | 4 个工具定义 | 不含逻辑 |
| `src/commands.js` | `/cross-agent` | 不含逻辑 |
| `src/http-local.js` | `/cross-agent/state`、`/cross-agent/action` | 不含逻辑 |
| `client.js` | 面板 + 底部状态条 | 不复制业务逻辑 |

## 三条不变量

1. **放行是一条连接的根**：未放行的对端发来的任何东西都不许落进会话或收件箱。
2. **消息即命令**（ADR-0001）：不提供远端 shell；要"让对方做事"就只能投递文字。
3. **审核只在 `confirm` 模式**：`open` 直通，`confirm` 入队等人；`review()` 是唯一闸口。

## 改动的落点

- 改协议：`src/protocol.js` 的常量与 `SPEC §4`；两边版本必须一起改。
- 改权限语义：`src/service.js` 的 `review()` + `src/approvals.js`；同时改 SPEC §5。
- 改限额：`src/limits.js` + SPEC §7；不要在别处硬编码数字。
- 加工具：`src/tools.js`（描述要写明"延迟=对方一次 agent turn"与"可能被拒绝"）。

## 测试

```sh
node --test test/*.test.js   # 单测：协议、存储、限流、审核、连接、文件、会话桥
node scripts/e2e.mjs         # 双实例端到端（真实 HTTP + HMAC + 落盘 + 审核）
```

没有 DSH 宿主也能跑：`src/session.js` 在测试里用假 `ctx`（见 `test/session.test.js`）。

## 已知的宿主耦合

`src/session.js` 里 `sessionController.prompt` 的字段与 `session/event` 的事件名来自
目录契约，**尚未在真机上逐字段验证**（票 01）。真机跑不通时先看
[docs/harness-notes.md](docs/harness-notes.md) 里的"待验清单"。
