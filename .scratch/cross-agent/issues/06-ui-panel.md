# 06 · Web UI 面板与状态条

**阻塞**：08
**被阻塞**：01、02、04

## 目标

人在 DSH 的 Web GUI 里看得见连接、审得了待办、查得到传输与审计。

## 交付

- `client.js`：`main` 槽位（key `cross-agent`）注册面板；`shell.bottom` 注册状态条。
- 面板四区：连接（名字/mode/在线点/指纹/改模式/封禁/删除）、待审核（同意 / 拒绝 / 记住 24h，
  且写明"同意后对方 agent 会在「跨端 · X」会话里开始执行"）、传输（最近 50 条）、审计（最近 100 条）。
- `locale/zh.json` + `locale/en.json`，`icon.svg`，`package.json` 的 `dsh.client` 与 `exports`。
- Client ↔ Host：`GET /cross-agent/state`、`POST /cross-agent/action`（同源 fetch，带上 CSRF 无关的本地判定）。

## 验收

- 装进 profile，刷新页面，侧栏/主区能打开面板；状态条显示"跨端 · N 待确认"。
- 点"同意"后，Host 侧 `approvals.approve` 被调用（审计里能看到），UI 在 2 秒内反映。
- 空状态、离线对端、超长名字（>32 字截断）都不破版。

## 不做

系统通知、深色模式特调（用主题 token）、移动端专门适配。
