# Agent Note: 页面自己的话：三个域、一个每页缓冲区、一个只能事后读的工具

Status: implemented

## Problem

有一类失败**不留痕迹**：handler 抛了异常、`fetch` 失败、脚本没加载、资源被拦。它们不进无障碍树（`browser_snapshot` 看不见）、不改 DOM（P0-2 的[变更清单](2026-09-29-action-report-changes.md)看不见），于是"点完什么都没发生"只能靠猜。

更麻烦的是**时间**：这些事件必须在页面自己的脚本跑起来**之前**就订阅好。加载期抛的异常在任何工具能被调用之前就已经抛完了，事后拿 `browser_evaluate` 去"看看 console 里有什么"根本无处可查——页面没有留下可读的 console 历史。所以这一条不是"再加一个读取工具"，而是"能不能赶上"。

P0-2 落地之后，这条的价值被重新称过一次：瞬时 toast 那一类"点完没反应"已经由变更清单解释了，剩下的独有价值**只有不留 DOM 痕迹的失败**——也就是加载期异常、handler 异常、请求失败、脚本加载失败。

## Decision

### 订阅（赶上时间）

`SessionBrowser.adopt()` 在为页面建立 CDP 会话之后立刻订阅三个事件，并 `enable` 对应的域：

| 事件 | 谁说的话 |
|---|---|
| `Runtime.consoleAPICalled` | 页面的 `console.*` |
| `Runtime.exceptionThrown` | 未捕获异常 |
| `Log.entryAdded` | 浏览器自己：请求失败、资源被拦、CSP 违规 |

两个 `enable` 都 `.catch(() => undefined)` 且**不进入调用方的关键路径**：一个不答应的页面就是一个 console 为空的页面，与"页面什么都没说"是同一种观察结果，不值得让每次 attach 都赌它。

### 缓冲（每页一份，导航即清）

- 每条记录是 `{ level, message, timestamp, url? }`，级别归一到 `debug | info | log | warn | error`（`warning`→`warn`，`verbose`→`debug`，`dir`/`table`/`count` 这类归 `log`）；
- 缓冲区**每页一份、上限 200 条**，满了丢最旧并**记下丢了多少**（`dropped`）——一个填满的缓冲必须能被看成"填满了"，而不是一个安静的页面；
- **导航（仅主帧）清空**：一条消息属于产生它的那份文档，和 ref 同源。子帧自己导航不清空——那没有替换调用方正在读的文档；
- 消息截到 500 字符；对象参数按协议的 `preview` 渲染（`{code: 500}`），取不到时用 `description`。

### 工具（事后读）

第 8 个工具 `browser_console({ levels?, filter?, limit? })` → `{ entries, matched, total, dropped, url, title, tabs }`。形状抄的是**Codex 云端的 `tab.dev.logs`**：`{ levels?: Array<'debug'|'info'|'log'|'warn'|'error'|'warning'>, filter?: string, limit?: number }` → `[{ level, message, timestamp, url? }]`。它是"读"而不是"等"：**不启动浏览器**（没有打开的页面就用与 `browser_wait` 同一种措辞拒绝并指路），因为问题问的是一张已经存在的页面。

## 参照系实测

**ZCode 的这一版没有它。** 四份可读产物（两个 client、`browser-use/0.4.2` 的服务端、`node-repl-host/0.6.0`）里 `consoleAPICalled` / `Log.entryAdded` / `exceptionThrown` / `consoleMessage` / `pageerror` / `"console"` **全部 0 处**（探针 `.prove/zcode-result-surface.mjs`）。所以"参照系有、我们抄"这句话对 ZCode 不成立。

**但 Codex 云端有，而且就是 `dev.logs`**（[control-browser 技能快照](https://codex-tool-reference.simonw.chatgpt.site/skills/control-browser)，2026-08-31）：

```ts
interface TabDevAPI { logs(options: TabDevLogsOptions): Promise<Array<TabDevLogEntry>> }
interface TabDevLogsOptions { filter?: string; levels?: Array<"debug"|"info"|"log"|"warn"|"error"|"warning">; limit?: number }
interface TabDevLogEntry { level: "debug"|"info"|"log"|"warn"|"error"; message: string; timestamp: string; url?: string }
```

也就是说：**这个能力在参照系的谱系里存在（Codex 有、Playwright MCP 有 `browser_console_messages(level, all)`），只是 ZCode 的这一版把它砍掉了**。这改变了上一轮的结论——它不再"只是我们自己的主意"，但形状仍然是我们按 Codex 的接口定的。

## 真机实测（回归 [24]）

fixture 一次说四件事：`console.log('booting')`、`console.error('save failed', { code: 500 })`、一个坏图片、以及一次定时器里的 `throw`。结果**恰好 4 条**：

```
[log:booting, error:save failed {code: 500}, error:Failed to load resource: net::ERR_INVALID_URL,
 error:TypeError: save is not a function\n    at data:text/html,…]
```

三条结论：

1. **`Runtime` 与 `Log` 两个域不会各报一次**：`console.error` 只出现一遍。开工前担心过重复（Playwright 两个域都听），实测没有——**重复如果真的出现，会由这条断言当场抓住**。
2. **对象参数的 `preview` 确实到达**（`save failed {code: 500}`），"对象只剩 `Object`"这条顾虑不成立。它仍然是协议给多少我们报多少：一个更深的嵌套对象不会展开。
3. **导航后重新读是空的**（`total: 0`），而 `total/matched/dropped` 三个计数说的是"这段历史有多长"。

还有一条只有真机才看得见的细节：在 `data:` 文档上，**只有资源错误带 `url`**（它是资源的地址），console 与异常两条没有——`data:` 文档的栈帧没有 url。异常消息本身仍然带着完整栈（被 500 字符截断），信息没有丢。

## Alternatives considered

**做成参数：动作时带 `console: true`，回报里附上这次调用期间说的话。** 否决，理由是**时间方向**：模型只有在动作没有产生预期效果**之后**才知道自己需要这份证据，而那时这次调用已经结束了——参数式只能回答"我事先就料到会有问题"的情况，恰好排除了这个能力存在的理由。相比之下 `browser_console` 能读到过去（自文档加载以来的全部），这才是"点完没反应"时的追问方式。

**不加工具，改成每次动作回报里附本轮产生的 console 错误（默认开、只收 error/warn、封顶 3 条）。** 有吸引力（点完就有解释，不用多一次调用），但否决：①P0-2 刚立下"回报不许常态膨胀"的约，而 console 的噪声与页面相关（开发模式的框架警告会在每次动作时刷屏）；②它只覆盖"动作期间"，覆盖不了加载期的异常——而那是这一类里最值钱的一种；③它会与变更清单争夺同一块位置，让每次动作的回报都更长。

**不做，记为不做。** 上一轮的结论曾经偏向这条（"P0-2 之后理由收窄"）。否决它的理由是：收窄之后剩下的那一小块恰好**无法用别的手段替代**——不留 DOM 痕迹的失败只能靠预先订阅，而"点完没反应"时模型的下一个动作本来就是"看看为什么"。代价是一个工具名与一处有界缓冲，收益是一整类静默失败变得可解释。

**把 `all`（跨导航的历史）也做上，像 Playwright MCP 的 `browser_console_messages(level, all)`。** 否决：帧/文档级清空是这个插件对"这个字符串指哪个文档"的一贯答案（ref 就是这么做的），保留跨文档的 console 会让"消息属于哪份文档"变成第二个需要解释的坐标；`dropped` 与 `total` 已经让"这段历史有多长"可见。

**用页内探针改 `console.*`（`Page.addScriptToEvaluateOnNewDocument` 注入）而不是听 CDP 事件。** 否决：注入发生在文档开始执行之后（`addScriptToEvaluateOnNewDocument` 的时机早于页面脚本，但它拿到的是另一套序列化：我们得自己把参数 stringify，还会与页面自己的 `console` 包装打架），而 CDP 这条路拿到的是浏览器渲染好的消息与它自己的 preview——更少我们自己编的解释。

**把加载期之前的日志也留在缓冲里（不清空）。** 否决：见上，与 ref 同源。

## Consequences

- **这是"新能力做成参数，不加工具名"这条规则的第二个有意破例**（第一个是 [`browser_wait`](2026-09-29-browser-wait.md)）。规则本身没变，例外需要理由：`browser_wait` 的理由是复用定位词汇，这里的理由是"监听必须早于页面脚本，而证据只能在事后被追问"——两件事都不是参数能表达的。
- **每次 attach 多两次 `enable`**：它们不阻塞 attach，但确实多两个协议调用；一个不答应的页面就是 console 为空。
- **对象参数只有一层 preview**：`console.error('failed', obj)` 能看到 `{a: 1}`，看不到嵌套三层的结构。要结构就去 `browser_evaluate` 拿值。
- **时间戳是浏览器进程的时钟**（不是 agent 主机的）：跨机器部署时两者会有偏差，它只保证和自己前后的事件顺序一致。
- **`dropped` 是这次会话的诚实成本**：一个每帧都 `console.log` 的页面会把 200 条填满，于是"最早那些"看不见——计数至少让这件事可见。
- 加载期的异常现在**能**被解释，但前提是页面在插件 attach 之前没有自己导航过一次（attach 时清空缓冲）。实际上 attach 发生在页面刚被创建/接管时，所以真实场景里路径是通的；已经加载完成的页面（复用别的调用留下的页面）会丢掉 attach 之前的消息。

## Testing

- `test/session-browser.test.ts`（10 条）：订阅发生在 ensure 之后、三类事件各自成一条、级别归一、级别与子串过滤是"与"、limit 取最新、导航清空而子帧导航不清、缓冲上限与 `dropped`、无页面时拒绝且不启动浏览器。
- `test/tools.test.ts`（3 条）：渲染的计数行、"什么都没说"与"没有一条匹配"是两种不同的事实、省略与丢弃的措辞。
- `test/attach.test.ts` 之外的 `test/ptc.test.ts`（2 条）：`browser_console` 出现在 `PTC_CALLS`，结果里的 `entries` 是数组、`total` 是数字；一个程序能"点完发现 `changed` 为空 → 去读 console → 分支"。
- 真机（`scripts/snapshot-regression.mjs` [24]）：5 条断言，见上。

## Related

- [动作回报里的变更清单](2026-09-29-action-report-changes.md)——把"有痕迹"的那一半补齐；本条补的是另一半
- [工具面下一轮](../../proposed/feature/2026-09-29-tool-surface-next-round.md)——本条的出处（原 P2-5）
- [工具面未解决的摩擦（第二轮·本地 SPA）](../../proposed/testing/2026-09-28-local-spa-drive-frictions.md)——"点完什么都没发生"的现场
