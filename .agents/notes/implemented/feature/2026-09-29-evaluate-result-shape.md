# Agent Note: evaluate 结果的形状：字符串原样、超长落盘、顶层 return 兜一次

Status: implemented

## Problem

09-28 那一轮真机留下了三条同源的摩擦（[未解决的摩擦](../../proposed/testing/2026-09-28-local-spa-drive-frictions.md) 第 5、6、7 条）：

1. **一次 `browser_evaluate` 返回了 387 KB**，把那一轮的上下文预算吃掉了大半；
2. **字符串被 JSON 转义**：`readable()` 一律 `JSON.stringify`，于是模型读到的页面文字是带 `\n`、`\"` 的转义形式，要先在脑子里解码才能用；
3. **顶层 `return` 直接报错**：`Runtime.evaluate` 求的是表达式，写 `return x` 会得到 `SyntaxError: Illegal return statement`——而工具描述承诺的正是"跑这段代码，把结果给我"。

参照系对第 1 条**没有答案**：实测它的程序返回值**完全没有上限**（`maxChars` / `MAX_RESULT` / `resultSize` / `outputLimit` 在四份产物里 0 处），上限只出现在**元素列表**的渲染上（`truncate(value, 60)`、`N of M elements shown — indices are sparse; K hidden`）。所以在"要不要限长"这件事上，我们只能按自己的代价来判断；能抄的是它**怎么渲染值**。

## Decision

### 值怎么渲染（第 2 条）

`src/tools/index.ts` 的 `readable()` 现在按参照系的 `stringifyReplResult` 分派：

- `undefined` → 文本 `undefined`；
- **字符串原样返回**，不再加引号、不再转义；
- 其余 → `JSON.stringify(value, null, 2)`，两格缩进；
- JSON 表达不了的（函数、symbol、循环引用）→ 页面的 `String(value)`，因为它是关于这个值唯一还能说的事实。

参照系的原函数（`node-repl-host/0.6.0/dist/mcp/server.js`，探针 `.prove/zcode-reference-details.mjs`）：

```js
function stringifyReplResult(value) {
  if (value === void 0) return void 0
  if (typeof value === "string") return value
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return inspect(value, { maxArrayLength: 100 })
  try { const json = JSON.stringify(value, null, 2); return json === void 0 ? String(value) : json } catch { return String(value) }
}
```

它多一条"TypedArray 用 `inspect` 渲染、数组最多 100 项"，我们没有抄：那个值是跨 CDP 边界来的 JSON，进程内没有可 inspect 的对象；而对数组设上限会**改变 PTC 程序看到的值**（程序会分支），不是渲染问题而是语义问题。

### 超长怎么办（第 1 条）

超过 `INLINE_CHARS`（40 000 字符，`src/tools/spill.ts`）的结果**整份写进文件**，结果里回来 `{ truncated: true, path, hint }` 加一段预览，而不是被截断。阈值常量从 `SNAPSHOT_INLINE_CHARS` 改名成 `INLINE_CHARS`：快照与求值是同一个问题（"这份文本是不是大得不该内联"），两个阈值只会给出两个答案。落盘优先走 harness 的 `spillStore`，没有时写进 `%TEMP%\dsh-browser-results`，与快照同一套降级。

**没有选"截断 + 预览"**：切一半的结果既不是事实，也不是指向事实的指针——模型无法判断缺了什么，也无法用程序去分支。落盘让"数据不丢"和"不烧上下文"同时成立。

### 顶层 `return`（第 3 条）

`SessionBrowser.evaluateIn()` 把 `Illegal return statement` 当成**第三种可重试的编译期拒绝**（前两种是顶层 `await` 与"这个名字已经声明过"）：把源码包成 `(async () => { … })()` 再跑一次，**只重试一次**（`bodied` 标志）。选 async 函数体而不是普通函数体，是因为它顺手把"顶层 await + 顶层 return"变成同一个包装，而不是两个。

### 明确不做：可见文本档

原计划里还有一条"加一个只取可见文本的口（排除 `style`/`script`/`noscript`）"。**没有做**，这是量了参照系之后的决定，理由记在下面。

## Alternatives considered

**加一个"可见文本"档（`browser_evaluate` 的参数，排除 `style`/`script`/`noscript`）。** 否决。参照系的纪律是明确的：`docs/playwright.md` 写着 "Do not dump `body` text or loop over a broad locator to discover the page. Use one bounded snapshot, then narrow to the relevant section or candidate."——它就差把"这个口不该存在"写出来。而我们这边读页面的家已经有两个更精确的入口：`browser_snapshot` 的 `find`/`target`/`depth`/`boxes`（过滤 + 预算 + 指路），和 `browser_evaluate` 里一句带选择器的表达式。再加第三个读文本的口，等于同一件事三个家，而它唯一多出来的能力（"整页纯文本"）恰好是最费上下文、最容易被页面文字里的注入内容污染的那一种。387 KB 那条摩擦由限长 + 落盘解决，不需要新档位。

**照抄参照系的 `inspect(value, { maxArrayLength: 100 })`。** 否决，理由见上（跨进程的值 + 会改变程序语义）。**只对最终文本限长**是这两者之外唯一不撒谎的办法。

**把超长结果截断（例如保留前 40 000 字符 + "…还有 N 字符"）。** 否决：模型拿不到剩下的事实，也拿不到一个能读的路径，于是它会重写一遍表达式、按更窄的范围再调一次——那正好是落盘省下的那一轮往返。

**给 `browser_evaluate` 设一个更小的默认上限（例如 10 000 字符）。** 否决：快照的 40 000 已经是这个插件对"一份结果可以有多长"的答案，两个数字会让"太大"变成一件因工具而异的事；而且从实测看，真正需要限的是 387 KB 那一档，40 000 已经把常见的整页读取（trending 364 行 ≈ 20 KB）放过去了。

**给程序返回值本身设上限（像某些 runtime 那样报错）。** 否决：那会把"读一整页"从一次成功的调用变成一次失败，而落盘让同一次调用既有预览又有全部数据。

## Consequences

- 一次读出整个文档的表达式现在回报成预览 + 路径；要继续用数据，要么读那个文件，要么改成 `browser_snapshot` + `find`。**数据没有丢**，只是不再全部挤进上下文。
- 字符串不再被转义：页面返回 `"a\nb"`，模型读到的就是两行。代价是一个**故意返回 JSON 字符串**的表达式不再被自动美化——那本来就是模型自己写的东西，它清楚里面是什么。
- `truncated` 是 PTC 程序能分支的字段（`if (answer.truncated) { /* 去读文件 */ }`）。
- 顶层 `return` 的那段代码跑第二次不再报错；`replMode`、`scopedBlock`、`asyncBody` 三种重试各自只触发一次，互不嵌套。
- `INLINE_CHARS` 现在是两个工具共用的阈值：改它要同时想到快照与求值。

## Testing

- `test/tools.test.ts`：字符串原样（含空串）、结构美化、`undefined`/函数/循环引用的回退、落盘的文案与"没有文件"的文案、对话框附带。
- `test/session-browser.test.ts`：顶层 `return` 被重试成 async 函数体（断言包装后的源码文本）、**只重试一次**（拒绝第二次包装）。
- `test/ptc.test.ts`：一个 40 000 字符以上的结果跨桥回来是 `{ truncated: true, path }`，并且**文件内容等于原值**——"不丢数据"这条断言只有端到端才成立。

## Related

- [动作回报里的变更清单](2026-09-29-action-report-changes.md)——同一批摩擦的 P0 项
- [工具面下一轮](../../proposed/feature/2026-09-29-tool-surface-next-round.md)——本条的出处（原 P1-4）
- [工具面未解决的摩擦（第二轮·本地 SPA）](../../proposed/testing/2026-09-28-local-spa-drive-frictions.md)——第 5、6、7 条的现场记录
