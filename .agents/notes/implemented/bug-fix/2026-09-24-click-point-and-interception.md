# Agent Note: 点击落点由页面自算，被遮挡的点击默认拒绝

Status: implemented

## Problem

点击是按坐标派发的，而坐标一直由插件自己算：`pointOf()` 读 `DOM.getContentQuads`，再按"content quads 是页面坐标（含滚动偏移）"减掉 `cssLayoutViewport.pageX/pageY`。2026-09-24 在 Google 搜索结果页（`scrollY = 2038`）上量到，这个假设是反的——quads 已经是帧内视口坐标。于是三次点击全部派发到 `(440, −1589)`：视口之外，`elementFromPoint` 返回 null，事件落在 `HTML` 上，链接上 `mousedown`/`mouseup`/`click` 一个都没有，而回报写着 `Clicked heading "…"`，还附了一句由滚动引起的 `The page changed: dom.`。

这个缺陷活过了所有既有验证，因为 **`scrollY = 0` 的页面上"视口坐标"与"页面坐标"是同一个数**：假 CDP 的 fixture 一屏放得下，当年的真机验证（点击 "Learn more" 真的跳转）也在页首。影响面只有 `browser_click`——`browser_type` 走 `DOM.focus` + `Input.insertText`，不碰坐标。

## Decision

点击的落点由**页面**给出，并在派发前校验：

- `pressProbe()`（`Runtime.callFunctionOn`，`awaitPromise: true`）一次回答三件事：**落点**（`getBoundingClientRect` 的中心；`StaticText` 这类非元素节点先用它的父元素；元素在 iframe 里就沿 `frameElement` 走到顶层帧）、**`moved`**（等两帧再读一次，动了就再问一遍，最多两次）、**命中**（`elementFromPoint` 钻进 shadow root 后落在谁身上）。
- 命中不是目标也不是它的后代（`within()` 同时走 light DOM 与 shadow root 的祖先链）→ **默认拒绝**，错误里指名接收者与 `force: true`；加 `force` 才照发，并把 `obstructed` 写进回报。
- 落点在视口之外 → 一律拒绝，`force` 也不放行。
- 页面完全不肯描述落点（节点已被替换等）才回退到 CDP 的 quad，并且**原样使用、不再换算**；这条回退没有命中校验，是已知的例外。
- `browser_click` 多一个 `force` 参数——不加新工具，新能力做成参数。

## Testing

- `.prove/quad-probe.mjs` 在滚动页上量出 quad 与页面坐标的关系（quad y = `433`，`pageY` = `2038`，元素在文档第 2471 px）。
- `.prove/click-probe.mjs` 在**正确**坐标 (440, 450) 派发可信输入，页面立刻跳到 `github.com/ChromeDevTools/chrome-devtools-mcp/issues/716`——证明失败的原因只有坐标，不是输入可信度，也不是页面的手势门槛。
- `node --test` 181/181（新增"被遮挡默认拒绝""`force` 照发并回报""视口外拒绝（`force` 也不放行）""移动元素重读"）。
- `pnpm run regression` 33/33，新增 [15]：比视口高的 fixture 上量到 `the press reached the element, at a point inside the viewport — changed: dom, press at y=881, viewport 900`，落点由元素自己的 handler 记下。

## Alternatives considered

**只修那一步减法，遮挡仍然只报告**（本仓库先前的取舍，见 [动作层三个骗法与快照两处语义](2026-09-25-action-reporting-and-snapshot-semantics.md)）：改动最小、零行为变更，但"静默点空"会在别的几何条件下重来，而"没报错"仍然会被模型读成成功。**照 page-agent 改成 DOM index + 页面内合成事件**：它根本不算坐标、遮罩也挡不住，代价是 `isTrusted: false`（检查可信度的站点会忽略），而且能点到真人点不到的按钮——用保真度换稳健，与本插件"给可信的真实输入"的定位相反。**保留 CDP 的 quad 作为主路径**：它必须被解释（哪套坐标、要不要减滚动量），而解释错一次就是这一则笔记；页面自己的 `getBoundingClientRect` 不需要解释。

## Consequences

点击的成功不再等于"没抛错"：被遮罩吞掉时，模型拿到的是可执行的下一步（关掉遮挡，或 `force`），而不是一条看起来成功的结果。代价是每个点击多一次 `Runtime.callFunctionOn`（含最多 50 ms 的两帧等待），而且**默认拦截会让以前"能点穿"的流程失败**——这是有意的取舍。仍未覆盖：跨域 iframe 的偏移走不出去（`frameElement` 返回 null），此时落点停留在那个帧自己的坐标系里。

**同一类缺陷在 `browser_type` 上另有一份**：只读输入框会接受焦点、`Input.insertText` 静默插进空气，而回报说文本已经输入——[输入也要问页面能不能接](2026-09-24-typing-actionability.md) 用同一句"问页面"的探针修掉了它，并且刻意**没有**照搬坐标那一套（可见性与遮挡对键入不是障碍）。
