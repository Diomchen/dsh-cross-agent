# Windows 测试包说明（v0.2.6）

这个包已在 Windows 11 实机跑通（发现、放行、指令、文件、远端建会话）。任何一步不对就把
`%USERPROFILE%\.dsh\dsh-cross-agent\bootstrap.log` 和 `data\` 一起发回来。

## 1. 前置

- DSH Desktop（或 `dsh`）已经能正常启动，Node ≥ 22.12。
- 包：`dsh-cross-agent-0.2.6.tgz`。

## 2. 安装 / 升级

先把 tgz 放到固定位置 `%USERPROFILE%\.dsh\packages\`，再用**完整路径 + `file:` 前缀**装：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\packages" | Out-Null
Copy-Item C:\path\to\dsh-cross-agent-0.2.6.tgz "$env:USERPROFILE\.dsh\packages\"
dsh plugin --profile desktop add "file:$env:USERPROFILE\.dsh\packages\dsh-cross-agent-0.2.6.tgz"
```

装完**重启 DSH**（关进程再开）。验证版本：

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-cross-agent\package.json" |
  Select-String '"version"'
```

### 三个容易踩的坑

1. **没有 `dsh plugin install` 这个子命令**。`dsh plugin` 后面的参数是原样转给 pnpm 的，
   要装包就是 `add`；`--profile <名字>` 要放在 `add` **之前**。
2. **别在 agent 会话里装**。pnpm 的全局 store 在 `%LOCALAPPDATA%\pnpm\store\v11`，
   在跨端会话的 `workspace-write` 沙箱里写不进去，会报
   `EPERM mkdir ...\pnpm\store\v11`。用普通终端（先关掉 DSH）跑。
3. **别用 `pnpm install --force` 去换 store**。那会把这个 profile 的所有插件依赖重装一遍，
   中途失败宿主就起不来了。

### 回滚

旧包留在 `%USERPROFILE%\.dsh\packages\` 里，装回去就行，然后重启：

```powershell
dsh plugin --profile desktop add "file:$env:USERPROFILE\.dsh\packages\dsh-cross-agent-0.2.3.tgz"
```

### 开发用的临时安装（不推荐）

把 tgz 解到工作区内，直接覆盖 `node_modules\dsh-cross-agent`，可以绕过 pnpm 的 store 限制。
代价是 `package.json` 里的依赖仍指向旧版本，**下一次 `pnpm install` 会把它还原**。

## 3. 放行防火墙（Windows 一定会问）

首次启动时插件会监听 `UDP 45881` 和 `TCP 45883`。Defender 会弹窗：

- 必须勾选 **专用网络（Private）**；只勾公用网络的话，同网段的另一台机器连不上；
- 如果当时点了"取消"，去「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」里手动加回
  正在跑 DSH 的那个可执行文件；
- 企业/学校网络常常**禁掉 UDP 广播**：那样两台机器互相看不见，属于网络策略，不是插件 bug。

## 4. 验证装好了

```powershell
curl.exe -s http://127.0.0.1:<DSH端口>/cross-agent/state
```

`<DSH端口>` 是 DSH GUI 地址里的那个本地端口（例如 `http://127.0.0.1:60974`）。

期望：`{"ok":true,"state":{...}}`，里面有 `self` / `ports` / `peers` / `pending` / `audit`。

面板：侧栏应该多一个"两个方框相连"的图标，点开是「跨端 agent」；底部一条 `跨端 · 无待办`。

## 5. 两台机器跑通

1. 两台机器装同一个包，**同一网段**；
2. 各自打开面板，几秒内应该看到对方出现在「连接」里，状态 `已发现`；
3. 点「请求连接」→ 对方面板出现一条「连接请求」→ 点「放行」；
4. 两端显示的 **8 位指纹必须一致**；不一致就停下（有人动包），删掉双方的 `peers.json` 重来；
5. 默认 `confirm` 模式：让 A 的 agent 调 `peer_ask` 给 B 发一句话，B 的面板出现待审核，点「同意」后 A 拿到答复。

## 5.4 广播被 Wi-Fi 挡掉时（企业网的常见情况）

Windows 这边如果 `peers` 一直是空的，但对端的 `45883/tcp` 明明能连上，通常是**客户端隔离 / 广播过滤**
把 `255.255.255.255:45881` 丢了——单播通、广播不通。插件为此留了两条出口：

1. **手工探针**（当场排障）：
   ```
   /cross-agent probe 10.10.11.11
   ```
   向对端的**发现端口**（默认 45881，不是 45883）单播一条 beacon；对端会回 ack，
   几秒内就出现在「连接」里。

2. **静态对端**（长期维持心跳）：在 `%USERPROFILE%\.dsh\dsh-cross-agent\peers.json` 写
   ```json
   { "peers": ["10.10.11.11", "10.10.10.120:45881"] }
   ```
   插件每拍（5 秒）往这些地址单播探针。也可以改用配置项 `peerAddresses`，
   但配置文件只在宿主启动时读，`peers.json` 只要重载插件就生效。

## 5.45 收件箱和共享目录在哪（沙箱会管到它）

默认位置是**默认工作目录**下的 `.cross-agent\`：

```
%USERPROFILE%\.dsh\profiles\desktop\.cross-agent\inbox\<对端名字>\
%USERPROFILE%\.dsh\profiles\desktop\.cross-agent\share\
```

v0.2.2 及更早版本里 `workingDirectory` 服务没注入成功，会悄悄退到
`%USERPROFILE%\.dsh\dsh-cross-agent\.cross-agent\`——那个位置在跨端会话的工作区**之外**，
`workspace-write` 沙箱会拦住 agent 往里写（升级后旧文件不会自动搬，需要的话自己挪一下）。
想换地方就配 `inboxDir` / `shareDir`。

## 5.5 按目录设新会话的权限（v0.2.4+）

远端可以在你机器上建会话，但**能开到哪一档由你定**。在 profile 的 `cordis.patch.yml` 里给插件加配置：

```yaml
- id: dsh-cross-agent
  name: dsh-cross-agent
  config:
    sessionPermissionRules:
      - { path: 'C:\work\public', preset: workspace-write }
      - { path: 'C:\work\secret', preset: read-only }
    sessionPermissionDefault: workspace-write   # 没命中规则时
    allowRemotePermissionRaise: false           # 想让远端能提权才改 true
    allowRemoteSessions: true                   # 关掉就是 403
```

规则按**最长前缀**匹配；远端请求里带的 `permission` 只能比规则更紧，更松会被夹住并回 `clamped: true`。

## 5.6 时钟（没权限校时的机器）

Windows 默认开着"自动设置时间"，但域策略或虚拟机快照会把它关掉，偏差一两分钟很常见。
插件的签名带时间戳，校验窗口是 ±60 秒——但**窗口会平移到对端自己的钟**（按 beacon 里的 `ts`
和 HTTP `Date` 头估），所以差个一两分钟不影响通信。差到小时级就真的该校时了（`w32tm /resync /force`）。

## 6. 出问题时

日志：`%USERPROFILE%\.dsh\dsh-cross-agent\bootstrap.log`（插件自己的启动/注册告警）
数据：`%USERPROFILE%\.dsh\dsh-cross-agent\data\`（identity / peers / approvals / audit）

把这两样 + DSH 的日志一起发回来就行。

## 已知差异（相对 macOS 验证过的版本）

- `deviceId`、密钥交换、HMAC 都是平台无关的，但 **UDP 广播的 Socket 行为没在 Windows 上跑过**；
- 收件箱里对端名字做目录名时会收窄 Windows 非法字符（`< > : " | ? *`）、去掉结尾的点和空格、
  给 `CON`/`NUL`/`COM1` 这类保留名加前缀；
- 长路径（>260 字符）在没开 LongPathsEnabled 的机器上可能失败，收件箱默认在工作目录下，通常够用。
