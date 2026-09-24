# Agent Note: 输入也要问页面能不能接

Status: implemented

## Problem

`browser_type` 的回报会是假的：2026-09-24 在真实 Chrome 上，往一个 `readonly` 的 `<input>` 里输入，工具回 `Typed "typed-into-readonly" into textbox "readonly". The page did not change.`，而那个框的值一直是 `""`。同一个页面上的可编辑框则正常拿到 `hello-there` 并聚焦，所以不是输入通道坏了，是**没有任何人问过这个控件收不收文本**：`DOM.focus` 对只读输入框是成功的，`Input.insertText` 随后静默插进空气。

这与[被遮罩的点击被报成成功](2026-09-24-click-point-and-interception.md)是同一类缺陷：工具说了话，但那句话是错的，而且错得很有说服力——模型会以为字段填好了，接着提交一个空表单。

## Decision

焦点落下之后、**选中旧值和插入第一个字符之前**，用 `typedProbe()`（`Runtime.callFunctionOn`）问页面一次，答案由 `readTyped()` 逐字段校验：

- 探针回答的是页面的 `activeElement`（元素本身或它的后代），所以"焦点没落在这个元素上"也是答案的一部分——那正是文本会跑到别处的另一种方式。
- 四种拒绝理由，原样写进错误：`it is read-only`、`it is disabled`、`the page did not focus it`、`it takes no typed text`（一个 `<button>`/`<div>` 这类控件）。
- 错误形如 `dsh-browser: textbox "locked" would not take the text because it is read-only; nothing was typed, so take a new snapshot and check the element`，并且**什么都没派发**：`Input.insertText` 一次都不会发出。
- **页面答不上来就不拦**：答案读不出这个代码能用的字段（节点已被替换、`DOM.resolveNode` 失败）时按原行为继续。这是与点击回退到 CDP quad 同一种取舍——探针是"问页面一个问题"，不是页面必须满足的前置条件。
- `browser_type` **不加 `force` 参数**：点击的 `force` 关掉的是"Receives Events"（遮挡有时是真的可以忽略），而这里的拒绝是"文字根本进不去"，放行只会把假成功请回来。工具面继续是 6 个，能力做成参数而不是新工具。

## Testing

- `test/session-browser.test.ts` 新增三条：只读字段被指名拒绝且 `Input.insertText` 为空；焦点没落上的元素被拒绝；页面答不上来时文本照旧发出（用假启动器默认那份"点击答案"来建模"答不上来"）。
- `pnpm test` **195/195，exit 0**（从 192 涨到 195）。
- `pnpm run regression` **39/39，exit 0**，新增 [18]：真实 Chrome 上 `data:text/html` fixture，只读框回报 `dsh-browser: textbox "locked" would not take the text because it is read-only…`、读回 `""`，同一个页面上的可编辑框仍拿到 `"hello" into textbox "free"`。

## Alternatives considered

**只把 `readonly`/`disabled` 写进文档，让模型自己看快照**：快照里只读框和普通框长得一模一样（`textbox "locked"`），ARIA 没有这个信息，读不出来的东西不能靠提醒。**加一个 `force` 参数保持一致**：见上，`force` 在点击那里是"明知有人盖着也要按"，在这里等于"明知进不去也要报成功"，语义相反。**拒绝前先试插一次、再读 `value` 验证**：那要往页面里写进又撤掉一段文本，会触发 `input` 事件（有的站点据此发请求），代价比问一句大得多。**按 Playwright 的四项全查（Visible/Enabled/Editable/Receives Events）**：可见性与遮挡对"程序化聚焦后插入文本"并不构成障碍，查了只会拒绝掉本来能用的流程。

## Consequences

`browser_type` 的成功不再等于"没抛错"。代价是每次输入多一次 `Runtime.callFunctionOn`（同步函数，无等待），以及**页面答不上来时仍可能回到旧的静默行为**——这条回退是有意留的，靠真机回归 [18] 与真实站点上的常规使用盯着。仍然不查可见性与遮挡：一个被遮罩盖住但可聚焦的输入框照样能被输入，这是与点击不同的正确行为。
