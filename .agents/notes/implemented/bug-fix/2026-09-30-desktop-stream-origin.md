# Agent Note: 面板 socket 连的是 Host 的 origin，不是文档的

Status: implemented

## Problem

Desktop 的窗口不是被 Host 服务的页面，而是一份 `dsh-app://app` 文档：`apps/desktop/src/main.ts` 的 `protocol.handle` 只发 shell 自己的文档与前端静态资源，其余路径一律 `forwardWebRequest(request, hostUrl, hostCookie)` 转发给 Host。旧的面板 socket 照 Web 的写法拼 `ws://${location.host}/dsh-browser/stream`，在 Desktop 里 `location.host` 是 `app`，于是它去连 `ws://app/…`——那个地址上没有任何东西会回答，画面永远是空的。同一面板的 HTTP 请求（`/dsh-browser/status`、`/dsh-browser/pages`）走的是相对路径、由 scheme handler 带着 cookie 转发，是好的；所以症状长得像"连不上"，实际只有 socket 这一条错了。

## Decision

客户端把 Host 的 origin 从 shell 发布的传输描述里读出来，`src/client/stream-url.ts` 一处实现（`globalThis.__DSH_TRANSPORT__.streamBaseUrl`，没有这个描述就退回 `location.origin`），面板只负责拿它拼地址。这不是给 Desktop 打的补丁，而是用 harness 已有的那条缝：Gateway 的 mux socket 就是这么算地址的（`packages/api/gateway/src/client/stream-client.ts` 的 `remoteStreamUrl()`，`__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI`），`packages/client/connection/README.md` 把它写成契约——静态桌面页可以给出自己所拥有 Host 的 HTTP origin，Gateway 用它开 WebSocket，而 HTTP 传输另选。Desktop 那一侧配合得很明确：`session.defaultSession.webRequest.onBeforeSendHeaders({urls:['ws://127.0.0.1/*']})` 只接受来自 `dsh-app://app` 窗口、且 host 与 Host 相同的握手，替它补上 Host 的认证 cookie 并把 `origin` 改写成 Host origin。地址对了，鉴权与信任检查就都自动成立。

HTTP 不跟着改：相对路径在 Desktop 被 scheme handler 转发时已带 cookie，而绝对跨源调用会撞上 Host 的信任围栏。

## Alternatives considered

**继续用 `location.host`，只在 Desktop 下特判**：要从 `location` 认出 Electron 窗口并找出 Host 端口，只能靠 `__DSH_TRANSPORT__`——那就是同一个来源，特判没有多出任何信息。**把画面改走 SSE 或长轮询**：镜像是双向的（面板还要把按键与指针发上去），换掉这条通道等于重做输入那一半，而且 JPEG 帧流走文本通道要重新编码。**让 host 侧放宽握手**：Desktop 已经在 `onBeforeSendHeaders` 里按 `ws://127.0.0.1/*` 补 cookie，服务端放宽反而要另做一套鉴权。

## Consequences

- `test/stream-url.test.ts` 三条钉住地址：页面自己的 origin、`dsh-app://app` 文档加已发布的 transport（结果里不许出现 `//app/`）、https 走 `wss`。
- Web 行为不变：那里的 `streamBaseUrl` 就是页面自己的 origin，两条路径同值。
- 真机已确认（2026-09-30，Windows Desktop，用户实测）：客户端半边更新后面板出帧、输入生效。Electron 的 ws 握手补头在本仓库的单测里覆盖不到，只能由用 Desktop 的那台机器验证。
