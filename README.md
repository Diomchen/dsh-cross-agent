# dsh-cross-agent

[![CI](https://github.com/Diomchen/dsh-cross-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Diomchen/dsh-cross-agent/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.12-3c873a)](package.json)

让**同一局域网里两台机器上的 DSH** 互相看见、互相下达指令、互相传文件。

- 一份 DSH 实例养一个身份；只有**放行**过的对端才能说话。
- 一条连接一个**跨端会话**（标题 `跨端 · <对端名>`）：对方的指令落进它，你的 agent 的答复从它出去。
- 两种权限：`open`（对方的消息与文件直接生效）与 `confirm`（每条消息、每个文件都等你点头）。
- 文件双向传输，≤100 MiB，sha256 校验，收到回执才算送到；落到工作目录的 `.cross-agent/inbox/<对端名>/`。
- 跨端**具名工具调用**（v0.2）：只有对方在配置里点名开放（`exposedTools`）的工具能被调，默认一个都不开。
- 全部动作进审计（最近 1000 条）。

词表见 [CONTEXT.md](CONTEXT.md)，规格见 [.scratch/cross-agent/SPEC.md](.scratch/cross-agent/SPEC.md)，决策见 [docs/adr/](docs/adr/)。

## 安装

两种装法，选一个：

**装 Release 里的包**（CI 产出的 tgz，附 `SHA256SUMS.txt`）：到
[Releases](https://github.com/Diomchen/dsh-cross-agent/releases) 下最新的
`dsh-cross-agent-<version>.tgz`，或者：

```sh
gh release download -R Diomchen/dsh-cross-agent --pattern '*.tgz' --dir .
# 然后在 DSH 里（或任何有 plugin_manager 的地方）：
#   plugin_manager action=install_bundle target=/绝对路径/dsh-cross-agent-<version>.tgz
```

**或者从源码目录装**（改过代码、想立刻试）：

```sh
# 在 DSH 里（或任何有 plugin_manager 的地方）：
#   plugin_manager action=install_bundle target=/绝对路径/dsh-cross-agent
```

装完重启 DSH。确认宿主半侧起来了：

```sh
curl -s http://127.0.0.1:<DSH端口>/cross-agent/state | jq '.state.self'
```

> 这个端点只接受回环地址；浏览器面板走同源 `fetch`，不需要额外令牌。

## 两台机器怎么连（零配置）

1. 两台机器装同一个插件，确认**在同一网段**、防火墙放行 `45881/udp` 与 `45883/tcp`。
2. 打开任意一端的 Web UI，侧栏/主区进「跨端 agent」：几秒内对端会带着 `已发现` 出现。
3. 点「请求连接」→ 对方面板上出现一条**待审核**的「连接请求」→ 对方点「放行」。
4. 两端显示同一个**指纹**（8 个十六进制字符）。不一致就说明中间有人在动包，别继续。
5. 默认模式是 `confirm`。要让它不打扰人，在那一侧点「改开放」并二次确认。

注意：**放行是单向的**。A 放行 B = 允许 B 给 A 的 agent 下指令；要让 A 也能指挥 B，B 也要放行 A。
两边都放行之后，两端会各建一个 `跨端 · 对方名字` 的会话。

## 两台机器之外的场景

- **同一台机器上两份 DSH**（两个 profile / 两个 `DSH_HOME`）：UDP 广播在回环上不一定互相送到，
  插件额外走一条**本机注册表** `$DSH_HOME/dsh-cross-agent/instances/*.json`。
  两边共享同一个 `DSH_HOME` 时自动生效；完全独立的两个 `DSH_HOME` 需要手动指定
  `registryDir`（见下面的配置）。
- **公网 / NAT 穿透**：不做。需要的话看 DSH 官方的 liveshare。

## 配置

在 profile 的插件配置里（或 `cordis.yml` 的对应行）：

| 键 | 默认 | 说明 |
|---|---|---|
| `discoveryPort` | `45881` | UDP 发现端口；同网段所有机器要一致 |
| `port` | `45883` | RPC 与文件端口 |
| `displayName` | 主机名 | 本机在局域网里显示的名字 |
| `inboxDir` | `<工作目录>/.cross-agent/inbox` | 收到的文件落到哪 |
| `shareDir` | `<工作目录>/.cross-agent/share` | 允许对端拉取的共享目录 |
| `shareRoots` | `[]`（= 只有 `shareDir`） | 共享目录白名单，可以给多个根 |
| `exposedTools` | `[]` | 允许对端通过 `peer_tool` 调用的本机工具名；**默认空 = 一个都不开** |

环境变量：`DSH_CROSS_AGENT_HOME`（数据目录，默认 `$DSH_HOME/dsh-cross-agent`）、
`DSH_CROSS_AGENT_DISCOVERY_PORT`、`DSH_CROSS_AGENT_PORT`。

数据目录：

```
$DSH_HOME/dsh-cross-agent/
  data/identity.json     deviceId、显示名、X25519 密钥对
  data/peers.json        连接表（状态、模式、共享密钥、指纹）
  data/approvals.json    待审核队列
  data/grants.json       "记住 24h" 的授权
  data/transfers.json    最近 500 次传输
  data/results.json      最近 200 条指令结果（按 correlationId 复查）
  data/audit.json        最近 1000 条审计（环形）
  instances/<deviceId>.json   同一台机器上的实例注册表
```

## 给 agent 的六个工具

| 工具 | 做什么 |
|---|---|
| `peer_list` | 谁在线、是否已放行、什么模式 |
| `peer_ask` | 给对方 agent 下一条指令，等它答复（默认 120 秒，上限 600 秒）；带 `session_id` 可投到对方为你建的会话 |
| `peer_file_send` | 推一个文件过去（≤100 MiB） |
| `peer_file_fetch` | 从对方共享目录拉一个文件（只读，不能越界） |
| `peer_tools` | 对方对外开放了哪些工具 |
| `peer_tool` | 调用对方**白名单里**的一个工具（confirm 模式下每次都要对方点头） |
| `peer_session_create` | 让对方在它某个目录下新建一条会话——目录即项目分组（已有目录复用，新目录当场注册） |

`peer_session_create` 的权限有个硬边界：**远端可以往紧里调，不能自己往松里调**。
新会话能开到哪一档，由接收方配置里的"按目录上限"决定，超出就夹住并在结果里标 `clamped: true`。

```yaml
# 接收方：按目录给新会话定权限上限（最长前缀匹配）
sessionPermissionRules:
  - { path: /Users/you/work/public, preset: workspace-write }
  - { path: /Users/you/work/secret, preset: read-only }
sessionPermissionDefault: workspace-write   # 没命中规则时
allowRemotePermissionRaise: false           # 显式允许远端提权（默认关）
allowRemoteSessions: true                   # 允许远端建会话（默认开；关掉就是 403）
```

`peer_ask` 的延迟是**对方一次 agent turn**，不是 RPC。对方 `confirm` 模式下它的人可能拒绝或超时；
超时返回 `ok:false` + `correlationId`，之后可以带 `correlation_id` 再查一次。

## 人的命令

```
/cross-agent status
/cross-agent pending
/cross-agent approve <id>          # 同意一条待办
/cross-agent reject <id>
/cross-agent connect <名字>
/cross-agent allow <名字>          # 放行（= 允许对方指挥本机 agent）
/cross-agent mode <名字> open --yes
/cross-agent mode <名字> confirm
/cross-agent block <名字>
/cross-agent rename <新名字>
```

## 跨端工具：先想清楚再开

`exposedTools` 是"工具名"级别的白名单，**不区分参数**。开放一个 `read_file`，就等于让对方能读那个工具能到的所有路径。
所以：

- 默认是空的，不是"没配置"；想用先在这里点名；
- 别开 `bash` / `write` 这类"能改变本机状态"的工具，除非你确实想让对方改你的机器；
- 对方试探白名单外的名字会被 `403` 并记进审计（`denied`）；
- 名字先用 `peer_tools` 查，不要猜。

```json
{ "exposedTools": ["read_file"], "shareRoots": [".cross-agent/share", "docs"] }
```

## 排错

| 症状 | 先看什么 |
|---|---|
| 对端一直不出现 | 同一网段？`45881/udp` 放通了？macOS 首次监听会问"允许传入连接"，Windows 要给**专用网络**放行 |
| 看得见端口、就是发现不到 | 企业 Wi-Fi 常丢广播（客户端隔离）。用 `/cross-agent probe <对端IP>` 单播唤醒，或把静态对端写进 `~/.dsh/dsh-cross-agent/peers.json` |
| 看得见但连不上 | `45883/tcp` 被挡；或对方从没点过「放行」 |
| 一直 `clock-skew` | 两台机器的时钟差超过 60 秒。插件会按对端 beacon 的钟自动对齐（窗口宽度不变），但差到小时级就要真的校时了：Windows 设置里「立即同步」|
| 指令一直 `awaiting-review` | 对方是 `confirm` 模式，需要它的人点同意；5 分钟没人管就返回 pending |
| 指纹两端不一致 | 有人在中间动包，或一端删过 `identity.json`。删掉两边的 `peers.json` 重新放行 |
| 文件传一半失败 | 收件箱满了（1 GiB / 500 件）或超过单件 100 MiB；错误里会带原因 |
| 插件装完 DSH 起不来 | 端口被别的程序占了。换 `port` / `discoveryPort`，日志里会有一行 `[dsh-cross-agent]` 警告 |

## 开发

```sh
node --test test/*.test.js    # 59 个单测
node scripts/e2e.mjs          # 单进程双实例端到端（真实 HTTP/HMAC + 文件落盘）
node scripts/smoke.mjs        # 单机验收：以已放行对端的身份，给本机插件发真实签名请求
node scripts/smoke.mjs --security   # 再加一条：白名单外的工具名必须被拒
node scripts/smoke.mjs --full       # 再建会话 + 定向投递（会花一次 agent turn）
```

装完/升级完，`smoke.mjs` 是"这台机器还好不好使"的最短答案；它不需要第二台机器。

## 发版

本地打一个试装包：

```sh
npm run verify:pack   # 打包内容自检：必需文件齐全，测试/脚本没混进去
npm pack              # → dsh-cross-agent-<version>.tgz
```

正式发版走 CI（`.github/workflows/ci.yml`）：改 `package.json` 的 `version`、提交、打 tag。

```sh
git tag v0.2.7 && git push origin main --tags
```

流水线会先跑 4 组矩阵测试（ubuntu node 22/24、macos 22、windows 22；ubuntu 上再跑一次双实例端到端），
然后真实 `npm pack`，把 `dsh-cross-agent-0.2.7.tgz` 与 `SHA256SUMS.txt` 挂到 `v0.2.7` 的 Release。
tag 和 `package.json` 版本对不上会直接失败。

升级前先确认三件事：

1. **两端版本要一起走**：协议常量、`inject` 列表、宿主接口形状任一处变了，另一头必须同级或更新；
2. Windows 的安装/回滚步骤见 [WINDOWS.md](WINDOWS.md) §2（`dsh plugin --profile desktop add file:...`，
   不是在 agent 会话里跑）；
3. 发完在真机各跑一遍：`peer_tools`（验签名与时钟）、`peer_ask`（验会话桥）、
   `peer_session_create`（验建会话与权限夹取）。

## 边界（不做）

公网中继与 NAT 穿透、远端 shell（ADR-0001：指令只投给对方的 agent，由它自己决定怎么做）、
广播给多个对端、目录同步、断点续传、系统级桌面通知、传输加密（只有 HMAC 完整性 + 防重放）。

跨端工具调用在 v0.2 加入，但受 ADR-0004 的白名单约束。

## 许可证

MIT
