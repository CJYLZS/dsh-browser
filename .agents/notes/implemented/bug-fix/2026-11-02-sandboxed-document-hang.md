# Agent Note: 不跑脚本的文档不再把调用挂住

Status: implemented

## Problem

访问 `https://raw.githubusercontent.com/CJYLZS/dsh-browser/refs/heads/main/AGENTS.md` 会让 `browser_navigate` 卡到 45 s 预算耗尽，而页面其实早就画出来了——同一时刻 `browser_console` 和 `browser_tabs` 都能正常回答，说明浏览器活着、网络通了、导航完成了。用户的直觉是"带文件名后缀的网页会卡死"，后缀不是原因：raw 文件只是最先被撞上的那类页面。

真正的触发条件是响应头：

```
content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
```

`sandbox` 不带 `allow-scripts`，Chrome 因此**暂停整个文档的脚本执行**。这不是"脚本报错"或"被 CSP 拦掉某个来源"——事件循环本身没跑。2026-11-02 在真机上逐个机制量（`.prove/probe-sandbox-mechanisms.mjs`）：`setTimeout`、`queueMicrotask`、`MutationObserver` 之外的 `requestAnimationFrame`、`MessageChannel` 全部永不回调，主世界与 `Page.createIsolatedWorld` 造的世界**一样**。仍然可用的只有同步求值（0–1 ms 回答）和 DOM 回调。

而插件的 settle 探针恰好是"把一个 promise 留在页面里、让它靠定时器兑现"：

- `armSettle()` 安装 `settleProbe()`（内部 `setTimeout(quiet, 500)` 与 `setTimeout(cap, 3000)`）；
- `readSettle()` 用 `Runtime.evaluate({ awaitPromise: true })` 去 await 它。

事件循环停了，这个 promise 永远不会 settle，于是那次 `Runtime.evaluate` 永不返回。定位方式是给 `CDPSession.send` 打时间戳（`.prove/probe-plugin-navigate.mjs`）：最后一条不返回的调用就是 `readSettle` 的 `Runtime.evaluate`，此后浏览器仍能同步求值。

## Decision

三件事，都在 `src/browser/session-browser.ts`。

**1. `readSettle` 的等待有上限。** 它是全文件唯一一处"await 的是页面里的 promise"，所以只有它需要宿主侧上限：`until(evaluateIn(...), SETTLE_MAX_MS + INTERRUPT_QUIET_MS)`，超时就当作"这一页没说出什么"，地址与标题照样带回去。这是**兜底**：不管冻结从哪来（沙箱、页面中途换成沙箱文档、渲染进程假死），调用都会返回。

**2. 一个可判定的"这个文档不跑脚本"的判据。** `scriptProbe()` 让页面跑一个 10 ms 的定时器，宿主给 250 ms：定时器答了就是活的，没答就是停了。判据被选中是因为它**区分得开"冻结"与"忙"**——真机量的三种形态：

| 判据 | 沙箱文档 | 主线程忙 | 正常页 |
|---|---|---|---|
| 等 10 ms 定时器（250 ms 预算） | 不返回 | 不返回 | 18 ms |
| 同步 `1+1` | 0–1 ms 回答 | 不返回 | 1 ms |
| `Runtime.terminateExecution` 能收回挂住的调用吗 | **不能，仍挂住** | 能 | — |

结论记在 `PageState.liveScript`，按 `performance.timeOrigin` 缓存（一个文档量一次）。`Runtime.terminateExecution` **不是**出路：第三行说明它对冻结文档无效，而对忙页面它虽然有效，忙页面本来就会自己回来。

**3. 知道是冻结就不装探针。** `armSettle()` 先读当前文档的判据，是 `false` 就给一个空槽位的 watch，`readSettle()` 见空槽位直接返回；`settle()` 也在读之前先量一次，于是"导航到一个沙箱文档"这种**探针装在前一个文档上**的情形同样不多等。

结果里多一个 `staticDocument: true`，工具文案随之改口（`changedText`）：不再说"页面没有变化"——那句话是**关于动作的证据**，而这种页面根本产生不了证据——改成指明这是沙箱文档、并指路 `browser_snapshot` / `browser_evaluate`（两者在它上面都正常）。

## Testing

`test/session-browser.test.ts` 三条 + `test/tools.test.ts` 一条。

假件的冻结是"定时器式问题永不 resolve"，抄的是真件的行为而不是它的实现。三条各自钉一个失效面，并且**都验证过有牙**：

- 冻结文档上的动作会返回（把 `readSettle` 的上限去掉不会红——因为第 3 条已让它不装探针，所以另加一条）；
- 第二次动作不再装探针（去掉判据就红）；
- 普通页仍然被观察（判据写成"一律 static"就红）；
- **动作过程中才冻结**（探针装好了、读的时候文档停了）：去掉 `readSettle` 的上限这条**无限挂起**——实测跑满 120 s 才被外部杀掉，正是它要防的形状。

`scripts/snapshot-regression.mjs` 新增 `[32]`：真浏览器上导航到那个 raw 地址，断言 45 s 内返回、`staticDocument === true`、地址正确、同步求值仍可读、之后还能正常导航离开。

顺带修了一个**本次工作区拆分引入的既有回归**：该回归脚本仍在 `new SessionBrowser({ config, ports, launch, logger })` 这种拆分前的构造方式上，自 `04b1617` 起一跑就 `Cannot read properties of undefined (reading 'join')`，即真机那一半其实已经十天没跑过。现在改走 `BrowserPool`。

真机验证（隔离 `D:\dsh-verify`，插件指向工作区 `lib/`）：同一个 raw 地址，修复前 `NEVER ANSWERED within 40003ms`；修复后第一次 6.7 s（探针装在前一个文档上，读了才等上限），把判据提到读之前之后 **1.58 s**；走 viewer 的 `navigate` 动词实际落页 **640 ms**。收尾时 `instances` 为空、`Test-NetConnection 127.0.0.1:9039` 为 `False`。

## Alternatives considered

- **给 `Runtime.evaluate` 传协议自己的 `timeout`。** 直接量过，**无效**：对"promise 永不 settle"的调用，`timeout: 2000` 与不传一样永不返回（`.prove/probe-bounded-evaluate.mjs`）。它管的是脚本执行时长，不是"等一个永远不会来的事件"。
- **用 `Runtime.terminateExecution` 收回挂住的调用。** 对沙箱文档无效（见上表），挂住的调用在 terminate 之后仍然挂住。它只在忙页面上有用，而忙页面不需要救。
- **只靠宿主侧上限、不做判据。** 那样每次落到沙箱文档都要**先付满 4 s**（上限值）才返回，而不是 1.58 s 里那点测量开销；并且"页面没变"这个错误结论会一直留着。上限是兜底，不是修法。
- **按 URL / Content-Type / 后缀判断。** 后缀是用户的直觉，不是机制：沙箱来自响应头，同一个域名可以按路径不同、`data:` URL 和本地文件也可能带 sandbox。判据必须是"这个文档的事件循环有没有动"。
- **禁用 CSP 或用 `Page.setBypassCSP`。** 那会改变页面本身的语义——我们是在阅读一个别人托管、明确声明"这段内容不许执行"的文档，绕过它的安全策略既不是调用方要的，也会让"页面上没有脚本"这个事实失真。
- **把探针改成不依赖定时器（只靠 `MutationObserver` 的微任务）。** `MutationObserver` 回调确实会跑（真机量过，1 ms），但 `settleProbe` 需要"安静 500 ms"这个时间概念才能收敛，而且 `Timeout`-free 的收敛还要另找一个时钟。用一个 250 ms 的判据换掉整个探针的重新设计，代价小得多；而且真要继续用探针，先问一句"这页跑不跑脚本"本来就必须问。

## Consequences

- 沙箱文档上动作类工具仍然可用、会返回，但**不会**报告任何变更——因为那种页面产生不了变更。`staticDocument` 就是让模型知道这一点的字段；文案明确指路读取类工具。
- 每个动作多一次文档读取（以及每个新文档一次 250 ms 的判据，缓存在 `timeOrigin` 上）。这一读本来 `settle()` 结尾也要做一次，现在提前做，普通页面的净成本是一次往返。
- 判据的 250 ms 相对真实定时器的 10 ms 有两个数量级余量，所以"慢页面"不会被误判成冻结；反方向（把冻结判成活的）只会退化成兜底上限，不会挂死。
- `readSettle` 现在有 4 s 的硬上限这件事本身值得记住：**凡是 await 页面内 promise 的地方都必须有宿主侧上限**。这条已经写进 `AGENTS.md`。
- 已知未覆盖：`pressProbe()` 也 await 两个 `requestAnimationFrame`（`awaitPromise: true`，同样是页面内 promise）。在沙箱文档上它同样不会返回——但那种页面没有可点的元素（快照只能拿到文本），所以现在没有被触发；这是同一个教训的下一个候选点。
