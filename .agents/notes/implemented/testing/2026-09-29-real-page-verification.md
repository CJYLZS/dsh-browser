# Agent Note: 真机过一遍：假件的形状必须抄真件

Status: implemented

## Problem

2026-09-29 这一轮落地的四项（等条件、页面自己的话、截图的三种形状、evaluate 的结果形状）在 `test/` 与 `scripts/snapshot-regression.mjs` 里全绿，其中三项还没有在**真实网页**上走过一遍。用户要求做这一次验证，并且明确"选真实网页、最好覆盖各种交互组件"。

一次贯通四十分钟的真机过一遍（本机 headless Chrome，8 个工具依次在 the-internet 的多个例子页上使用）当场发现**三个缺口**，全都不是逻辑错，而是**假件的形状与真件不同**：

1. **歧义列表把"没查过"说成"页面没说过"。** 同一对同名按钮，`text` 问出来是 `in RootWebArea "The Internet"`，`selector` 问出来是 `no named ancestor`——选择器那条路走 DOM，早先的实现直接填了空数组。单测只断言了拒绝的标题行，所以从来没人问过名单里写了什么。
2. **一条拒绝理由在真机上根本走不到。** 禁用的输入框会让 `DOM.focus` **本身**失败，于是调用方拿到 `cdpSession.send: Protocol error (DOM.focus): Element is not focusable`，而 `it is disabled` 这条理由永远轮不到——假 CDP 的 `DOM.focus` 从来都成功，所以单测证明不了它。
3. **整个功能不可用。** `inline: true` 走完采集、写完 store，然后被 harness 的 `output.schema` 校验拒掉：`tool "browser_screenshot" returned invalid output: "value.image.name" is not a declared property`。假 store 只答五个字段，真 store 答的是 `ImageAttachmentRef`（多一个 `name?`，类型里还有 `originalDimensions?`）。这一条不是细节：模型要的东西一样没拿到。

## Decision

**每轮工具改动都要在真实网页、真实服务上过一遍公开工具面，判据不是"`test/` 绿"。** 具体三条：

- **假件必须抄真件。** 假 CDP 的错误拼法抄 Chrome 的（`Element is not focusable`），假服务的返回形状抄真服务的类型（`ImageAttachmentRef`），断言要覆盖真件**多给的部分**（多出来的字段、协议层的失败），而不只是 happy path。只按 happy path 造的假件，证明的是假件自己。
- **真机能钉住的事实进固定任务集，不进一次性的人工记录。** `scripts/snapshot-regression.mjs` 这次扩了 [18]（三个输入框：只读 / 禁用 / 正常）并新增 [26]（同一对同名按钮用 `text` 与 `selector` 各问一次），两份笔记里的"待真机确认"因此销账。一次性过一遍只用来**发现**缺口，不用来保管结论。
- **回归的判据落在 `data:text/html` fixture 上，真实站点只用来看"真实交互组件下的行为"。** 外部页面内容由别人决定：`[1]` 那条"快照比旧的三分之一页面预算大"（`first.nodes > 300`）已经因为 github.com/trending 变瘦而红过一次（199 节点），这不是回归该有的脆弱点。

### 本轮用到的站点（下次从这里挑）

- **<https://the-internet.herokuapp.com/>** —— 44 个互不相同的例子：表单与 basic auth、dropdown / checkbox、`<dialog>` 式的 entry ad、动态加载与动态控件、iframe 与嵌套帧、**shadow DOM**、无限滚动、损坏图片与 onload 异常、Large & Deep DOM（54 层、2807 个深层节点）、可排序表格、WYSIWYG 编辑器。全部静态、无需登录。
- **<https://testing.qaautomationlabs.com/>** —— 18 个组件，含 shadow DOM、iframe、拖拽、文件上传下载、web tables、alerts，无需登录。
- **<https://qaplayground.com/>** —— 22+ 组件（影子 DOM、iframe、拖拽、动态等待、面试式靶子）。
- 真实站点（github、文档站、Shopify 之类的商品页）留着当"内容由别处决定"的那一面：适合看快照规模、控制台噪音与真实点击路径，不适合当回归判据。

### 三个缺口各自的落点

| 缺口 | 修法 | 钉住它的测试 |
| --- | --- | --- |
| 选择器歧义不报祖先 | `entryInTree()` 复用树的那次查找，`trail` 缺席 = "树没描述它" | [`session-browser.test.ts`](../../../../test/session-browser.test.ts) 两条 + 回归 [26] |
| 禁用元素走不到拒绝理由 | 聚焦失败不中断，探针先问状态再问焦点；页面给不出理由时才引用协议原话 | 同文件两条 + 回归 [18] |
| 附件引用比声明宽 | `imageRefOf()` 逐字段收窄，`IMAGE_SCHEMA` 与 harness 的 `ImageValue` 对齐 | [`ptc.test.ts`](../../../../test/ptc.test.ts)（宽 store 那条） |

细节各归各篇：[定位参数化](../feature/2026-09-29-locator-parameters.md)、[输入也要问页面能不能接](../bug-fix/2026-09-24-typing-actionability.md)、[截图的形状](../feature/2026-09-29-screenshot-shapes.md)。

## 验证结果（2026-09-29，本机 headless Chrome）

- `browser_snapshot`：列表页尺寸行 `1440x900 viewport, page 1440x1377`；`/large` 上 `depth=3` 给 `… 2807 nodes are deeper than depth=3 (the page goes to depth=54) …`；自己注入的一棵已知四层子树给出**精确**的 `4 nodes are deeper than depth=1 (the page goes to depth=5)`；`find=/bottom tex?t/` 打印路径与命中数；第二次读同一棵子树时 `*` 标记消失（"页面多了这个节点"而不是"第一次看到"）。
- `browser_click`：`role=button name="Add Element"` → `dom: +1 button "Delete"`；`selector: "#elements button:first-child"` → `dom: -1 button "Delete"`；已被删掉的 ref → `has no visible box in the page; take a new snapshot and try again`（诚实且指路）；`/dynamic_loading/2` 上点击回报两条结构化变化：`~ div "Start" style: (none) → "display: none;"` 与 `+1 div "Loading..."`。
- `browser_wait`：`{text: "Hello World!"}` → `Waited 0.8 s — heading "Hello World!" is on the page`（元素与它内部的文本 run 只算一个答案）；等不到时 `matched:false` 且给出下一步；`{time: 400}` → `Waited 0.5 s (a fixed wait)`。
- `browser_type`：`role=textbox` 找到无名输入框并写进 `hello from dsh`，回报带上这一轮新写的"没变化不等于失败"限定语，读回值确认文本真的落地；三个输入框的无障碍名全部来自 `placeholder`。
- `browser_console`：`/javascript_error` 上同时拿到未捕获的 `TypeError`（带栈）与 favicon 的 404（浏览器日志）两个来源；自行 `console.log/warn/error` 三条后共 5 条、最旧在前；`levels:["error"]` + `filter:"gam"` → 1 条；`limit:2` → 最新两条 + `(3 older matching entries are not shown.)`；导航到下一页后缓冲清空，只剩新文档自己的一条失败请求。
- `browser_screenshot`：整页 `1440x1377`（文档高于 900 的视口）；元素 `970x62` 且带 role+name；**滚到 `scrollY=477` 后同一个元素字节完全相同**（sha256 前 16 位一致），且截图后 `scrollY` 仍是 477（不滚动页面）。
- `browser_evaluate`：`40 + 2` → `42`；`return 7` → `7`（顶层 `return` 兜底）；`() => 5 + 5` → `10`（函数被调用）；字符串原样、对象走 JSON；`'x'.repeat(50000)` 落盘，文件 **50000 字节且全是 `x`**（没有截断）；同一段 `const` 声明跑两次都返回 `42`（重复声明兜底）。
- 收尾口径：`pnpm run typecheck`、`pnpm run build` exit 0；真隔离 `pnpm test` **399/399**；`pnpm run regression` **75/76**，唯一红的是上面那条依赖外部页面内容的阈值判断。

**一条插件之外的观察**（记在这里免得下次再查）：工具结果里**内容整体是合法 JSON** 的文本到模型侧会变成压成一行（`'{\n  "a": 1\n}'` 回来是 `{"a":1}`），而同样形状的文本由 `pwsh` / `web_fetch` 返回时不会被压——所以 `readable()` 的 `null, 2` 缩进对 JSON 值看不见。这不是本插件的行为（`lib/index.js` 里原样返回那个字符串），JSON 语义也不受影响，因此不改；只是别再以为缩进真的到了模型眼前。

### 三处修复后的复验（同一条真机链路，插件重载之后）

上表三个缺口改完、`pnpm run build` 重出 `lib/index.js`、DSH 重载插件后，用**工具面**（不是回归脚本）把同一条链路重走了一遍：

- **缺口 1**：`/add_remove_elements/` 上先加出两个 `Delete` 按钮，`selector: ".added-manually"` 与 `text: "Delete"` 各问一次，两次都是 `in RootWebArea "The Internet"`——`selector` 那条路不再说 `no named ancestor`，与 `text` 一侧的说法一致。
- **缺口 2**：`/dynamic_controls` 上初始禁用的输入框被拒成 `dsh-browser: textbox would not take the text because it is disabled; nothing was typed, …`（协议原话 `Element is not focusable` 不再外泄），读回值 `""`——注意别查错元素：`form input` 会命中那个隐藏 checkbox（值 `on`），要问 `form input[type=text]`。点 `Enable` 后再输入，`hello!` 正常落地。
- **缺口 3**：`browser_screenshot({inline: true})` 打在 `h1` 上返回 image 块（`970x62`、6995 字节，与不带 `inline` 时的元素截图同尺寸同字节），`"value.image.name" is not a declared property` 不再出现。

这条复验也顺手确认了 `browser_type` 的 `clear` 默认是 `true`：连着两次输入是**替换**关系（第二次的 `!` 让值从 `hello` 变成 `!`），要追加得显式 `clear: false`——这是既定行为，不是缺陷。

## Alternatives considered

**只跑 `pnpm test` 与回归就算验证完。** 否决——这正是三个缺口漏过去的方式：单测用的是假 CDP 与假 store，回归只驱动 `SessionBrowser`，两者都看不到"工具层的结果要过 harness 的 `output.schema` 校验"这一层，也看不到 Chrome 对某个具体控件会怎么答。

**发现缺口就顺手把假件补一个字段/换一句错误拼法。** 否决：那只修了这一个字段。规则要写成"假件的形状抄真件"，否则下一轮换个服务、换个协议方法，同一个形状的洞会再出现一次。

**把这次验证的记录留在 `.prove/`。** 否决：`.prove/` 是 gitignore 的衡量产物，不是权威；持久的结论进笔记（本篇），可执行的判据进回归脚本。

**把真实站点本身当回归判据。** 否决：外部内容会变（[19] 已经红过一次）。真实站点用来发现缺口与观察真实行为，判据落在自己的 fixture 上。

## Consequences

- 验证有了一份可复用的清单（站点 + 每个工具看什么），下一轮照做即可；成本是整轮约四十次工具调用加一次回归。
- 三个缺口的共同形状值得记住：**假件的形状决定测试能看见什么**。假 CDP 的 `DOM.focus` 永远成功、假 store 只答声明过的字段，于是"禁用"与"多字段"这两个真实形状在测试里不存在。
- **`inline` 这条链路的闭环依赖一次插件重载**：DSH 在加载插件时读入 `lib/index.js`，`pnpm run build` 只更新磁盘上的产物，所以界面上仍跑旧模块时同一个调用会继续报校验错误——那不是修复没生效，是模块没被换掉。2026-09-29 重载后复验通过（见上一节）。下次改 host 半边时按同一顺序：改源码 → 跑测试 → `pnpm run build` → 重载/重启 → 用工具面复验一次。
- 仍然欠着的真机项收窄成两条：关联 `<label>`（而不是 `placeholder`）计算无障碍名，以及 `role`+`name` 组合在真实页面上的消歧（这一轮走的是 `text` 与 `selector`）。

## Related

- [定位参数化：ref，或者"在动作那一刻再问一遍"](../feature/2026-09-29-locator-parameters.md)（缺口 1）
- [输入也要问页面能不能接](../bug-fix/2026-09-24-typing-actionability.md)（缺口 2）
- [截图的形状：整页 / 元素 / 内联，以及 clip 是页面坐标](../feature/2026-09-29-screenshot-shapes.md)（缺口 3）
- [求值结果的形状：字符串原样、超长落盘](../feature/2026-09-29-evaluate-result-shape.md)（本轮一并复验）
- 固定任务集：[`scripts/snapshot-regression.mjs`](../../../../scripts/snapshot-regression.mjs)
