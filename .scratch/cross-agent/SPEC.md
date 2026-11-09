# SPEC · dsh-cross-agent v0.1

> 词表见 [`CONTEXT.md`](../../CONTEXT.md)。决策见 [`docs/adr/`](../../docs/adr/)。
> 票：`issues/01..08`。**只实现本文件写下的东西**；想加，先改这里。

## 1. 目标

两台机器（同一局域网）上的两份 DSH 实例，装同一个插件之后：

1. 自动互相看见（零配置，不填 IP）；
2. 本机的人**放行**某个对端，并选 `open` 或 `confirm`；
3. 一条连接对应一个**跨端会话**，agent 之间以**指令消息**互相下达任务；
4. 双向**传输**文件（≤100 MiB、sha256、回执、收件箱落盘）；
5. `confirm` 模式下，入站指令与文件都要本机的人**审核**，可"记住 24h"；
6. 全部动作进**审计**；超限的动作被限流拒绝，且拒绝也被记下。

## 2. 非目标

不做：公网中继 / NAT 穿透 / 远端 shell（ADR-0001）/ 广播给多个对端 / 目录同步 /
断点续传 / 系统级桌面通知 / Linux 桌面层特判 / 加密传输（只做 HMAC 完整性 + 防重放）/ 多用户与团队权限。

**v0.2 起**加入跨端具名工具调用，但只有"本机白名单点名过的工具"能被调（ADR-0004）。

## 3. 架构

```
                    UDP 45881 (beacon / ack, JSON ≤512B)
   ┌────────────┐  ──────────────────────────────────────  ┌────────────┐
   │  Home A    │                                          │  Home B    │
   │            │  HTTP 45883 (HMAC 签名, JSON / 流)        │            │
   │ identity   │  ──────────────────────────────────────  │ identity   │
   │ discovery  │   /ca/v1/hello  /hello-confirm  /ask      │ discovery  │
   │ peers      │   /file(POST)   /file?id=(GET)            │ peers      │
   │ approvals  │                                          │ approvals  │
   │ session    │  ── DSH 内部 ──                          │ session    │
   │  ↕ sessionController.prompt / session/event            │            │
   │ audit      │                                          │ audit      │
   └────────────┘                                          └────────────┘
        ↑ 本地 HTTP: DSH webServer 上的 /cross-agent/state , /cross-agent/action
        ↑ Web UI: main 面板 + shell.bottom 状态条
```

### 模块（`src/`）

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `identity.js` | `deviceId`、显示名、X25519 长期密钥，持久化 | 不认识对端 |
| `discovery.js` | UDP beacon 收发、地址表、心跳 | 不写状态、不认证 |
| `peers.js` | 连接表、状态机、权限模式、共享密钥 | 不碰文件与会话 |
| `protocol.js` | 报文编解码、HMAC 签名/校验、nonce 窗口、上限常量 | 不做 IO |
| `rpc.js` | 45883 上的 HTTP 服务端 + 出站客户端 | 不做业务判断 |
| `session.js` | 跨端会话的查找/创建、投递指令、抓答复 | 不做审核 |
| `approvals.js` | 待审核队列、24h 过期、"记住 24h"授权 | 不执行动作 |
| `files.js` | 传输、sha256、收件箱、回执、限额 | 不认识 agent |
| `limits.js` | 按对端/按来源的滑动窗口限流 | 不存审计 |
| `audit.js` | 1000 条环形审计 | 不做展示 |
| `store.js` | storageDomain 优先、JSON 文件兜底 | 不定义表结构以外的东西 |
| `tools.js` | 4 个 agent 工具 | 不含业务逻辑 |
| `commands.js` | `/cross-agent` 人的入口 | 不含业务逻辑 |
| `http-local.js` | `/cross-agent/state` 与 `/cross-agent/action` | 不含业务逻辑 |
| `service.js` | 把上面接起来，暴露 `state()` / `act()` | 不做 IO 细节 |

### 端口

| 用途 | 端口 | 可配 |
|---|---|---|
| 发现 UDP | `45881` | `DSH_CROSS_AGENT_DISCOVERY_PORT` |
| RPC + 文件 TCP | `45883` | `DSH_CROSS_AGENT_PORT` |
| 数据目录 | `$DSH_HOME/dsh-cross-agent/` | `DSH_CROSS_AGENT_HOME`（测试用） |

## 4. 线协议 v1

### 4.1 发现（UDP，JSON，UTF-8，≤512 字节）

```json
{ "v": 1, "t": "beacon", "deviceId": "<uuid>", "name": "<显示名>", "port": 45883, "ts": 1730000000000 }
{ "v": 1, "t": "ack",    "deviceId": "<uuid>", "name": "<显示名>", "port": 45883, "ts": 1730000000000 }
```

- 每 5 秒向 `255.255.255.255:45881` 广播一次 `beacon`；绑定 `0.0.0.0:45881`，`reuseAddr: true`。
- 收到 `beacon` 时单播一条 `ack` 回源地址，按源 IP 限速 1 条 / 4.5 秒。
- 每源入站限速 20 条 / 10 秒；非法包也计数。
- 丢弃：`v !== 1`、`deviceId` 不是 UUID、`deviceId === 自己`、超过 512 字节。
- 地址只留在发现层（`addressOf(deviceId)`），**绝不进面板快照**。

### 4.2 RPC（HTTP/1.1，端口 45883）

请求头（除 `/hello` 外全部必带）：

| 头 | 值 |
|---|---|
| `x-ca-device` | 发送方 `deviceId` |
| `x-ca-ts` | 毫秒时间戳 |
| `x-ca-nonce` | 16 字节随机数的 hex |
| `x-ca-sig` | `hex(HMAC-SHA256(key, method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + sha256hex(body)))` |

校验顺序：连接表里有这条连接 → 时间窗 ±60s → nonce 未用过（内存 4096 条 LRU）→ 签名。
任一失败 → `401 {"ok":false,"reason":"..."}`，并记一条审计（`denied`）。

### 4.3 端点

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| POST | `/ca/v1/hello` | 无（按源 IP 限 5 次/分） | 发起放行请求：`{v,deviceId,name,pub,nonce}` |
| POST | `/ca/v1/hello-confirm` | 派生密钥 | 放行方回执：`{v,deviceId,name,pub,nonce}`，带签名 |
| POST | `/ca/v1/ask` | 是 | `{id,text,sessionId?}` → `{ok,id,sessionId,reply}` 或 `{ok:false,reason:"pending",correlationId}` |
| POST | `/ca/v1/file/begin` | 是 | 第一阶段：`{name,size,sha256,transferId,note,waitMs}` → 审核在这里做完，批准后发一个 5 分钟有效的 token |
| POST | `/ca/v1/file` | 是 | 第二阶段：头 `x-ca-name`/`x-ca-size`/`x-ca-sha256`/`x-ca-transfer`，体为原始字节 → 回执；token 不在批准表里就 403 |
| GET | `/ca/v1/file?path=<相对路径>` | 是 | 从本机**共享目录**（可多个根）流式下载；落在任何根之外的路径 404 |
| GET | `/ca/v1/tools` | 是 | 列出本机对外开放（`exposedTools`）的工具名 |
| POST | `/ca/v1/tool` | 是 | `{tool,args,waitMs}` → 在白名单里才执行，返回 `{ok,text,reason}` |

### 4.4 密钥协商（TOFU）

1. A 在发现里看到 B，点"放行 B"→ A 调 `POST http://B/ca/v1/hello`，体里带 A 的 X25519 公钥与随机 `nonce`。
   B 若未放行 A，则落一条 `hello` 审核项（**放行永远是人的动作**），并回 `{ok:true,state:"pending"}`。
2. B 的人点同意 → B 用自己的私钥与 A 的公钥做 ECDH，`HKDF-SHA256(shared, salt=sha256(排序后的两个 deviceId), info="dsh-cross-agent/v1")` → 32 字节共享密钥。
3. B 调 `POST http://A/ca/v1/hello-confirm`，带 B 的公钥与 `nonce`，**用刚派生的密钥签名**。
   A 做同样的派生并验签：验过 = 双方确实握着同一把钥匙（channel binding）。A 落库为 `admitted`。
4. 两者的**指纹** = `sha256(key)` 前 8 个 hex 字符，面板上显示，供人肉核对。

## 5. 状态机

```
discovered ──(人点放行, 完成协商)──> admitted(confirm|open)
      │                                   │
      └──(人点拒绝)──> rejected            └──(人改模式/删除)──> admitted / 移除
             （blocked 由 admitted 或 pending 直接进入，不再接受 hello）
```

- `pending`：收到了 `hello` 但人还没表态。
- `admitted`：连接生效，按 `mode` 过滤入站。
- `rejected` / `blocked`：`hello` 一律 403，指令与文件一律 401/403。

| 入站事件 | `open` | `confirm` |
|---|---|---|
| `hello`（首次） | 审核 | 审核 |
| `ask` | 直接投递 | 审核，5 分钟内未被审 → 回 `pending` |
| `file` | 直接落盘 | 审核，5 分钟内未被审 → 不落盘 |

## 6. 存储（`store.js`，storageDomain 优先，JSON 兜底）

| 表 | 键 | 内容 | 上限 |
|---|---|---|---|
| `identity` | `self` | deviceId/name/priv/pub/fingerprint | 1 |
| `peers` | deviceId | name/state/mode/key/fingerprint/时间戳/地址（内存） | 64 |
| `approvals` | id | kind/peerId/摘要/原文/createdAt/expiresAt/status | 200 |
| `grants` | `peerId:kind` | expiresAt | 200 |
| `transfers` | id | peer/direction/name/size/sha256/status/at | 500 |
| `results` | correlationId | peer/status/reply/at | 200 |
| `audit` | seq | at/peer/kind/outcome/detail | 1000（环形） |

## 7. 限额

| 项 | 值 |
|---|---|
| 指令消息大小 | ≤ 8 KiB |
| 指令频率 | ≤ 20 条/小时/对端，≤ 200 条/天/对端 |
| 单文件 | ≤ 100 MiB |
| 收件箱 | ≤ 1 GiB 且 ≤ 500 件 |
| 文件频率 | ≤ 20 件/小时/对端 |
| 跨端工具频率 | ≤ 30 次/小时/对端 |
| 待审核 TTL | 24 小时（过期作废） |
| 审核响应窗口 | `min(5 分钟, 发起方愿意等的时间 - 1.5 秒)` |
| "记住"授权 | 24 小时 |
| `peer_ask` 等待 | 默认 120 秒，上限 600 秒 |

## 8. 工具（agent 侧）

| 工具 | 参数 | 返回 |
|---|---|---|
| `peer_list` | — | `{peers:[{name,state,mode,online,fingerprint,lastSeenAt}]}` |
| `peer_ask` | `peer`, `text`, `wait_ms?`, `session_id?` | `{ok, reply?, sessionId?, correlationId?, reason?}` |
| `peer_file_send` | `peer`, `path`, `note?` | `{ok, transferId, bytes, sha256, receipt?}` |
| `peer_file_fetch` | `peer`, `path`, `dest?` | `{ok, path, bytes, sha256}` |
| `peer_tools` | `peer` | `{ok, tools:[名字]}` |
| `peer_tool` | `peer`, `tool`, `arguments?`, `wait_ms?` | `{ok, text, reason?}` |

工具描述必须写明：跨端延迟 = 对方一次 agent turn；`confirm` 模式下可能被对方的人拒绝或超时。

人的入口：`/cross-agent status|pending|approve|reject|admit|mode|block|rename`。

## 9. UI

- `main` 槽位，key `cross-agent`：四个分区——连接 / 待审核 / 传输 / 审计。
- `shell.bottom`：`跨端 · N 待确认`（N=0 时显示"跨端 · 无待办"），点击切到面板。
- 文案中文为主，`locale/en.json` 给英文。图标 `icon.svg`。
- 审核卡片必须写明：同意一条指令 = 对方 agent 会在「跨端 · X」会话里开始执行，消耗本机额度。

## 9.5 跨端工具（v0.2）

- 接收方配置 `exposedTools: []`，**默认空**；只有点名过的工具能被 `/ca/v1/tool` 调用。
- 名字不在名单里 → `403 tool-not-exposed`，并记一条 `denied` 审计。
- 调用在接收方的**跨端会话**里、用接收方 agent 的权限执行（`ctx.tools.execute`）。
- `confirm` 模式下每次调用都要人点头（与指令、文件共用同一个审核队列）。
- 调用方先用 `peer_tools` 查名字，不能猜。

## 10. 验收

1. 两台同网段机器（或同机两个 `DSH_HOME`）互相在 10 秒内出现在对方的"待放行"里。
2. 放行后指纹两端一致；`open` 模式下 `peer_ask` 直接拿到答复。
3. `confirm` 模式下 `peer_ask` 挂起 → 面板出现待审核 → 同意 → 发起方拿到答复；忽略 5 分钟 → 发起方得到 `pending`。
4. 100 MiB 以内文件双向传输，sha256 一致，收件箱路径正确，同名不覆盖。
5. 关掉对端 → `peer_list` 显示 offline；`peer_ask` 快速失败而不是卡 120 秒。
6. 未放行的对端发 `ask`/`file` → 401，审计有 `denied`。
7. 审计里能看到放行、改模式、审核、指令、传输五类事实。
8. 插件损坏（端口占用 / 存储打不开）时 DSH 正常启动，只打一行警告。
