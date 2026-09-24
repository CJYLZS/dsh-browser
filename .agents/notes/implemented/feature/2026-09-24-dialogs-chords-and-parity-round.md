# Agent Note: 与 ZCode/Codex 对照后的四项补齐：对话框、手势、快照查询、技能

Status: implemented

## Problem

本插件的能力面是照着"六个工具、代码优先"的取向长出来的，但对照两条外部实现后暴露出三类缺口：

- **ZCode 的内置 browser-use**（自研，`packages/shared/src/browser-use/*` 与 `packages/core/src/browser-client/*`，对齐 Codex 的对象模型）有我们完全没有的**输入面**：修饰键组合、右键、双击、坐标路径、`getJsDialog`。我们的 `NAMED_KEYS` 只有 13 个无修饰键，`dispatchInput` 对其它键名直接抛错，`browser_click` 不传 `button`/`clickCount`。
- **Codex 的 in-app browser**（官方文档）在同一个位置给出答案：**对话框阻塞渲染进程，直到有人回答**。我们从未注册 `page.on('dialog')`，于是 Playwright 静默自动 dismiss：`confirm()` 恒 false、`prompt()` 恒 null，而回报写的是 "The page did not change"——这不是"缺一个能力"，是**给出了错误的答案**。
- 两者的快照都优先"结构化 + 可缩小"，Codex 把它作为 2x 往返优化的来源；我们只有 `target=`/`depth=`，没有按内容筛选，也没有几何信息。

## Decision

四项一起落地，全部走"加参数不加工具"（工具面固定 6 个，见[工具面优化](2026-09-24-tool-surface-optimization.md)）：

1. **对话框必须事前声明。** 每次动作/导航/求值都可带 `dialog: "accept" | "dismiss"`（prompt 另带 `dialogText`）；会话层注册 `page.on('dialog')`，按"最近一次在飞的调用"的策略回答，**永远不留下未回答的对话框**（页面在等答案时不跑脚本、不渲染、不答主线程协议），并把 `DialogReport` 写进结果、把 `dialog` 记进 `changed`。未声明时按 dismiss 回答并如实上报。
2. **输入通道补齐"代码做不到"的三样**：键盘组合键（`Control+A`、`Shift+Tab`、`Meta+Enter`，含 CDP modifiers 位、无文本抑制、Shift 只对字母改大小写）、鼠标 `button`/`double`（双击是两组 press-release，第二组 `clickCount: 2`）、以及 `browser_type` 的 `ref` 变成可选——不给 ref 就是"按键发给页面当前焦点，不移动焦点、不替换任何东西"，这是 Escape 关菜单唯一说得通的表达。侧栏转发同一套（`Ctrl+A` 以前往页面里插一个 "a"），但**发之前先用 host 的键表自检**，原因见下一节。
3. **快照加 `find` 与 `boxes`**：`find` 收文本或 `/pattern/flags`，只打印匹配节点**及其在树里的路径**（祖先也打印，深度与整页快照一致），一个匹配都没有时说"没匹配上"而不是回一段空文本；`boxes` 给每个会打印的元素附视口坐标，取自 `DOM.getContentQuads`——与点击落点同一个来源、同一套坐标。
4. **技能与不可信规则**：新增 `skills/dsh-browser/SKILL.md`（frontmatter 自描述，正文是纪律），经 `ctx.inject(['skills'])` 注册；不可信规则同时写进工具描述（`browser_snapshot`、`browser_evaluate`），因为它必须常驻而不是按需加载。

## 键表只有一份：面板不发 host 会拒的和弦

和弦进协议时，两半各留了一份键名表：host 的 `NAMED_KEYS`、以及面板自己的同名常量。只要两份表能各自长出一点不同，面板就能拼出 host 解析不了的东西，而**最普通的一次按键就撞上了**：在侧栏画布上单独按下 Ctrl，面板按"修饰键 + 键"拼出 `Control+Control`（修饰键成了它自己的键），host 按"和弦要把键写在最后"拒收。拒收走的是 WS 的 error frame，而面板把 error frame 当作"浏览器出问题了"——整屏提示 +「重启浏览器」按钮，于是一次普通按键看起来像浏览器坏了（`Alt+Alt`、`Shift+Shift`、`Ctrl+F5` 同理，后者的键名根本不在表里）。

现在键表住在 `src/browser/keys.ts` 一处：host 用它解析并派发，面板用 `isDispatchableKey` 在**发之前**自问一句，答"不能"就不发。于是面板不再送单按的修饰键、不再送表里没有的键（`F5`、`Insert`）；工具侧不变——`browser_type` 仍然拒绝并指路，因为那里的调用方是模型，它需要知道自己写错了。

## 为什么对话框是"事前声明"而不是"事后回答"

这是本轮唯一一个真正有取舍的设计。对话框是同步阻塞的：页面在 `confirm()` 里等着，渲染进程不答任何需要主线程的协议调用。我们的每个动作后面都跟着 settle（`Runtime.evaluate` 读 MutationObserver 的槽位）、点击前有 `pressPoint`（`Runtime.callFunctionOn`）——**留一个未回答的对话框，等于让下一次调用去等一个永远不会回答的页面**，正是[被取消的调用](../bug-fix/2026-09-24-cancelled-calls-and-bounded-waits.md)那一篇记下的最坏失败。所以答案只能由**发起调用的那一次**声明，副作用是模型要先知道会有对话框（第一次 dismiss 的回报会告诉它，下一次带上 `dialog: "accept"`）。

## 证据

- **真机**（`scripts/snapshot-regression.mjs`，headless Chrome 153）：`[19]` 打印的 `box=230,167 980x48` 与页面自己的 `h1.getBoundingClientRect()` **逐数字相同**（`[230,167,980,48]`）——坐标空间这类断言只有真机能证明；`find` 在 github.com/trending 的 364 行树上按一个可访问名收敛到带路径的几行；`[20]` confirm 的 dismiss/accept 与 prompt 的 `accept("Ada")` 都同时满足"回报说的"与"页面记下的"；`[21]` `Control+A` 之后输入框的值仍是 `hello` 且 `selectionStart/End = 0/5`（旧实现会变成 `helloa`），右键得到 `contextmenu`、双击得到一次 `dblclick`、无 ref 的 Escape 到达页面且焦点仍在原元素。
- **单元/行为**（`node --test`）：组合键的参数序列（Enter 无修饰时与旧行为逐字段相同，零修饰不写 `modifiers`）、无 ref 的按键不发 `DOM.focus`/`insertText`、对话框的四种类型与 prompt 默认值、`find` 的匹配字段与路径、文本 run 合并后整句可被查询命中、`boxes` 只向页面询问会打印的元素。
- **活面板**（GUI 里量，`client-keys.test.ts` 的对照）：在页面上临时接管 `WebSocket.prototype.send`，把合成 keydown 打到侧栏画布上，录下**真正发出去的帧**。修前：`Control+Control`、`Alt+Alt`、`Control+F5` 都发出去了（host 随即拒收）；修后：这三个一条都不发，而 `Control+a`（`{"type":"key","key":"Control+a"}`）、字面 `a`（`text`）、`Enter`、`Shift+ArrowUp` 与修前逐字节相同。`dsh-client-hmr` 把新 `lib/client.js` 推过去即可复量，不用刷新页面。

## Alternatives considered

**把对话框留着不答、让下一次调用回答**（Codex `getJsDialog()` 的形状）：页面被阻塞期间不跑脚本、不渲染、不答需要主线程的协议调用，我们的 settle 与 press 探针都会挂到超时，等于把"浏览器再也回不来"请回来。**加第 7 个工具 `browser_dialog`**：工具面固定 6 个，而且它答不了——对话框在结果返回前就已经被回答或阻塞页面，没有"事后"这个时刻。**保持 Playwright 的静默 dismiss**：它把"页面问了一句话然后被拒"报成"页面没变化"，比缺失更坏。
**把快捷键留给 `browser_evaluate` 里的合成 KeyboardEvent**：合成事件不是可信事件，站点不认，这正是插件存在的理由（点击的真实鼠标事件同理）。**给所有键建一张完整 keycode 表**：只有字母的大小写在各键盘布局上一致，`Shift+1` 在不同布局是不同的字符，所以非字母一律按书写原样派发，需要输入字符就用 `text`。**为"按键"新开 `browser_press`**：它是 `type` 的一种形状（无 ref、无 text），新工具只会让模型在两个入口之间选。
**把技能写成更多工具描述**：不可信规则确实进了工具描述，但"一次任务读一遍"的纪律按调用重复是纯开销；**让 harness 扫描插件目录提供技能**：bundle 层没有声明技能的位置，插件贡献技能的正规路径是注册。

## Consequences

- 结果面变大：`ActionReport`、快照、求值、截图的结果都可能带 `dialogs`，`changed` 多一个 `dialog` 取值。没有对话框时字段不出现，因此"每次调用多一行"的代价只在真出现对话框时付。
- 键盘从"13 个无修饰键 + 插字符"变成"名称/单字符/和弦"，未知修饰键与未知键都报错并指路；`NAMED_KEYS` 之外的多字符键名（`F5`）行为不变，仍建议改用 `text`。这是**工具侧**的合同；**面板侧**改由 `isDispatchableKey` 先拦（见上），一个普通按键不会变成一条错误提示。
- `browser_type` 的 `ref` 与 `text` 变为可选：`clear` 在无 ref 时无意义（没有元素可选旧值），文档写明"不替换任何东西"。
- 新增 peer `@deepseek-ai/dsh-skill`（`>=0.1.7-rc.1 <0.2.0`），运行期用 `ctx.inject` 软依赖：没有技能注册表的 profile 照常拿到六个工具，只少一段纪律；技能文件读不到时打 warning 而不是让插件加载失败。
- 侧栏的快捷键不再是"插入一个字符"：`Ctrl+A` 选中、`AltGr` 组合仍按字符发送（Windows 上 AltGr 就是 Ctrl+Alt）。
