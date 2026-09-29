# Agent Note: PTC 兼容门禁：用真实 run_code 桥把工具面钉住

Status: implemented

## Problem

下一轮要动工具面（加参数、改动作回报的形状、可能加工具）。而"工具在 PTC 下能不能用"是**另一份契约**：`ptc`/`both` 下模型不按名字调用工具，而是写一段程序，经 `run_code` 的派发桥以 `tools.<name>(args)` 打到我们的工具上。于是三件事同时变了——schema 要能编译成 SDK 里的类型、结果要是程序能分支的**值**、失败要在程序里**可捕获**；再加一件本插件自己悄悄决定的：哪些调用可以重叠。native 模式全绿**完全不能**说明这四件事成立。

这个契约的失败曾经（且部分仍然）是静默的：`jsonSchemaToTs` 对子集外的 schema 返回 `unknown` 且**不抛**。更关键的是流程问题：**在加第七个工具之前，没有人会专门去检查这件事**。需要的不是一篇说明，而是一个"新工具自动被覆盖、漏了就红"的机制。

## Decision

`test/ptc.test.ts` 在**同一进程内**挂真实的 `ToolRuntime`（`mode: 'both'`）、读**真实的** `tools:sdk` 段文本、跑**真实的** `run_code` 传输与它的派发桥。只有两个不归本插件所有的 seam 被顶替：`systemPrompt`（section 注册表，只被要求渲染）与 `ptcRuntime`（语言后端）。

后端替身用 `new Function` 在**本进程**执行程序体（真实后端用沙箱子进程执行）。它忠于浏览器工具能观察到的一切——绑定、绑定的无损 JSON 边界、拒绝契约——而在两个不可能影响这些断言的地方不忠：没有隔离，且**不剥离可擦除类型注解**，所以文件里的程序都写成纯 JavaScript。

覆盖机制是那张 `PTC_CALLS` 表加一条断言（"可见的工具面恰好等于这张表覆盖的六个"）：**加工具而没给它写 PTC 调用，测试直接红**。十四条断言分四组：

- **SDK 形状**：名字是裸标识符（不是 `tools["x"]`）；参数与输出都不是 `unknown`；必填参数不被声明成可选；`button` 的枚举字面量、输出的 `changed: string[]` / `settled: boolean` 都还在。
- **真实桥**：一个程序足以驱动全部六个工具，且每个都回**值**（不是渲染文本）；`browser_snapshot` 铸出的 ref 在**另一个子调用**里仍然有效（ref 属于页面、不属于调用）；截图的 `path` 真实存在且 `bytes` 与磁盘一致；整个返回值能无损 JSON 往返。
- **失败契约**：未捕获的拒绝让整次运行失败并带 `CODE_RUN_FAILED`；被 `try/catch` 捕获后程序继续；参数的 schema 校验在**绑定处**拒绝（程序里传 `url: 42` 会 reject）。
- **隔离与并发**：`ptc` 下直接按名字调用浏览器工具是 `UNKNOWN_TOOL`，而同一个名字作为子调用可以跑；`Promise.all` 里两个调用在页面里**串行**（`peak === 1`）；两个会话各拿各的浏览器；无会话的程序在**起浏览器之前**就被拒绝。

**门禁被证明有牙**（同一轮改回，`git diff -- src` 为 0）：给 `browser_evaluate` 加 `isConcurrencySafe: () => true` → 两条并发断言都红，其中一条是行为性的（`peak` 实测 `2`）；把 `browser_screenshot` 改名 → 覆盖断言与程序断言都红。

## 参数侧其实不是静默的（实测，推翻了最初的判断）

最初写进测试文件顶部的理由是"给 schema 加一个不支持的 key，SDK 会**静默**把它 render 成 `unknown`"。实测把它推翻了（探针 [`ptc-loud-or-silent.mjs`](../../../../.prove/ptc-loud-or-silent.mjs)）：

- `defineTool` 的 value-schema DSL 在**构造时**就拒绝子集外的关键字——参数是 `parameters.a.pattern is not supported by the value schema DSL`，输出的 value schema 同样被拒。所以正常写法下那个洞**不可达**，不是静默的。
- 仍然可达的一半在别处：`jsonSchemaToTs` 对子集外的 schema 返回 `unknown` **且不抛**，而 `register()` 接受一个**没过 DSL 的手工 `ToolDefinition`**——实测它被生成成 `handmade: unknown;`。

所以断言的落点是"生成的文本"，而不是"schema 本身"：那是 schema、DSL 与模型所见三者唯一交汇的地方。这条纠正值得留着——一个门禁的理由如果没量过，很可能在防一个不存在的洞，而真正的洞在别处。

## Alternatives considered

1. **只做静态断言**（schema 在支持子集内、值可 JSON 往返），不挂注册表。便宜，但测的是 schema 而不是模型看到的文本：`unknown` 的降级发生在**投影**里，静态断言看不见；也测不到失败契约与并发分类。放弃。
2. **用真的 `@deepseek-ai/dsh-ptc-runtime-node` 跑端到端。** 最忠实，但要多装一整套 peer（`dsh-fs`/`dsh-sandbox`/`dsh-subprocess`/`dsh-timeout`/`dsh-session-policy`），并让它在沙箱里 spawn 一个管道 stdio 的子进程——本环境会 EPERM。而且那一层**不归本插件所有**：用真注册表 + 真桥 + 顶替后端，把不属于自己的那层留在外面。放弃。
3. **写成对六个工具的手写断言清单。** 更短，但它不是门禁：第七个工具不会被覆盖。放弃，改用一张表加"可见面恰好等于这张表"的断言。
4. **让后端替身只记录 bindings、不执行程序**（即 harness 自己 `ptc.spec.ts` 里 `FakeRuntime` 的用法）。那样 `code` 只是个标签，测不到"程序真的能这么写"。放弃：`new Function` 让程序体**真的**被执行。

## Consequences

- `pnpm test` 从 265 条到 **279 条**（新增 14 条），实测 279/279 通过、exit 0。
- **加工具多了一步**：`PTC_CALLS` 必须补一行，否则红。这条常驻规则写在根 `AGENTS.md` 的测试小节，理由在本篇。
- 测试文件顶部的模块注释同时是这份契约的入口：改 `src/tools/index.ts` 前先读它，那里写了四件事（SDK 形状、值是值而不是句子、失败是拒绝、并发默认串行）。
- **未覆盖**：不测"工具永不返回"（那是 `timeoutMs` 与 `cancelable()` 的地盘，见[被取消的调用那一篇](../bug-fix/2026-09-24-cancelled-calls-and-bounded-waits.md)）；不测 GUI 里 PTC 子调用的呈现（PTC 下内层子调用只进会话日志，GUI 显示的是外层程序的卡片）；后端替身不剥离类型注解，所以它**不能**用来验证一段 TypeScript 程序。
- **已知缺口**：`ctx.ptcRuntime` 这一层只有开一个 `DSH_TOOLS_MODE=both` 的独立实例才能真验证（本环境跑不了管道 stdio 的子进程）。这篇门禁不声称覆盖它。

## Related

- 上一轮的调查与下一轮的方向：[工具面下一轮：定位要能再解析，动作回报要有内容](../../proposed/feature/2026-09-29-tool-surface-next-round.md)
- 工具面本身（六个工具、为什么只有六个）：[工具面](../feature/2026-09-23-tool-surface.md)
- 工具面的上一次优化（快照裁剪、落盘出口、动作回报）：[工具面优化](../feature/2026-09-24-tool-surface-optimization.md)
- 真机复验（本门禁的手工对应物，两者都保留）：[重启后重做 GitHub Trending](2026-09-24-toolset-evaluation.md)
- 上限与取消（本门禁刻意不覆盖的那一半）：[被取消的调用与有界等待](../bug-fix/2026-09-24-cancelled-calls-and-bounded-waits.md)
