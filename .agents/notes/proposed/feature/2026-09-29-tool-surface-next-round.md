# Agent Note: 工具面下一轮：定位要能再解析，动作回报要有内容

Status: proposed

<!-- 全部条目都已落地（2026-09-29，最后一轮 P1-4 / P2-5 / P2-6 / P3-7 + 候选小项）。这篇保留为**来源记录**：每条都销账并链到它自己的笔记，方案本身不再有待办；它的两个参照系梳理与"明确不做"清单仍是这两轮取舍的现场。 -->

## Problem

[09-28 那一轮](../testing/2026-09-28-local-spa-drive-frictions.md)真机使用（本地长驻 SPA）留下 9 条摩擦，但**只列了症状，没有定方向**。把它们按机制归并后只剩两个结构缺口：

1. **元素句柄只能在快照时刻解析一次。** ref 属于页面、导航即失效，这是[快照的语义](../../implemented/bug-fix/2026-09-25-action-reporting-and-snapshot-semantics.md)里刻意的决定，但它同时意味着 SPA 每次重渲染都作废手里全部 ref；而同一页出现三对同名控件（『暂停』×3、『重置』×3、『启动并连接』×2）时，ref 是**唯一**的定位手段，于是"点一个按钮"要三步：`find` 拿 ref → `target=` 看子树 → `click`。
2. **动作回报只说"变了"，不说"变成什么"。** `changed` 的取值域是 `url`/`title`/`dom`/`dialog`（[session-browser.ts](../../../../src/browser/session-browser.ts)），`dom` 只带一个 mutation 计数。于是"点了只弹瞬时 toast 的按钮"回报成 `The page changed: dom.`，而 7 秒后读到的徽标、状态、消息流全没变——本轮最贵的一次误判就是这么来的。

同期两个成熟参照系都摆在手边，需要一次明确的"抄什么、不抄什么"：**Codex**（本机 ZCode 的 `browser-use` 插件就是它的镜像，源码里到处写 Codex-compatible）与 **Playwright MCP**（DSH 自己就带一个实验性 provider）。本笔记只定方向与取舍；9 条的细节仍以 09-28 那篇为准，落一条销一条。

## 两个参照系

### Codex / ZCode：一个工具 + 一整套对象 API

模型侧**只有一个工具**：一个 Node REPL（`js`）。浏览器是那个 REPL 里的对象——`agent.browsers.get/getForUrl/getDefault` → `browser.tabs.*` → `tab.playwright.*`、`tab.cua.*`（坐标）、`tab.dom_cua.*`（节点）。组合发生在 JavaScript 里（`locator.filter({hasText}).nth(0)`、`Promise.all`），而不是发生在工具参数里。ZCode 0.5.1 的 API 表与 Codex 云端抓取的快照有差异，值得记下：

| 成员 | ZCode 0.5.1 | Codex（2026-08-31 快照） |
|---|---|---|
| `playwright.domSnapshot` | ✅ 默认观察手段 | ✅ |
| `getByRole/getByText/getByLabel/getByTestId` + `filter({has,hasText,visible})` + `count()` | ✅ | ✅ |
| `waitForURL` / `waitForLoadState` / `locator.waitFor` / `expectNavigation` | ✅（常规预算 3000 ms 封顶） | ✅ |
| `screenshot({fullPage, clip})`，必须同格 `emitImage` 内联 | ✅ | ✅ |
| `cua` / `dom_cua` | ✅ | ✅ |
| `getJsDialog()` | ✅ | ✅ |
| `setViewportSize` / `recording` / `content.export` | ✅ | ✅ |
| **`dev.logs({levels, filter, limit})`（console）** | ❌ | ✅ |
| **`clipboard.read/write`** | ❌ | ✅ |
| 风险动作确认政策（输入敏感数据即"传输"） | ❌ | ✅ |

它的纪律里有几条与我们同构、几条我们没有：「一次观察周期只做一个改状态的动作」；**不要同时取快照和截图**；`count()` 为 0 就立刻重取快照、别去等超时；**超时是重取快照的信号，不是重试信号**；「URL 没变不等于点击失败」；页面内容是不可信数据。它还把低频指引做成按需加载（`agent.documentation.get('screenshots')`），而不是一次性塞进技能。

### Playwright MCP：工具矩阵，元素参数是「ref 或唯一选择器」

上游 `@playwright/mcp` 走另一条路：几十个小工具，但**元素参数只有一种形状**——`target: "Exact target element reference from the page snapshot, **or a unique element selector**"`。同形状贯穿 `browser_click` / `browser_type` / `browser_hover` / `browser_drag` / `browser_select_option` / `browser_take_screenshot` / `browser_evaluate`。我们需要的四个缺件它都有现成答案：

- `browser_wait_for(text | textGone | time≤30s)`——等条件，而不是 sleep；
- `browser_console_messages(level, all)`——console，且 `all` 决定"自上次导航以来"还是"整个会话"；
- `browser_take_screenshot(target, fullPage, scale: css|device)`——元素级与整页；
- `browser_find(text | regex)`——只回匹配节点加它在树里的路径。

### 我们：6 个固定工具，参数是 ref

`browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_evaluate`（[src/tools/index.ts](../../../../src/tools/index.ts)）。没有 locator 层，没有 console，没有等条件，截图只有视口一种形状。已有的优势不要丢：镜像在侧栏、按 session 隔离的真实 Chrome、以及**逐动作的问页面再派发**（遮罩拒绝、只读框拒绝、跨页旧 ref 拒绝）——这些是两侧都没有的。

## 同一模式的通用版，DSH 已经有了：PTC

**"一个工具 + 一整套对象 API"不是 Codex 专有的形状，DSH 在 harness 层就有一个通用实现，而且比插件自带一个 REPL 更合适**：`dsh-tools` 的 `mode: native | ptc | both`。选 `ptc` 时模型只看见保留的 `run_code` 传输工具 + 一份**按已加载 runtime 语言生成的 SDK**，每个可见工具都是其中一个 async 绑定；程序按 async 函数体执行，顶层 `await` 与 `return` 可用，`Promise.all`、循环、分支都在。后端由 `ctx.ptcRuntime` 提供（`dsh-ptc-runtime-node` 执行可擦除 TypeScript，Python 那个还是实验性的）。

对我们意味着三件事：

1. **组合层不该由插件自建。** 我们的六个工具在 PTC 下自动变成 `tools.browser_click({...})` 这样的绑定，和 `bash`、`read`、`job_output` 同处一个程序。自己再造一个 REPL，等于复制 `ctx.ptcRuntime`、发明第二套要学的接口，并绕过 SDK 生成、逐子调用的策略检查与事件、以及「外层 `run_code` 才有硬尺寸上限」那套结算约定。
2. **并发默认就是安全的。** 注册表里 `isConcurrencySafe?(args)` 只有**恰好 `true`** 才算 parallel，**不声明就是 exclusive**（harness 的 `packages/core/tools/src/index.ts`）。我们六个工具都没声明，所以 `Promise.all([browser_click(a), browser_click(b)])` 会被注册表串起来跑，而不是同时打到同一个 CDP 会话上。要放开也必须是有意识的（contract 要求 opted-in 的执行不得改父级状态）。
3. **它抬高了"什么算好工具"的门槛**，而这正好是下一轮要做的事：结果要是**程序能读的值**（P0-2 的 diff 从散文变成可分支的数据）、错误要**可捕获且可执行**（P0-1 的"拒绝并列出候选"胜过"猜一个"）、参数形状要能从生成的声明里猜出来（我们现有形状没问题）。

代价也要记：PTC 下内层子调用的事件只进日志，GUI 里看到的是外层程序的卡片，而不是每次点击各自那张卡片；所以**native 仍应是默认呈现**，PTC 是可选（今天连 harness 自己都还是 `DSH_TOOLS_MODE` 环境变量级的临时开关，逐会话选择"being designed"）。

## 对照表：9 条摩擦落在哪

| 09-28 摩擦 | 机制 | 生态里的答案 | 我们下一轮 |
|---|---|---|---|
| 1 只报"变了"不报"变成什么" | 回报无内容 | Codex：按预期效果判断 + `dev.logs` | **P0-2** 动作回报带紧凑 diff |
| 2 同名控件无法消歧 | 定位只有 ref | 两侧：语义定位 + 唯一性拒绝 | **P0-1** 定位参数化 |
| 3 重渲染废掉全部 ref | 句柄一次解析 | 两侧：动作时才解析 | **P0-1** 同上（同一处方） |
| 4 没有等条件，只能 sleep | 缺原语 | `browser_wait_for` / `locator.waitFor` | **P1-3**（工具或 skill 规范，二选一） |
| 5 evaluate 返回无上限 | 结果形状 | 两侧都没有（同样问题） | **P1-4** 默认限长 + 可见文本档 |
| 6 字符串被 JSON 转义 | 渲染 | Codex：REPL 原样返回值 | **P1-4** 字符串原样、对象美化 |
| 7 顶层 `return` 报错 | 模板缺位 | n/a（REPL 求值表达式） | **P1-4** 自动兜一次 + 写进 skill |
| 8 截图只有视口 + 二次 `read_image` | 形状 | 两侧：`fullPage`/元素级 + 内联 | **P2-6** 截图形状 |
| 9 `depth=` 截断不指路 | 文案 | `browser_find` 给了另一条路 | **P2-6** 截断提示给节点数与深度区间 |

## Proposal

**P0-1｜定位参数化（吃第 2、3 条）。** `browser_click` / `browser_type` 的元素参数从 `ref` 扩成「ref **或** 语义/CSS 定位」（`role`+`name`、`text`、`selector` 三选一），命中多个**拒绝并列出候选**（每项附最近的具名祖先），命中 0 个立即报错并指路重取快照。这既是两侧唯一收敛的形状，也顺带解决 ref 被重渲染作废——选择器在动作那一刻才解析。**是参数，不是新工具**，符合「新能力做成参数，不加工具名」。

**P0-2｜动作回报带紧凑 diff（吃第 1 条）。** `armSettle()` 已经在 dispatch **之前**装好 MutationObserver、已经数了 mutations，把它从「计数」升级成「记前 k 个增删改的名字」即可，机会成本几乎为零。目标形状：`dom: +1 status "先在实例表里点一行…"`、`~ button "启动并连接" disabled: (none) → "true"`，条数封顶（k≈5）并说明省略了多少。**每一项都要是结构化的字段**（role/name/变化种类/前后值），因为 PTC 下模型会写代码去分支——散文只够 native 模式下人读。（**已落地**，见 [动作回报里的变更清单](../../implemented/feature/2026-09-29-action-report-changes.md)；两处与这里的原方案不同：参照系实测下来 ZCode/Codex 的动作返回 `undefined`、根本没有这一层，所以没有可抄的实现；字段用的是页面自己能担保的事实——`tag`/`role` 属性/`preview`——而不是计算后的无障碍 role/name。）

**P1-3｜等条件（吃第 4 条，工具与规范二选一）。** 要么加 `browser_wait(text | role+name | selector | url | time, timeoutMs)`，要么维持「不加工具」而把「轮询到条件成立」的规范模板写进 skill。**不要两个都做**。本轮的等待对象是应用层状态（引擎冷启动 1 s 到几十秒），sleep 表达不准，所以纯文档救不了语义，只能救「怎么写」。**量了参照系之后的建议：加工具**（它有四个等待方法且劝退固定 sleep，且我们的定位词汇可以原样复用，模型只需多学一个动词；形状与理由见本文 `## 参照系实测（下一轮：P1-3 起，2026-09-29）` 那一节）；这条同时**推翻** AGENTS.md 里"等待留给 evaluate"的旧决定，推翻理由必须是 09-28 的真机摩擦，不是"参照系有"。

**P1-4｜evaluate 结果的形状（吃第 5、6、7 条）。** 默认限长（超限截断 + 保留现有 spill 提示）、加一个「只取可见文本」的口（排除 `style`/`script`/`noscript`，就是那个 387 KB 的来源）、字符串原样而对象美化、`Illegal return statement` 自动包一层 async IIFE 重试一次。

**P2-5｜`browser_console`（唯一值得新加的工具）。** 理由不可替代：**监听必须在页面脚本跑之前装上**，事后用 evaluate 补不了，而本轮"点完什么都没发生"的静默失败只能靠它解释。形状照抄两侧：级别过滤 + 「自上次导航以来 / 整个会话」+ 落盘回路径。

**P2-6｜截图形状（吃第 8、9 条）。** `fullPage` / `target`（元素级）/ `inline`；`inline` 走 harness 已有的 image block（`read_image` 就是这条路的先例），代价是需要 `ctx.inject(['attachments'])`，这是本轮唯一的跨包依赖。`depth=` 的截断文案补上节点数与内容深度区间（第 9 条，这已是第二次撞到）。

**P3-7｜skill 补配方表与模板。** 「读页面 / 找控件 / 等条件 / 看某区域 / 点重名控件」各用哪条。容器已经就位：技能已声明 `resourceBase: {kind:'directory'}`（[src/skill.ts](../../../../src/skill.ts)），harness 会把「Base directory for this skill: …，按需加载」交给模型，所以**加 `skills/dsh-browser/references/*.md` 零代码即可**——正是 Codex `agent.documentation.get(…)` 那套按需加载。

**候选小项（量参照系时捡到的）：把"没变化 ≠ 失败"写进渲染。** 它的动作回执里带一句 `effect_note`："…this is evidence, not proof of failure. … Otherwise do not repeat it blindly."——我们现在的"页面没有变化"没有任何这类限定，模型据此很容易把"点了没反应"读成"点击失败"并重试（重试恰好是 09-25 那轮量到的"把菜单关掉"的来路）。**成本是一行字**，但会让每次"没变化"的回报都长一点，所以列成候选而不是直接做：先看 `changedText()` 那三种（未 settle / 变了 / 没变）里哪一种最值得加限定语。

**明确不做**（每条都在下节留了理由）：不做 REPL/单工具架构（组合层归 harness 的 PTC，不归插件）；不重抄 Playwright MCP 的工具矩阵；不抄 `browser_handle_dialog` 的事后回答；不抄 `run_code_unsafe` 与无限制文件访问；不把"点第 n 个同名控件"做成参数；不抄参照系回执里的 `retry_action` 指令字段（我们报事实不给指令，`settled`/`changed`/`changes` 已经把判断所需的事实给全）。

## 官方侧现状（2026-09-29 核对）

想确认"官方是否也要把浏览器做成内置插件"，答案是**没有**（核对点：harness checkout 的 `dsh-v0.2.0-rc.1`；npm 上 `@deepseek-ai/dsh` 的 `latest` 仍是 `0.1.7-rc.2`）：

- 内置的只有**侧栏 Browser 标签**（`@deepseek-ai/dsh-client-ui-sidebar-browser`：Web 用 iframe、Desktop 用 Electron webview）。它是**呈现面**，不是工具面——它的决定笔记明说 "Browser state is presentation state. It does not enter the Session log, model request, resource model"。而且在 `dsh-web-app` 的 bundle 补丁里它对非 desktop profile 是 `disabled` 的（"Web profiles opt in; Desktop retains sandboxed HTTP(S) Browser tabs"），这一条在 `0.1.7-rc.2` 就已如此，不是新变化。
- 面向模型的浏览器走**单槽注册表** `ctx.browserUse` + 三个**实验性** provider（`browser-use-playwright-mcp` / `browser-use-chrome-devtools-mcp` / `browser-use-stagehand-native`），"require explicit activation"，没有任何 shipped bundle/preset 挂它们。
- 插件管理器**预置但默认关闭**的 bundle 只有 4 个（agent-team-profile、voice-input、auto-review、schedule），没有浏览器。
- `0.1.7-rc.2 → 0.2.0-rc.1` 之间与 browser 相关的改动只有版本号、测试与样式/文案，**没有新能力**。

推论有两条：**我们的定位没有被官方取代**；同时**"想要 Playwright MCP 那套工具矩阵的人应该去挂那个 provider"**——这是我们敢保持工具面薄的依据，而不是偷懒的理由。

## 参照系实测（下一轮：P1-3 起，2026-09-29）

探针 [`.prove/zcode-action-surface.mjs`](../../../../.prove/zcode-action-surface.mjs) 量四个可读产物（`browser-use` 0.5.1/0.4.2 的客户端、0.4.2 的服务端、`node-repl-host` 0.6.0）里的字面出现次数；接口面另读 `docs/api.json`、`docs/playwright.md`、`skills/control-browser/SKILL.md`。**注意 0.5.1 的缓存里没有 `dist/`**（`main` 指向不存在的文件），所以能量的最新服务端是 0.4.2。

### P1-3 等条件：参照系把它当**一等原语**，但只等**页面状态**

- **方法面**：`locator.waitFor({ state: "attached" | "detached" | "visible" | "hidden", timeoutMs? })`、`page.waitForLoadState({ state?, timeoutMs? })`、`page.waitForURL(url, { timeoutMs?, waitUntil? })`、`expectNavigation(action, { url? })`，外加一个**单独的命令** `tab.playwright.waitForTimeout(ms)`。`networkidle` 明确**不支持**。
- **没有谓词等待**：`waitForFunction` / `poll` 一处都没有。也就是连参照系也不给"轮询任意表达式"，它给的是"等到某个**元素状态**成立"。
- **预算**：常规定位/URL/加载态/evaluate 操作**默认 3000 ms，且请求更大的值也封顶在 3000 ms**；固定 sleep 是独立命令、且在文档里被明确劝退（"Prefer a targeted wait or fresh `domSnapshot()` over routine sleeps"、"for the rare case where no concrete page state can be observed yet"）。长活儿的官方答案是**拆成多次调用**：REPL 那一格 "…than 30000 ms… Set it to at least the estimated total runtime plus 15000 ms. If that exceeds the 120000 ms maximum, split the work into multiple calls."——**120 s 上限与我们的 `browser_evaluate` 完全一致**。
- **失败纪律**：超时/strict/解析失败之后**不许重试同一个定位器**——"take a fresh `domSnapshot()` and rebuild it from snapshot facts"、"A timeout is a signal to refresh the snapshot and rebuild the locator, not to retry it unchanged."
- **`expectNavigation(action)` 是"先装观察者再动作"**：它**在动作之前**起一个加载态等待器，并提醒"已加载的旧页面可能直接满足它"，所以要用 `{ url }` 证明真的换了页面。这与我们 `armSettle()` 在 dispatch 之前装 MutationObserver 是同一条原理。
- **推论（这是本轮要定的形状）**：我们缺的不是"再写一个 sleep"，而是**一个能说出"在等什么"的原语**，且它的结果是**可判断的**（命中/超时，超时时页面现在是什么样）。参照系的等待词汇全是页面状态，正因为应用层就绪**最终表现为页面状态**（09-28 那 6 次 sleep 等的"引擎就绪"在页面上就是一个状态文字/徽标/行）。
- **建议：加 `browser_wait`（工具），不加 skill 模板。** 理由按重要性：①**它复用我们已有的定位词汇**（`text` / `role`+`name` / `selector`，与 `browser_click` 完全同一套名字和同一个解析器），所以对模型的新增词汇量只是**一个动词**，这是"第七个工具"这笔账里最关键的一项；②摩擦的实质是**结果形状**——evaluate 里手写的轮询循环不会回报"没等到 + 页面现在说什么"，而这正是"按预期效果判断"需要的信息；③超时是**值**（`matched: false` + 现状 + `changes`），不是异常——未捕获的异常会**直接判 `CODE_RUN_FAILED`**，而"还没就绪"是正常分支（与 `## Acceptance criteria` 里那条"超时不抛异常"一致）；④参照系把等待做成一等原语（四个方法），且**禁止**用固定 sleep 顶替。
- **要一起记下的代价/反证**：AGENTS.md 现在明确写着"等待留给 evaluate，真遇到再加"（[工具面优化](../../implemented/feature/2026-09-24-tool-surface-optimization.md) 那一轮的决定）。加工具就是**推翻它**，理由必须是真机摩擦（09-28 第 4 条）而不是"参照系有"；并且**不能两个都做**——决定加工具之后，skill 里不再写轮询模板（否则同一件事两个家）。
- **参数草案**：`text?` / `role?`+`name?` / `selector?` / `url?` / `time?`（**恰好一个**，误用按现有风格拒绝并指路），`timeoutMs?` 默认约 10 s、上限由工具预算给出（工具的 `timeoutMs` 要大于等待上限，否则等待与调用同一刻到期，回报会变成"调用超时"而不是"没等到"）。结果：`{ matched, waitedMs, url, title, element?, text?, changes? }`——超时时 `changes` 复用 P0-2 的清单，直接回答"那这段时间页面动了什么"。

### P1-4 / P2-5 / P2-6 / P3-7 的同一次实测

- **P1-4（evaluate 结果形状）**：参照系**对程序返回值没有任何上限**（`MAX_RESULT`/`maxResult`/`resultSize` 全 0）——这条摩擦在它那里不存在答案。可抄的是它**元素列表**的截断写法：按优先级排序（`elementPriority`，保留祖先）、稀疏索引、并写明 `N of M elements shown (selected by priority, ancestors kept) — indices are sparse; K hidden`；元素值 `truncate(value, 60)`。另外 `nodeRepl.write(text)` 走文本、程序返回值走**结构化通道**，佐证"字符串原样、对象美化"的方向。
- **P2-5（`browser_console`）**：**四份产物里 `consoleAPICalled` / `Log.entryAdded` / `exceptionThrown` 全 0**——参照系根本不捕获页面 console 与异常。所以这是我们自己的主意，不是抄来的；而且 **P0-2 落地之后它的理由变窄了**：瞬时 toast 那类"点完什么都没发生"现在由变更清单解释，剩下的独有价值只有**不留 DOM 痕迹的失败**（handler 抛异常、fetch 失败、资源 404）。这条要在动手前重新称一次价值，不能靠上一轮的理由惯性。
- **P2-6（截图形状）**：`screenshot({ fullPage?, clip? })` + `elementScreenshot({ includeNonInteractable?, x, y })`（**坐标**，不是 ref）+ `nodeRepl.emitImage(bytes)` 产出真正的 image 内容块。我们的 `target=<ref|selector>` 比它的坐标版**更强**（我们有 ref，它只能给点），所以元素级截图按原方案做；`inline` 的障碍在我们这侧（image 块要 attachment 引用），继续按原方案记成唯一的跨包依赖。它还有一条纪律值得抄进 skill：截图超时**不要立刻重发同一张**。
- **P3-7（skill 配方表）**：参照系把它做成**带元数据的文档注册表**：`documents.json` 里每篇有 `mode: "included" | "lookup"`、`when: { browserTypes, requiredApiMembers }`、`description`（什么时候该读），模型用 `agent.documentation.get(name)` 按需取；`SKILL.md` 是常驻那一半（18.8 KB），`lookup` 那几篇很短（`screenshot.md` 1.2 KB、`viewport.md` 560 B）。我们的 `resourceBase: {kind:'directory'}` 已经给出 lookup 那一半，缺的只是**文件本身**；`when`（能力门控）这一层我们的技能注册表没有对应字段，记为不抄。

## Alternatives considered

**改成 Codex 那种「一个 REPL 工具 + 对象 API」。** 组合能力最强，但**这个模式在 DSH 里已经有通用实现，而且不由插件拥有**：`dsh-tools` 的 `mode: ptc` 就把每个可见工具变成生成 SDK 里的一个绑定，交给 `ctx.ptcRuntime` 执行，顶层 `await`、`Promise.all`、循环都在。插件自己再包一个 REPL，等于复制这套 seam、发明第二套接口，并绕过 SDK 生成、逐子调用的策略与事件、以及结算约定；同时它会把「工具面的形状」从注册表手里挪到一个插件私有的对象图上，侧栏镜像、逐动作问页面这三条既有约束都建立在前者之上。我们要的是**被组合**（结果可读、错误可捕获、并发默认安全），不是**自己当组合层**。

**把 Playwright MCP 的工具矩阵抄一遍（hover/drag/select_option/press_key/resize/tabs/file_upload…）。** 与「工具少而必要、新能力做成参数」直接冲突，而且 DSH 已经有一个上游 provider 提供这一整套——想要它的人挂它就行。我们补的应该是**表达不了**的（console 的历史、动作的 diff），不是**表达得难看**的。

**什么都不做，全交给 `evaluate` 兜**（09-24 对「等待」的选择，也是现状）。能兜住，但代价是 6 次固定 sleep、一次 387 KB 返回、以及一次"判定为空操作"的误判——每次都烧调用与上下文，而"等应用层状态"根本无法用 sleep 表达准。**量了参照系之后这条仍是有竞争力的选项**（它有四个等待方法，但那是 REPL 里免费的方法；对我们是一个新工具名，与"工具少而必要"只差一步），所以它留在这里而不是被删掉：如果下一轮把"复用定位词汇"的收益估低了，改选它就是改一行 proposal 的事。

**给 click 加「点第 n 个同名控件」。** 同名控件的稳定排序无法保证，会制造新的静默错点；按文本 + 祖先定位才可读。所以 P0-1 的消歧是"命中多个即拒绝"，不是"挑一个"。

**让 ref 跨重渲染永久稳定。** 与已落地的「ref 属于页面、跨页旧 ref 必须报错」冲突：让一个字符串同时可能指两个页面的两个元素，比作废更危险。折中是失效时按 role + name 重解析并说明——那正是 P0-1，而不是改 ref 的语义。

**抄 `browser_handle_dialog` 那种"事后回答对话框"。** 页面在对话框被回答前不跑脚本、不响应需要主线程的协议调用，事后回答是死锁而不是取舍；我们的「动作前声明回答」是[实测结论](../../implemented/feature/2026-09-24-dialogs-chords-and-parity-round.md)，不动。

**只在 README / skill 里写清楚，不改工具。** 09-28 那一轮读过 skill，摩擦照旧：文档能救「不知道怎么写」（模板类，P1-4/P3-7），救不了「不知道发生了什么」（观察类，P0-2/P2-5）。这条仍适用于纯模板项，所以 P1-3 保留了它。

## Acceptance criteria

**动手前的前置条件已落地**：`test/ptc.test.ts` 是这一轮的 PTC 兼容门禁（[那一篇](../../implemented/testing/2026-09-29-ptc-compatibility-gate.md)）。下面每一项都会改工具面或工具签名，所以每一项都要同时给那张 `PTC_CALLS` 表补一行，否则门禁红。

每条要么落地并带一条可量断言，要么被明确记为「不做」并从本笔记删除：

- ~~**P0-1**：`role`+`name` 定位与同元素 ref 点击等价；命中多个时**拒绝**且候选里带祖先名；SVG 这类无名接收者的拒绝消息给出可执行的下一步（09-24 第 5 条）。~~ **已落地**（2026-09-29），三条都带断言，见 [定位参数化](../../implemented/feature/2026-09-29-locator-parameters.md)。
- ~~**P0-2**：动作回报出现 diff 条目（条数与文案可断言），且"只改瞬时 toast 的按钮"能报出那次变化；超过 k 条时写出省略数量；条目字段结构化（PTC 程序可分支），不只是渲染文本。~~ **已落地**（2026-09-29），四条各有断言，真机回归 [22] 在一个 fixture 上同时量到三种形状，见 [动作回报里的变更清单](../../implemented/feature/2026-09-29-action-report-changes.md)。
- ~~**P1-3**：若加工具，命中与超时两条路径各有断言、超时**不抛异常**（返回 `matched: false` + 现状 + `changes`，因为未捕获异常会直接判 `CODE_RUN_FAILED`，"还没就绪"是正常分支）；给两个条件、或条件与 `time` 同时给，要**拒绝并指路**；等待上限必须小于工具自己的 `timeoutMs`（否则同刻到期会把"没等到"报成"调用超时"）。~~ **已落地**（2026-09-29，选了"加工具"）：7 条断言覆盖命中/超时/地址/固定等待/无页面/变更清单/拒绝，见 [等条件那一篇](../../implemented/feature/2026-09-29-browser-wait.md)。**真机也量过了**：`scripts/snapshot-regression.mjs` 的 [23] 用 `data:` fixture 验了六条（1200 ms 后出现的元素在 797 ms 命中、超时是值不是异常、地址条件不读树、等到的元素能被同一句 `text` 点中、元素与它内部的文本 run 只算一个答案），并**当场抓到一个定位层缺陷**（同一句 `text` 同时命中元素与其内部 run），修法记在 [定位参数化](../../implemented/feature/2026-09-29-locator-parameters.md) 里。
- ~~**P1-4**：截断标记与 spill 提示同时出现；可见文本档不含 `style`/`script` 文本（用那个 387 KB 的表达式当反例）；字符串原样、对象美化各有一条渲染断言；顶层 `return` 的那段代码跑第二次不再报给模型。~~ **已落地（2026-09-29）**：字符串原样、超长落盘（`truncated` + 路径 + 预览）、顶层 `return` 包成 async 函数体重试一次，见 [evaluate 结果的形状](../../implemented/feature/2026-09-29-evaluate-result-shape.md)。**可见文本档按量到的证据改为不做**：参照系明确禁止 dump `body` 文本（"Use one bounded snapshot"），而 `browser_snapshot` 的 `find`/`target`/`depth` 已经覆盖同一诉求。
- ~~**P2-5**：能捕获一次未捕获异常与一条 `console.error`；导航后默认只看本轮，`all` 能取回导航前的。~~ **已落地（2026-09-29，选了"加工具"）**：`browser_console` 订阅 `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` / `Log.entryAdded`，每页一份有界缓冲、导航即清空；真机 [24] 一次量到四类消息（并证伪了"两个域会重复上报"与"对象只剩 Object"两条顾虑），见 [页面自己的话](../../implemented/feature/2026-09-29-page-console.md)。`all`（跨导航历史）**不做**，与"消息属于产生它的那份文档"冲突。
- ~~**P2-6**：元素级与整页截图的尺寸断言（元素截图小于视口截图）；内联路径不产生 `read_image` 的往返。~~ **已落地（2026-09-29）**：`fullPage` / 元素目标 / `inline` 三个参数，`clip` 的坐标空间由探针实测确定（页面坐标 + `captureBeyondViewport`，因此**不需要**先滚动），真机 [25] 六条断言；`inline` 的跨包依赖改成两个结构化声明的服务 + **截图之前**的路由门禁，见 [截图的形状](../../implemented/feature/2026-09-29-screenshot-shapes.md)。`depth=` 的截断文案同时补上"页面到第几层"（[aria 的那条](../../implemented/feature/2026-09-29-screenshot-shapes.md)）。
- ~~**P3-7**：`references/` 至少一篇，且 `test/notes.test.ts` 之外还应有一条断言保证 skill 里链接到的附属文件存在。~~ **已落地（2026-09-29）**：五篇按问题组织的配方，`skill.test.ts` 做**双向**对账（列出的必须存在、存在必须被列出）并检查每篇首行写着 `Read when …`；不做清单文件（技能注册表没有 `mode`/`when` 字段，harness 也不会读它，见 [技能配方](../../implemented/feature/2026-09-29-skill-recipes.md)）。
- **候选小项：把"没变化 ≠ 失败"写进渲染。** **已落地（2026-09-29）**：`changedText()` 的"没变化"那一支现在带上"这是页面说的话，不是对动作的判决；往别处看，别重按同一处"。同一条纪律也进了技能配方 `references/when-nothing-happened.md`。

## Risks

- **P0-1 会点错文本会变的控件**：靠"命中多个即拒绝"兜住，但"只有一个候选"时仍可能点到一个刚变成别的东西的按钮；所以解析结果要进回报（让模型看得见它点的是谁），并保留拒绝优先于猜测的默认。
- **每次动作多一次页面侧解析**，与「启动路径上不许有等页面回答的 await」的既有约定相邻；解析必须走 [cancelable()](../../../../src/browser/cancel.ts) 的既有上限，不能引入新的无界等待。
- **P1-3 若加工具，最大的风险是"它变成一个更体面的 sleep"**：一旦有 `browser_wait`，模型可能拿它当"等一会儿"用（`time: 8000`），那正是 09-28 那 6 次 sleep 的同一件事换了个名字。对策：`time` 只作为**最后手段**与其余条件并列存在（描述里写清它是"没有可观察状态时"的那条路），并且**结果里必须回报"这次等的是什么"**，让重复使用可见；同时 skill 只指路不写模板（二选一已经定了不做模板）。
- **P1-3 的第二个风险是"等在错误的页面上"**：等待与动作之间若发生导航/切换标签，等待的可能是另一份文档（参照系为此专门提醒 `expectNavigation` 可能被"已加载的旧页面"满足）。所以命中必须回报**命中的是谁**（`element`）与**当时的 url**，不能只回一个 `true`。
- **P0-2 会让每次动作回报变长**，与「筛比印重要」方向相反；必须限条数 + 写出省略量，否则修完误判换来常态膨胀。（**已按此落地**：≤5 条 + `changesOmitted`，见 [动作回报里的变更清单](../../implemented/feature/2026-09-29-action-report-changes.md)。）
- **P2-5 的 console 缓冲区要有生命周期**：按页（或按会话）绑定、导航时清空/切段，否则会变成第二个无界增长点；`all` 与"自上次导航以来"的语义要在结果里写清楚。
- **P2-6 的元素截图要先滚动到元素**，而滚动本身改变页面状态（懒加载、`IntersectionObserver`），所以"动作后自动截图"不能默认开；`inline` 依赖 attachments 服务，没有它时要有明确降级路径。
- **我们可能在跟一个正在变化的官方面并行**：单槽 `ctx.browserUse` 目前我们不占，若官方某天默认挂载某个 provider，同一会话会出现两个浏览器、两套词汇。这条要么由我们注册（自认是 provider 之一），要么由一篇笔记明确记为「故意不占」——现在两者都没有。
- **被 PTC 组合会放大结果的稳定性要求**：程序会 `catch` 我们的错误并分支，同一个失败换一种措辞就会让那段代码失效；工具也不得依赖"上一次调用留下的上下文"（`run_code` 每次是新程序，中间值只存在于那次执行里）。这条反过来支持 P0-1 的"拒绝并列出候选"，因为它给出的是可再试的结构化事实。
- **ZCode/Codex 的数字不可直接移植**：它的 3000 ms 预算是 IAB 的取值，我们的超时是逐工具声明的（navigate 45 s、snapshot/click/type/screenshot 30 s、evaluate 120 s），照抄会把长任务的失败阈值改坏。

## Related

- [工具面未解决的摩擦（第二轮·本地 SPA）](../testing/2026-09-28-local-spa-drive-frictions.md)——本笔记的 9 条来源，细节以它为准
- [PTC 兼容门禁](../../implemented/testing/2026-09-29-ptc-compatibility-gate.md)——本轮动手前的先决条件；改工具面时那张 `PTC_CALLS` 表必须跟着长
- [工具面未解决的摩擦（第一轮·内容站）](../testing/2026-09-24-open-tool-frictions.md)——`depth=` 一族同源，`find`/`boxes` 已发货
- [动作结果要有语义](../../implemented/bug-fix/2026-09-25-action-reporting-and-snapshot-semantics.md)——P0-2 是它没覆盖的那一层，落地形状见 [动作回报里的变更清单](../../implemented/feature/2026-09-29-action-report-changes.md)
- [工具面优化：三源梳理与 P0/P1 落地](../../implemented/feature/2026-09-24-tool-surface-optimization.md)——P1-3 复议其中「不做独立的 wait_for」
- [被取消的调用](../../implemented/bug-fix/2026-09-24-cancelled-calls-and-bounded-waits.md)——P0-1 新增的页面侧解析要遵守它的上限约定
- [对话、按键与对照补齐那一轮](../../implemented/feature/2026-09-24-dialogs-chords-and-parity-round.md)——`find`/`boxes` 的落地处
- [技能文件](../../../../skills/dsh-browser/SKILL.md)——P3-7 的落点
- Codex 的浏览器技能与 API 快照：<https://codex-tool-reference.simonw.chatgpt.site/skills/control-browser>（本机 ZCode 的 `browser-use` 0.5.1 是它的镜像）
- Playwright MCP 的工具表：<https://github.com/microsoft/playwright-mcp>
