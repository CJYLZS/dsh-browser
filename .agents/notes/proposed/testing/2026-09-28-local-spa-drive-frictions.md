# Agent Note: 长时间驱动本地 SPA 的工具面摩擦

Status: proposed

<!-- 9 条已全部销账（2026-09-29）。这篇保留为**现场记录**：它记的是"当时发生了什么"（症状、代价、原始数字），方向与取舍已经各自进了 implemented/ 的笔记，逐条链在上面。 -->

## Problem

本轮（2026-09-28）用内置浏览器在一个**本地长驻 SPA** 上走完一条真实验收：NiceGUI 的十页驾驶舱 `http://127.0.0.1:8080/`，任务是"填连接表单 → 由框架拉起一个 `Plat.exe` → 等它就绪 → 启停推演 → 切换实例 → 收尾核对"，约 10 次点击、30 余次读取与定位调用。这一轮的摩擦与 [09-24 那两轮](2026-09-24-open-tool-frictions.md)（github.com/trending、Google 结果页）**不同类**：公开内容站的痛点是"印得太多"，本地 SPA 的痛点是**观察与定位** —— 页面每 tick 都在重渲染、控件同名成对出现、关键反馈是瞬时 toast。按本轮实际损失排序：

1. **动作结果只说"变了"，不说"变成什么"。** 点『连到这一台』回报 `The page changed: dom.`；7 秒后读到的徽标、状态、消息流全没变，于是我判定它是空操作。真实反馈是一个**瞬时 toast**（"先在实例表里点一行"），等到我去读页面源码（应用侧 `pages/dashboard.py:317` 的 `_notify(..., ok=False)`）才确认。这是本轮最贵的一次误判，而 [动作结果要有语义](../../implemented/bug-fix/2026-09-25-action-reporting-and-snapshot-semantics.md) 已经解决了"旧 URL 骗人"，这一层（**变化的内容**）还空着。**已解决（2026-09-29）**：动作回报现在带一份有上限的变更清单，瞬时插入的 toast 会以 `+1 status "先在实例表里点一行"` 出现在结果里，见 [动作回报里的变更清单](../../implemented/feature/2026-09-29-action-report-changes.md)。
2. **同一页有三对同名控件，`find` 只给路径不给上下文。** 『暂停』×3、『重置』×3、『启动并连接』×2，多张表都有『选择』。我要靠 `target=` 逐个看子树、或用 `evaluate` 取坐标来消歧；为点一个按钮平均要"`find` 拿 ref → `target` 看子树 → `click`"，一次点击三次调用。**已解决（2026-09-29）**：`browser_click` / `browser_type` 收 `role`+`name` / `text` / `selector`，命中多个**拒绝并逐个列出最近的具名祖先**，见 [定位参数化](../../implemented/feature/2026-09-29-locator-parameters.md)。
3. **每次重渲染都废掉手里所有 ref。** 本轮 ref 从 `e304` 涨到 `e559`。"选中某一行 → 点停止"这种两步动作必须重新取快照、重新定位，而选中态那一行本身也会因为表格刷新换 ref。**已解决（2026-09-29）**：定位在动作那一刻才解析，所以重渲染不再需要中间那次快照，见 [定位参数化](../../implemented/feature/2026-09-29-locator-parameters.md)。
4. **没有"等条件成立"的原语，只能固定 sleep。** 本轮写了 6 次 `await new Promise(r=>setTimeout(r,8000))`。等待的对象是**应用层状态**（引擎冷启动 1 s 到几十秒、连接 + 加载想定 12 s），不是 DOM 稳定，所以"动作后等 settle"覆盖不到：短了误判"没反应"，长了白等，且调用期间没有任何中间反馈。这一条要复议 [工具面优化](../../implemented/feature/2026-09-24-tool-surface-optimization.md) 里"不做独立的 `wait_for` 工具"那个决定。**已解决（2026-09-29）**：加了 `browser_wait`（复用同一套定位词汇，超时是值不是异常），那两处旧决定被有意推翻，见 [等条件那一篇](../../implemented/feature/2026-09-29-browser-wait.md)。
5. **`evaluate` 的返回值没有上限，事前也无法预估。** 我用 `document.body.innerText` 匹配 `/正在连接/`，正则吃到了 `<style>` 与 boot script 的文本，返回 **387602 B**，被 spill 到临时文件，只能改用 `read`。工具没报错，也没在事前给出"结果很大"的信号——而 spill 本身是好设计，缺的是**默认限长**与**可见文本**这一档。**已解决（2026-09-29）**：超过 40 000 字符的结果整份落盘、回报预览 + 路径 + `truncated`，见 [evaluate 结果的形状](../../implemented/feature/2026-09-29-evaluate-result-shape.md)。**"可见文本"这一档按量到的证据改为不做**：参照系明确禁止 dump `body` 文本，而 `browser_snapshot` 的 `find`/`target`/`depth` 覆盖同一诉求。
6. **字符串结果被 JSON 转义。** 返回的字符串在结果里被压成一行带 `\n` 的 JSON 字面量，中文页面尤其难读；我最后统一改成 `JSON.stringify(x, null, 1)` 反而更可读，说明默认渲染选错了方向。09-24 记的是相反方向的摩擦（"返回值要手动 `JSON.stringify`"）——两条一起指向同一件事：**对象该美化、字符串该原样**。**已解决（2026-09-29）**：`readable()` 现在字符串原样、其余 JSON 美化，与参照系的 `stringifyReplResult` 同一形状，见 [evaluate 结果的形状](../../implemented/feature/2026-09-29-evaluate-result-shape.md)。
7. **顶层 `return` 只报 `SyntaxError: Illegal return statement`。** 我想表达"多语句 + 等待"，而 skill 只写了"允许顶层 `await`"，没给这个场景唯一可行的模板（async IIFE）。正确写法我是试出来的。**已解决（2026-09-29）**：工具现在自己把 `Illegal return statement` 兜成 `(async () => { … })()` 跑一次（不用调用方写模板），描述里也写明顶层 `await` 与 `return` 都可用，见 [evaluate 结果的形状](../../implemented/feature/2026-09-29-evaluate-result-shape.md)。
8. **截图只有视口一种形状，且要二次 `read_image`。** 本轮页面很长（连接表在 y≈1200），我全程没看过它一眼，只能靠 `evaluate` 抓文本代替"看一眼这张表"；遇到瞬时反馈时也没有"动作后立刻留一张"的手段。**已解决（2026-09-29）**：`fullPage` / 元素目标 / `inline` 三个参数落地，元素截图按页面坐标裁剪、**不需要先滚动**，见 [截图的形状](../../implemented/feature/2026-09-29-screenshot-shapes.md)。"动作后自动截图"**不做**：它会默认改变每次动作的行为，而想留证据的调用自己加一次即可。
9. **`depth=` 的不可预测性第二次撞上**（与 09-24 第 2/8 项同源）：`depth=6` 得到一句 `311 nodes are deeper than depth=6`，既没说那些节点挂在哪一支，也没说该换哪个参数——而这一轮我真正需要的是"这张表在哪一层"。**已解决（2026-09-29）**：截断文案现在同时给出节点数与**页面实际到第几层**（`… 311 nodes are deeper than depth=6 (the page goes to depth=11) …`），"raise depth"因此有了确切数值；要更细的定位仍走 `find` / `target`，见 [截图的形状](../../implemented/feature/2026-09-29-screenshot-shapes.md) 与 [aria 的深度测量](../../implemented/feature/2026-09-29-screenshot-shapes.md)。

一条**不是缺陷但决定了我怎么复述验收**的观察：SPA 的瞬时反馈（toast）与应用层日志里，只有**持久**的那份能当证据。本轮最后是靠页面上一份持久消息流（`已拉起引擎 … / 推演已开始 / 已暂停 / 已重置到想定初始状态 / 已停止本框架拉起的引擎`）把验收原样贴给人看的。工具侧能补的是"动作后的紧凑 diff"与 console 捕获；**应用侧该自己把反馈落成持久记录**，别指望读得到 toast。

## Proposal

- **动作回报带紧凑 diff**：新增/移除/文本变化的头几个元素（role + name + 一句话），例如 `dom: +1 status "先在实例表里点一行…"`；toast/notify 这类瞬时插入要能被识别成一次变化。目标是"只凭结果就能判断点击是否真的有效"。
- **新增 `browser_console`**（console 消息 + 未捕获异常，可选网络失败），专治"点完什么都没发生"的静默失败；与 09-24 记的"落盘 + 回路径"同一口径。
- **定位消歧**：`browser_click` / `browser_type` 接受 `text=` / `selector=` 目标（ref 仍首选，命中多个就拒绝并列出候选）；`find` 的每个匹配附**最近的具名祖先**（`『暂停』@顶栏` / `@连接控制`）；保证 `find` + `boxes: true` 可组合。
- **`browser_wait(for: text|selector|ref|expression, timeout_ms, poll_ms)`**，返回"命中/超时 + 命中元素或文本"；至少在 skill 里给出 async IIFE 的规范模板与"它会阻塞到超时"的说明。
- **`evaluate` 加 `max_chars`**（默认 8–16 KB，断点插 `… [+N chars]`）并把"超过多少会 spill"写进描述；再加一个 **`browser_text`**（只取可见文本，排除 `style/script/noscript`）覆盖"页面上现在写着什么"这个最常见诉求。
- **结果渲染**：字符串原样输出，对象才 JSON 美化（与 09-24 那条"要手动 stringify"合并成一条规则）。
- **`Illegal return statement` 自动兜一次**：包一层 `(async()=>{…})()` 重试，或把这个模板写进错误文案。
- **`browser_screenshot` 支持 `ref=` / `selector=`**（元素级）与 `full_page=true`，并提供 `inline=true` 省掉一次 `read_image`；另加"动作后自动截图"选项，专收 toast 与弹窗。
- **`depth=` 截断提示给出节点数与内容深度区间**，并指路 `find=` / `target=`（与 09-24 第 2/8 项同源，这是第二次撞到）。
- **skill 加一张"该用哪个"的配方表**：读页面 / 找控件 / 等条件 / 看某区域 / 点重名控件，各用哪条 + 一句注意。

## Alternatives considered

**什么都不做，全交给 `evaluate` 兜**（现状，也是 09-24 对"等待"的选择）：能兜住，但这一轮的代价是 6 次固定 sleep 与一次 387 KB 的返回——每次都在烧调用与上下文，而"等应用层状态"根本无法用 sleep 表达准。**把 `wait` 做成 evaluate 的糖**：语义等价，但模型需要知道"该等什么"，参数化比自由发挥更省 token、也能进回归；若维持"不加工具"，就必须在 skill 里把模板写成规范（本笔记两条都记，留给实现时二选一）。**给 `click` 加"点第 n 个同名控件"**：同名控件的稳定排序无法保证，会制造新的静默错点；按文本 + 祖先定位才可读。**让 ref 跨重渲染永久稳定**：与已落地的"ref 属于页面"冲突（跨页静默点错的风险更大），折中只能做"失效时按 role + name 重解析并说明"，这一条 09-24 已经落地，本轮缺的是**不用重新取快照**就能定位。**`max_chars` 做成硬上限**：会切掉本该看的证据，所以"默认限长 + 明确 spill"两条路并存。**为每项加一个新工具**：与"工具少而必要、新能力做成参数"冲突；除 `console` / `wait` 这两个 evaluate 表达不了（或表达起来很贵）的以外，其余都按参数加。**只在 README/skill 里写清楚而不改工具**：这一轮我读过 skill，摩擦照旧发生——文档能救的只有"不知道怎么写"（模板类），救不了"不知道发生了什么"（观察类）。

## Acceptance criteria

每项要么落地并带一条可量断言，要么被明确记为"不做"并从本笔记删除：

- 动作回报里出现 diff 条目（数量与文案可断言），且"点了只改 toast 的按钮"能报出那次变化；
- `browser_console` 能捕获到一次未捕获异常与一条 `console.error`，并落盘回路径；
- `text=` 定位与同元素 ref 点击等价；命中多个时拒绝并列出候选（含祖先名）；
- `wait` 的命中与超时两条路径各有断言，超时不抛异常而是回报未命中；
- `max_chars` 截断标记与 spill 提示都出现；`browser_text` 不含 `style`/`script` 文本（用本轮那个 387 KB 的表达式作反例）；
- 元素级与整页截图的尺寸断言（元素截图小于视口截图）；
- `depth=` 截断提示包含节点数与深度区间；
- 同时把 [09-24 那篇](2026-09-24-open-tool-frictions.md) 里已落地的项（`find` / `boxes`）标注为已发货。

## Risks

`text=` 定位在文本会变的控件上会点错（要靠"命中多个即拒绝"兜住）；`wait` 若支持表达式形态，等于把等待语义再实现一遍，可能与"取消时要停页面"的既有约定打架（见 [被取消的调用](../../implemented/bug-fix/2026-09-24-cancelled-calls-and-bounded-waits.md)）；`max_chars` 截断会把关键长 JSON 切碎，靠 spill 兜底；`find` 附祖先名会增加每次打印的行数（与"筛比印重要"方向相反，需用它只在 `find` 命中时生效来抵消）；元素级截图在长页面上要先滚动，而滚动本身会改变页面状态（懒加载、`IntersectionObserver`），所以"动作后自动截图"要允许关闭。

## Related

- [工具面下一轮：定位要能再解析，动作回报要有内容](../feature/2026-09-29-tool-surface-next-round.md)（本笔记的 9 条被它归并成两个结构缺口、排成 P0/P1/P2 与「不做」清单；本笔记仍是条目的权威，落地后逐条销账）
- [工具面未解决的摩擦](2026-09-24-open-tool-frictions.md)（同一话题的上一轮清单，本笔记部分取代它：`find` / `boxes` 两项已发货）
- [动作结果要有语义](../../implemented/bug-fix/2026-09-25-action-reporting-and-snapshot-semantics.md)（第 1 项是它未覆盖的那一层）
- [工具面优化：三源梳理与 P0/P1 落地](../../implemented/feature/2026-09-24-tool-surface-optimization.md)（第 4 项复议其中"不做独立的 `wait_for` 工具"）
- [对话、按键与对照补齐那一轮](../../implemented/feature/2026-09-24-dialogs-chords-and-parity-round.md)（`find` / `boxes` 的落地处）
