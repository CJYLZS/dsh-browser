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
- **<https://testing.qaautomationlabs.com/>** —— 15 个组件（checkbox / radio / dropdown / list box / slider / form / web table / **iFrame** / **shadow DOM** / window-popup-modal / **drag & drop** / **JavaScript alert** / notifications / 文件上传与下载），外加一个"challenge mode"（给每次加载加随机延迟，正好量显式等待），无需登录。
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

### 组件站点那一遍：<https://testing.qaautomationlabs.com/>

15 个组件 + 一个"challenge mode"（随机加载延迟）的练习站，无需登录。这一遍走的都是 the-internet 覆盖薄的地方，结论如下（其中三处是缺陷，见后台两节）：

- **三种对话框全对**（`/javaScript-alert.php`）：不给 `dialog` 时 alert 被 dismiss 且回报 `changed: dom, dialog` 与对话框原话；`dialog: "accept"` 让 confirm 被接受，页面自己把结果写成 `You clicked OK on confirm button.`；prompt 带 `dialogText: "hello from dsh"` 被接受，页面回显 `You entered: hello from dsh`——**帧外第三方证据**，不是我们的自述。
- **弹窗里的点击穿得过整页遮罩**（`/window-popup-modal.php`）：点开 Bootstrap 弹窗后 `body` 变成 `sidebar-mini modal-open`、`modal-backdrop fade show` 出现，共 9 条变化；再点弹窗里的 `Close` 时遮罩盖着全页，落点判定没有误判（没有要 `force`），关闭后 8 条变化如实报到，含 `aria-modal: true → (none)` 与 `role: dialog → (none)`。
- **同一对同名按钮在弹窗里也一样**：弹窗里两个 `Close` 只差位置、名字与描述完全相同，`text: "Close"` 命中 **3** 个——第三个是那段代码片段（它的 StaticText 里含 `Close`），子串匹配如实列出；两个 Close 的祖先都只写到 RootWebArea，因为那个 `dialog` 自身没有无障碍名（trail 只写有名字的祖先）。
- **ref 点击 + 导航回报正常**：列表页按 ref 点链接 → `changed: url, title` 两条都对（GET 那一类；POST 那一类见下）。
- **帧内控件不可达**（`/iframe.php`）：见下。

### 新发现：子帧的内容不在快照里，而 Chrome 的整页树本来就不含它

`testing.qaautomationlabs.com/iframe.php` 上有两个**同源**子帧（`iframe1.php` / `iframe2.php`，`contentDocument` 可达，帧里各有一句 `I am iFrame 1` 与一个 `button "CLick Me"`）。我们的快照只有两个节点：

```
- Iframe "iframe 1" [ref=…]
- Iframe "iframe 2" [ref=…]
```

`target=<那个 ref>` 也展不开任何东西。把 AX 探针挂到端口 9333 上量原始树（`.prove/ax-probe/tree.json`），两个 `Iframe` 节点的 `childIds` 都是 `[]`——**Chrome 的整页 `Accessibility.getFullAXTree` 不把子帧的树并进来**，每个帧要按 `frameId` 单独取。所以这是 Chrome 的形状，不是我们的过滤规则吃掉了它。

后果是帧内控件今天完全不可达：

- 没有 ref（快照里没有那些节点）。
- `selector` 也不行：`iframe[name=iframe1] button` → `no element matches selector …`，因为 `DOM.querySelector` 只在主文档里找。而这条错误接着建议"call browser_snapshot and act on a ref from its result"——在帧这一情形里是**死路**，那个 ref 永远不会出现。
- 唯一的路是 `browser_evaluate` 走同源 `contentDocument`，那是不可信事件，正是 `browser_click` 存在的理由。

修法是功能级的：按 `Page.getFrameTree` 给每个子帧各取一次树（同进程帧用 `frameId`，OOPIF 要附加 `Target`），把子树接到 `Iframe` 节点下面，ref 也要发给帧内节点，`selector` 同样要能下到帧里。不在本轮修复范围。

### 新发现：替换文档的点击把状态读在导航提交之前

`/login` 上提交表单（POST `/authenticate` → 302 回同一地址）连点两次，两次的回报都是：

```
Clicked button " Login".
Page: https://the-internet.herokuapp.com/login — "Loading https://the-internet.herokuapp.com/login"
The page changed: title.
```

三处都不对：那个标题**页面从来没有过**（提交前后 `document.title` 都是 `The Internet`，the-internet 所有页面共用这一个标题），`changed: ["title"]` 于是声称了一次并未发生的标题变化，而真正发生的事——整份文档被换掉（`#flash` 随后读出 `Your username is invalid!`，说明表单确实提交了）——一条都没报（mutation 数为 0，因为观察者装在被换掉的那份文档上）。对照组：点 `Form Authentication` 链接（GET，同源）回报的标题就是对的，`changed` 只有 `url`。

根因有两层，都是"读得太早"：

- **`page.title()` 会自己编一个标题。** Playwright 的 `_title()` 在页面答不上来（导航进行中、求值没法进行）时走 `catch` 分支，返回 `` `Loading ${pendingDocument()?.request?.url()}` ``（`playwright-core/lib/coreBundle.js` 里 `async _title()`，本机为 24472 行附近）。所以这个字符串的含义是"读不到"，不是"页面叫这个"。
- **`settle()` 等的不是"新文档提交"。** `await started.waitForLoadState('domcontentloaded')` 对**已经**处于该状态的旧文档是空操作，于是后面整段状态（url + title）都读在新文档提交之前；GET 那次恰好读在了提交之后，所以看起来正常。

修法要落在 settle 那一层（装一个导航观察者，等新文档提交之后再读状态，并把"文档被替换"本身当作一次变化报出来），那是本仓库最敏感的一处，不在本轮修复范围。

### 新发现：`selector` 进不到 shadow root 里的元素（与子帧同一个形状）

`testing.qaautomationlabs.com/shadow-dom.php` 的影子根里那个 `div.box`（`aria-label="Shadow DOM message box"`）在快照里是 `generic "Shadow DOM message box"`，**点它的 ref 成功**——`document.elementFromPoint` 在影子根那里只会返回宿主，所以这一次成功说明落点判定确实钻进了影子根（与笔记里写的行为一致）。但 `selector: "#shadow-host .box"` → `no element matches selector`。

根因是三处 `DOM.getDocument` 都没有 `pierce`（`session-browser.ts:2018`、`:2057`、`:2320`，都是 `{ depth: 0 }`），于是 `DOM.querySelector(All)` 的搜索面只是主文档的浅层。ref 能进影子根是因为 AX 树为影子节点也给了 `backendDOMNodeId`。**这与子帧那条是同一个形状**：`selector` 能到的地方比 ref 少，而"没有匹配"的错误在两种情形里都建议去找一个不会出现的 ref。

### 新发现：`find` 的搜索面比它自己声称的窄

实测（同一个站点）：`find: "tablist"` 命中那个 tablist 节点，而 `find: "level=\"1\""` 与 `find: "orientation"` 都返回 `Nothing in the page matches …`——可这两样确实印在快照的行里（`heading "…" level="1"`、`tablist orientation="horizontal"`）。所以 `find` 搜的是 **role 与名字**，不是"快照打印出来的文字"；工具描述里那句 "a query is tested against the text a snapshot prints" 不准确，照着自己看到的那行去搜的调用方会得到"页面里没有"的答复（而 `level=` / `url=` 这类属性恰好是模型最可能拿来筛的那几个）。

### 第二遍：<https://qaplayground.com/>（Next.js，14+ 个组件）

- **多标签的接管是对的**：点 `↗Open Tab A`（页面里是 `window.open`）那一次，回报正文就是新页，页列表是 `[0] https://qaplayground.com/practice/tabs-windows` 加 `[active] https://qaplayground.com/`。调用方**没有**"选某个页面"的参数，这是有意的（`src/tools/index.ts` 里 `tabsText` 的注释：*the pages are not the caller's to choose*）。退回原页有两条路：在 `browser_evaluate` 里 `window.close()` 关掉新页（实测两次都随即退回原页），或按地址导航回去（丢页面状态）。页列表里的 `[0]` 只是标号，没有任何参数收它——**界面上也看不到**：`src/client/api.ts` 里有 `tabs`，但只有设置页横幅用它显示"n 个页面"，面板那一侧是一个观察窗、跟着活动页走（`view.tsx` 里的 `tab` 是 DSH 自己的标签信息）。所以"浏览器开了几个页面"只能从工具回报与设置页看出来。
- **但三次里只有第一次抓住了新页**，第二、三次都漏了（见下）。
- 这一遍只走了多标签；数据表、动态等待、无限滚动没走。

### 新发现：`window.open` 开出的新页可能赶不上这次回报

三次点开新标签，第二、三次的回报是这样的（以第三次为例，页面自己已经数到 `3 tabs opened`）：

```
Clicked button "↗Open Tab C".
Page: https://qaplayground.com/practice/tabs-windows — "How to Handle Tabs and Windows…"
The page changed: dom.
dom: ~ button "↗" → "✓"; ~ span "2 tabs opened" → "3 tabs opened"

[active] https://qaplayground.com/practice/tabs-windows
```

回报里**只有一个页面**，正文说页面停在旧页。紧接着的下一次调用（一个 `depth: 1` 的快照）里却是两个页面、活动页已经是新页：

```
[0] https://qaplayground.com/practice/tabs-windows
[active] https://qaplayground.com/practice/links
```

这与"替换文档的点击读得太早"是**同一个根因面**：settle 只等"当前文档安静"，不等"新文档 / 新页面提交"。区别在后果更大——`tabsText` 的注释明说这行就是为此存在的（*a caller that could not see that would keep describing the page it left behind*），而这里正是它没起作用的那种情形：调用方被告知"还在旧页"，下一次调用却已经落在它从未被告知的新页上。修法同上：动作之后先等"文档/页面提交"这件事，再读状态与页列表。

### 新发现：点击不看元素能不能用（与输入不对称）

`/practice/dynamic-waits` 上有一个初始禁用的 `Submit`（快照里就写着 `button "Submit" [disabled]`）。点它：

```
Clicked button "Submit".
The page did not change. That is what the page says, not a verdict on the action: …
```

`browser_type` 对禁用输入框是会点名拒绝的（上一轮刚修：`would not take the text because it is disabled; nothing was typed`），而 `browser_click` 对禁用按钮既照派事件、也照报 `Clicked`，唯一的相关提示是那句对所有"没变化"都一样的"读作：还没看到可观察的变化"。模型据此最自然的下一步是再点一次或去找遮罩，而真正的原因（按钮还没启用）一个字都没有。Playwright 的 actionability 里 "Enabled" 与 "Receives Events" 是并列的两条，我们只做了后者。

### 新发现：等待没有"可用"这个条件

同一页的演示文案是 "Button becomes enabled 3 seconds after arming"——**"等到某个控件可用"正是动态等待最核心的场景**，而 `browser_wait` 的条件只有 text / role+name / selector / url / time。为了把它钉成可复现的证据，往页面里注入一个稳定禁用的按钮再等它：

```
注入： <button id="dsh-disabled-probe" disabled="">Submit probe</button>
browser_wait({role: "button", name: "Submit probe"})
→ Waited 0.5 s — button "Submit probe" is on the page.
```

按钮一直是禁用的，等待却当场成功——因为"在页面上"与"能按"是两件事，而条件语言只有前者。调用方只能退到 `time: 3000`（它自己的文案称之为"最后手段"）或在 `evaluate` 里轮询。

### 新发现：布尔属性的方向读不出来（加了和删了是同一条）

同一个注入的按钮，用两个各改一次的按钮分别驱动，回报是**一模一样**的一行：

| 动作 | 回报 |
| --- | --- |
| `probe.disabled = true`（加上属性） | `dom: ~ button "Submit probe" disabled: (none) → (none)` |
| `probe.disabled = false`（移除属性） | `dom: ~ button "Submit probe" disabled: (none) → (none)` |

真机先量过 Chrome 给的是什么：移除时 `MutationRecord.oldValue` 是 `""`，回调时 `getAttribute('disabled')` 是 `null`。根因在主机侧 [`readChange`](../../../../src/browser/session-browser.ts) 的 `said()`：

```js
if (typeof value !== 'string' || value === '') return undefined
```

它把**空串当成"页面没说"**，可 `disabled=""` 的空串恰恰是它真实的值（布尔属性一律如此：`checked`、`selected`、`required`、`readonly`、`hidden`…）。于是 `from: ''` 被丢掉，两边都渲染成 `(none)`——"这个属性被加上/被移除"这个信息完全丢失。页面侧其实把该给的都给了（`attributeOldValue: true`，`oldValue` 实测是 `""`），丢掉它的是我们自己这一侧。

### 两条"留给 evaluate"的实测结论（记下来，省得下次重新怀疑）

- **拖拽能做到，但必须给坐标。** 页面的重排发生在 `dragover` 里、按 `e.clientY` 决定插到谁前面：`dragstart` 打在源上、`dragover` 打在目标上（带 `clientX`/`clientY`）、再 `dragend`，`Item 1:- Inbox` 从第一挪到了最后。第一次探的时候没带坐标（`clientY` 为 0），顺序纹丝不动——所以"拖拽做不到"曾经是个**假发现**，是量第二遍量掉的。
- **上传给不了真实路径。** `browser_type` 对 `<input type=file>` 的拒绝是对的（`input would not take the text because it takes no typed text`；那个 input 本身 `display: none`，所以它不在树里、快照里只有样式化的 `LabelText "Browse for a file to upload"`）。要给它文件只能在 `evaluate` 里造 `File` 塞进 `DataTransfer` 再触发 `change`——页面确实认（`Selected File: dsh-probe.txt & File Size is 0.01 KB`）。也就是说调用方能给的永远是**内容**，不是磁盘上那个文件；`DOM.setFileInputFiles` 没有工具包。

## Alternatives considered

**只跑 `pnpm test` 与回归就算验证完。** 否决——这正是三个缺口漏过去的方式：单测用的是假 CDP 与假 store，回归只驱动 `SessionBrowser`，两者都看不到"工具层的结果要过 harness 的 `output.schema` 校验"这一层，也看不到 Chrome 对某个具体控件会怎么答。

**发现缺口就顺手把假件补一个字段/换一句错误拼法。** 否决：那只修了这一个字段。规则要写成"假件的形状抄真件"，否则下一轮换个服务、换个协议方法，同一个形状的洞会再出现一次。

**把这次验证的记录留在 `.prove/`。** 否决：`.prove/` 是 gitignore 的衡量产物，不是权威；持久的结论进笔记（本篇），可执行的判据进回归脚本。

**把真实站点本身当回归判据。** 否决：外部内容会变（[19] 已经红过一次）。真实站点用来发现缺口与观察真实行为，判据落在自己的 fixture 上。

## Consequences

- 验证有了一份可复用的清单（站点 + 每个工具看什么），下一轮照做即可；成本是整轮约四十次工具调用加一次回归。
- 三个缺口的共同形状值得记住：**假件的形状决定测试能看见什么**。假 CDP 的 `DOM.focus` 永远成功、假 store 只答声明过的字段，于是"禁用"与"多字段"这两个真实形状在测试里不存在。
- **`inline` 这条链路的闭环依赖一次插件重载**：DSH 在加载插件时读入 `lib/index.js`，`pnpm run build` 只更新磁盘上的产物，所以界面上仍跑旧模块时同一个调用会继续报校验错误——那不是修复没生效，是模块没被换掉。2026-09-29 重载后复验通过（见上一节）。下次改 host 半边时按同一顺序：改源码 → 跑测试 → `pnpm run build` → 重载/重启 → 用工具面复验一次。
- 两条欠账在同一次复验里销掉：`/login` 的 `Username` / `Password` 无障碍名确实来自关联 `<label for>`（页面里既没有 `placeholder` 也没有 `aria-label`，浏览器自己的 `input.labels` 也答同一个词）；`/login` 上 `text: "Login"` 同时命中 `heading "Login Page"` 与 `button " Login"` 而被拒，补上 `role: "button"` 就命中按钮——`role`+`name` 的消歧在真实页面上成立。
- 这一轮之前的三条结论都被复验为真，但**三遍真机过下来又找出九条新的**，按优先级是：子帧内容不在快照里且 ref / `selector` 都到不了（`Iframe` 节点在原始树里 `childIds: []`，是 Chrome 的整页树不含子帧，属功能级改动）＞`window.open` 开出的新页赶不上这次回报（三次里漏两次，而那一行正是为防止"调用方继续描述它已经离开的页面"存在的）＞替换文档的点击会报出一个页面从未有过的标题（`page.title()` 在答不上来时自编 `Loading <url>`）＞点击不看元素能否使用（与输入的拒绝不对称）＞等待没有"可用"这个条件＞布尔属性的方向读不出来（`disabled` 加了和删了印成同一行，根因是我们自己的 `readChange` 丢掉空串）＞`selector` 进不到 shadow root（三处 `DOM.getDocument` 都没带 `pierce`）＞`find` 只搜 role 与名字、却声称搜的是打印出来的文字＞"没有匹配的 selector"这条错误在有子帧时给的建议是死路（它叫调用方去取一个不会出现的 ref，这一条随前几条一起修）。前三条其实是同一句话的三个面：**回报是在页面把话说完之前读的**。一次真机过一遍的价值不在"确认已修的"，而在这种只会在真实导航时序、真实帧结构与真实影子根里出现的缺陷。
- 这九条（外加多标签"设置页看得到两个页面、侧栏只有一个标签"的第十条）已在同一天分批修复：前九条按缺陷类别落在各自的笔记里（定位/输入/截图/变更清单/等待，见 Related 与各自的链接），第十条的 1:1 标签见[那一篇](../feature/2026-09-29-one-tab-per-page.md)；回归脚本补了 [27]（同址两页仍是两个 CDP target、按 target 关页、按页镜像出帧）。

## Related

- [定位参数化：ref，或者"在动作那一刻再问一遍"](../feature/2026-09-29-locator-parameters.md)（缺口 1）
- [输入也要问页面能不能接](../bug-fix/2026-09-24-typing-actionability.md)（缺口 2）
- [截图的形状：整页 / 元素 / 内联，以及 clip 是页面坐标](../feature/2026-09-29-screenshot-shapes.md)（缺口 3）
- [求值结果的形状：字符串原样、超长落盘](../feature/2026-09-29-evaluate-result-shape.md)（本轮一并复验）
- 固定任务集：[`scripts/snapshot-regression.mjs`](../../../../scripts/snapshot-regression.mjs)
