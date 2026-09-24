# Agent Note: 工具面优化：三源梳理与 P0/P1 落地

Status: implemented

## Problem

真机实测（headless Chrome 153，github.com/trending 一次完整任务）暴露六类问题：快照被 InlineTextBox 噪音吃掉（850 节点、默认预算 300、截断 592 节点）、ref 打开一个下拉菜单就整体重编号、动作回报旧 URL（"工具返回值会欺骗模型"）、导航与等待只能手写 sleep 轮询、滚到底还在滚、"重资产"（大快照）直接占上下文。

## Decision

按优先级落地 P0/P1：过滤 `InlineTextBox` 并按文本 run 合并、快照加 `target`/`depth`、截断文案指路、动作结果带被操作元素的语义描述 + 真实 URL/title + 是否变化并在动作后等 settle、ref 标"本步新增"（`*`）、快照头部加 `Page info:`、属性白名单 + `aria-hidden` 跳过 + `[data-dsh-browser-ignore]` 逃生舱、ref 失效时按 role+name 重定位、快照落盘回路径、真机回归脚本 `scripts/snapshot-regression.mjs`；默认预算 300 → 500。

三处证据，各自独立，结论一致的地方才进优先级：

1. **真机实测**（2026-09-24，headless Chrome，github.com/trending 一次完整任务）。六个工具全部走过一遍：导航 → 快照 → 截图 → 点开 Date range 菜单切到 This week → 用 Quick search 输入并回车 → 回退 → 重新快照 → 滚动到底截图。量到的数：
   - 整页约 **850 个 AX 节点**，默认预算 300（`src/browser/aria.ts:58`）→ 快照被截断并留 **592 个节点未打印**；一次快照约 8–10k token。绝大部分被吃在 `- InlineTextBox "T"` 这种**一个字母一行**、没有 ref、没有语义的节点上。
   - `browser_click` 点完 `This week` 后工具回报 "active page is now https://github.com/trending"，而实际已是 `?since=weekly`（用 evaluate 复核才发现）。**工具返回值会欺骗模型。**
   - `browser_evaluate` 顶层 `await` 报 `SyntaxError: await is only valid in async functions`；返回值要手动 `JSON.stringify`。
   - 用旧 ref 报错清晰（`e40 is not a ref from a snapshot of the current page`），但打开一个下拉菜单就让整页 ref 重编号（`e91` → `e137`），等于"点一个元素要重付一次快照钱"。
   - 滚动、后退、等待只能写 evaluate；`history.back()` 之后必须自己 sleep 再轮询才读到新页面。
2. **业界调研**（Playwright MCP、chrome-devtools-mcp 与其 design-principles/--slim、Playwright CLI + vercel-labs/agent-browser、browser-use、Stagehand、Browserbase MCP、Tencent BrowserSkill、Anthropic 的 writing-tools-for-agents）。
3. **page-agent v1.12.4 源码**（`alibaba/page-agent`，浅克隆在 harness 已忽略的 `lib/page-agent`，commit `9eb6b66`）。它是"把页面结构文档化"这一路线的代表，做法源自 browser-use。

## 结论

| 主题 | 证据 | 决定 |
|---|---|---|
| 快照体积 | 实测 850 节点里大半是 InlineTextBox 噪音；Playwright MCP 有 `find`/`depth`/`target`/存盘；chrome-devtools 有 `verbose=false` + `filePath` + 分页；page-agent 的属性白名单 + 20 字符截断 + 同值去重 | **P0**：过滤 InlineTextBox；加 `target`/`depth`；截断文案要指路 |
| 元素身份 | 我们的 ref 导航即失效且整体重编号；Playwright MCP 的 `target` 同时收 ref 与选择器；Stagehand 用 XPath（跨步骤不失效）+ description 自愈；browser-use 有 `EXACT→STABLE→XPATH→AX_NAME→ATTRIBUTE` 阶梯；page-agent 每步重编号但有 `*[n]` 标新增 | **P0** 给 ref 加"本步新增"标记；**P1** ref 失效时按 role+name 重定位，再失败才报错 |
| 动作结果语义 | 实测 click 回报旧 URL；page-agent 回报 `✅ Clicked element ([3]<a >文档 />)` 且滚动结果带"已到底部/顶部"；其 prompt 明写"不要假设动作成功" | **P0**：动作结果带被操作元素的语义描述 + 真实 URL/title + 是否发生变化 |
| 导航与等待 | 实测必须手动 sleep 轮询；Playwright MCP 有 `--timeout-settle`（默认 500ms）；chrome-devtools 的 `evaluate_script` 有 `waitForStableDom`；page-agent 用固定 1s sleep + 4s 轮询（粗） | **P0**：click/type/navigate 等导航 commit 或 DOM 稳定后回报；不做独立的 `wait_for` 工具 |
| 滚动预算 | 实测滚到底还在滚；page-agent 把视口/总高/上下各多少像素与页数放进 header+footer，并给可滚动容器标 `data-scrollable` 余量；Playwright MCP 有 `--mobile`"页面更轻省 token" | **P0**：快照头部加 `Page info:`；**P1** 给可滚动元素标余量 |
| 属性与忽略 | 我们只印 role/name/value/states（干净但信息少）；page-agent 白名单里**没有 class**、值截 20 字符、重复值去重、与文本重复的 aria-label/placeholder/title 不输出、`aria-hidden=true` 整棵子树跳过、`[data-page-agent-not-interactive]` 逃生舱 | **P1**：按此四规则补属性；补 `aria-hidden` 与 `[data-dsh-browser-ignore]` |
| 重资产 | chrome-devtools 的设计原则：*"Files are the right location for large amounts of data"*、*Reference over Value*；Playwright CLI 每个命令只回 URL/title + 磁盘上的快照文件链接；实测 harness 自己的 `web_fetch` 溢出就落到 `dsh-spill-*` 并提示可 grep | **P1**：快照/console/network 走"落盘 + 回路径"，复用 harness 的 spill 目录，截图保持现状（已返回路径） |
| 工具面 | 我们 6 个；chrome-devtools `--slim` 只有 3 个（navigate/evaluate/screenshot）；Anthropic 指南："更多工具不等于更好"，要合并、要 pagination/truncation 默认值；Tencent BrowserSkill 用 6 个"动作复用式"工具（`browser_interact{action}`）；Browserbase MCP 只有 6 个 | **保持 6 个**。新能力优先做成参数（如 click/type 的 `waitFor`），不轻易加工具名 |
| 渐进暴露 | BrowserSkill 的 DSH 插件默认 `lazyTools: true`——skill 被调用后才注入 6 个工具 schema；Playwright 的 CLI 路线是同一思想的另一种实现 | **P2**：接 skill，懒注册工具 schema |
| 测试与评测 | page-agent **没有任何断言 DOM 文档格式与索引的测试**，只有 prompt 里的散文契约 + 人工清单（Bing/AntD/Element-Plus/Quill/MUI/Radix 11 例，记 revision/browser/case/status/evidence）；CI 不跑浏览器；`packages/e2e/` 至今不存在。Anthropic 指南要求量化 tool-call 数、总 token、错误数 | **P1**：给快照不变量加真机回归用例（索引稳定性、截断文案、忽略规则、属性策略），这是他们没做、我们能领先的一层 |
| 能力边界 | page-agent 公开列出"不支持 hover/拖拽/右键/快捷键/坐标/跨域 iframe、无视觉" | **P1**：README 增一节明确写我们能做什么、不做什么（我们的边界不同：这些多数能用 evaluate 做，但不可信或不稳） |
| 上下文策略 | page-agent 全程无流式、usage 采集但无消费者、超限 fail-loud、扩展每步无条件前置一张**无上限**的 tab 表格、无任何压缩 | **不抄**。上下文归宿主；我们只保证单次结果小；将来若加标签列表必须设上限 |

## 优先级

| 级别 | 事项 | 落点 | 验收 |
|---|---|---|---|
| P0 | 过滤 `InlineTextBox`（及无 ref 无语义的纯文本叶子），文本按 run 合并成一行 | `src/browser/aria.ts`（`visit()`） | 同一页同样的节点预算能覆盖完整页；trending 页节点数下降到可用范围 |
| P0 | 快照支持 `target`（ref/选择器子树）与 `depth` | `src/browser/aria.ts` + `src/tools/index.ts` | 截断时能用子树取到后半页的 ref |
| P0 | 截断文案指路（现在只有 `… N more nodes`） | `src/browser/aria.ts:163` | 文案给出 `target=`/`depth=`/找回方式 |
| P0 | 动作结果带元素语义描述 + 真实 URL/title + 是否变化；click/type 后等 settle | `src/browser/session-browser.ts`、`src/tools/index.ts` | 复现 trending 那次"切 This week"，结果里的 URL 必须是 `?since=weekly` |
| P0 | `browser_evaluate` 接受 async 函数/顶层 await 并自动 JSON 化 | `src/tools/index.ts` | 直接写 `await fetch(...)` 不再报 SyntaxError |
| P0 | ref 标"本步新增"（`*`） | `src/browser/aria.ts` | 动作后只需小快照即可定位新出现的元素 |
| P1 | 快照头部 `Page info:`（视口/总高/上下像素与页数/百分比） | `src/browser/session-browser.ts` | 不再出现"滚到底还在滚" |
| P1 | 属性白名单 + 截断 + 去重 + 与文本重复则省略；`aria-hidden` 跳过；`[data-dsh-browser-ignore]` + 黑/白名单配置 | `src/browser/aria.ts`、`src/config.ts`、设置页 | 体积不涨的前提下信息量增加；站点能主动豁免 |
| P1 | ref 失效自愈：先按 role+accessible name 重定位 | `src/browser/session-browser.ts` | 打开下拉菜单后点原元素仍成功 |
| P1 | 快照/console/network 落盘并回路径 | `src/tools/index.ts` | 大页面快照不占上下文 |
| P1 | 真机回归用例集（快照不变量）+ 固定任务集（记录 tool-call 数与 token） | `test/`、`scripts/` | 每次改动前后可对拍 |
| P2 | skill + 懒注册工具 schema | `src/index.ts` | schema 不常驻 system prompt |
| P2 | README「能力边界」一节 | `README.md` / `README.zh.md` | 与 page-agent 的 limitations 一节同规格 |

后续一轮补上了这张表里"响应纪律（find / 按引用）"缺的那一半：`browser_snapshot` 新增 `find`（文本或 `/pattern/flags`，只回匹配节点与它在树里的路径）与 `boxes`（每个会打印的元素的视口坐标，与点击落点同源，都是 `DOM.getContentQuads`）。同一决定，理由与真机数字见[对照补齐那一篇](2026-09-24-dialogs-chords-and-parity-round.md)。

## 明确不做

- **不抄 page-agent 的"每步重取整页文档"**：它是长页面上最大的开销来源；我们已有 `maxNodes`，继续走"按需 + 按引用"。
- **不抄 `enableMask`**（遮罩阻止用户操作）：与"用户可旁观、可接管"的取向相反。
- **不把上下文策略学 page-agent**（无预算、无压缩、fail-loud）。
- **不改成 CLI**：第三方实测（Checkly 2026-07）显示同一任务 MCP 48–50k vs CLI 45–48k 上下文，"基本持平"；该抄的是它们的响应纪律（find / depth / max-output / 按引用），不是换传输层。
- **不用 click/type 默认附带全量快照**：chrome-devtools 的 `includeSnapshot` 默认 false 才是我们这个档位。

## 待定（已由上节的实施记录回答）

- `browser_snapshot` 的默认预算要不要从 300 提高（过滤噪音后同样的 300 能覆盖更多内容，是否还需要更大）→ **提到 500**。
- 是否引入"流水线式"的 `cdpBrowser` 语义（page-agent 的 index 与我们 ref 并存，还是二选一）→ **不引入 index**，ref 改成"按页面稳定"，等价收益已在 ref 内取得。
- 真机回归用例集放在 `test/`（要能进 CI，但 CI 里没有浏览器）还是 `scripts/`（照 `.prove/` 的做法，手动跑、留证据）→ **`scripts/snapshot-regression.mjs`**，理由见实施记录。

TDD：先写失败用例，再改实现；`pnpm run typecheck && pnpm test && pnpm run build` 全绿（146 个用例）。真机部分由 `scripts/snapshot-regression.mjs` 覆盖，22/22 通过。

## 真机数字（headless Chrome 153，1440x900，github.com/trending）

| | 改动前 | 改动后（预算 300） | 改动后（新默认 500） |
|---|---|---|---|
| 打印行数 | 300（截断） | 300（仍截断） | **364（整页，无截断）** |
| 未打印节点 | **592** | 64 | 0 |
| ref 数 | 158 | 229 | 278 |
| 字符数 | 12,780 | 21,656 | 26,079 |
| `InlineTextBox` 行 | 大量（一字一行） | 0 | 0 |
| 属性 | 无 | url/level/placeholder 等 | 同左（175 行带 url） |

同一份 1148 节点的真实 AX 树，`before.txt` / `after.txt` 都在 `.prove/ax-probe/`。结论：**同样的 300 预算，覆盖比例从约 34% 提到约 82%；新默认 500 一次调用读完整个页面**，而旧行为要 3 次调用才能读到同样的内容（按行数算约省 1/3 字符，另省 2 次往返）。代价是每行更长（属性白名单，尤其是 `url`，约 175 行 × 40 字符）——这是刻意的交易：模型不必点开链接就知道它去哪。不想要就把设置页的白名单清空。

其他真机结论：

- **`replMode` 会吞掉 `awaitPromise`**：`Runtime.evaluate` 带 `replMode:true` 时 `(async () => 43)()` 返回 `{}` 而不是 43。所以它只能当**重试**（首次报 `await is only valid…` 时才用），不能当默认——否则 `browser_evaluate` 里 `fetch(...)` 就变 `{}` 了。
- **`Accessibility.getPartialAXTree(fetchRelatives:false)` 只回目标节点本身**（链上没有子节点），所以 `target` 不走这条协议，改成"全量取树 + 按 backendNodeId 取子树"，确定性更好，也不多一次调用。
- `aria-hidden` 的子树在 CDP 里本来就是 `ignored`，且 `ignoredReasons` 明确写着 `ariaHiddenSubtree`/`ariaHiddenElement`——用它区分"提升子节点"和"整棵丢弃"，不需要额外 DOM 查询。
- 忽略选择器的成本：`DOM.getDocument(depth:0)` + 每个选择器一次 `DOM.querySelectorAll` + 每个命中一次 `DOM.describeNode(depth:-1)`，实测 **1–2ms**；没有命中时固定 2 次调用。
- 一次点击的 settle：GitHub 上点 "Explore" 全流程（导航 + 静默 500ms）约 1.0–2.2s，观测到 4k+ 次 DOM 变更；无变化的点击约 +0.5s。

## 改了什么

- `src/browser/aria.ts`：五条过滤规则（丢 `InlineTextBox`/`LineBreak`/`ListMarker`；丢被祖先名字包含的 `StaticText`；丢无名或与祖先重名的装饰性 `image`；丢"只包一个节点"的无名结构 wrapper，保留能分组的；合并同父相邻文本 run，按需补空格）；`RefLabels` 把 ref 变成**按页面稳定**（不再随快照重编号，新出现的标 `*`），并记住 role+name；`target`/`depth`/`ignore`/属性白名单（截断 60 字符、与 name/value 重复则不印、同值只印一次）；截断文案给出 `target=`/`depth=` 的下一步；`DEFAULT_MAX_NODES` 300 → 500。
- `src/browser/page-info.ts`（新）：`Page info:` 一行（视口/页面尺寸/屏数/滚动像素与百分比/上下余量），数据来自 `Page.getLayoutMetrics`——与点击坐标同一个来源，两者不会互相矛盾。
- `src/browser/session-browser.ts`：`snapshot({target,depth})`；忽略选择器解析；`ActionReport`（元素语义 + 真实 url/title + `changed` + mutation 数 + 是否 settle + 是否自愈）；click/type/navigate 后统一 settle（先等 `domcontentloaded` 2s，再等 DOM 静默 500ms、上限 3s，用 MutationObserver 计数）；ref 失效自愈（只在本页内按 role+name 唯一匹配时重指，跨页仍报错）；`evaluateIn` 的 `replMode` 重试。
- `src/config.ts`：`snapshotNodes` 默认 500；新增 volatile 的 `snapshotAttributes`（白名单，逗号分隔）与 `snapshotIgnore`（选择器，逗号分隔，默认 `[data-dsh-browser-ignore]`）；`listOf()`。
- `src/tools/index.ts`：`browser_snapshot` 新增 `target`/`depth`/`file` 三个参数（不新增工具，仍是 6 个）；结果带 `info`/`nodes`；click/type/navigate 的结果与文案改成"做了什么 + 页面在哪 + 变了什么"；`browser_evaluate` 描述里写明支持顶层 await。
- `src/tools/spill.ts`（新）：大快照落盘（优先 `ctx.get('spillStore')`，取不到或写失败就落自己的临时目录），回路径 + 读取指引；阈值 40k 字符，`file:true` 显式触发。console/network 不适用（插件本来就没有这两类捕获）。
- 设置页 + 两种语言：新增两行（属性白名单、忽略选择器），并说明"启动项重启浏览器、快照设置下一次生效"。
- 测试：`aria.test.ts` 重写扩充（30 例）、新增 `page-info.test.ts`(9)、`spill.test.ts`(9)、`tools.test.ts`(10)；`session-browser.test.ts` 增补 15 例（target/depth/忽略选择器/ref 稳定/自愈/settle/真实 url/replMode）；`test/support/cdp.ts` 的 `answers` 支持函数值，`test/support/browser.ts` 的假页面支持 `waitForLoadState`。
- 脚本：`scripts/snapshot-regression.mjs`（真机固定任务集，22 项不变量）；`scripts/ax-probe.mjs` 改成挂到已运行浏览器的 CDP 端口上量（不自己起进程），并同时输出 300/500 两个预算下的行数、截断与字符数。`pnpm run regression` / `pnpm run probe`。

## 与 page-agent 的分歧（仍然坚持）

- 不做每步全量重取：我们的 ref 现在跨快照稳定，重取一次就够用；它每步重取是长页面最大的开销。
- 不引入 index 语义：`ref` 已经承担"稳定句柄 + 可自愈"，再加一套 index 只会让模型在两个编号体系里选。
- 不把 `*` 当成唯一的新元素发现手段：`target`/`depth` 是更省的做法，`*` 只是兜底。

## 这一轮仍然没做

- P2：懒注册工具 schema（**技能本身已落地**，见[对照补齐那一篇](2026-09-24-dialogs-chords-and-parity-round.md)，但六个工具的 schema 仍常驻 system prompt）；README「能力边界」一节。
- 快照头里"可滚动容器还剩多少"（结论表里是 P1、优先级表里没列）：需要逐元素 `scrollHeight > clientHeight`，一次 in-page 扫描拿不到 backendNodeId，成本与收益不划算，继续等真实需求。
- `file:true` 的自动触发阈值定在 40k 字符（约 12k token），没有做成"按 token 预算"：插件的单次结果保持小，压缩归宿主。

---

## Alternatives considered

**不抄 page-agent 的"每步重取整页文档"**：那是长页面上最大的开销来源。**不抄 `enableMask`**（遮罩阻止用户操作），与"用户可旁观、可接管"相反。**不学它的上下文策略**（无预算、无压缩、fail-loud）。**不改成 CLI**：第三方实测同一任务 MCP 48–50k 与 CLI 45–48k 基本持平，该抄的是响应纪律（find / depth / max-output / 按引用）而不是换传输层。**不用 click/type 默认附带全量快照**：chrome-devtools 的 `includeSnapshot` 默认 false 才是这个档位。仍开放的两项（P2）：skill + 懒注册工具 schema、README 的「能力边界」一节。

## Consequences

快照从"整页文档"变成"可裁剪、可落盘、带几何信息的引用树"；元素身份改成"按页面稳定 + 自愈"，等价收益在 ref 内取得，因此**不引入 page-agent 式的 index**。这一轮的判据全部来自真机数字，对拍产物在 `.prove/`。
