# 03 · 指令通道（open 模式）

**阻塞**：04、05、07、08
**被阻塞**：01、02

## 目标

A 的 agent 调 `peer_ask` → B 的跨端会话里出现一条指令 → B 的 agent 做完 → A 拿到答复文本。

## 交付

- `src/session.js`：`ensurePeerSession(peer)`（按标题 `跨端 · <显示名>` 找，找不到就建）、
  `deliver(peerSessionId, text)`、`collectReply(sessionId, sinceMs, timeoutMs)`。
- `src/rpc.js`：`POST /ca/v1/ask`（服务端）+ 出站 `call(peer, '/ca/v1/ask', body)`。
- `src/tools.js`：`peer_list`、`peer_ask`。
- `src/limits.js`：消息 8 KiB、20/时、200/天。

## 验收

- 单测：`peer_ask` 参数校验（peer 不存在、text 超长、未放行）→ 明确的错误文本。
- 单测：限流第 21 条被拒，错误里带 `retryAfterMs`。
- 真机（open 模式）：A 问"你机器上 node 版本？"→ B 的 agent 在跨端会话里被唤起 → A 的工具返回 B 的答复。
- 真机：B 关机后 `peer_ask` 在 3 秒内失败（`offline`），不是卡满 120 秒。

## 不做

审核、文件、面板。
