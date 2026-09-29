# Agent Note: 定位参数化：ref，或者"在动作那一刻再问一遍"

Status: implemented

## Problem

工具面只会用 ref 指名元素，而 ref 是**某一次快照就某一份文档给出的答案**。这带来两个当场量到的摩擦（[下一轮那篇](../../proposed/feature/2026-09-29-tool-surface-next-round.md) 的第 2、3 条）：

1. **同名控件无法消歧。** 页面上两个「启动」按钮，快照给它们两个 ref，但调用方手里只有字符串，没法说"实例表里那个"。
2. **重渲染废掉全部 ref。** SPA 换掉一个节点，ref 就指向没人看的东西；导航更是让整页 ref 作废，而调用方唯一的办法是**再取一次快照**——一次多余的往返，且新快照又可能立刻过期。

两件事是同一个病因：工具面只有**答案**，没有**问题**。而 Playwright、Codex 两侧收敛到的形状都一样——语义定位（role+name / text / selector）在**动作执行的那一刻**才解析。

## Decision

`browser_click` / `browser_type` 的元素参数从"必须是 ref"扩成"ref **或** 一个定位"（[`src/browser/locate.ts`](../../../../src/browser/locate.ts)）：

- **三种定位形态**：`role`（可配 `name`）、`text`、`selector`。语义是**三选一**，不是叠过滤器；同时给两个会被拒绝，而不是悄悄按其中一个收窄——写了两个的调用方要的是这里没实现的东西，猜它指哪一半正是点错元素的来路。
- **在动作那一刻解析**：`name`/`text` 是大小写不敏感的子串，匹配读**无障碍树**（`Accessibility.getFullAXTree`），所以"定位能匹配到的"恰好就是"快照会打印出来的"。`selector` 交给 DOM（`DOM.querySelectorAll` + `DOM.describeNode`）再按 `backendDOMNodeId` 映回树，因此能触达无障碍树没描述的元素。
- **命中 0 个**：立即报错，点名调用方写的那句定位，并指向 `browser_snapshot`。选择器本身被页面拒绝时**另报**（"页面拒绝了 selector"），不混成"没有元素匹配"——后者会让调用方去找另一个元素，而错的是问题本身。
- **命中多个**：**拒绝**，并把每个候选连同它**最近的具名祖先**列出来（`button "Open" — in dialog "Settings" < RootWebArea "Dashboard"`）。拒绝才是这个功能的价值所在：挑一个会点到调用方没指名的元素，报 0 个会把非空页面说成空的。名单是让拒绝可用的那一半——两个同名控件之间，祖先名通常是唯一能把它们分开的事实。祖先链只取最近的三个具名者，无名的包装层跳过而不是印成 `generic ""`；确实没有具名祖先的候选项写 `no named ancestor`。
- **ref 与定位是两套名字空间**：`ElementTarget = string | Locator`，`ref` 与任一形态同时出现会被拒绝。
- **动作失败后的自愈沿用原来的规则**：元素在动作中途被替换时，ref 走既有的"按 role+name 找回"，定位则**重新解析一次**，且只在恰好一个候选时才重试——与解析时的拒绝同一个取舍。
- **两个工具的元素参数完全一样**：`ref` / `role` / `name` / `text` / `selector`，其中 `role`+`name` 是一种形态、`text` 与 `selector` 各自是一种。这是参照系本身的形状——Playwright 的定位轴在终点动作之间共享（`getByRole(…).click()` / `.fill(value)`），"一套定位词汇，施加到任意动作"。所以 `text` 在两个工具上都是定位。
- **`browser_type` 的内容参数因此改名 `value`**：`fill(value)` / `type(value)` / `press(value)` 是生态自己给这个参数的名字（实测签名见下），`text` 则留给 `getByText` 那一轴。改名不是这次落地的附带损伤，它就是"`text` 在两个工具上同义"能成立的前提。
- **`text` 是那个不猜 role 的口**：猜错 role 的代价是实打实的——承载输入的元素在无障碍树里可能是 `textbox`、`searchbox`、`combobox`、`spinbutton`，猜错就得到"没有元素匹配"并被迫再取一次快照，而那正是这一项要消灭的往返。参照系的技能文档把这条写成了硬规则（"Do not replace a snapshot-proven `heading` with a guessed `link` role"），所以两个工具都必须有一个按名匹配、不带 role 的口。
- **顺带给改名的代价兜底**：按 MCP 的扁平 `browser_type(text: …)` 习惯写 `{ref, text}` 的调用方会被拒，而拒绝里会指名正确参数（"pass them as value"）——否则这条错误读起来像是在抱怨定位，而调用方真正错的只是一个参数名。
- **无名接收者的消息也能用了**（本项验收的第三条）：`elementName` 不再把无名元素印成 `svg ""`，只印角色——引号里的空字符串读起来像消息本身出了 bug。
- **一处由真机补上的候选规则（2026-09-29 晚些时候）**：**祖先已经说过同一句话的文本 run 不算第二个答案**。起因是 [`browser_wait`](2026-09-29-browser-wait.md) 的真机回归：`{ text: "engine ready" }` 在一个刚被插入的按钮上同时命中**按钮**与**它内部的 `StaticText`**（按钮这类角色会从内容计算无障碍名），于是"命中多个"的拒绝把一次本来唯一的定位判成了歧义，等待回报的也是那个 run——而 run 是任何动作都够不着的（快照从不给它 mint ref）。**但不能简单丢弃文本 run**：`<div>Loading…</div>` 这种普通容器自己不算名字，run 是唯一说得出话的节点（实测：`role="status"` 的 div 也**不会**从内容取名），丢了它，页面上那句话就再也找不到。所以规则与快照的过滤同源——快照不打印"祖先已经说过的 run"，定位也就不把这种 run 算作候选；`locateInTree` 里按"匹配到的祖先"逐个判断（`src/browser/locate.ts`），并因此把 `isTextRun` 这个谓词收进 `aria.ts` 一处。

## 与既有决定的关系

- 元素身份（"按页面稳定 + 自愈"）是[工具面优化那一篇](../feature/2026-09-24-tool-surface-optimization.md)定的；这一篇是它的下一层：那条决定让**同一个元素**在被替换后还能找回来，这条让调用方**不必先拿到 ref** 就能指名元素。
- 解析走的是 [`cancelable()`](../../../../src/browser/cancel.ts) 包住的同一次调用，所以"多一次页面侧解析"没有引入新的无界等待——这正是下一轮那篇 Risks 里要求的。
- 解析结果进回报：`ActionReport.element` 是**解析后**的 role+name，不是调用方写的那句定位，所以"我点的是谁"由页面回答。

## 参照系实测（2026-09-29，本机 ZCode `browser-use` 0.5.1 的 `docs/api.json` 与 `skills/control-browser/SKILL.md`）

上面几条取舍是照着参照系定的，把量到的签名留在这里，免得下次再翻一遍：

- **定位轴**：`getByRole(role, options?)`（`{name}` 在 options 里）、`getByText(text)`、`getByLabel(text)`、`getByPlaceholder(text)`、`getByTestId(testId)`、`locator(selector)`；`TextMatcher = string | RegExp`；`filter({has, hasNot, hasText, hasNotText, visible})`、`first()`、`nth()`、`count()`。
- **终点动作与它们的内容参数**：`click(options?)`、`fill(value: string)`、`type(value: string)`、`press(value: string)`、`check`、`selectOption`、`waitFor`。**内容参数一律叫 `value`**，`text` 是定位轴——这就是上面那条改名的依据。
- **它把 5 个轴收敛成我们的 1 个，是因为我们读 AX 树**：`getByLabel` 与 `getByPlaceholder` 在它那边必须分成两轴，因为那是在 DOM 里查属性；而 Chrome 计算**无障碍名**时本来就会用上关联 label 或 placeholder，所以我们的 `name`／`text` 一个轴覆盖了它两个轴。这条依赖"无障碍名由 label/placeholder 计算"这条规则，**本轮测试（假启动器）证明不了它**，属于必须真机确认的一类。
- **命中多个就失败、并且"收紧范围而不是用位置兜底"**：它的技能文档原话是 `if it is greater than 1, tighten scope instead of using a positional shortcut`，失败分类里也列了 `strict`。这独立印证了我们"拒绝 + 列候选 + 让调用方收窄"以及**故意不做** `nth`/`first`（下一轮那篇的"明确不做"）。
- **`getByTestId` 不必单开一个轴**：`selector: '[data-testid="x"]'` 就是它。
- **它还有一个我们没拿的**：`TextMatcher` 收 `RegExp`，技能里专门强调 `getByRole` 的 `name` 收正则。我们**已经有** `/regex/` 解析器（`aria.ts` 的 `parseQuery`，`browser_snapshot` 的 `find=` 在用），所以这是个便宜的后续项，本轮没做。

## Alternatives considered

1. **什么都不做，ref 被拒就再取一次快照。** 这是当时的现实，也是第 3 条摩擦本身；它没有回答第 2 条——同名控件再取一次快照还是两个同名 ref。
2. **命中多个时自动挑第一个（或报"第一个"）。** 短、且大多数时候没错，但错的时候是**静默点到另一个元素**还回报成功——本仓库已经在这个形状上栽过两次（旧的跨页 ref "以错误的理由通过"、遮挡点击报成成功）。拒绝优先于猜测是既有默认。
3. **定位做成 ref 的过滤器**（给 ref 再加 role/name 收窄）。那要求调用方先有一个 ref，而"没有可用的 ref"正是要解决的问题。
4. **`browser_type` 干脆不提供 `text` 定位**（把"要输入的字符"留在 `text` 上）。这是我第一版落地的形状，理由是"`text` 是已发布的参数名、为一个边际收益改名是坏交易"。**量了参照系之后推翻了**：它的内容参数叫 `value`、`text` 是定位轴；而它把"不要猜 role"写成硬规则，正好说明"按文本找输入框"不是边际收益——猜错 role 就要多一次快照往返，那正是这一项要消灭的东西。另外这个形状下 `browser_type` 上"按文本找元素"根本做不到，只能靠 `role`+`name`（要求猜 role）或 `selector`（要求会写 CSS）。**改用改名。**
5. **放开 `name` 单飞**（`{name}` 不带 `role` 也算一种定位），从而不用改名。解析层本来就支持（实测探针 [`bare-name-locator.mjs`](../../../../.prove/bare-name-locator.mjs)：`{name:"Search"}` 直接答出 `searchbox "Search"`），挡路的只有工具层那一条"name 必须配 role"。放弃的理由：它让 `text` 与裸 `name` 成为**同义拼法**——同一件事两个名字，而模型要学会哪个都行。`name` 留作"收窄 role"的那一半、`text` 留作"不知道 role"的那一半，分工清楚；改名虽然动了参数，却是往参照系的名字上动。
6. **照抄 Playwright MCP 的单一 `target` 字符串**（"页面快照里的元素引用，或唯一的选择器"）。一个字符串同时承载两种名字空间，`"#main"` 和 `"e3"` 只能靠猜：选择器会被当成 ref 查、或者反过来。我们留两个参数，让"这是 ref"和"这是选择器"是**语法**而不是**约定**。
7. **`ref`  + 一个嵌套的 `locator?` 参数**（`locator: {role, name} | {text} | {selector}`），比平铺少三个顶层参数，且 DSL 能表达——实测 `oneOf` 会渲染成真正的联合类型（探针 [`locator-as-one-parameter.mjs`](../../../../.prove/locator-as-one-parameter.mjs)）。放弃的理由：它**没有省掉任何校验**（`ref` 与 `locator` 之间仍然只能靠运行时拒绝，schema 表达不了"这两个恰好给一个"），却把每个形态的文档挪下一层，模型必须记得往 `locator` 里面看；而平铺时每个形态都是一个带自己 JSDoc 的具名参数，PTC 下生成的 SDK 一行一个、可直接读。参数个数的收益不足以换这一层心智负担。**如果以后要给定位加 `nth` / `exact` / `within` 这类修饰，这个取舍要重新算**——那时顶层参数会在两个工具上一起膨胀。
8. **单个 `target: {ref} | {role, name} | {text} | {selector}`**，让"恰好一种形态"完全由类型表达（`oneOf` 在 SDK 里就是联合类型）。这是唯一能靠 schema 消除互斥校验的方案，代价是**最常见的那次调用也要写嵌套对象**（`{target: {ref: "e2"}}`），并且改名/改形会同时打破所有既有调用方、skill 与两份 README。为一个我们本来就会在运行时给出的错误信息付这个价，不值。**而且它并没有解决 4 号要解决的问题**：把 `value` 从参数列表里拿掉换成嵌套结构，只是把"内容参数叫什么"这个问题藏起来而已。

关于"为什么不干脆留着 `ref` 不动、只加参数"：**留不住，而且这与选哪种形态无关**。只要定位是一种可选的指名方式，`ref` 就必须从 `required: true` 变成可选——因为 `required: true` 在 schema 层面说的正是"你不许不用 ref 指名元素"。实测（同一支探针）：`ref` 标为 required 时，只给 `role` 的调用在**工具体执行之前**就被参数校验拒掉（`invalid arguments: missing required property "ref"`，工具体一次都没跑），只给 `ref` 的那次才跑。所以"只加参数、不动原参数"在这件事上不是更保守的选择，而是一个**不可实现**的选择；改成可选不是顺带的损伤，那个改动本身就是这个能力在 schema 里的表达。

## Consequences

- `pnpm test` 从 279 条到 **310 条**（16 条 `test/locate.test.ts` 的纯解析 + 11 条 `session-browser.test.ts` 的动作层 + 4 条 `test/ptc.test.ts` 的桥、SDK 形状、不猜 role 的输入、以及改名后的纠正提示）。实测 **310/310**，`pnpm run typecheck` 与 `pnpm run build` 均 exit 0。（2026-09-29 晚些时候补了上面那条文本 run 规则，`test/locate.test.ts` 与 `session-browser.test.ts` 各 +2/+1，整套到 **353**。）
- **PTC 门禁当场抓住了这次改名**：`PTC_CALLS` 里 `browser_type` 的那行原本是 `{ref, text}`，改名后 `text` 变成定位，门禁立刻红（`was given both ref and a locator`）。它就是为这种事存在的——参数语义变了而调用方没跟上，测试先说话。
- **PTC 门禁需要一行额外覆盖**：`PTC_CALLS` 里 click/type 仍用 ref 形态（那是主要形态，也验证了旧路径没坏），另外四条断言把一个**定位**当参数送过 `run_code` 桥、确认 `browser_type` 能不猜 role 找到输入框、并确认 `ref`+定位与 `name` 无 `role` 两种误用都以可捕获的拒绝到达程序里。
- **子串匹配意味着定位可能比调用方预期命中更多**——这正是拒绝兜住的失败模式，但"只有一个候选"时仍可能点到刚变成别的东西的按钮（下一轮那篇 Risks 里已记的那条，没有消除，只是让它可见）。
- **每次动作多一次 `Accessibility.getFullAXTree`**（selector 形态再多几次 DOM 调用）。有上限、可取消，但它是纯增的开销。
- **`selector` 与树形态同时给出时按交集处理**（既要匹配选择器、又要匹配 role/name）。工具层不提供这个组合，所以它是库层的诚实语义而非可达路径。
- **无障碍树没描述的元素只能用 `selector` 触达**，且它的候选名只能是标签（`div`），因为确实没有别的名字可给。
- **改名有一个已知的迁移代价**：按 MCP 扁平 `browser_type(text: …)` 习惯写 `{text: "x"}`（想输入当前焦点）的调用方，现在会被当成定位搜索，得到 `no element matches text "x"`。失败是响亮的、可捕获的，而且错误信息里把 `text` 当定位这件事会教它改；`{ref, text}` 那种写法则直接被拒绝并指名 `value`。代价是一次往返，不是静默写错地方。
- **`role`/`name` 只做大小写不敏感的子串匹配，还不收 `/regex/`**：参照系的 `TextMatcher` 收，我们的 `parseQuery` 也已经有这个能力，所以这是记在案上的后续项。
- 真机验证仍是欠的：本轮的断言都在 `test/`（假启动器 + 真注册表），`scripts/snapshot-regression.mjs` 的固定任务集还没有一条用定位跑的动作；"关联 label / placeholder 会进无障碍名"这条也还没在真页面上确认过。

## Related

- 这一轮的方案与验收标准：[工具面下一轮：定位要能再解析，动作回报要有内容](../../proposed/feature/2026-09-29-tool-surface-next-round.md)
- 元素身份与快照裁剪的那一层：[工具面优化：三源梳理与 P0/P1 落地](../feature/2026-09-24-tool-surface-optimization.md)
- 动作回报的语义（`element`/`obstructed` 为什么不是装饰）：[动作结果要有语义](../bug-fix/2026-09-25-action-reporting-and-snapshot-semantics.md)
- 解析必须遵守的上限约定：[被取消的调用与有界等待](../bug-fix/2026-09-24-cancelled-calls-and-bounded-waits.md)
- PTC 兼容门禁（定位作为参数过桥的那两条断言在它里面）：[PTC 兼容门禁](../testing/2026-09-29-ptc-compatibility-gate.md)
