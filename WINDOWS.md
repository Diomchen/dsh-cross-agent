# Windows 测试包说明（v0.2.1）

这个包是**未在 Windows 实机验证过**的测试包。请按下面顺序走，任何一步不对就把日志发回来。

## 1. 前置

- DSH Desktop（或 `dsh`）已经能正常启动，Node ≥ 22.12。
- 包：`dsh-cross-agent-0.2.1.tgz`。

## 2. 安装（二选一）

**A. 解包后按目录安装（推荐，路径最不容易出问题）**

```powershell
mkdir C:\temp\dsh-cross-agent
tar -xzf dsh-cross-agent-0.2.1.tgz -C C:\temp\dsh-cross-agent --strip-components=1
```

然后在 DSH 里（或任何能调 `plugin_manager` 的地方）：

```
plugin_manager  action=install_bundle  target=C:\temp\dsh-cross-agent
```

**B. 直接装 tgz**

```powershell
dsh plugin install C:\path\to\dsh-cross-agent-0.2.1.tgz
```

两种方式都会在 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules` 里装一份。
装完**重启 DSH**。

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

## 6. 出问题时

日志：`%USERPROFILE%\.dsh\dsh-cross-agent\bootstrap.log`（插件自己的启动/注册告警）
数据：`%USERPROFILE%\.dsh\dsh-cross-agent\data\`（identity / peers / approvals / audit）

把这两样 + DSH 的日志一起发回来就行。

## 已知差异（相对 macOS 验证过的版本）

- `deviceId`、密钥交换、HMAC 都是平台无关的，但 **UDP 广播的 Socket 行为没在 Windows 上跑过**；
- 收件箱里对端名字做目录名时会收窄 Windows 非法字符（`< > : " | ? *`）、去掉结尾的点和空格、
  给 `CON`/`NUL`/`COM1` 这类保留名加前缀；
- 长路径（>260 字符）在没开 LongPathsEnabled 的机器上可能失败，收件箱默认在工作目录下，通常够用。
