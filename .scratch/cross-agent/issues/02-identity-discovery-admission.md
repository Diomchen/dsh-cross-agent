# 02 · 身份、发现、连接表、放行协商

**阻塞**：03
**被阻塞**：01（只需 `store` 的兜底接口，可先用 JSON 文件实现，01 完成后替换）

## 目标

两台机器互相看见，人能放行，放行后两端握着同一把钥匙。

## 交付

- `src/identity.js`：首启生成 `deviceId`（UUID）与 X25519 密钥对，落 `identity`；`rename()`。
- `src/discovery.js`：UDP 45881 beacon/ack、地址表、源限速（照 `dsh-zoo` 的形态写，端口不同）。
- `src/protocol.js`：beacon 编解码、`hmacSign`/`hmacVerify`、nonce 窗口、全部上限常量。
- `src/peers.js`：状态机 `discovered|pending|admitted|rejected|blocked`、`mode: open|confirm`、
  `admit()`（ECDH + HKDF + 指纹）、`setMode()`、`block()`、`remove()`。
- `src/store.js` 的 JSON 兜底实现（`$DSH_HOME/dsh-cross-agent/*.json`，原子写）。
- `src/rpc.js` 的服务端骨架：`/hello`、`/hello-confirm`。

## 验收

- 单测：beacon 编解码往返；`deviceId` 非法/版本不符被丢；HMAC 正反用例；nonce 重放被拒。
- 单测：两个 `createPeer()` 实例用回环 socket 完成 hello → 人同意 → hello-confirm，两端指纹一致。
- 真机：本机起两个 `DSH_HOME`，两边 `state()` 互相出现，`online` 在对方关闭后 15 秒内变 false。

## 不做

消息投递、文件、UI、审计（只留 `audit.record()` 的调用点）。
