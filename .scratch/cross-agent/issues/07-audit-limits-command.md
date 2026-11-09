# 07 · 审计、限流收口、人的命令

**阻塞**：08
**被阻塞**：03、04、05

## 目标

"上周谁让我干活了"能在 10 秒内答出来；超限动作一律被拒且留下痕迹。

## 交付

- `src/audit.js`：环形 1000 条（`store` 的 `audit` 表），`record({peer, kind, outcome, detail})`。
  五类：`admit` / `mode` / `review` / `instruction` / `transfer`，外加 `denied`。
- `src/limits.js` 全量接入：消息、文件、收件箱、`hello` 按源 IP。
- `src/commands.js`：`/cross-agent status|pending|approve <id>|reject <id>|admit <name>|mode <name> open|confirm|block <name>|rename <新名字>`。
- `README.md`：安装、端口、两台机器怎么连、怎么排错（防火墙、同网段、UDP 广播）。
- `AGENTS.md`：给后续 agent 的项目地图（模块 ↔ 职责 ↔ 票）。

## 验收

- 单测：环形表第 1001 条覆盖第 1 条；`denied` 也进审计。
- 单测：`/cross-agent mode b open` 在未二次确认时拒绝。
- 真机：`/cross-agent pending` 与面板显示一致。

## 不做

审计导出、按时间范围查询（只给最近 1000）。
