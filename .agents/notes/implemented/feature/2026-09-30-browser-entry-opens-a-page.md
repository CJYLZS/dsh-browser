# Agent Note: 浏览器入口每次点击开一个新页面

Status: implemented

## Problem

用户的实测：**浏览器已经跑起来之后再点一次「浏览器」入口，标签和之前那个"合并"了**。两个机制叠加造成这一幕：

- 引导页入口走的是**页面型开法**（`openTab`），而 `cdpBrowser` 没有 `multiple`，地址固定为 `sidebar://cdpBrowser`。harness 侧 `ui-sidebar-right` 的 store 对页面型 kind 忽略 `revealIfOpened`，直接复用同面板里已有的那一个，所以第二次点击连新标签都开不出来。
- 即使开出来了，这个标签**不指向任何页面**（`contentId` 不是页面地址），对账在页面标签出现后立刻把它关掉（[一一对应那一篇](2026-09-29-one-tab-per-page.md)的决定 3）。

同时 agent 那一侧只有"看"没有"开"：1:1 之后工具结果里的 tab 列表已经和侧栏同源，但模型没有任何办法**新建**一个页面，也没有办法把"工具作用的那一页"换成别的一页。

## Decision

1. **入口的占位面板自己向 host 要一个页面。** 面板挂载时 `POST /dsh-browser/pages {action:"open", sessionId, request:<该标签记录自己的 id>}`。`request` 是幂等键：同一条标签记录重挂载（切走再切回、换会话、客户端刷新）是同一个请求，不会重复开页；host 记住的是 `request → targetId`，页面没了那条记忆就作废，下一次又是新开。
2. **`openPage()` 的规则是"一次点击一个页面"。** 浏览器没在跑就先启动——它启动时的初始页面**就是**这一页（一次请求不要变成两个空白页）；已经在跑就 `context.newPage()`，并把新页设为工具作用页（`adopt` 本来就会这样）。因此"点一次 = 多一个页面"而不是"复用在跑的那台浏览器"。
3. **`cdpBrowser` 加 `multiple: true`。** 每次点击都是独立的占位记录：浏览器正在启动、上一个占位还在面板里时再点一次，不会再被 store 合并掉，第二个请求同样会落到 host 上。
4. **占位仍然让位。** 占位标签没有 `targetId`，页面标签一出现，对账照旧关掉它——1:1 的规则没有被这次改动动摇，只是入口现在真的会产出页面。
5. **agent 侧加第 9 个工具 `browser_tabs`（list / open / select / close）。** 页面的开、切、关不是"当前页的属性"：页内 JS 看不到别的 target，把它们塞进现有 8 个工具的参数只会让"作用于哪一页"进到每个签名里。`select` 改的是**工具作用页**，用户点侧栏标签**不会**改它（用户拍板：面板给眼睛，工具给 agent，要换页由 agent 显式指定）。
6. **工具读的 tab 列表与侧栏同源。** `status()` 与 `pageTabs()` 现在都走同一个 `namedPages()`（能命名的页面，按浏览器自己的页面顺序），所以"工具看到的页面数 = 侧栏标签数"是构造性的，而不是两处各读一遍 `context.pages()`。列表里每一行都带 `targetId`——`select` 与 `close` 就是按它指名页面。

## Alternatives considered

**让入口注册自己的 guide entry 渲染器（照 `ui-sidebar-terminal` 的做法）。** 能精确拿到"用户点了这一下"的时机，但要在插件里自绘胶囊、重放默认入口的行为（标题、描述、快捷键），换来的只是"少一个 request 幂等键"。占位面板的挂载时机**就是**点击时机：只有入口会开出这种没有页面的标签。

**让 host 在"无 page 参数的 viewer 连上来"时开页。** 看起来少一步（不用新路由、不用客户端发请求），但 viewer 会因为切标签重挂而重连，等于把"一次点击"绑成"一次连接"，还是要引入幂等键；而且它把"看看这台浏览器"和"给我开一个页面"混成同一个语义，旧面板的无页面 viewer 会开始悄悄造页面。

**把能力做成参数而不是新工具**（`browser_navigate({newTab:true})` + 各页面工具加 `tab` 参数）。工具名不变，代价是每个工具的签名与文档都要带上"作用于哪一页"，而这一步的真正主体是**浏览器**而不是某一页。用户选择了新工具，这也是本插件第三个"新能力 = 新工具名"的例外（前两个是 `browser_wait` 与 `browser_console`），已记入 [AGENTS.md](../../../../AGENTS.md) 与 README 的工具表。

**`select` 顺带 `bringToFront()`。** 不做：面板是用户的眼睛，Chrome 自己的标签焦点是用户窗口里的东西，工具换页不该去动它；headless（默认）下它也没有作用。

**`close` 复用 `closePage()` 的静默语义。** 工具侧先核对 id 再关：面板关一个已经不在的页面沉默是对的（用户已经在看真相），而模型需要一个能纠正自己的拒绝。

## Consequences

- **页面数 = 点击数**（浏览器正在启动的那一个窗口除外：启动中的请求 join 同一次启动，而一次启动只有一页初始页面，所以两次点击落成同一页）。这是"点一次一个页面"的边界，写在 README 的已知限制里。
- 路由 `POST /dsh-browser/pages` 从"只关"变成"开/关"：body 多一个 `action` 判别字段，**旧的 `{sessionId,targetId}` 形状继续按 close 接受**（已发布客户端的形状不因为一次升级就作废）。路由函数改名 `registerPageClose` → `registerPages`。
- **模型可见的变化**：工具结果里的 tab 行现在写作 `[active] <targetId> <url>`，因为 `select`/`close` 要复制这个 id。
- 新标签最迟在对账的一拍（1.5 s）之后出现——开页是立即的，标签是轮询跟上的。这是既有架构（轮询而非推送）的代价，不额外引入通道。
- 一次点击最多多一个页面，且只在有会话的 GUI 里发生：路由带连接信任检查，未认证请求照旧 401。

## Testing

- `test/session-browser.test.ts`：`openPage` 的三种结局（没在跑 → 初始页面就是新页面；在跑 → 新的一页且成为工具作用页；同 `request` 重复 → 同一页）、页面没了之后同一 `request` 再开、带地址的一页、`selectPage` 换作用页不开新页、不存在的 id 被拒。
- `test/view-pages.test.ts`（新）：路由的开/关/幂等/旧 body 形状/坏 body 不启动浏览器/405/信任检查。
- `test/client-api.test.ts`（新）：客户端两个 POST 的 body 契约与 `targetId` 读回。
- `test/ptc.test.ts`：`PTC_CALLS` 加了 `browser_tabs` 的一行（表就是覆盖契约），并断言"开两次 = 两个页面"、"select 之后 `browser_evaluate` 落在那页（另一页的会话上零次调用）"、"关掉最后一页浏览器停止"、"列表是读不是请求（不启动浏览器）"、三种拒绝。列表断言里的 `targetId` 来自**假件**：`test/support/browser.ts` 的 `context.newPage()` 现在也会像真 Playwright 那样广播 `page` 事件（真件会广播，插件正是靠这个事件 adopt）。
- `test/tools.test.ts`：`tabsText` 的 id 列与 `tabsActionText` 的四种动作文案。
- **真机回归 `[31]`**（`scripts/snapshot-regression.mjs`，不进 `pnpm test`）：同一台已经在跑的浏览器连续两次 `openPage()` 得到两个不同的 `targetId`、标签数恰好 +2、`selectPage()` 只把活动标记挪到那一页、同一条 `request` 问两次只得到同一页。这一条钉的是假件学不来的那部分：真 Playwright 的 `context.newPage()` 真的会广播 `page` 事件，adopt 真的在它之后拿到 `targetId`。

## Related

- **部分取代**：[侧栏标签与浏览器页面一一对应](2026-09-29-one-tab-per-page.md)——其决定 1–6 仍然成立，只有"引导页入口保留页面型开法、页面标签出现后让位"这一句被本篇扩展（入口现在每次点击都要一个页面）。
- 多标签与页面生命周期的事实基础：[那一篇](../architecture/2026-09-23-multi-tab-and-page-lifecycle.md)。
- harness 侧"页面型 kind 一个面板只有一个"的规则与 `multiple`：`ui-sidebar-right` 的 store（`openContent`）与 tab 定义（`SidebarRightTabDefinition.multiple`）。
