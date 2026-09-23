# AGENTS.md — dsh-browser

本目录是 harness 仓库之外的外部 dsh 插件（`lib/` 已被 gitignore，不入 harness 仓库）。本文件只约束在 `lib/dsh-browser/` 里的工作。

## 已定方向（2026-09-23 实测）

- **默认 headless。** 实测 headless 下 screencast 稳定出帧、输入生效、渲染内容真实；无窗口就没有遮挡/最小化问题。headful 保留为配置项。
- **tab kind 用 `cdpBrowser`，不占用 `browser`。** 0.1.7 的 `ui-sidebar-browser` 已占用 `browser`，那是 iframe/Electron webview 的嵌入路线，与本插件的「镜像真实 Chrome 进程」不是同一能力，两者并存。
- **端口发现不能用 `DevToolsActivePort`。** Playwright 会同时传 `--remote-debugging-pipe`，此时该文件不写；已确认端口真的监听，改为轮询 `/remote-debugging-port` 指定端口的 `/json/version`。
- **不要重复 Playwright 已有的反后台化。** 它的默认参数已含 `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-background-timer-throttling`；实测最小化与遮挡下画面都继续出帧，`CalculateNativeWinOcclusion` 不是起作用的一方。
- **screencast 是重绘驱动的**：画面完全静止时几乎不出帧，侧栏 canvas 保留最后一帧即可。
- **按 session 隔离浏览器，单位是 session 不是工作目录。** 每个 session 一个浏览器实例（自己的进程、profile、cookie、CDP 端口、页集合），懒启动，`session/disposed` 回收。这与 ZCode 的行为一致。结构是 `BrowserPool`（按 session 持有）+ `SessionBrowser`（只服务一个会话）；工具用 `exec.agent?.id` 定位实例，面板用会话作用域槽位拿到的 `sessionId` 指名端口，两者必须是同一个 id（`Agent.id: SessionId`，已核对 `ApiSessionController` 的 `resumeSessionId` 路径）。**改动这一层时要同时想到三个消费方：面板（WS 查询参数）、工具（agent id）、设置页（root 作用域，看不到当前会话，只能看实例列表）。**
- **`debugPort` 是基准不是地址。** 每实例一个端口，`PortAllocator` 向上探空闲端口并持有到浏览器关闭；`--remote-debugging-port=0` 不可用（实测见 plan.txt）。想知道某个会话在哪个端口，读 `/dsh-browser/status`，不要假设是配置里那个值。
- **`userDataDir` 是父目录。** 每会话一个子目录，段名用 harness 的 `encodeSegment` 规则转义（不自己发明）。推论：登录态不跨会话共享——这是"真实隔离"的代价，改回去就等于放弃隔离。headful 下每个用过的 session 各有一个窗口。
- **侧栏标签是观察窗，浏览器标签才是资源。** 关掉侧栏标签不关闭浏览器，只是这个 viewer 退订（重新打开会发现浏览器还在，若已死则在重连时自动换一个）；关闭浏览器用面板上的「关闭浏览器」；最后一条浏览器标签不可关（Chrome 关掉最后一个 tab 会退出整个进程）。
- **page 的稳定标识用 CDP `targetId`**，不用自己 mint 的 id：外部 DevTools / Playwright 附加时看到的是同一个 id。工具侧的 ref（`e1`）是**快照内的临时标签**，导航即失效，只在当前页有效。
- **浏览器死亡不是异常，是常态。** `context.on('close')` 已接：用户关窗口、崩溃都会进 `closed` 并带原因，`ensure()` 会重新起一个。新增任何"持有浏览器句柄"的状态时，都要想它在 `forget()` 之后会怎样。
- **风控靠关掉自动化标记解决，不靠换引擎。** Playwright 启动的浏览器一律 `navigator.webdriver === true`（headful 也一样），headless 还多带一个 `HeadlessChrome` UA。交替 3 轮 A/B、同一网络同一时间窗下：带这两个标记 0/3 通过，关掉后 3/3 通过。配置项 `stealth`（默认开）负责加 `--disable-blink-features=AutomationControlled` 并用 CDP 把 UA 里的 `Headless` 去掉。真需要二进制级隐身时用 `executablePath` 指向用户自备的隐身 Chromium——不要把第三方二进制打包进来。
- 完整实测证据与脚本见 `plan.txt` 的「实施记录」与 `.prove/`；多标签与页面生命周期的完整设计见 `plan.txt` 的「设计」一节。

## 搜索：用 rg，搜索范围尽可能小

- 搜索一律用 `rg`（ripgrep）。不要用 `grep`、`grep -r`，也不要用 `find | xargs grep`。
- 每次搜索都从**尽可能窄**的路径起步：先包、再子目录、再具体文件。例如 `rg -n "registerUpgrade" packages/host/webserver/src`，而不是从仓库根开始扫。
- 需要全仓范围时先用 `--glob` / `-t` 收窄文件类型，并且说清为什么必须全仓。找某个东西的位置时用 `rg -l` 只列文件，比打印匹配内容便宜。
- 一律 `rg -n` 带行号，方便直接引用 `file:line`，不要事后再用 `sed`/`cat` 补行号。

## 目标版本：先 0.1.5-rc.2，后迁 0.1.7

按仓库当前 checkout 的 **0.1.5-rc.2** 开发；功能基本完成后再适配 **0.1.7**（`0.1.7-alpha.1` / `0.1.7-alpha.2` 已发布，仓库只是还没切过去）。

核对 API 之前先确认目标版本。两个版本差异已经造成过误判：

| API | 0.1.5-rc.2 | 0.1.7-alpha.2 |
|---|---|---|
| `SidebarRightTabDefinition.multiple` / `keepMounted` | 无 | 有 |
| `ctx.browserUse`（`@deepseek-ai/dsh-browser-use`） | 无 | 有，独占单 provider 槽位 |
| `ui-sidebar-terminal` / `ui-sidebar-browser` | 无 | 有，web-app 已装 |
| `cordis.patch.yml` 里 `ui-sidebar-right` 的行号 | 224 | 240 |

**不要用本 checkout 的源码去否定一份写自 0.1.7 的计划**，反之亦然：仓库里查不到某个 API 只说明它不在这个版本，不等于它不存在。判存在性用 `npm view @deepseek-ai/<pkg> versions`，不要只靠本地 `rg`。

## 不要为宽泛搜索委派子代理

一个「在整仓里找某 API」的宽范围 Explore 子代理会退化成全仓 grep：慢、烧上下文、结论还不如一条窄 `rg` 直接。先用一条窄 `rg` 自己定位；只有确实要跨多个包、多种命名约定铺开找时，才委派子代理，并在提示词里写死要搜的具体目录，禁止它从仓库根开始。

## 设置页与工具集

- **设置页必须给出"生效"的证据，而不只是"保存"。** 写入是即时的，用户看不到的是浏览器有没有按新值重来。状态横幅从插件的 `GET /dsh-browser/status` 读**正在跑的实例**（不是当前配置），写入与「重置」都走同一个 `commit()`——重置漏掉重读会让横幅一直报上一个浏览器。多实例之后它列出每个会话的实例（会话 id 去掉 `session-` 前缀再截断，否则每行都长得一样）。
- **工具少而必要，以代码工具为主。** 6 个：`browser_evaluate` 是主力；工具只补代码表达不了的语义：`browser_snapshot` 给 ARIA 树（也是 click/type 的 ref 来源）、`browser_click` / `browser_type` 给可信的真实输入事件（`evaluate` 里的 `element.click()` 不是可信事件）。其余（滚动、后退、等待、下拉、拖拽）都留给 evaluate，真遇到再加。
- **坐标有两套**：`DOM.getContentQuads` 给的是页面坐标（含滚动偏移），`Input.dispatchMouseEvent` 要的是视口坐标，中间要减 `cssLayoutViewport.pageX/pageY`。这条已经在真实 Chrome 上验证过（点击 "Learn more" 真的跳转），改坐标换算时要重跑一次真机验证——假 CDP 不会发现这类错误。

## 测试

- `pnpm test` 就是 `node --test test/**/*.test.ts`：Node 24 原生剥离类型，**不要引入 tsx**（插件代码里也不要用 enum / 参数属性这类不可擦除语法，否则测试跑不起来）。
- 浏览器相关的测试用 `test/support/browser.ts` 的假启动器：它记录每次 launch 的配置与 profile 目录，并让 page/CDP 可编程应答。凡是"决定"（谁拿哪个端口、什么时候关、ref 有没有失效）都该在这里测；只有"协议细节"（真实 AX 树形状、坐标空间、真实点击是否可信）必须在真机上验证一次。
