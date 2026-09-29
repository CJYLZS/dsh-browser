# Agent Note: 截图的形状：整页 / 元素 / 内联，以及 clip 是页面坐标

Status: implemented

## Problem

截图只有一种形状：视口。于是两件事做不了——**判断布局**（比窗口高的页面里，视口截图只是任意一扇窗）与**看一个控件**（要么截整页再找，要么绕回 DOM）。第三个问题是流程上的：截图写在磁盘上、模型必须再 `read_image` 一次，同一批像素被判断了两次，也花掉一次调用。

原计划里还有一条当时写成"元素截图要先滚动到元素，而滚动本身改变页面状态（懒加载、`IntersectionObserver`）"的风险——这条风险**在动手前被证伪了**，见下。

## Decision

### 三种形状，都是参数

`browser_screenshot({ …元素目标, fullPage?, inline? })`：

- **默认** → 视口：不传 `clip`，报 `cssVisualViewport` 的尺寸；
- **`fullPage: true`** → 传文档尺寸（`Page.getLayoutMetrics` 的 `cssContentSize`）的 `clip` + `captureBeyondViewport: true`，报文档尺寸；
- **元素** → 用与动作工具**同一套**目标写法（`ref` / `role`+`name` / `text` / `selector`）解析出元素，问页面它的矩形，裁剪那一个矩形，报元素的尺寸与它的 role+name。

元素与 `fullPage` 同时给是**工具层拒绝**的：整页和一个元素是两张不同的图片，猜哪一张等于把假结果请回来。参照系的 CUA 动作 schema 也在注释里写了同一条互斥（`// 区域截图：…与 fullPage 互斥`）。

### `clip` 是页面坐标：实测纠正了参照系的注释

`src/browser/session-browser.ts` 的 `clipProbe()` 返回 `getBoundingClientRect()` **加上各层文档的滚动偏移**，沿 `frameElement` 一路加到顶层文档——也就是**页面坐标**。这个选择来自一次专门的测量（`.prove/clip-space-probe.mjs`），而不是照抄：

- fixture：400 px 高的视口、2000 px 高的文档，`y = 1200..1300` 处放一块 300×100 的**高反差条纹**，其余是白纸。条纹块压缩后的 JPEG 是白纸块的 **20.4 倍**——所以"文件多大"就能判断裁剪有没有落在条纹上，不需要任何图像解码库。
- `clip: {y: 1200}` + `captureBeyondViewport: true` → 条纹（19532 B）；`captureBeyondViewport: false` → 白纸（957 B）。**视口之外的区域只有 beyond 才给。**
- 滚到 `scrollY = 900` 后再用同一个 `{y: 1200}` → **仍然是条纹，字节数与 scroll 0 时一模一样**；而把同一个元素当成视口坐标（`y: 300`）去裁 → 白纸。

参照系的注释把 `clip` 说成"视口 CSS px"（`browser-use` 的 CUA schema："区域截图：CDP Page.captureScreenshot 的 clip（视口 CSS px）"），**这一步是错的**，或者至少对"先滚动再截图"那条路才成立。我们的结论是：**页面坐标 + `captureBeyondViewport: true`，因此元素截图不需要滚动页面**——那条"滚动会改变页面状态"的风险直接消失，而不是被管理。

回归 [25] 把同一条结论钉在真机上：元素截图在 `scrollY = 0` 与 `scrollY = 900` 下**字节完全相同**。

### `inline`：软依赖 + 硬门禁

`inline: true` 除了写文件，还把图片作为 image 内容块附在结果里（`render` 返回 `[{type:'text'}, {type:'image', attachment}]`），省掉 `read_image` 那一跳。它通过两个**结构化声明**的服务工作（`src/tools/attach.ts`，与 `spillStoreOf` 同一手法，插件不 import 这两个包）：

- `ctx.get('attachments')` 的 `saveImage({ data, mediaType, name })` → 持久的 `ImageAttachmentRef`；
- `ctx.get('llm')` 的 `resolveModelInfo(provider, model)` → 该模型声明的 `inputModalities`。

**路由门禁不能省，也不能放到截图之后**：一个不声明 image 输入的模型收到图片块会让**整个请求**失败，而图片块属于被 append 的工具结果，于是**之后每一次请求都会失败**——这不是浪费 token，是把会话弄坏。所以 `assertImageRoute()` 在**截图之前**跑，拒绝时给出出路（"drop inline to get the file path"），并且**一个像素都不采**。

形状的正确性不是猜的：`shotBlocks()` 的返回类型被 harness 自己的 `ContentBlock` 检查过（结构化声明的 `ImageRef` 一字不改地被接受），也就是说这条"不 import 包"的路在类型层也是通的。

**但类型层通过不等于结果能过校验：附出去的引用必须收窄成自己声明的字段。** 工具结果会被 harness 按 `output.schema` 校验，而 store 的记录比我们声明的宽。2026-09-29 在这个 GUI 里量到——真实 store 答的是 `ImageAttachmentRef`（`name?` 与 `originalDimensions?` 都在里面），我们只声明了五个字段且 `additionalProperties: false`，于是整个工具结果被拒：`tool "browser_screenshot" returned invalid output: "value.image.name" is not a declared property (additionalProperties: false)`，字节**已经写进 store**，模型拿到的却是一个错误——而错误里那句 `value.image.name` 是本插件自己的字段名。现在 `imageRefOf()`（[`src/tools/attach.ts`](../../../../src/tools/attach.ts)）逐字段抄成 `attachmentId / mediaType / bytes / width / height / name? / originalDimensions?`，`IMAGE_SCHEMA` 与之逐字对应；harness 自己的 `read_image` 也是这么映射它的 `ImageAttachmentRef` 的（`imageRefFromValue`）。store 以后再多一个字段只会被丢掉，不会把一次已经发生的采集变成失败。

### 伴生改动：`depth=` 的截断文案给出"页面到第几层"

同一条验收标准里还挂着 09-28 的第 9 条摩擦（09-24 也撞过一次）：`depth=6` 只回报 `311 nodes are deeper than depth=6`，既不说那些节点挂在哪一支，也不说该换哪个数值——"raise depth"因此在实践上是一次一次试。

`src/browser/aria.ts` 现在**先量一次树的实际深度**再写这句话：

```
… 311 nodes are deeper than depth=6 (the page goes to depth=11) and were not printed; raise depth to see them
```

测法是与打印器**同一套提升规则**的一次遍历（`deepestDepth()`：整棵丢弃的 wrapper 不进入，非打印节点不增加层级，因为它的子节点会提升到它自己的层级），所以第二个数字是"再深也到这里"的确切上界，不是估计。成本是内存里那棵树的又一遍 O(n) 遍历（≤1500 节点），没有任何协议调用；`depth` 足够大时这句话根本不出现，所以多出来的半句只在真被截断时花 token。

## 参照系实测

- **Codex**：`screenshot(options: { fullPage?: boolean; clip?: ClipRect }): Promise<Uint8Array>`；CUA 动作 schema 是 `{ method: 'screenshot', ref?, fullPage?, clip?, tabId? }`；元素级另有 `elementScreenshot({ includeNonInteractable?, x, y })`——**只有坐标**，没有 ref。我们有 ref，所以元素级按 ref/定位器做，比它强。
- **纪律两条**（`docs/screenshot.md`，"lookup-only guidance"）：①bytes **必须**在同一格 `nodeRepl.emitImage(...)` 转成 image 块，"绝不要把 `Uint8Array` 当最终表达式返回"；②"如果一次截图超时了，不要立刻再发同一张"——底层的捕获可能还在完成。第二条进了我们技能里的 `references/visual-evidence.md`。
- **Codex 还有 `views`/`browserScreenshotPaths`**：显式 `tab.screenshot()` 的原始 PNG 会被记成 session artifact 的绝对路径。我们不需要它：文件路径就是我们返回的那个值。
- 它没有"元素与整页互斥"的**运行时**拒绝（schema 里三者都在），只有注释说互斥；我们把它做成参数校验。

## Alternatives considered

**先滚动到元素，再按视口坐标裁剪（即参照系注释所暗示的那条路）。** 否决——它建立在"clip 是视口坐标"这个前提上，而这个前提被实测推翻了。既然页面坐标能直接裁到视口之外，滚动就是纯粹白白引入的副作用（懒加载被触发、`IntersectionObserver` 被喂一次、`scroll` 事件被派发），也顺带把"元素截图会不会改变页面"这条风险变成不需要管理的东西。

**用 `DOM.getContentQuads` 当矩形。** 否决：它给的是**帧内视口坐标**（2026-09-24 那条教训[已经量过](2026-09-24-dialogs-chords-and-parity-round.md)：滚动页上第 2471 px 的元素 quad 是 433），要变成页面坐标得自己加滚动偏移，而且它只给内容框、跨帧要再走一遍。页内探针一次就把 `getBoundingClientRect + scroll` 拿到，并且能沿 `frameElement` 走出嵌套帧。

**PNG 而不是 JPEG。** 否决：整页 PNG 的体积在长页面上是数量级的差别，而 JPEG 的质量已经是一个配置项（`quality`）；`inline` 时附件服务也会检查尺寸与字节上限，JPEG 更容易过。

**把元素截图做成新工具（Playwright MCP 的 `browser_take_screenshot` 形状）。** 否决：截图已经是一个工具，形状是它的参数——这一条正好是"新能力做成参数"的正面例子（与 `browser_wait`/`browser_console` 那两个有意破例相对）。

**不做 `inline`，保持"截图只返回路径"。** 曾是这个仓库的立场（`README` 与 `src/tools/index.ts` 的文件头都写着"图片块需要附件服务签发的引用，插件无法自行构造"）。改主意的理由：那半句"无法自行构造"**是错的**——`ctx.get('attachments')` 就能拿到服务，`read_image` 走的就是这条路；而"省掉一次往返"对"看一个东西长什么样"这种任务是直接收益。代价是一个跨包软依赖与一个必须存在的门禁，两者都写在上面的 Decision 里。

**给 `inline` 一个"服务不在就静默降级成纯路径"的行为。** 否决：模型明确要了图却只拿到路径，而结果里不提这件事，就是一次静默的偏离期望——与"参数写错要拒绝并指路"的既有风格相反。

## Consequences

- 整页截图对 `position: fixed` 元素的表现由 Chrome 的 beyond-viewport 实现决定（固定定位元素在长页面上通常只在顶部出现一次）；这一点**没有**专门验证，是我们与 Playwright 的 `fullPage` 共享的已知行为。
- 元素没有盒子（`display: none`、零尺寸）时拒绝并指路（复用 `boxlessError`），不会给一张空白矩形。
- 页面坐标对**嵌套帧**的处理是"逐帧 `getBoundingClientRect` + 各层滚动"，与 press 的走法同源；帧边框（`clientLeft/clientTop`）没有算，跨帧元素可能差一两个像素。
- `inline` 让 `browser_screenshot` 成为唯一会**改变请求形态**的工具：同一次调用在有图像能力的模型上是"文本 + 图片"，在别的模型上是"文本 + 路径"。
- `lib/` 的构建产物里多了 attachment 的调用点，但**运行时依赖没有增加**：两个服务都是通过 `ctx.get` 拿的。
- **`inline` 的失败模式是被这一次真机验证改掉的**：字段名的校验失败发生在采集**之后**，所以那时候的代价是"图采了、存了、结果报错"。收窄之后剩下的失败模式只有 store 自己抛错（在采集之后、写文件之前），与门禁拒绝（在采集之前）各占一端。

## Testing

- `test/session-browser.test.ts`（4 条）：视口截图不传 `clip`；整页截图的 `clip` 是文档尺寸且 `captureBeyondViewport: true`；元素截图的 `clip` 是页内探针给的矩形（向下取整/向上取整）且**没有 `DOM.scrollIntoViewIfNeeded`**；没有盒子的元素被拒绝且一次都没截。
- `test/tools.test.ts`（3 条）：三种主体的文案、内联与不内联的文案差、`shotBlocks` 在有/无图片时分别是两块与一块。
- `test/attach.test.ts`（7 条）：两个服务的结构化查找、有图像能力的路由通过、无图像能力/无法解析路由/没有 llm 服务三种拒绝、以及 `imageRefOf` 把 store 多给的字段丢掉而保留声明过的可选字段。
- `test/ptc.test.ts`（4 条，注册表层）：`inline` 会把**采集到的字节**交给 store 并渲染出 image 块；一个答得比声明宽的 store（`name`、`originalDimensions`、外加一个我们不报的字段）**不会**让结果被校验拒掉；不声明 image 输入的模型被**在截图之前**拒绝（断言 `Page.captureScreenshot` 一次都没发生）；`fullPage` 与元素同时给被拒绝。
- 真机：`.prove/clip-space-probe.mjs`（坐标空间）+ `scripts/snapshot-regression.mjs` [25]（6 条：视口/文档尺寸、元素尺寸与名字、滚动位置保持 0、同一元素两次截图字节相同）。

## Related

- [工具面下一轮](../../proposed/feature/2026-09-29-tool-surface-next-round.md)——本条的出处（原 P2-6）
- [点击的坐标只有一套](2026-09-24-dialogs-chords-and-parity-round.md)——quad 是视口坐标的那次测量；本条是它在截图侧的对偶
- [工具面未解决的摩擦（第二轮·本地 SPA）](../../proposed/testing/2026-09-28-local-spa-drive-frictions.md)——第 8、9 条的现场
