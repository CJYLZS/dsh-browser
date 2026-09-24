# Agent Note: 多标签与页面生命周期

Status: implemented

## Problem

早期实现把三个不同的东西——侧栏标签、浏览器标签、浏览器进程——当成了同一个：关掉侧栏标签就失去浏览器，`window.open` 出来的新标签无人观察，浏览器死了没人知道。

## Decision

按 session 隔离浏览器（每 session 一个进程、profile、CDP 端口、页集合，懒启动，`session/disposed` 回收）；一个会话内的多个浏览器标签由 `context.on('page')` 跟随，激活页是镜像与工具共同作用的那一张；screencast 属于一个 CDP 会话而不是 viewer，所以 `start()` 在 `ready` 之后统一补挂；侧栏标签只是观察窗，关掉它不关浏览器。

## 根因：三个"标签页"被当成一个

- **浏览器标签页** —— Playwright 的一个 `Page`，即真实 Chrome 窗口里的一条 tab。
- **侧栏标签页** —— DSH 右栏的一个 tab。
- **会话** —— 一个 workspace / 对话。

现在的实现把三者合一：一个进程一个 browser、一个 `page`、一条 WS、一份 screencast。所以每个会话打开侧栏看到的都是同一个页面，每个会话的工具调用也都在动同一个页面。

## 已核实的事实

| 事实 | 位置 |
|---|---|
| 侧栏布局**按会话**（`SurfaceState` per session id，槽位 `scope: 'session'`） | `ui-sidebar-right/README.md` State |
| session 作用域的 keyed 槽位，注册方 `inject` 工厂的第一个位置参数就是 `sessionId` | `ui-slots` 的 `InjectParams` |
| 只有活动 tab 的 body 被挂载（`renderTab(active)`）；折叠侧栏时 panel 仍挂载，只是移出视口 | `ui-dockkit/.../TabPanel.tsx:410`、`ui-sidebar-right/.../SidebarRight.tsx:9` |
| 0.1.5 的 page 类型地址是 `pageAddress(kind)`，**每格强制去重** | tab 注册契约 |
| 0.1.7-alpha.2 新增 `multiple?: boolean`：为真时地址变成 `pageAddress(kind)/<uuid>`，每次打开都是独立实例；另有 `keepMounted` | 0.1.7 tarball `lib/client.js:6062`、`tab-registry.d.ts:84` |
| 工具执行上下文能拿到会话：`exec.agent?.id`，而 `Agent.id: SessionId` | `packages/core/agent/src/types.ts:13-16` |
| host 侧有 `session/disposed`，payload 是 `Session` | `packages/core/session/src/index.ts` |
| **会话的 id 在 reopen / 恢复时保持不变**：打开已存在的对话走 `agents.resume({ resumeSessionId: sessionId })`，`persistence.open(id)` 用的就是这个 id | `packages/api/session-controller/src/agent.ts:430-466`、`packages/core/agent-loop/src/index.ts:857` |
| 一个会话绑定一个 cwd（header.cwd 不符会抛 `ApiSessionCwdConflict`），而多个会话可以共用一个 cwd —— 所以 session 是比工作目录更细的单位 | `packages/api/session-controller/src/agent.ts:456` |

## 决定一：按 session 隔离浏览器（每个 session 一个浏览器实例）

隔离单位是 **session**（一次对话），不是工作目录：同一个工作目录下的两个对话各有各的浏览器，对话恢复后仍是它自己那一个。这与 ZCode 的行为一致。

「按 session 隔离」只能是**每个 session 一个浏览器实例**（自己的进程、profile、cookie、CDP 端口、页集合）。原因不在 Playwright，在浏览器本身：同一个窗口里的标签共享 cookie jar，只有独立 profile 才隔离。所以"会话之间隔离登录态"和"共用一个窗口"不能同时成立，二选一。这一版按 session 隔离做：

- **headful 下每个用过的 session 各有一个窗口**，这是本选择的直接后果；默认 headless 时没有窗口，代价不可见。之前设想的"一个窗口、标签按 session 归属"是共享 profile 的模型，作为备选保留（以后真需要再加作用域配置），现在不做。
- **端口**：每个实例一个端口。不能用固定 9333，也不能用 `--remote-debugging-port=0`（Playwright 的 pipe 在场时 Chrome 不写 `DevToolsActivePort`）。启动前用 `net.createServer().listen(0)` 从 `debugPort` 起向上探一个空闲端口；设置页的 `debugPort` 因此是**基准端口**，并列出当前在跑的实例与它们各自实际用的端口。仓库里没有现成的空闲端口 helper。
- **profile**：临时模式 `mkdtemp('dsh-browser-<sessionId>-')`；长期模式 `<userDataDir>/<sessionId>`。会话 id 在 reopen / 恢复时保持不变（见事实表），所以长期 profile 能跨对话重开保留登录态。
- **生命周期**：懒启动——第一次工具调用或第一个 viewer 订阅时才起；`session/disposed` 关闭该实例并清临时 profile；配置 `maxSessions` 上限，超限关最久未用的；侧栏菜单加「关闭浏览器」。
- **代价**：用过的 session 各留一个 Chrome 进程（headless 下不可见，headful 下每个用过的 session 一个窗口）；`debugPort` 从单值变成基准端口。

## 决定二：一个会话内的多个浏览器标签页

分两阶段，阶段 A 现在能做，而且它同时是阶段 B 的地基。

**阶段 A（0.1.5）**：真实浏览器的标签条由 body 自己画（列表 + 切换 + `+` 新建 + `×` 关闭）。

- 真相来源是 CDP 的 `Target.setDiscoverTargets`（`targetCreated` / `targetDestroyed` / `targetInfoChanged`），不是 Playwright 的 `context.on('page')`：前者带 `targetId`、`title`、`url`、`openerId`、`browserContextId`，正好既是标签条的列表、又能在标题/URL 变化时推送。`context.on('page')` 只用来拿可操作的 Playwright `Page` 对象，两者按 `targetId` 配对。浏览器级会话来自 `context.browser()?.newBrowserCDPSession()`（该 typings 里只在 Android/Electron 下返回 null）；退路是直接读我们已经持有的那个端口的 `/json/list`。
- 一个浏览器只服务一个 session，所以**不再需要按 `openerId` 判定归属**——实例内的每条标签都属于这个 session。
- 用 CDP 的 `targetId` 作 page 的稳定标识，不用自己 mint 的 id——外部 DevTools/Playwright 附加时看到的是同一个 id，两个世界对得上。
- 侧栏里选中某条标签时同时 `Target.activateTarget`，让真实窗口跟着切过去；headful 下这是必须的，否则侧栏显示的和窗口显示的不是同一条。
- 代价：这条标签条是我们自己画的，跟 harness 的 tab chip 不是一套（不能拖出去分屏）。

**阶段 B（0.1.7）**：声明 `multiple: true`，让每个浏览器标签页可以在侧栏拥有自己的 tab（`openTab('cdpBrowser', { params: { target } })`），于是能拖到另一个格子里两个页面并排。需要新增 `SidebarRightTabParamsMap` 的 `cdpBrowser: { target: string }` 声明，body 从 `navigation.params` 读初始目标、`navigation.revision` 变化时切目标。`keepMounted: true` 能让切走再切回不重连，但折叠侧栏时 body 仍挂载，所以要按 `tab.visible` 主动暂停推流，否则后台一直在解码 JPEG。

## 决定三：流的形状

一条 WS 不再是"一个全局流"，而是"一个 viewer 对某个（会话，目标页）的订阅"。

- WS URL 带上会话：`/dsh-browser/stream?session=<id>`，id 来自 body 注册时 `inject` 工厂拿到的 `sessionId`。
- host 按 `(sessionId, targetId)` 维护 screencast：只有 ≥1 个 viewer 选中该目标时才开，最后一个离开就关——重绘驱动的成本只付给真正在看的人。
- viewer → host 新增 `{type:'selectTab', targetId}`、`{type:'newTab'}`、`{type:'closeTab', targetId}`，其余不变。
- host → viewer 新增 `{type:'tabs', tabs:[{id,title,url}], selected}`，页面增删或被别的来源改动时推送。

## 决定四：关闭语义

关键不对称：**侧栏标签是观察窗，浏览器标签才是资源**。关掉观察窗不该毁掉 agent 正在用的东西。

| 事件 | 结果 | 理由 |
|---|---|---|
| 用户关掉侧栏的浏览器标签 | 浏览器不动，只有这个 viewer 退订 | 视图的寿命与资源的寿命不同 |
| 任何人关掉某条浏览器标签（agent / 页面 `window.close` / 用户在真实标签条 Ctrl+W） | 该 session 的所有 viewer 收到新的 tabs 列表；选中它的人回落到当前活动页；没有页面可回落时提示「新建标签」 | 视图跟随真相；工具遇到已消失的 target 要报明确错误并列出可用 target |
| 关掉这个浏览器里的最后一条标签 | 禁止（`×` 置灰），或关闭后立刻补一个 `about:blank` | Chrome 关掉最后一个 tab 会退出进程，而浏览器是 agent 的长驻资源 |
| 用户关掉真实窗口（headful） | 只有**这个 session** 的浏览器进入 `closed`，viewer 显示「重新启动」；下一次工具调用或点击重新启动 | 每个 session 一个实例，爆炸半径就限定在它自己 |
| `session/disposed` | 关闭该 session 的浏览器并清临时 profile | 资源跟着会话生命周期 |
| 插件卸载 / harness 退出 | 关闭全部实例 | 同上 |
| Web 页面刷新（侧栏布局是内存态） | 浏览器不动，侧栏回到收起态；再打开标签时接上同一个浏览器、同一批 page | 布局是视图状态，浏览器是资源 |

## 工具侧对应

- 工具加 `target?` 参数，缺省是"该会话当前活动页"。
- 新增 `browser_tabs`（list / new / select / close），顺手回答"agent 怎么知道有哪些标签"。
- `navigate` / `screenshot` / `evaluate` 的结果带上 `targetId` 与 tabs 摘要，让 agent 不必额外查一次。

## 动工前必须实测

1. 同一 Node 进程里并发两个 `launchPersistentContext`（不同 profile、不同 `--remote-debugging-port`）：两条都能起、两个端口都通、两条 screencast 互不干扰。这是"按 session 隔离"的地基。
2. 同一 context 下多 page：每页一条 `context.newCDPSession(page)`；浏览器级 `newBrowserCDPSession()` 能起来，`Target.setDiscoverTargets` 能报出用户在真实窗口新建的标签及其 `openerId`。这是阶段 A 的地基。
3. `Target.activateTarget` 能让真实窗口跟着侧栏切换标签（headful 下必须，否则侧栏显示的和窗口显示的不是同一条）。

## 不做的事

- 不把浏览器标签页 1:1 映射成侧栏标签页（0.1.5 做不到；0.1.7 作为可选增强，不是默认形态）。
- 不做"一个窗口、标签按 session 归属"的共享 profile 模型。它更省资源、headful 下只有一个窗口，但会话之间共享 cookie，与"按 session 隔离"直接冲突。以后真需要再加作用域配置。

---

## Alternatives considered

**侧栏标签与浏览器标签一一对应**：会强迫用户为每个真实标签开一个侧栏标签，且关掉观察窗不该等于关掉资源。**允许关掉最后一条浏览器标签**：Chrome 关掉最后一个 tab 就退出整个进程，等于"关标签"变成"杀浏览器"，不可接受（正文「不做的事」）。

## Consequences

隔离的代价是登录态不跨 session 共享——这是"真实隔离"的价钱，改回去就等于放弃隔离。会话身份的传递必须同时满足三个消费方（面板 WS 查询参数、工具的 agent id、设置页的实例列表），三者必须是同一个 id。
