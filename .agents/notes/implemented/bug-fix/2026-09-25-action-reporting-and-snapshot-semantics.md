# Agent Note: 动作层三个骗法与快照两处语义

Status: implemented

## Problem

工具回报会骗模型，而且骗得很有说服力：点击后回报的是旧 URL；页面在 handler 里同步做完的事被报成"没有变化"；被遮罩吞掉的点击被报成成功。快照侧还有两处语义不明：`*` 的含义、以及函数值被序列化成 `{}`。五个问题全在 github.com/trending 上真机复现。

## Decision

A 跨页旧 ref 必须报错（`forgetPage()` 清映射但**保留编号**，新页面不再发出旧号）；B 观察者装在输入**之前**（`armSettle()`/`readSettle()`，探针 promise 挂在 `globalThis.__dshSettle<n>` 每动作一个槽位）；C 点击的落点被遮挡时写进 `report.obstructed`；D `*` 的判据是"上一张快照时整棵 AX 树里的 DOM 节点集合"（`RefLabels.observe()`），不是"上次打印了什么"；E 值是函数就调用（有 `objectId` 用 `callFunctionOn`，没有才回退 `(表达式)()`）。

起点是一次真机 dogfooding：重启 dsh 后用最新工具集把 github.com/trending 从头浏览一遍（读全页 → 按语言筛选 → 进仓库 → 返回）。**浏览本身是通的**（`evaluate` 一次取回 23 个 Rust 仓库；筛选框 ref 在输入前后不重编号；关闭状态的 `<details>` 里 1029 个语言 radio 一个都没进快照），但动作层暴露出五个"静默给错信息"的地方，按 A→E 顺序先写失败用例再修。

## A. 跨页旧 ref 静默改指（高危，两次独立复现）

- 现象：拿着上一页的 `e42`（本该是 `anthropics/financial-services` 链接）在新页面上点，工具回报 **`Clicked heading "Footer navigation"`**；另一次拿 `e13`（本该是 `Language: Rust` 按钮）回报 **`Clicked button "Solutions"`**。两次都"点中了另一个元素，并且当作成功回报"。
- 机制：`RefLabels.reset()` 清空映射并把 `next` 归 1，而标签只有 `e<n>` 这个字符串，不带页面身份。于是 `targetOf('e42')` 会返回新页面的 e42。**能不能报错取决于新页面此刻有没有 mint 到第 42 个标签，纯属运气**——AGENTS.md 里"跨页的旧 ref 必须报错"这条不变量此前是靠运气成立的。
- 为什么测试没兜住：`test/session-browser.test.ts` 已有用例 `a ref the page no longer has fails rather than clicking something else`，但它在导航后**没有再取快照**，所以新页面一个标签都没发，旧 ref 自然查不到——它以错误的理由通过。新用例补的正是缺的那一步：导航 → 在新页面取快照（mint 出足够多的号）→ 用旧 ref → 必须被拒。
- 修法：`reset()` 改名 `forgetPage()` 并**保留 `next`**，编号在一个浏览器见过的所有页面之间单调递增。`adopt()`/`framenavigated` 改成 `this.labels.forgetPage()`（原来 `new RefLabels()` 会把计数也重置）。为什么不做"标签里带 epoch"：字符串是调用方唯一持有的东西，让新页面发不出旧号就是最省事的强区分。

## B. 同步反应被漏报（中危）

- 现象：点 Language 按钮、点 Spoken Language 按钮，两次都报 **`The page did not change.`**，而菜单确实开了。我在点击**之前**自己装的 observer 整个点击只记到 1 条：`attributes:open`。
- 机制：`click()` 先 dispatch 三次鼠标事件，之后才调 `settle()`；而 MutationObserver 是在 `settle()` 里才安装的——动作已经发生完了。只有**异步**重渲染（React 下一 tick，比如输入筛选词）落在观测窗内，于是出现"输入有变化、点击没变化"的诡异不对称。危害不止少一条信息：模型相信"没变化"就会重试，第二次点击把菜单**关掉**（toggle）。
- 修法：拆成 `armSettle()`（dispatch 之前装上探针，promise 挂在 `globalThis.__dshSettle<seq>`，逗号表达式让它不被 await）+ `readSettle()`（再等那个 promise 并把槽位清掉）。槽位带序号是因为并发的两个动作不能读到彼此的记录。测试用"探针被装上时有没有已经派发过鼠标事件"来建模：装晚了就看不见 handler 里做完的事。

## C. 点击被遮挡也算成功（中危）

- 现象：Spoken Language 菜单开着时点 `e46`（`cloudflare / quiche` 链接）回报 `Clicked link "cloudflare / quiche"` + 页面没变——实际打在菜单遮罩上，把菜单关掉了；关掉菜单后同一个 ref 立刻正常跳转。直接测量：header 的 Solutions 下拉展开时，article 链接**自己的坐标** (343,415) 上坐的是 `div.NavDropdown-module__trailingLinkContainer "View all solutions"`。
- 机制：点击是按坐标派发的，工具从不问"这个点上现在是谁"。
- 修法：派发前 `obstructionAt()` —— `DOM.resolveNode` 拿到目标的 objectId，再 `Runtime.callFunctionOn` 在页面里问 `document.elementFromPoint`（会钻进 shadow root，`this.contains(top) || top.contains(this)` 两个方向都算命中），不一致就写进 `report.obstructed`（role + name），由 `actionText` 渲染成一句 "The click was received by …"。**只报告、不阻止**：假遮蔽（shadow DOM、跨 frame、`pointer-events`）会把可用流程变成硬失败，而 `DOM.resolveNode` 失败就等于答不了、不算遮挡（真机上"元素在别的 frame"正是这条路径）。

## D. `*` 的含义（低危，但会让模型去找自己制造的变化）

- 现象：`depth=3` 快照之后用 `target=e15` 钻进一篇文章，里面 12 个元素全被标 `*`——页面什么都没变，只是上次没走到那么深。而"先读浅层再钻进去"正是省上下文的常规操作。
- 机制：`labelFor` 原来的 `fresh: this.snapshots > 0`，即"这个标签是这次快照 mint 的" = "这次遍历第一次到达"，与"页面新出现"混为一谈。
- 修法：判据换成**上一张快照时整棵 AX 树里的 DOM 节点集合**（`RefLabels.observe()`，`formatAxTree` 从入参 `nodes` 收集——`target`/`depth` 只影响打印、不影响入参，所以怎么缩都不会被误判成新增）。`forgetPage()` 也把基线清掉：换页后第一张快照不标任何新。

## E. 函数被静默吞成 `{}`（低危，一行级）

- 现象：`() => 1` 回 `{}`，连 `history.back()` 都没执行（我自己在验证时就这么写错了一次）。机制是 `Runtime.evaluate` 的 `returnByValue` 把函数序列化成 `{}`，模型很容易读成"页面返回了空对象"。
- 修法：值是函数就调用它——有 `objectId` 用 `Runtime.callFunctionOn`（`function () { return this() }`，`awaitPromise`），没有才回退到把表达式写成调用 `(表达式)()`。工具描述同步改成 "a returned promise is awaited and a returned function is called"。

## 验证

- `pnpm run typecheck`、`pnpm test`（**178/178，exit 0**）、`pnpm run build` 全绿；跑完 `%TEMP%\dsh-browser-*` 目录数 3 → 3（上一轮的泄漏不变量仍然成立）。
- `pnpm run regression` 扩到 **30/30，exit 0**：新增 [10]–[14] 五节把这次修的东西搬到真机上。实测输出（`.prove/regression.log`）：
  - `a reaction inside the click handler is reported as a change — changed: dom, 1 mutations`，随后快照里真的出现 `link "This week" *[ref=e292]`；
  - `a stale ref is refused, and says to take a snapshot — dsh-browser: e290 is not a ref from a snapshot of the current page…`（e290 这个数字本身就是单调编号的实证）；
  - `the click reports what was over the point — {"role":"div","name":"Veil"}` 与 `the covered click changed nothing`；
  - `asking for more of the page marks nothing as new — 0 starred lines` 与 `a node the page gained is marked new — - button "Later" *[ref=e310]`；
  - `a function is called rather than answered as {} — returned 1, side effect 7`。
- 回归脚本的既有 22 项全过，说明快照过滤/坐标换算/落盘那几层没有被这轮改动碰到。
- 这轮改的全是 host 半边（`lib/index.js`），所以要**重载插件/重启 dsh** 才生效；客户端半边没动。

## 这一轮的元教训

一个"文档里写着、测试也绿着"的不变量仍然可以是假的——A 就是被一条**以错误的理由通过**的用例保护着。补用例时先问"它凭什么通过"；如果答案是"因为 fixture 恰好没那么大 / 没走那一步"，那它保护的不是这条不变量。B/C/E 还有一个共同点：**工具说了话，但那句话是错的，而且错得很有说服力**；只报告事实（`obstructed`、`mutations`）比替模型下结论（"没有变化"）安全得多。

## Alternatives considered

**A 保留 `reset()` 重编号**：调用方手里只有一个字符串，新页面再发出同一个号就同时指两个页面的两个元素，跨页旧 ref 会静默点到别的元素上还说成功——这条以前**靠运气**成立。**C 只报告、不阻止**：当时担心 shadow DOM / 跨 frame / `pointer-events` 的假遮蔽会把可用流程变成硬失败；这个取舍**后来被推翻**，见 [点击落点与默认拦截](2026-09-24-click-point-and-interception.md)。

## Consequences

五处都补了用例（含一条"以错误的理由通过"的旧用例被改写），真机回归从 22 项涨到 30 项。A 与 D 是同一个教训的两面：**用例凭什么通过**比它是否通过更重要。C 的最终形态不在本笔记里。
