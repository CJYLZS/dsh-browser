# Agent Note: 外部插件骨架与 screencast 镜像

Status: implemented

## Problem

agent 要用上本机的真实浏览器，用户还要能看见它在做什么。harness 仓库不收外部插件，而真实 Chrome 窗口不是文档，无法用 iframe 嵌入。

## Decision

`lib/dsh-browser` 是一个自成仓库的外部插件（tsdown 双构建：host ESM + client CJS factory，自带的 `dsh.bundle.patch` / `dsh.client.inject`），用 playwright-core 驱动本机 Chrome/Edge。画面走 CDP `Page.startScreencast` 出 JPEG 帧 → WebSocket → 侧栏 canvas，用户的鼠标与键盘按归一化坐标回传 `Input.dispatch*`；浏览器自己暴露一个 CDP 端口，DevTools 或 Playwright `connectOverCDP` 可以附加。

## 目标

在 `lib/dsh-browser` 建一个**外部 dsh 插件**（`lib/` 已被 gitignore，不进 harness 仓库）：给 agent 提供浏览器工具，把本机 Chrome/Edge 的实时画面渲染到 Web 右栏；浏览器自身暴露 CDP 端口，可用 DevTools 或 Playwright `connectOverCDP` 附加调试；支持临时 profile 与长期 profile。

已定选择：**playwright-core 驱动**、**默认 headful（可配置 headless）**、**先交付可运行骨架**。

## 为什么不是 iframe

真实 Chrome 窗口不是文档，无法 iframe；任意外部站点会被 `X-Frame-Options`/`frame-ancestors` 拒绝；即便 iframe 自己的页面，也不是 agent 那个浏览器进程与 profile。可行做法是 **CDP screencast 镜像**，已被上述实现验证。

## 已核实的接入点

| 用途 | 机制 | 位置 |
|---|---|---|
| 右栏 tab | `ctx.sidebarRightTabs.register({id,kind,multiple,priority,title,guide})` | `packages/client/ui-sidebar-right/src/client/tab-registry.ts` |
| tab 主体 | `ctx.slots.inject('sidebar.right.pane.tab', …)` | 同构范例 `packages/client/ui-sidebar-terminal/src/client/index.ts` |
| profile 默认装配 | `web-app` 已装 `ui-sidebar-right` / `ui-sidebar-terminal` | `packages/bundle/web-app/cordis.patch.yml:240` |
| WS 通道 | `ctx.inject(['webServer'])` → `registerUpgrade({path,handler})`，独占路径 | `packages/host/webserver/src/index.ts:176` |
| 工具 | `ctx.tools.register(defineTool({...}))` | `docs/cookbook/adding-a-tool.md` |
| 生命周期 | `ctx.on('agent/disposed')` / `'session/disposed'` | `packages/core/session/src/index.ts:63` |
| 外部插件骨架 | 自带 pnpm workspace、tsdown 双构建、`dsh.bundle.patch`、`dsh.client.inject` | 模板 `lib/dsh-remote-development` |
| 安装 | `dsh plugin add --profile web link:<绝对路径>`，`pnpm run build` 后重启生效 | 同上 README |

## 包结构

```
lib/dsh-browser/
  package.json          name: dsh-browser（外部插件不入 @deepseek-ai scope）
  pnpm-workspace.yaml   packages: [- .]，storeDir: .pnpm-store（与 harness 仓库隔离）
  tsdown.config.ts      host: src/index.ts → ESM；client: src/client/index.ts → CJS factory
  cordis.patch.yml      insert 一行插件
  src/
    index.ts            注入 ['tools','webServer']，装配 manager + tools + 视图路由
    config.ts           Schema 配置：浏览器 channel/可执行路径、profile 模式与目录、headless、调试端口、screencast 质量
    browser/
      launch.ts         启动浏览器、创建持久化 context、解析实际 CDP 端口
      manager.ts        按 Session 持有实例，响应 agent/disposed、session/disposed
      screencast.ts     CDP screencast 会话（含强制 ACK），帧广播
      input.ts          上行事件 → Input.dispatch*
    tools/              M1：navigate / screenshot / evaluate
    view/server.ts      WS upgrade 路由 + JSON 控制路由
    client/
      index.ts          注册 tab 类型、body 槽位、locale
      view.tsx          canvas + 工具条；WS 客户端；输入转发
      locales.ts / styles.ts
```

## M1 骨架

**启动**：`chromium.launchPersistentContext(userDataDir, {...})`。浏览器选择用 `channel: 'chrome' | 'msedge'`，也支持显式 `executablePath`。临时 profile = `mkdtemp`，长期 profile = 配置目录。默认 `headless: false`、`viewport: null` 保留真实窗口尺寸。

启动参数（含调研结论）：
```
--remote-debugging-port=<port>          # 外部 CDP / Playwright 附加
--disable-features=CalculateNativeWinOcclusion   # 必须：否则被遮挡即停止渲染
--no-first-run --no-default-browser-check
```
启动后读 `userDataDir/DevToolsActivePort` 拿到实际端口。

**画面**：`context.newCDPSession(page)` → `Page.startScreencast({format:'jpeg', quality:70, maxWidth:1600, maxHeight:1200, everyNthFrame:1})`；每帧先 `Page.screencastFrameAck`（否则 Chrome 停发），再以原始二进制广播给已连接的 WS 客户端。无订阅者时停掉 screencast 省 CPU，有客户端时再启动（借鉴 ironclaw 的做法）。canvas 按缩放比适配，客户端把 CSS 坐标换算成视口坐标后发送，不改真实窗口大小。

**输入**：`Input.dispatchMouseEvent`（move/pressed/released/wheel）、`Input.dispatchKeyEvent`（keyDown/keyUp/rawKeyDown/char）、`Input.insertText`。

**WS 路由**：`registerUpgrade({path:'/dsh-browser/stream'})`，二进制 JPEG 下行、JSON 上行（attach / resize / 输入事件）。客户端从页面同源连 `ws(s)://${location.host}/dsh-browser/stream`。

**安全（必须做）**：自定义路由不经过 gateway 的 trusted-host 拦截器，handler 必须自己判信任——复用 `@deepseek-ai/dsh-client-connection` 的 `isTrustedApiRequest(request, trustedHosts)`（与 gateway 同一判据；若未公开导出则实现同一套 loopback/trustedHosts 规则）。否则 `host: 0.0.0.0` 时局域网任何人都能驱动本机浏览器。

**客户端**：`register({id:'dsh-browser', kind:'browser', multiple:true, priority:'extension', ...})` + body 槽位渲染 canvas 与工具条（地址栏、后退/刷新、CDP 端点展示与复制）；`ctx.locale.register` 双语字典；空状态提示"请勿最小化浏览器窗口"。

**工具**：`browser_navigate`、`browser_screenshot`、`browser_evaluate`。

## M1 验证

1. `pnpm install && pnpm run build` → `dsh plugin add --profile web link:D:/code/deepseek-harness/lib/dsh-browser` → 重启 harness。
2. 右栏新建 browser tab，确认画面出现。
3. 在真实窗口点链接，确认侧栏同步；在侧栏 canvas 点击/输入，确认真实窗口响应。
4. **遮挡场景实测**：把 DSH 网页盖到 Chrome 上方，确认画面仍在刷新（验证 anti-occlusion 参数生效）。
5. `curl http://127.0.0.1:<port>/json/version` 确认 CDP 端口可用；外部 Playwright `connectOverCDP` 连上并读到同一页面。
6. 让 agent 调 `browser_navigate`，确认侧栏跟随。
7. 关闭会话，确认浏览器进程退出、临时 profile 目录清理。

## M2 / M3

**M2**：profile 管理（命名长期 profile + 设置卡片，参照 remote-development 的 `settings.section`）；工具补齐（click / type / press / scroll / wait_for / AX 快照 / tab 切换）；每会话多实例与侧栏多 tab 对应；最小化提示与自动恢复。

**M3**：与 `ctx.browserUse` 的关系（该槽位独占，需与 Playwright MCP 等共存策略）；e2e 与快照测试；双语 README 与文档。

## 仍需实测的点

1. `launchPersistentContext` 传 `--remote-debugging-port=N` 后端口是否真的监听——虽有维护者答复，M1 第一步仍以 `/json/version` 实测确认。
2. 同一 `user-data-dir` 被其他 Chrome 实例占用会导致启动失败——长期 profile 必须用插件专属目录，并给出明确错误而非静默失败。
3. `quality` / `maxWidth` / `everyNthFrame` 需按实际帧率与带宽调参。
4. 图片型工具结果的内容块注册方式（browser-use provider 已支持图片结果，实现时对齐）。
5. `dsh.client.inject` 的基线模块表条目需与 web bundle 实际提供的表一致（照 remote-development 的清单核对）。

## 对 harness 仓库的影响

无。插件在 `lib/`（gitignore），不改 harness 任何文件；唯一耦合是 `dsh.client.inject` 声明的基线模块名与 peer 版本区间（对齐 `>=0.1.7-alpha.1 <0.2.0`，devDependencies 固定 `0.1.7-alpha.2`）。

---

## Alternatives considered

**iframe 嵌入**：跨域站点会被 `X-Frame-Options`/`frame-ancestors` 拒绝，而且 iframe 里的页面不是 agent 那个浏览器进程与 profile，与本插件的目标不是一个东西（正文「为什么不是 iframe」）。**把插件放进 harness 仓库**：`lib/` 已被 gitignore，插件必须能独立安装、独立构建、独立发布。

## Consequences

镜像路线让"用户可旁观、可接管"成立，输入的信任级别与侧栏里的真实点击一致；代价是帧率由重绘驱动（画面静止时几乎不出帧，侧栏保留最后一帧），profile、端口与进程回收都由插件自己负责。
