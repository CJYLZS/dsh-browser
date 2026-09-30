# Agent Note: 子帧拼接从未生效，以及同一轮真机过一遍留下的六条摩擦

Status: implemented

## Problem

2026-09-29 在真实浏览器上逐项验证八个工具（起因是用户报告侧栏浏览器在上一轮客户端改动后要硬链接触发刷新才恢复，随后要求验证工具面是否正常）。八个工具各自的能力面全部通过，但无障碍树里少了整整一类节点，另有六条摩擦。

### P1：子帧内容对工具完全不可见，而拼接这条路径从未生效

[uitestingplayground.com/frames](http://uitestingplayground.com/frames) 上两个同源 `about:srcdoc` 子帧（两层嵌套，`contentDocument` 可达、帧内共 8 个按钮）：快照把这块印成 `- Iframe "Outer Frame"`，一个子节点都没有，也没有任何"内容不可达"的说明；`browser_click({ text: "Submit" })` 得到 `no element matches`；而同一时刻的截图里 8 个按钮清清楚楚 —— **像素与无障碍树互相矛盾**，这是本轮唯一一条"看得见却读不到"的缺陷。

根因是一个字段名。`childFrameIds()` 读 `child.frame?.frameId`，而 Chrome 的 `Page.Frame` 没有这个字段，标识符叫 `id`（探针实测 root frame keys 为 `["id","loaderId","url",…]`，`frame.frameId` 是 `undefined`）。于是它恒返回 `[]`，`fullTree()` 在"没有子帧"处提前返回，**任何页面上的子帧都不会被拼接** —— 不是"某些帧不行"，是这条路径从未跑通过一次。协议侧四步全部正常（帧树有子帧、每帧答得出树、`DOM.getFrameOwner` 拿得到 owner、owner 也在页面树里），只有字段名读错。

单测为什么一直是绿的：`test/session-browser.test.ts` 的假件与源码抄的是**同一个错字段名**，`test/frame-trees.test.ts` 又只驱动纯函数 `mergeFrameTrees` —— 假件证明的是假件自己。这正是[假件的形状必须抄真件](../testing/2026-09-29-real-page-verification.md)那一条要防的漏。

### P2–P7：六条摩擦

1. **原生 `<select>` 是死路，且拒绝文案的建议永远不会成功。** 点 combobox 报 `Clicked combobox`，但弹层属于浏览器进程、不在 DOM 里；改点 option 被拒成 `option "Two" has no visible box… take a new snapshot and try again` —— 重试永远不会成功。对照：页面自己画的下拉（react-select）全程正常。
2. **纯 property 变化读作"页面没变"。** 不把 `checked` 反射成属性的复选框、把 GUID 写进 `input.value` 的按钮都只报"没变"：变更清单由页内 MutationObserver 驱动，property 写入不产生 mutation 记录（attribute 变化是报的）。
3. **歧义拒绝在无名控件上不可用**：候选行里没有 ref，"用唯一名字收窄"这条建议对两个无名图标按钮毫无出路。
4. **移动焦点的按键不报焦点落到了谁身上。** `Shift+Tab` 只说 `on whatever the page has focused`；无元素输入那一半把同一件事写成 `into the element`。
5. **后续对话框归到下一次调用的回报里。** 页面（或用户在侧栏）自己开的对话框会混进下一次工具调用的结果。
6. **`pnpm test` 往 `%TEMP%` 留下 spill 目录**（`dsh-browser-shots` 里的 3 个 jpg 与 `dsh-browser-results`），与根 `AGENTS.md` 那句"不该多出任何 `dsh-browser-*` 目录"的字面不符。

## Decision

七条一起落地，都描述当前现实。

### 1. 子帧按 `Page.Frame.id` 拼接

`FrameTreePayload.frame` 的类型与 `childFrameIds()` 的读取都改成 `id`；假件改成真机形状，于是"把源码改回 `frameId`"会让那条端到端用例变红——这是这条修复唯一的防回归牙齿。回归脚本补了 [28] 的同源 `srcdoc` fixture：帧内的控件必须出现在同一次 `browser_snapshot` 里，并且能被它的 ref 点中。跨进程（OOPIF）帧仍不可达，`fullTree()` 的注释写明"不可达就不猜"；`snapshot` 的 `target=` 与 `snapshotIgnore` 走的是另一条 `DOM.querySelector` 路径，仍不穿影子根与子帧（见 Consequences）。

### 2. 原生 `<select>` 与 checkbox 用 `browser_click` 的 `select` / `checked` 参数设置

参照系把这两件事做成了一等的 `select(ref, values)` 与 `check(ref, checked)`；这里按"新能力做成参数，不加工具名"落成同一个工具的两个参数：

- `select: string[]`：对目标命中的（或目标 option 所属的）`<select>` 选择这些 option，按 option 的 `value` 或可见 label 匹配；设置 `selected` 并派发页面自己的 `input` / `change`。回报 `selected`（实际选中的 label），而不是"没报错"。
- `checked: boolean`：对 checkbox / radio 设置 `checked`，同样派发页面自己的事件；回报 `checked`（控件最终的状态）。

两者都不派发鼠标事件（这一点有断言钉住：`pointerCalls` 为空），并且各自在被命中的元素不是对应控件 / 被禁用 / 一个值都匹配不到时**指名拒绝**，而不是照派事件。**一个不含 attribute 的 property 写入，变更清单天然看不见**，所以这两个参数自己回报结果，不指望 `dom:` 那一行。

### 3. 变更清单的说明改对了措辞

看不见的不是 attribute，而是**不产生 mutation 记录的 property 写入**（`input.value`、`checked`、`selectedIndex`）。未变化那一行现在把这条写明，并给出路："读回控件"。原始提案写的是"写明它看不见属性与值的变化"——那句话会把一句假话写进工具描述，因为 attribute 变化一直是报的。

### 4. 歧义拒绝给每个候选一个 ref

候选行现在带 `[ref=eN]`（用 `RefLabels.labelFor` 现造，与快照用的是同一本台账），列表最多 10 条、其余用 `… and N more` 计数——形状抄 playwright-core 的 strict mode（它的 `aka <selector>` 就是"每个候选一个可用的名字"，只是它现生成 selector，我们现造 ref）。候选**都没有无障碍名**时，那句"用唯一名字收窄"换成"名字区分不了它们，请取快照后按 ref 行动"。

### 5. 无元素的按键 / 输入回报焦点目标

`ActionReport.focused` 从无障碍树里带 `focused` 状态的节点读出（role + name，与快照同一套命名），只在调用没有指名元素时读。两半措辞统一成一个 `typedSubject()`：有名元素说"文本/按键落在谁身上"，没名就说读到的焦点（读不到才退回 `the focused element`）。成本是每次无元素调用多读一次树。

这条在真机上一开始就是错的，而错法值得留在代码旁边：**只要页面有焦点，Chrome 就把文档自己标成 `focused`**，并且文档节点永远排在前面——于是"取第一个带该状态的节点"必然答出 `RootWebArea`。探针（`.prove/focus-probe.mjs`，attach 到一台已在跑的浏览器而不是自己起浏览器，因为沙箱里 Playwright 起浏览器是 `spawn EPERM`）量到的形状是：`activeElement` 落在 body 上时只有 RootWebArea 带这个状态；焦点进了输入框或按钮时，RootWebArea **和**那个控件同时带。判据因此改成"只认控件"：`focusedInTree` 跳过 `RootWebArea` / `WebArea` / `document`，若只有文档有焦点就答 `undefined`（措辞退回 `the focused element`，而不是谎称按键落在了页面上）。单测的假件按真机形状补上"根节点也带 `focused`"——改回取第一个，两条焦点用例都会红。

### 6. 对话框不再冒充"本次调用开的"

`beginCall()` 在每个会排空缓冲的调用开始时，把**已经在缓冲里的**对话框移进 `dialogsEarlier` 并标 `earlier: true`；结果里那一行明说"它在本调用开始前就开着，本调用没有打开它"。动作调用经 `underPolicy()`、读取类经 `snapshot()` / `screenshot()` 各调用一次。参照系的做法更彻底（`getJsDialog()` 按需拉取、从不把对话框算在某个动作头上），但我们为了不死锁必须自动应答，所以只能做到"标注来源"。

### 7. 临时目录的口径改成"只要求不新增 profile 目录"

`dsh-browser-shots` / `dsh-browser-snapshots` / `dsh-browser-results` 是跑着的实例共享的固定目录，删目录会删别人的东西；根 `AGENTS.md` 那句话收窄成"不新增临时 profile 目录（`dsh-browser-<随机后缀>` 那类）"，同时 `test/ptc.test.ts` 删掉自己写出的那张截图（它此前只断言文件存在）。

### 参照系：zcode 的 browser-use

参照实现在本机 zcode 插件 cache 里（`browser-use/0.5.1` + `browser-use/0.4.2` 的命令 schema + `node-repl-host/0.6.0`），逐条对照后只有一条改变计划：

- **P1：有对应能力。** 它的 `domSnapshot()` 默认就含 iframe bodies 与 open shadow DOM，帧内定位另有 `frameLocator`；这证明"帧内容进快照"就是正确目标，计划不变。
- **P2：有对应能力，而且是一等的。** 命令层是 `select(ref, values)`（按 value 或可见文本匹配 `<select>` 的 option，可多选）与 `check(ref, checked)`；Playwright 面是 `selectOption / check / setChecked / uncheck`。于是计划从"把拒绝文案指向 `browser_evaluate`"升级成"把这两件事做成参数"。
- **P4：有对应能力。** Playwright 的 strict mode 原文是 `strict mode violation: <locator> resolved to N elements:` 后跟每行 `1) <preview> aka <selector>`，候选上限 10 并打 `...`；zcode 的纪律是先 `count()`、大于 1 就收窄、禁止 `first/last/nth`。计划不变，形状照抄。
- **P5：半有。** 浏览器面没有（它的 `press` 返回 `undefined`，全仓没有 `activeElement`），但 CUA 的变更摘要报 `focus_changed=true focused="<title>"`，形状可借。
- **P6：有，而且思路不同。** `getJsDialog()` 返回当前打开的 dialog 或 `undefined`，`handleDialog(accept, promptText)` 显式回答；对话框从不归给某个动作。我们抄不了拉取式（见上），但"归属"这个问题因此有了判据：要标明来源，而不是换一次调用记账。
- **P3 / P7：没有对应能力。** 四份产物里 `MutationObserver` 计数全为 0，动作成功返回 `undefined`，不存在变更清单；临时目录与浏览器能力无关。两条都按原计划（只能改措辞 / 改口径）。

### Testing

- 单测（`node --test --test-isolation=none "test/**/*.test.ts"`）新增：select 的三条拒绝与一条成功、check 的设置与拒绝、焦点落点、对话框来源、歧义候选 ref 与无名建议；PTC 侧加了 `select` / `checked` 的类型断言与一条"程序能读到 `selected`"的桥测。完整数字见 Consequences。
- 真机回归：`scripts/snapshot-regression.mjs` 补了 [28]（`SELECT_FIXTURE` + `IFRAME_FIXTURE`）。本机沙箱里 `launchPersistentContext` 直接 `spawn EPERM`，提权一次跑通了整轮：**87/87 全绿**，[28] 的六条各自 PASS —— 选择回报 `["Two"]`、页面自己的 `change` 处理器记下 `{"value":"two","log":"picked two"}`；勾选回报 `true` 且控件读回 `{checked:true, reflected:false}`（确实没有 attribute）；同源帧内的 `button "Inner control"` 出现在页面树里，按它的 ref 点击让帧内的处理器真的跑了。
- **工具面复验（重启 dsh 之后，按"模型会写的那几个调用"走真机）**：fixture 留在 `.prove/tool-verify/`——本地 8791/8792 两个静态服务，同一份页面用 `127.0.0.1:8791`、`127.0.0.1:8792`、`localhost:8791` 三个地址框起来，一次把同源 / 跨源同站 / 跨站三种帧分开。结论：
  - **子帧**：同源帧与**跨源同站**帧的控件都进树、ref 点得中（帧内那个 handler 真的跑了）；**跨站（OOPIF）**那一路只有节点没有内容——盲区边界就此从"跨源"收窄到"跨进程"，正文那条判断在真机上成立。
  - **`select` / `checked`**：按可见 label 与按 option 的 value 各选一次、把 `<option>` 当目标自动上溯到 `<select>`、勾选与取消勾选、radio，全部成功且页面自己的 `change` 处理器逐次确认（`picked two` / `picked three` / `agree true` / `radio b`）；未匹配的值、非 `<select>`、禁用控件、`select`+`checked`、`select`+`force`、空数组六种都**指名拒绝**且没落下任何状态；整批调用期间页面上的 `pointerdown`/`mousedown`/`click` 计数器**全为 0**——确实是设状态，不是点。
  - **歧义**：候选行带 `[ref=eN]`（把拒绝原文里的 ref 取出来去点，真的点中）、12 个候选截到 10 条并数出 `… and 2 more`、12 个**全无名**的候选走"名字区分不了它们"那一套措辞。
  - **P3 的事实复核**：往输入框打 `hello`，值真的进去了，而 `changed: []`、`mutations: 0`——提示语针对的正是这种写入。
  - **对话框**：页面自己在 `setTimeout` 里开的 `confirm` 被自动 dismiss，下一条调用报出 `earlier: true`，再下一条就没有了。附注一条边界：对话框若落在**那次调用自己的 settle 窗口内**，会被算成那次调用开的——这是"动作期间发生的就算这个动作造成的"的固有口径，不是缺陷（第一次量错就是踩在这里）。
  - **焦点**：当场就是错的（报 `RootWebArea`），根因与修法见上面第 5 条。
- **真机回归第二轮**：`scripts/snapshot-regression.mjs` 补 [29]（`FOCUS_FIXTURE` + `BARE_FIXTURE`），修完 P5 之后整轮 **91/91**——`Tab` 报 `{"role":"textbox","name":"First field"}` 且页面 `activeElement` 确实是 `first`，再按一次报 `Second field`，`Shift+Tab` 报回 `First field`，而一个没有任何可聚焦控件的页面上 `focused` 是 `undefined` 而不是那个 `RootWebArea`。

## Alternatives considered

- **只改字段名，不动假件。** 否决：假件继续教错，下一个人会把 `frameId` 再抄回去，而用例会继续绿着放行。
- **`child.frame.frameId ?? child.frame.id` 兜底。** 否决：两个字段名里有一个是凭空的，兜底把"我到底在问哪个字段"永久糊掉。
- **连 OOPIF（跨进程帧）一起做。** 不在本轮：量到的两个帧都是同进程的 `about:srcdoc`，跨进程要附加 `Target`，把"不可达就不猜"留在注释里比顺手扩大范围诚实。
- **P2 只把拒绝文案指向 `browser_evaluate`。** 这是原始提案，被参照系改掉了：它有 `select` / `check` 这种一等命令，而我们也确实在真机上遇到了这个形状（`AGENTS.md` 的规矩本来就是"真遇到再加"）。
- **P2 新开一个 `browser_select` 工具。** 否决：那是新工具名，而"新能力做成参数"是既定的纪律（`browser_wait` / `browser_console` 是仅有的两处有意破例，各有它自己的理由）。
- **P2 让 `select` 接一个字符串而不是数组。** 否决：参照系的命令就是 `values: string[]`，多选是同一件事的一部分；数组在 PTC 的 schema 子集里也已经有先例（`changed`）。
- **P4 只印已经存在过的 ref，不为候选现造。** 现造（`labelFor`）更贴参照系：Playwright 的 `aka` 也是错误里现生成的，调用方能立刻用这个 ref 行动，而不必再取一次快照。代价是"ref 只由快照发出"这条说法在实现上多了一个入口——但 ref 仍然属于页面、编号仍然不重头来，语义没变。
- **P7 把 spill 目录纳入测试清扫（删目录）。** 否决：那是跑着的实例共享的目录，测试删它就可能删掉另一个 dsh 正在写的截图——与"只删自己见过的临时 profile"是同一条理由。
- **把六条各拆一篇笔记。** 否决：它们是同一次真机过一遍留下的回报/措辞问题，一篇便于逐条销账。

## Consequences

- **帧内的节点从此占 ref 号**，`.prove/snapshot-regression/` 的既有行数与 `.prove/ax-probe/` 的预算对拍都要重跑一遍；[等条件那一篇](../feature/2026-09-29-browser-wait.md)里"iframe 里的元素等不到"那条盲区收窄成 OOPIF（已改）。
- **`browser_click` 的参数与结果各多两项**（`select` / `checked` 与 `selected` / `checked`），`browser_type` 多一项 `focused`；PTC 的 schema 类型与桥测同步更新，可见工具面仍是 8 个。
- **未覆盖 / 已知缺口**：跨进程帧不可达；**原先列在这里的"三处选择器解析不一致"已修**（2026-09-29：`target=` 与 `snapshotIgnore` 也改走页内走查，见 [定位参数化](../feature/2026-09-29-locator-parameters.md)，真机回归 [30] 钉住）；`select` 只匹配 value / 可见 label，不接 index；对话框只能标注来源，不能像参照系那样按需拉取。
- **真机那一条量过两轮**：第一轮 `pnpm run regression` **87/87**（含 [28] 六条），补了修 P5 之后的 [29] 是 **91/91**（见 Testing）。中间那次工具面复验是拿模型会写的那几个调用走真机页面的，它当场揪出 P5 的错法——单测之所以一直绿，是因为假件按"只有元素带 `focused`"造，收到真树的那次修复就是把假件改成真形状。
- **重启后的工具面复验（2026-09-29，已做，六条全绿，没有剩下的欠账）**：改的是 host 半边（`lib/index.js`），所以先在旧模块上量了一遍（揪出 P5），重新加载插件之后又在修好的这版上量了一遍：`Tab` / 再一次 `Tab` / `Shift+Tab` 分别报 `First field` / `Second field` / `First field`，按 `Escape`（不动焦点）仍报 `First field`，每一条都与页面 `document.activeElement` 对上；没有任何可聚焦控件的页面上 `focused` 缺席而不是 `RootWebArea`；子帧内容在树里且 ref 点得中（帧内与顶层两处标记都为 true）；歧义拒绝里的第一个 ref 点得中；页面自己在定时器里开的 `confirm` 报 `earlier: true`；顺带用一次 `select` 证明加载的确实是新构建（`selected: ["Two"]`，页面自己记下 `picked two`）。**这一轮的 fixture 服务随 dsh 一起被重启收走**，要再跑就 `node .prove/tool-verify/serve.mjs` 与 `node .prove/tool-verify/serve.mjs 8792` 两条命令。
- **单测**：`pnpm run typecheck` exit 0；改动前 444 条，第一轮 456 条，修完 P5 后 **457 条**；真 `pnpm test` 全绿（沙箱策略放开成默认 `danger-full-access` 之后不再需要提权；之前 `workspace-write` 下测试运行器与浏览器启动都是管道 stdio 的 `EPERM`）。

## Related

- 同一条链路的上一轮：[真机过一遍：假件的形状必须抄真件](../testing/2026-09-29-real-page-verification.md)
- 动作回报：[动作结果要有语义](2026-09-25-action-reporting-and-snapshot-semantics.md)
- 变更清单：[动作回报里写着页面改了什么](../feature/2026-09-29-action-report-changes.md)
- 定位：[定位参数化](../feature/2026-09-29-locator-parameters.md)
- 等待条件：[等一个条件](../feature/2026-09-29-browser-wait.md)
- 探针与完整记录：`.prove/iframe-splice/FINDINGS.md`（`frame-tree-shape-probe.mjs` 量真字段名、`frame-splice-source-probe.mjs` 用仓库自己的源码验证拼好的树）


