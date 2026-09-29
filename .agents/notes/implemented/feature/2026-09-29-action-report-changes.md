# Agent Note: 动作回报里写着页面改了什么，而不是只说"变了"

Status: implemented

## Problem

动作回报里的 `changed` 只有一个词：`dom`。它对模型做的事和它对程序做的事一样少——[09-28 那条摩擦](../../proposed/testing/2026-09-28-local-spa-drive-frictions.md)写得很直白："只报'变了'不报'变成什么'"：一次点击让提示条出现、一次点击只是让转圈重画了一遍，两种回报一模一样。而下一句判断（再点一次？换个元素？去取快照？）只能靠**再发一次调用**去观察。

这恰恰是动作层唯一有信息优势的地方：探针在 dispatch **之前**就装好了（[动作结果要有语义](../bug-fix/2026-09-25-action-reporting-and-snapshot-semantics.md) 那一轮解决的正是"观察者必须装在输入之前"），它已经在数 mutation 记录——数出来的东西只用于决定 `changed` 里要不要写 `dom`，记录本身被丢掉了。

## Decision

settle 探针从**计数**升级成**记头 5 条**，每条都是页面自己说得出的事实；动作回报多两个字段：

- `changes: DomChange[]`（最多 5 条，空则整个字段不出现）：`{ kind, tag?, role?, preview?, attribute?, from?, to? }`，`kind` 是 `added | removed | attribute | text` 四选一。
- `changesOmitted: number`（为 0 时不出现）：看到了但没写进清单的**条数**。省略要计数，因为"40 条里印了 5 条"和"页面只动了 5 次"读起来一样。

渲染成一行，挂在 `The page changed: dom.` 下面：

```
dom: +1 status "先在实例表里点一行"; ~ p "24.1k" → "24.2k"; ~ button "启动并连接" disabled: (none) → "true"; and 12 more changes
```

三处刻意的取舍：

- **字段是"页面声明的"而不是"浏览器计算的"。** `role` 只填元素自己 `role` 属性里写的那个值，`tag` 是标签名，`preview` 是一小段文本（`aria-label` → `placeholder` → 文本 → `value`，截到 60 字符）。**无障碍 role/name 仍然只由 `browser_snapshot` 说**：为了每条变化都拿到计算后的 role/name，得对每个变化再发一轮协议调用，而被移除的节点在无障碍树里已经没有对应节点了（它已经不在文档里）。所以这份清单回答"去哪里看"，快照回答"那是什么"。
- **`preview` 不叫 `name`。** 它是页面的说法，不是无障碍名；参照系（Codex 的 `ElementInfo`）把这两件事分成 `ariaName` 与 `visibleText`/`preview` 两个字段，理由一样。
- **页面来的东西要过边界。** 记录是页面返回的，不是我们构造的：只有声明过的字段、只有字符串类型的值能进结果，每个字段在**这一侧再截一次**，条数在这一侧再封一次顶（页面的 `omitted` 还要加上被这一侧砍掉的条数）。一条看不懂的记录被丢弃，而不是让调用失败。

### 页内探针记什么

- **`added` / `removed`**：childList 记录里的增删节点。元素说自己的标签与文本；**文本节点说自己的 `data`**（容器说的是整段文本，不是"它丢了什么"）。被移除的节点没有父元素可问，所以改变化报在**失去它的那个元素**上（`-1 li "已连接的实例"`）。
- **`attribute`**：属性名 + `oldValue` + 读回来的当前值。两边都没有时字段直接不出现（`(none)`），不是字符串 `"null"`——属性以前不存在和属性值是空串是两件事。
- **`text`**：`characterData` 记录的前后文本。
- **一条文本节点被另一条文本节点替换 = 一条 `text` 变化。** 真机量到的形状：`element.textContent = '24.2k'` 在 MutationObserver 里是**一次 childList**（旧文本节点被移除、新文本节点被加入），不是 `characterData`。照字面报会变成 `-1 p "24.1k"; +1 p "24.2k"`——用两条（占掉 5 条里的两条）说一件读者会称为"这段文字改了"的事，而且两条的 `preview` 还会读成同一个值。所以只在这一种形状下折叠：恰好一个文本节点出、恰好一个文本节点进、同一个父元素。多于一个节点、或其中有元素节点（`innerHTML`、`replaceChildren`），仍然是两条。
- **画不出来的元素不计入。** `script`/`style`/`link`/`meta`/`title`/`template`/`noscript`/`base` 的增删改直接跳过：CSS-in-JS 几乎每次渲染都重写一个 `<style>`，留着它就会把 5 个名额填成页面的机器。**跳过的不算省略**——"没写进去"和"不值得写"是两件事。`mutations` 仍然把它们数进去，所以 `mutations > 0` 而清单为空是可能且诚实的。
- **同一条变化只说一次**：按（节点 × 种类 × 属性名）去重，两次改同一个按钮的 `disabled` 是一条变化。`mutations` 是**记录数**，`changesOmitted` 是**去重后的条数**，两个计数单位不同也各自说清。

### 参照系实测（2026-09-29；探针 [`.prove/zcode-action-surface.mjs`](../../../../.prove/zcode-action-surface.mjs)）

三个可读的层各自量过一遍（量的是**字面出现次数**，这些产物是压缩过的，出现 0 次就是那个能力不在那一层）：`browser-use/0.5.1` 与 `0.4.2` 的 `scripts/browser-client.mjs`（模型面运行时）、`browser-use/0.4.2/dist/mcp/server.js`（页面侧服务；**0.5.1 这个缓存里根本没有 `dist/`**，它的 `main` 指向同包里不存在的文件，所以能量的最新服务端是 0.4.2）、`node-repl-host/0.6.0/dist/mcp/server.js`（REPL 宿主）。

**结论要分两侧说，第一版笔记把这一条写窄了：**

- **浏览器那一侧确实没有。** `MutationObserver` 在**四份产物里都是 0 次**；客户端 `click(options?): Promise<void>`、`fill(value, options?): Promise<void>` 直接丢掉动作的返回值，`docs/overview.md` 原话 "Actions return `undefined` on success."。`settle` 在客户端那 1 次是提示词里的散文（"settled the backend navigation"），在服务端那 82 次是 Promise/流的 settled 标志与拒绝信封的字段——**没有动作静默窗口**。
- **但它的姊妹路径——电脑操作（CUA）——两侧都有，而且形状很像我们要的东西。** 都在 `node-repl-host`：`formatAxChangeSummary(state, mode, base_state_id, changes)` 打出一份差分摘要，`actionReceiptBlock(receipt, effectEvidence)` 打出一份**动作回执**。原文形状：

  ```
  state_id=… app: com.example.app pid=1234 "Notes" window: "…" window_id=…
  ax_snapshot: mode=… base_state_id=… elements=42
  changes: updated=3 added=0 removed=0 focus_changed=false
    ~ [12] button "Save" disabled=true → false
  Unchanged rows are omitted: no element was added or removed, so element order and
  every index are identical to … and remain valid under state_id=…
  ```

  ```json
  { "action_receipt": { "schema_version": "zcode-cua-action-receipt-v1",
      "action_sent": …, "dispatch_status": …, "retry_action": false,
      "target_verification_status": …, "effect_evidence": "unchanged",
      "effect_note": "…this is evidence, not proof of failure…" } }
  ```

  `mode === "no_change"` 还有一段专门的文案："No material accessibility change since …; re-observing again will return this same summary, so take the next action instead."

**我们抄了什么、又故意不抄什么：**

- **抄**：变化要**一条条结构化**（它的回执是带 `schema_version` 的 JSON，给程序读；散文是给人读的那一半）；`~` 表示"同一个东西改了"、`added`/`removed` 分开计数（我们的 `+1`/`-1`/`~` 与它同形）；每个值**截断在 60 字符**（我们是 `CHANGE_TEXT_MAX = 60`，独立收敛到同一个数）；**没印出来的要计数**——它的元素列表写着 `N of M elements shown (selected by priority, ancestors kept) — indices are sparse; K hidden`，与我们的快照预算和 `changesOmitted` 是同一条规矩。
- **不抄它的机制**：它是**拉式差分**——拿两份 AX 观察比（需要 `base_state_id`，所以只有在"再观察一次"之后才看得到变化，而且变化若在两次观察之间被改回去就看不见）；我们是**推式观察**——探针在 dispatch **之前**装好，同步反应与被撤销的变化都在窗口内被抓到。这正是[动作结果要有语义](../bug-fix/2026-09-25-action-reporting-and-snapshot-semantics.md) 那一轮用真机代价换来的东西。
- **换来的代价是描述更弱**：它的差分跑在 AX 元素列表上，所以每行都有**真的 role 与 title**；我们的摘要跑在页内 DOM 节点上，只有标签、页面声明的 `role` 属性与一小段文本（理由见 `## Decision` 与替代方案 2、3）。
- **它的回执还有两个我们没有的字段**：`retry_action`（"要不要重试"的**指令**）与 `effect_evidence` + `effect_note`（"没变化"是**证据不等于失败**，并说清什么时候该再发一次、什么时候不该）。我们只报事实、不给指令，这是有意的；但 `effect_note` 的那句提醒值得抄进渲染——见下一轮那篇的候选，本轮没做。
- 另外两个量出来的参照：`ElementInfo = { ariaName?, boundingBox?, nodeId?, preview, role?, selector, tagName, testId?, visibleText? }` —— 计算出的 `ariaName` 与页面上的 `visibleText`/`preview`/`tagName`/`role` 是**分开的字段**，被截断的文本就叫 `preview`（支持"`preview` 不叫 `name`"）；浏览器快照的元素形状里有 `ref`/`tag`/`role`/`name`/`text` 与两级截断标记（`domTruncated` 与 `truncated`），与我们的"预算 + 元素上限"同构。

## Alternatives considered

1. **只保留计数（当时的现实）。** 这是被解决的那条摩擦本身；`changed: dom` 分不出"提示条出现了"和"转圈重画了"。
2. **每条变化都去无障碍树里查计算后的 role/name。** 那才是"和快照同一个词"的理想形状，代价是每个变化一轮协议调用（`Accessibility.getPartialAXTree` 要 `objectId`/`backendNodeId`，还得先把变化节点从页面里兑换成 `objectId`），而且**移除的节点在无障碍树里已经不存在**——最需要"说清走掉的是什么"的那一类，恰恰是这条路拿不到的那一类。放弃：付出确定的往返与失败分支，换来一个在最重要情形下更差的答案。
3. **在页内用标签名推 role**（`<input>` → `textbox`、`<a href>` → `link` 之类的映射表）。省下协议往返，但那是**role 命名的第二个家**，而且会和快照打架：同一行元素在快照里是 `textbox "Email"`、在变更清单里是 `input`。放弃：宁可两个字段各自诚实（`tag` 是标签、`role` 是页面声明的 role），也不做一个会对不上号的假名字。
4. **不加渲染，只给结构化字段。** 结构化是 PTC 的硬要求，但 native 仍然是默认呈现（[下一轮那篇](../../proposed/feature/2026-09-29-tool-surface-next-round.md) 已记：PTC 下内层子调用的事件只进日志），只给字段等于让默认模式下的模型从 JSON 里读散文。两者都要，且渲染的就是字段本身。
5. **不封顶，或封顶但不说省略了多少。** 前者让回报随页面成比例变长（与"筛比印重要"相反）；后者把"40 条里的 5 条"说成"只动了 5 次"——一个会静默误导的回报比一个长回报更糟。
6. **照字面报"一个文本节点走了、一个文本节点来了"。** 见上：真机量到的最常见文本改写形状就是它，照字面报会用两条说一件事、还把前后两个值都说成新值。**放弃。**
7. **把 `script`/`style` 的增删也报出来。** 更"完整"，但 CSS-in-JS 每次渲染都重写 `<style>`，5 个名额会被机器占满，而这些都是读者在页面上看不见、也点不到的东西。放弃：**跳过不是省略**，省略要计数，跳过不计数。
8. **把变化挂在 `element` 上**（"你点的这个元素变了什么"）。窄了：一次点击最常见的后果恰恰是**别处**变（提示条、列表、计数器），而"你点的元素自己被禁用"只是其中一种。

## Consequences

- **动作回报多两个字段、多一行（有变化时）**：`changes` 与 `changesOmitted`；`changed` 的语义没变（`dom` 仍然是"页面动过"）。`browser_navigate`/`click`/`type` 的渲染都带上这一行。
- **不增加任何协议调用**：整份摘要在已经装好的探针里算完，`readSettle` 还是原来那一次读。探针字符串更大（多了一段页内代码），每次动作都多付这点解析成本。
- **未覆盖的地方（本轮明确没解决）**：
  - **只看得见主文档。** 探针装在主框架上，`subtree: true` **不穿透 shadow root**，也看不见任何 iframe 里的变化——Web Component 内部或跨文档的响应不会被报出来（`mutations` 也就不会增加）。
  - **移除的节点只能报它自己的标签与文本**，拿不到它生前的无障碍 role/name（它已经不在树里）。
  - **`preview` 可能选错来源**：一个成对出现表单项的 `<input>` 若既无 `aria-label` 也无 `placeholder`，`value` 就成了它的标识，而这未必是读者认它的名字。
  - **同名元素的歧义仍在**：清单说"有个 `button` 被禁用了"，不含 ref，也不保证和快照里哪一行对应。
- **代价与边界都靠测试钉住**：页内那一半由 [`test/settle-probe.test.ts`](../../../../test/settle-probe.test.ts) 用假 DOM + 假 `MutationObserver` 驱动（喂进去的是**浏览器的记录形状**，断言的是它的摘要），边界那一半由 [`test/session-browser.test.ts`](../../../../test/session-browser.test.ts) 用手写的恶意记录驱动（`null`、错类型、500 字的 preview、10 条条目），格式由 [`test/tools.test.ts`](../../../../test/tools.test.ts) 断言，桥由 [`test/ptc.test.ts`](../../../../test/ptc.test.ts) 断言（SDK 里 `changes?: ({ kind: "added" | … })[]` 保留字面量 + 一段程序读 `report.changes[0].role`）。
- **真机那一半在 [`scripts/snapshot-regression.mjs`](../../../../scripts/snapshot-regression.mjs) 的 [22]**：一个 `data:` fixture，点一次同时发生三件事（加一个 `role="status"` 的节点、`#count` 的文本改写、给自己加 `disabled`），三条形状各自断言到字段。**这一轮真机量到并改掉了一个假的形状假设**：`element.textContent = …` 产生的是 childList 替换（不是 `characterData`），第一版真机跑出来是 `+1 p "24.2k"` 与 `-1 p "24.2k"`——两次断言在同一台真机上红过之后才有上面那条折叠规则。
- **验证**：`pnpm test` **336/336，exit 0**（真正的 `pnpm test`，每个文件一个子进程；沙箱内需一次性提权，管道 stdio 会 EPERM）、`node --test --test-isolation=none "test/**/*.test.ts"` 336/336 exit 0、`pnpm run typecheck` 与 `pnpm run build` 均 exit 0（`lib/` 随之重建）。真机回归 53/54：唯一的红是**与本项无关**的那条数据依赖断言（`github.com/trending` 今天 199 个节点，阈值是 `> 300`），本项新增的 4 条全绿。
- **渲染的样子**留了一份对拍：`.prove/change-list-render.mjs`（把真机回归里那份 `changes` 打成文本）。

## Related

- 动作回报的语义（`element`/`obstructed`/`changed` 为什么不是装饰，以及观察者必须装在输入之前）：[动作结果要有语义](../bug-fix/2026-09-25-action-reporting-and-snapshot-semantics.md)
- 这一项在下一轮方案里的位置与验收标准：[工具面下一轮：定位要能再解析，动作回报要有内容](../../proposed/feature/2026-09-29-tool-surface-next-round.md)（P0-2）
- 催生它的那次真机摩擦记录（第 1 条）：[本地 SPA 驱动摩擦](../../proposed/testing/2026-09-28-local-spa-drive-frictions.md)
- PTC 兼容门禁（`changes` 的 SDK 形状与"程序能分支"那两条断言在它里面）：[PTC 兼容门禁](../testing/2026-09-29-ptc-compatibility-gate.md)
- 动作层的等待与上限约定：[被取消的调用与有界等待](../bug-fix/2026-09-24-cancelled-calls-and-bounded-waits.md)
