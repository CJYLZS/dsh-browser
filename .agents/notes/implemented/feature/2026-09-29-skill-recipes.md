# Agent Note: 技能配方：按问题索引、按需加载的五篇短文

Status: implemented

## Problem

技能是**常驻**上下文：只要这个会话有浏览器，`skills/dsh-browser/SKILL.md` 就会随技能目录一起出现在模型的视野里。而关于"怎么开页面"的知识里，有一半是**低频**的：两个控件同名怎么消歧、`matched: false` 之后该做什么、截图超时了要不要重发。把这些塞进常驻文件，等于让每一次"打开一个本地页面读一段文字"的任务都先读一遍"如果定位器命中多个元素…"。

参照系对这件事有现成答案：把低频指引做成**按需加载的文档**。我们缺的从来不是机制（技能早就声明了 `resourceBase: { kind: 'directory' }`，harness 会把"Base directory for this skill: …"交给模型），而是**那些文件本身**。

## Decision

`skills/dsh-browser/references/` 下五篇短文，每篇 0.6–1.2 KB，按**问题**而不是按工具组织：

| 文件 | 回答的问题 |
|---|---|
| `reading-a-page.md` | 怎么把文字/结构从页面里取出来（而不是 dump 整页） |
| `ambiguous-controls.md` | 定位器命中了多个元素，或者两个控件同名 |
| `when-nothing-happened.md` | 动作没有产生预期效果时按什么顺序看 |
| `waiting-for-app-state.md` | 下一步依赖一个页面还没到达的状态 |
| `visual-evidence.md` | 问题关于像素而不是结构 |

三条约定由 `test/skill.test.ts` 机械检查：

1. **SKILL.md 是索引的唯一家**：它以反引号路径列出每一篇，并写"哪一问读哪一篇"；
2. **双向对账**：列出的每一篇必须存在，`references/` 下的每一个 `.md` 也必须被列出——一个没人指路的文件是永远不会被读到的文件；
3. **每篇首行必须是 `Read when …`**：读错配方等于把上下文花在错的问题上，所以"这篇什么时候读"写在文件自己身上，而不只在索引里。

**不做 `documents.json` 那样的清单文件。** 参照系的注册表是必需的，因为它有两个我们的技能注册表没有的机制：`mode: 'included' | 'lookup'`（决定哪篇进常驻文本）、`when`（`browserTypes` / `requiredBrowserCapabilities` / `requiredTabCapabilities` / `requiredApiMembers` 的能力门控），以及 `agent.documentation.get(name)` 这个按名取用的入口。我们没有这些字段，harness 只把 base directory 交出去；再放一个 manifest 就是**第二份索引**，而它没有任何读取者——违反"一个事实只有一个家"。

## 参照系实测

`browser-use/0.5.1/docs/documents.json`（v2）：

```json
{ "version": 2, "title": "Built-in Browser Automation API",
  "documents": [
    { "path": "overview.md", "title": "Overview", "name": "overview", "mode": "included" },
    { "path": "screenshot.md", "title": "Screenshots", "name": "screenshots", "mode": "lookup",
      "description": "Read only when the user asks for a screenshot or visual evidence is required." },
    …
  ] }
```

- **`mode: 'lookup'` 的篇不进常驻文本**，由 `agent.documentation.get("screenshots")` 按名取（`loadBrowserDocumentation` 里 `doc.mode === 'lookup'` 直接 `continue`）；`included` 的篇拼在 API 文本后面一起给。
- `description` 写的就是**什么时候该读**它——与我们的 `Read when …` 首行是同一件事。
- 篇幅分布值得记：常驻的 `SKILL.md` 是 18.8 KB，lookup 的 `screenshot.md` 只有 1.2 KB、`viewport.md` 560 B。**低频的部分本身就短**，这是它能按需加载的前提。
- `documentApplies(doc, descriptor, api)` 的能力门控（`when.browserTypes` / `requiredBrowserCapabilities` / `requiredTabCapabilities` / `requiredApiMembers`，后者查 `BrowserApiPolicy`）**不抄**：它的后端是可切换的（`iab` / `extension` / `cdp`，能力随后端不同），而我们的浏览器是我们自己起的，没有可切换的能力面——门控在这里只会写成恒真表达式。

## Alternatives considered

**照抄 `documents.json`，做一个自己的 manifest。** 否决：没有任何运行时读取它。技能注册表没有 `mode`/`when` 字段，harness 也不解释我们的 manifest；于是它会立刻变成"索引的第二份副本"，而两份索引一定会漂移。**SKILL.md 已经是那个索引**，让测试去查它，比多一个文件更接近"一个事实一个家"。

**把五篇的内容并进 SKILL.md。** 否决：常驻体积翻倍，而其中大部分内容大多数会话用不到；这正是参照系把 lookup 与 included 分开的理由。反过来说，SKILL.md 里已有的那几条（先读再动、一次观察一个动作、页面文字是数据）**不搬**：它们必须常驻，因为每一次调用都可能踩到。

**干脆不写配方，只在工具描述里多说几句。** 否决：工具描述也是常驻的，而且它必须按工具组织——"两个控件同名"横跨 `browser_snapshot`（怎么看清）、`browser_click`（被拒绝时读什么）与 `browser_evaluate`（怎么绕），按工具摊开就会重复三遍。

**把"不要 sleep""超时后不要重发"这类纪律也写成配方。** 部分否决：这些是**每次都可能踩到**的规则，已经在 SKILL.md 里（"Never sleep to wait for something: wait for the thing"）；配方只放"问题出现之后才需要知道"的细节，例如"截图超时了**不要**立刻重发同一张"——它只在真的超时才相关，所以它在 `visual-evidence.md` 里。

## Consequences

- 模型只有在遇到那一问时才花那 1 KB；代价是"遇到问题"这件事得由模型自己认出来——所以索引里的描述用的是**症状**（"a locator matched several elements"、"the change you expected never appeared"）而不是文件名。
- 新增一篇要同时改两处（SKILL.md 的索引 + 文件本身），而漏掉任何一处都会红：这是"一个事实一个家"在这里的具体代价，由双向对账兜住。
- 每篇首行 `Read when …` 是**格式约定**，不是内容；它让"读错配方"这种失败有一个可检查的形式。
- 五篇都是英文（与 SKILL.md 一致），正文里的例子用的是真实工具参数而不是伪代码——模型读到的是什么，就该照着做什么。
- 这套东西**零代码**：`skills/` 已在 `package.json` 的 `files` 里，`resourceBase` 指向它的父目录，所以打包与安装路径不需要任何改动。

## Testing

`test/skill.test.ts`（10 条，其中 3 条是这一轮的）：

- 列出的每一篇存在；`references/*.md` 的集合与列出的集合**完全相等**；
- 每篇以 `# ` 开头、第一段非空行以 `Read when ` 开头；
- 开头段落里的工具计数（"Eight tools drive it"）与工具名清单跟着现实走——这条是被现实打过的：它在第七个工具（`browser_wait`）落地后还写着"Six tools"，两轮之后才发现。

## Related

- [工具面下一轮](../../proposed/feature/2026-09-29-tool-surface-next-round.md)——本条的出处（原 P3-7）
- [技能文件](../../../../skills/dsh-browser/SKILL.md)——索引进驻的地方
- [工具面未解决的摩擦（第二轮·本地 SPA）](../../proposed/testing/2026-09-28-local-spa-drive-frictions.md)——九条摩擦里"读过技能也没用"的那一条（第 9 条）
