# 05 · 文件传输

**阻塞**：07、08
**被阻塞**：02、03

## 目标

双向传文件：≤100 MiB、sha256 校验、收件箱落盘、收到回执才算送到。`confirm` 模式下先审后落盘。

## 交付

- `src/files.js`：`send(peer, absPath, note)`、`fetch(peer, remotePath, destDir?)`、
  `acceptInbound(stream, meta)`、`inboxDir(peerName)`、sha256 流式计算、同名加序号。
- `POST /ca/v1/file`（流式接收）、`GET /ca/v1/file?id=`（流式发送）。
- 收件箱：`<工作目录>/.cross-agent/inbox/<对端名>/`；工作目录取 `ctx.workingDirectory`，
  取不到退回 `$DSH_HOME/dsh-cross-agent/inbox/`。
- 限额：单件 100 MiB、收件箱 1 GiB / 500 件、20 件/小时/对端。
- 落盘后在本机跨端会话里投一条通知："收到 X 的文件 A（路径 …）"。

## 验收

- 单测：sha256 与 Node 的 `crypto.createHash` 对同一个随机 buffer 一致；1 KiB / 8 MiB 往返。
- 单测：同名第二次落盘变成 `a(1).txt`；超过 100 MiB 在**读之前**就被拒（看 `x-ca-size`）。
- 单测：断流（发送方提前断开）→ 半截文件被删掉，没有回执。
- 真机：100 MiB 文件双向传输，sha256 两端一致。

## 不做

断点续传、多线程、目录打包（目录要调用方自己 tar）。
