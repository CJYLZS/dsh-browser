# Agent Note: 侧栏标签与浏览器页面一一对应

Status: implemented

## Problem

旧语义是"观察窗"：侧栏永远只有一个浏览器标签，面板镜像**活动页**，多开的页面只在工具结果的标签摘要里以文本出现。2026-09-29 真机验证时用户指出了两个后果：

- **数量对不上。** agent 点开一个链接，设置页横幅显示浏览器有两个页面，侧栏还是那一个标签——用户没法看到新开的那个页面，除非它恰好是活动页。
- **关不掉，还会漏。** 多标签之后"关掉观察窗"和"关掉页面"是两回事：镜像跟着活动页走，侧栏关掉一个标签什么页面都没关；如果一个页面从此只有 agent 看得见、用户看不见，这个页面就**泄露**了。用户据此拍板：取消「关闭浏览器」按钮，**关掉页签就是关掉对应的浏览器标签页**。

## Decision

1. **一个页面一个标签，地址由页面的 CDP `targetId` 构成**（`dsh-resource://dsh-browser-page/<targetId>`）。`targetId` 是页面的稳定身份——外部 DevTools 与 Playwright 附加时看到的就是同一个 id——所以同址两页是两个标签，客户端重载后每个标签还能接回它原来在看的页面。身份在 `adopt()` 时从页面自己的 CDP 会话问一次（`Target.getTargetInfo` 无参调用，答的就是这个会话所附着的 target），存进 `pageIds`；页面关掉就删掉。
2. **关标签 = 关页面，host 决定关页还是停浏览器。** 侧栏的 close 机制本就有"资源清理先于移除"的口子（`ctx.sidebarRight.registerCloseHandler(kind, …)`），客户端在那里登记：解析出 `targetId`、记入 closing 台账、`POST /dsh-browser/pages`。host 侧 `closePage()` 数自己的页面：只剩最后一页时走 `stop()`——Chrome 的最后一个 tab 关掉会退出整个进程，那次关闭就是**有意的停止**，`userClosed` 语义保住"用户关的"不会被 viewer 拉回来；否则 `page.close()`。客户端不数页面，它数不了：报告是快照，真相在 host。
3. **对账替代"变化时揭示"。** 客户端每 1.5 s 读一次 `/dsh-browser/status`，对**每个**报告里的会话做 `reconcile`：浏览器持有的每个页面一个标签（缺了就 `openResourceIn`，同一步展开栏目），页面没了标签跟着走。旧判据（只对"没在跑 → 在跑"这个变化反应）是为了"用户关掉的观察窗不被拉回来"——在 1:1 里那个状态**不存在了**：用户关掉标签就是关掉了页面，没有"标签关了页面还在"可保护。对账因此可以无条件做。唯一剩下的窗口是"刚关还没关掉"：报告还在列这个页面，而标签已经没了，对账会把它再开回来——closing 台账挡住这个窗口，条目在报告不再列出该页面时清除，另有 15 s 兜底（关页请求失败时，页面确实还在，标签回来是诚实的）。
4. **「关闭浏览器」按钮删除。** 面板不再有停止浏览器的控件：每个页面的关闭入口就是它的标签。WS 的 `close` verb 保留并改为"关闭 viewer 所指的页面"（无 page 参数的旧 viewer 仍停整台浏览器），兼容旧面板。
5. **镜像按页挂流。** `SessionBrowser.mirrors` 按 `targetId` 键，每个镜像**自己** `newCDPSession` 并持有——绝不复用 `adopt()` 的会话，因为那一个说 detach 就 detach。两个 viewer 看同一页共享一条 screencast；输入、`navigate`/`reload`、剪贴板选区都路由到 viewer 指名的页面，工具作用于哪一页与它无关。浏览器重启/崩溃后旧 target 全部失效，标签由对账替换，不需要恢复机制。
6. **标题跟着页面走。** `/dsh-browser/status` 的 tab 列表现在带 `title`，由一次浏览器级 `Target.getTargets` 读出（一次调用覆盖全部页面，不进渲染进程，忙碌的页面拖不住它）；标签芯片经 `sidebar.right.pane.tab.title` 插槽读这份事实，页面改名芯片跟着改，拿不到时退回打开时抓的文字。

## 为什么是"资源地址"而不是页面型标签

harness 的两种开法里，页面型标签（`openTab`）的地址是打开时 mint 的随机 UUID，恢复布局后 navigation 记录为空（revision 0），对账无从知道这个标签指哪个页面；资源地址则把身份放进 `contentId` 本身，恢复、去重、重连都靠它。代价是要登记 `patterns` 并让 `canOpen` 守住自家的前缀——已做（`dsh-resource://dsh-browser-page/**`）。引导页入口保留页面型开法：它是"起一台没人看的浏览器"的唯一入口，页面标签出现后由对账让位。

## Alternatives considered

**保留观察窗，面板里加页面切换器**：切换器把浏览器自己的标签条在面板里重画一遍，而且泄露还在——关掉面板仍然关不掉页面，"只有 agent 看得见的页面"照旧存在。用户要的是浏览器与侧栏同构，不是更强的观察窗。

**页面型标签 + navigation 参数携带 targetId**：地址随机、恢复即失忆，见上节；且每 1.5 s 一次的对账要读每个标签的 occurrence 才能拿到参数，比比对 `contentId` 贵。

**客户端数页面、决定"最后一个关 = 停浏览器"**：客户端手里的报告是快照，页面数随时会变；host 数 `context.pages()` 是当时的事实。决定放在真相那一侧。

**复用 `adopt()` 的 CDP 会话给镜像**：`adopting()` 会 `previous.detach()`，复用的会话在下一次 adoption 时被拆掉，镜像无声断流——正是 AGENTS.md 里"流属于一个 CDP 会话"教训的换一种踩法。镜像自持会话，代价是活动页被镜像时多一条 CDP 会话，可接受。

**从面板 body 里关页面（`tab.actions.close()` + WS `close`）**：面板的 WS 正是随标签一起拆掉的东西，close 走它就是走一条正在关闭的通道。POST 路由是与标签生命周期无关的剩余通道，这也是它单独存在的原因。

**保留「关闭浏览器」按钮**：按用户的决定删除；理由即 Problem 里的泄露论证——按钮的语义（停整台浏览器）与新的同构模型冲突，留着一个与标签条并行的停止入口就是留一条绕过"关标签 = 关页面"的路。

## Consequences

- 设置横幅与状态路由的形状不变（多了 tab 的 `title`），但路由变 await：`pool.statusAsync()` 每实例一次 `Target.getTargets`，1.5 s 一拍、每实例一次协议调用，不进渲染进程。
- 客户端轮询从"只在没开面板时"变成"常开"：对账必须看见页面消失，而页面消失恰恰发生在面板开着的时候。每 1.5 s 一次本地 GET，与设置横幅同数量级。
- 重启按钮（失败卡片上的那个）在 1:1 下几乎不可达——失败浏览器的页面为空、标签随之关闭——只在旧标签与瞬态窗口里出现，保留。
- 工具结果里的 tab 列表带 `targetId` 与 `title`，`TABS_SCHEMA` 必须同步声明这两个字段——`additionalProperties: false` 下漏声明会让**整次调用**以 `"value.tabs[0].targetId" is not a declared property` 失败（与内联图片那次的教训同源：结果过不了 `output.schema`，字节已经发出去了）。
- 已知取舍：镜像活动页时该页有两条 CDP 会话（adopt 一条、mirror 一条）；关页请求失败且 host 长期不可达时，标签会以 15 s 为周期开回来，直到对账看到浏览器不在了。

## Testing

- `test/client-pages.test.ts`：地址与解析、reconcile 的开/关/让位、closing 台账（挡住与过期）、页面事实的"没变就不通知"。
- `test/client-surface.test.ts`：`followOneReport` 对假 ctx 的四条决定（补缺、关陈、让位、台账挡住），及 `canOpen` 守住自家前缀。
- `test/session-browser.test.ts`：status 带 `targetId`/`title`；`closePage` 的三种结局（关页存浏览器、最后一页停浏览器且 viewer 不复活、无此页不动）；按页镜像（画面只给指名的 viewer、同页共享一条 screencast、无此页拒绝）；输入与导航路由到指名的页面。假件为此补了两处**真件形状**：`Target.getTargetInfo` 带 `title`（真件答的比 id 多）、CDP 会话的 `detach()`（真件有，`closeMirror` 要调）。
- `test/view-server.test.ts`：WS 按 `page` 参数绑定页面——帧、地址、输入、close 都属于那一页，页面消失即告知并收线；无参数的 viewer 行为不变。假 socket 必须带真实 WebSocket 的 `OPEN`/`CLOSED` 常量，否则路由里所有 `readyState === client.OPEN` 守卫全部失效——这条在第一次跑通前拦下了"一条消息都发不出去"的假绿。

## Related

- 旧语义（观察窗、`userClosed` 的来历）：[面板跟着浏览器走](2026-09-24-pane-follows-the-browser.md)——其决定 1 仍然成立，2 与 3 被本篇取代。
- 多标签与页面生命周期的事实基础：[那一篇](../architecture/2026-09-23-multi-tab-and-page-lifecycle.md)。
- 本轮真机验证与九项缺陷的来源：[真机过一遍](../testing/2026-09-29-real-page-verification.md)。
