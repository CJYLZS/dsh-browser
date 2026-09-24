# Agent Note: 重启后重做 GitHub Trending：A–E 真机复验

Status: implemented

## Problem

五处修复（上一则笔记的 A–E）需要一次独立复验，同时要回答"这一轮工具用得是否顺手"，而不是只看测试是否变绿。

## Decision

在重启后（载入新的 host 产物）重做同一轮 GitHub Trending 任务并逐条复验：A–E 全部成立（跨页旧 ref 被拒、菜单点击报 `dom`、遮挡被指名、`*` 不再乱标、`() => 1` 返回 1）；page info、落盘出口、`target=` 收 CSS 选择器、跨页 ref 编号、精确回报都在真机上起作用；遗留四项摩擦记入 [工具面未解决的摩擦](../../proposed/testing/2026-09-24-open-tool-frictions.md)。同一轮还纠正了一条**无效的检查**：上一轮"`%TEMP%` 里 before=3 after=3"用的是被沙箱改指的 `$env:TEMP`，根本没看到真实临时目录。

重启（载入新 `lib/index.js`）后重做上一轮的浏览任务，并逐条复验 A–E。**这一轮没有改任何代码**——用户重启就是为了验当前产物，host 半边一动就得再重启一次。

## 任务侧

- `browser_navigate https://github.com/trending` → `The page changed: url, title, dom.`（重启后浏览器的第一张页面，url/title 确实都变了）。
- 全量快照 364 行 / 26,078 字符、17 篇 `article`，与 `document.querySelectorAll('article.Box-row').length === 17` 完全一致——**快照没有静默吃内容**。
- 榜单外设占比是**落盘后在磁盘上数出来的**（不是估的）：73 个贡献者链接 + 17 `Built by` + 17 star CTA + 17 段 "Star" 文本 + 34 个 star/fork 计数 + 17 个 "stars today" = 175 行 = **48%**；站点 chrome ≈ 55 行；真正回答"今天什么在涨"的 ≈ 134 行（37%）。纯噪音（贡献者头像 + star 按钮）107 行 = 29%。
- 搜索：点 `button "Search or jump to"` → `dom`；`browser_type "univer"` → `dom`；带 `key="Enter"` → `url, title`，落在 `https://github.com/search?q=univer&type=repositories`。
- 仓库页 `dream-num/univer`：page info 直接报 `page 1440x12603 (15 screens) — at the top, 11703 px below, screen 1 of 15`；`depth=4` 只印顶部、砍掉 1196 节点。
- Rust 榜一次 evaluate 取全：23 个仓库、全部 `Rust`、今日 star 合计 1947，头名 `clash-verge-rev` 396 / `hydradb` 305 / `nasiko` 288——与上一轮**逐字一致**，取数路径稳定。

## A–E 真机复验（全部通过）

| | 上一轮的现象 | 这一轮的实际回报 |
|---|---|---|
| A | 跨页旧 ref 静默点到别的元素还说成功 | `Error: dsh-browser: e42 is not a ref from a snapshot of the current page; call browser_snapshot and use a ref from its result` |
| B | 点开菜单报 "The page did not change." | `Clicked button "Language: Any ".` + `The page changed: dom.` |
| C | 被遮罩吞掉的点击报成成功 | `Clicked link "You must be signed in to star a repository".` + `The click was received by button "Language: Any", which is over the element the ref named.` |
| D | 浅层快照后下钻，满屏 `*` | `depth=2` 砍掉 350 节点后 `target=e43` 印出 7 个上次没打印过的节点，**0 个 `*`** |
| E | `() => 1` 回 `{}` | `() => 1` → `1` |

C 这条**量过真值**，不是只看回报：第一个 article 的 star 链接框 `[1118,402,75,28]`、中心 (1156,416)，而页面自己的 `document.elementFromPoint(1156,416)` 返回 `SUMMARY «Language: Any»`——打开的语言选择器容器真的盖住了那个点，浏览器把这一下给了 summary（所以选择器被关掉，`dom` 变化也是真的）。回报指名正确，不是误报。

## 新能力在这轮实际起作用的地方

- **page info 头**（`1440x900 viewport, page 1440x2577 (3 screens) — at the top, 1677 px below`）：滚动前就知道还有几屏，不用先 evaluate 量一次。
- **落盘出口**：`browser_snapshot(file:true)` 回 20 行 + 路径 + `344 more lines are in the file`，之后可以在磁盘上数（`Select-String`），不再靠数 ref 估行数——本文的 48% 就是这么来的。内联阈值 40,000 字符（`SNAPSHOT_INLINE_CHARS`），26k 的榜单快照因此仍内联；挂了 harness 的 `spillStore` 就用它（`dsh-spill-*` 是 harness 的会话目录，不是本插件新建的），没挂才用插件自己的兜底目录。
- **`target=` 收 CSS 选择器**：`input[placeholder^="Search or jump to"]` 一次拿到 `combobox ... *[ref=e279]`，省掉一次 364 行全量快照；不匹配时报 `no element matches #query-builder-test; check the selector, or take a full snapshot and use a ref`，不是静默空结果。
- **ref 编号跨页连续**（新页面从 `e280` 起，不回到 `e1`），且新页面首批节点**不带** `*`——导航变化由 `changed: url, title` 表达，不该再用 `*` 喊一遍；搜索框那种真正新建的节点则正常带 `*`。
- **回报的精确性**：同一 URL 再导航一次只报 `dom`，没有虚报 `url/title`。

## 仍然不顺手的地方（按影响排序，本轮都没动代码）

1. **快照噪声没变**：29% 是贡献者头像链接 + star 按钮，而模型没有办法说"只要列表、不要每张卡片的外设"。`target=` 只能按子树切，切不出"同一种元素只留一个字段"。
2. **`depth=` 不可预测**：它从 AX 根算起，而 `/trending` 的内容在 depth 4–6、仓库页在 10+，所以 `depth=6` 在榜单页几乎印了整页（357/364），在仓库页 `depth=4` 才是真的浅。截断提示 `… N nodes are deeper than depth=6` 出现时已经来不及省上下文。可行的下一步：把节点数与内容深度区间并进 page info 头（例如 `364 nodes, content at depth 4-9`），让模型有依据挑 depth。
3. **evaluate 猜选择器是静默失败**：我在仓库页一次取 6 个字段，描述/topics/语言全空——选择器零匹配不报错，只有"全是 null"这一个信号。可考虑（不一定要做）在结果里对"表达式含选择器但零匹配"给一句提示。实践上正确的顺序是**先读 ARIA 快照定结构、再写 evaluate**。
4. **遮挡回报里的元素名可能让人意外**：这次指名 `button "Language: Any"`，但它的 box（`[904,343,134,21]`）**不包含**落点 (1156,416)——命中来自它内部那个弹出层。事实没错（页面自己也是这么答的），但"按钮在别处、却说它在你点上"读起来矛盾。可选改进：同时给出落点上"画着"的节点（`elementsFromPoint` 栈顶）作为上下文。

## 卫生（并纠正上一轮一条无效的检查）

- **上一轮"`%TEMP%\dsh-browser-*` before=3 after=3 ⇒ 泄露不变量成立"是无效检查**：DSH 沙箱把 `$env:TEMP` 改指到 `dsh-<rand>`（本轮是 `dsh-oaON7x`），那次列的是沙箱自己的临时目录，**根本没看到真实 `%TEMP%`**。测试侧的不变量（`test/support/browser.ts` 删自己发出去的目录、`test/support.test.ts` 钉住它）不受影响，但人工核对的那条结论作废。
- 真实 `C:\Users\lenovo\AppData\Local\Temp` 现状：`dsh-browser-*` 共 4 个、**56.7 MB**——`oPPrmK`（31.9 MB，最新写入 11:33:07 = 活的）、`IczUVf`（23.2 MB，停在 11:28:24 = 重启前那个会话留下的）、`U5Raa3`（1.1 MB，11:05）、`dsh-browser-shots`（0.4 MB，共享截图目录，跨会话累积 3 张）。
- 活着的浏览器只有一个：CDP 端口探测 9333 活（`Chrome/153.0.8010.53`）、9334–9338 全死。进程列表在沙箱里看不到（`Get-Process` 静默返回空、`Get-CimInstance` 拒绝访问），所以"没有遗留浏览器进程"只有端口这一条证据。
- 结论：**重启会留下一份 20–30 MB 的 profile 目录**（Chromium 只在优雅退出时删临时 profile，host 被 kill 时留下）。真要清理必须带所有权判据（写 PID 锁、启动时只删锁已死的目录），不能按名字通配——另一个 host 的活浏览器同名。

## 调用账

本轮 30 次浏览器调用：真正回答"今天什么在涨 / Rust 头名 / 某个仓库的状态 / 搜一个仓库"约 13 次；A–E 复验与真值测量约 15 次；我自己写错 2 次（把 TS 语法 `ax?: undefined` 写进 JS、用了一个不存在的 `#query-builder-test`）。上一轮是 24 次里有 15 次在诊断——诊断变便宜是因为已经知道页面结构，成本主要转移到复验上。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

复验本身成为一轮工作：30 次浏览器调用里约 15 次是刻意复验。它也暴露了真实残留（4 个 `dsh-browser-*` 目录 56.7 MB，其中一个是重启前那个会话留下的），并把"回归 fixture 必须有一个比视口高的页面"这条写进了测试约定——那正是主笔记里坐标缺陷活下来的原因。
