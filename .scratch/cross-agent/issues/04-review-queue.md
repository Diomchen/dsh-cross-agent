# 04 · 审核队列（confirm 模式）

**阻塞**：06、07、08
**被阻塞**：03

## 目标

`confirm` 模式下，入站指令不生效，先进入待审核；人同意才投递，拒绝或超时则明确告诉发起方。

## 交付

- `src/approvals.js`：`enqueue({kind, peerId, summary, payload})`、`list()`、`approve(id, {remember})`、
  `reject(id)`、`expire()`（24h）、`grantFor(peerId, kind)`（24h TTL）。
- `POST /ca/v1/ask` 在 `confirm` 下：入队 → 最多等 5 分钟 → `approve` 后再投递 → 答复通过
  `results` 表回给发起方；超时回 `{ok:false, reason:"awaiting-review", correlationId}`。
- `peer_ask` 支持 `correlation_id` 轮询复查。
- 审核动作全部进审计（`review/approved|rejected|expired`）。

## 验收

- 单测：TTL 过期清理；"记住 24h"只作用于 `peerId+kind`；过期后的 approve 返回明确错误。
- 单测：`confirm` 下未审核时 `/ask` 在 5 分钟内返回 `awaiting-review`，且**没有**创建任何 agent turn。
- 真机：B 的面板出现待办 → 同意 → A 的 `peer_ask` 拿到答复；拒绝 → A 收到 `rejected-by-peer`。

## 不做

面板渲染（票 06）、文件的审核（票 05 复用同一个队列）。
