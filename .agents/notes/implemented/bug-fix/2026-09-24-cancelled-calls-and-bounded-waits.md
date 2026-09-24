# Agent Note: 被取消的调用必须放弃，并且把页面停下来

Status: implemented

## Problem

2026-09-24 真机验证时，一次 `browser_navigate`（打开一个取不到的地址）**再也没有返回**：对话中断按下去没用，重启这一轮也没用，最后只有手动点「关闭浏览器」才结束。模型侧看到的是一个永不返回的工具调用，用户侧看到的是一个停不下来的会话。

三层原因，缺一层都不会卡死：

1. **工具不观察 `exec.signal`。** DSH 的契约是 `execute` 的异步工作"必须观察或转发 `exec.signal`，并且只在自己拥有的工作归于静止后才 settle"，而注册表**不会放弃**它拿到的 promise（`packages/core/tools/src/index.ts:228`）。中断只是把信号 abort 掉，body 不理会就等于没人理会。
2. **工具路径上有几处没有上限的等待。** `page.goto` 有 30 s 上限，但 `settle()`/`armSettle()` 走的是 CDP `Runtime.evaluate`，而 Playwright 的 `cdp.send()` **默认没有超时**；`start()` 里的两处也一样：`launchPersistentContext` 用 Playwright 的默认 **180 s**，`openStream()` 里的 `Page.startScreencast` 同样没有上限。
3. **`ensure()` 单飞一个 `start()`。** 一次卡住的启动，是之后每一次调用都会 join 的启动（`this.starting`），所以"一个调用卡住"会变成"这个会话的浏览器从此都卡住"——这正是"关掉浏览器才活过来"的机制。

## Decision

- 六个工具都声明 `timeoutMs`，由 `dsh-tool-call-timeout-policy` 强制：navigate 45 s（比导航自己的 30 s 大，让"页面只是慢"走 Playwright 那条会指名地址与超时的报错），snapshot / click / type / screenshot 30 s，evaluate 120 s（表达式是调用方自己的代码，等页面、轮询接口都是合法用法）。
- 所有调用统一经过 `cancelable()`（`src/browser/cancel.ts`）：它**先挂上 abort 监听再启动工作**，与调用方的 signal 竞速，已 abort 的调用根本不碰浏览器，被放弃的那条 promise 的失败被吞掉（否则就是一个 unhandled rejection）。
- 取消不只是放弃，还要停下：`SessionBrowser.interrupt()` 发 `Page.stopLoading` 与 `Runtime.terminateExecution`（各 1 s 上限）。**两个都不答的浏览器不再可用**，直接丢弃（`forget()` + `closed`），下一次调用起一个新的——留着一个卡死的浏览器，就是让后面每一次调用都卡死。
- `launchPersistentContext` 显式给 `timeout`，预算与 CDP 监听同一个（20 s）：浏览器 3 分钟起不来对调用方没有任何意义，而排在他后面的每个调用都在等同一个 `start()`。
- `start()` 里 `openStream()` 用 5 s 上限（镜像是视图，不是浏览器），日志里的 `await page.title()` 直接去掉——启动路径上不该有任何一次"等页面回答"。
- 顺带修掉验证时撞到的第二个问题：同一段 `const` 跑第二次会被页面全局作用域拒成 `SyntaxError: Identifier 'el' has already been declared`。这是**页面作用域**的错误，不是代码的错误，用 `{ … }` 包一层重试一次即可（块自己的完成值就是原来要的值）。

## Testing

- `test/cancel.test.ts`：取消后放弃并停页面、已 abort 的调用绝不启动工作、没有 signal 时直通、自己失败的调用不被误停、放弃之后才到来的失败不会变成 unhandled rejection。
- `test/session-browser.test.ts`：取消会发出 `Page.stopLoading` 与 `Runtime.terminateExecution` 且保留答话的浏览器；连这两个都不答的浏览器被丢弃，下一次 `ensure()` 真的起了第二个（`launch.browsers.length === 2`）；重声明会重试而不是报错。
- 真机 `pnpm run regression` 36/36，新增两节：**[16]** 在真页面上跑 `await new Promise(() => {})`（永不返回的脚本）→ 500 ms 后 abort → 调用 **513 ms 返回取消错误**，紧接着 `1 + 1` 仍答 `2`（`Runtime.terminateExecution` 真的把渲染进程放开了）；**[17]** 同一段 `const twice = 41; twice + 1` 连跑两次都答 `42`。
- 重启载入新产物后，用**会话自己的工具**（不是回归脚本）重演了用户报的那一幕：`browser_evaluate('await new Promise(() => {})')` 不再卡死，**120 s 预算到点后返回** `Error: tool call timed out after 120000ms`，随后紧跟的一次 `evaluate` 立刻答 42，页面仍是原来那一页（说明 `interrupt()` 得到了回答、浏览器没被丢弃）。

## 模型侧看到的两种消息

谁 abort 决定了模型看到哪一句，两者都是"会返回"：

- **预算到点**：`dsh-tool-call-timeout-policy` 在它自己的计时器赢下时用结构化的 `TOOL_TIMEOUT`（`tool call timed out after <n>ms`）**替换**工具自己的错误，所以那条"页面已停下、浏览器可以继续用"的说明不会出现在这种情况下；这不是本插件能改的（[策略在 `packages/guard/timeout-policy/src/index.ts:73`](../../../../../../packages/guard/timeout-policy/src/index.ts)）。
- **调用方中断**（用户按中断、这一轮被取消）：走的是 `cancelable()` 自己的错误，也就是 `dsh-browser: … was cancelled by the caller; the page was stopped, and the browser is free for the next call`。

## Alternatives considered

**只声明 `timeoutMs`，不做取消路径**：预算到点确实会 abort 信号，但 body 不观察信号就什么都不会发生——这就是缺陷本身。**只在工具层 race，不停页面**：调用能返回，但那段永不结束的脚本还在跑，下一次 `browser_evaluate` 会排在它后面，"卡住这次调用"只是变成"卡住下一次调用"。**给所有 CDP send 加统一超时**：`Runtime.evaluate` 跑的是模型自己的代码，等 90 秒的轮询是合法用法，统一上限会砍掉合法用法；上限因此放在每个工具这一层，按语义给不同预算。**取消时直接关掉浏览器**：最能保证静止，但一次误触的中断就会关掉用户正在看的页面、丢掉所有打开的标签。**不支持中断，改成文档里写"别打断"**：这条路已经实测过——中断按下去没用，用户只能自己去关浏览器。

## Consequences

中断现在是可用的：真机上 500 ms 取消、513 ms 返回，页面随后立即可用。代价是**取消会让那个调用没有任何结果**（没有 report、没有 URL），而一个连 `Page.stopLoading` 都不答的浏览器会被丢弃——下次调用重新起一个，cookie 因为 profile 是每会话复用的而还在，但打开的标签与页面状态没了。另外 `browser_evaluate` 从此有 120 s 上限，`Runtime.evaluate` 在重声明时会多跑一次、await + 重声明时最多三次。

本轮验证还留下了几项不影响正确性的摩擦，记在[工具面未解决的摩擦](../../proposed/testing/2026-09-24-open-tool-frictions.md)里。
