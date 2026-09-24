# Agent Note: 工具面未解决的摩擦

Status: proposed

## Problem

[重启后重做 GitHub Trending：A–E 真机复验](../../implemented/testing/2026-09-24-toolset-evaluation.md) 收尾时仍列着四项不顺手之处，[工具面优化](../../implemented/feature/2026-09-24-tool-surface-optimization.md) 里的 P2 也还开着。它们都不影响正确性，但每一项都在消耗后续每一轮的调用或上下文。按影响排序：

1. **快照噪声**：364 行里 107 行（29%）是贡献者头像链接与 star 按钮这类纯噪音，而模型没有任何办法说"只要列表、不要每张卡片的外设"——`target=` 只能按子树切，切不出"同一种元素只留一个字段"。
2. **`depth=` 不可预测**：它从 AX 根算起，而 `/trending` 的内容在 depth 4–6、仓库页在 10+，所以 `depth=6` 在榜单页几乎印了整页（357/364），仓库页 `depth=4` 才是真的浅。截断提示出现时已经来不及省上下文。
3. **evaluate 猜选择器是静默失败**：一次取 6 个字段，描述 / topics / 语言全空——零匹配不报错，只有"全是 null"这一个信号。
4. **遮挡回报的元素名读起来矛盾**：指名的是 `button "Language: Any"`，但它的 box 并不包含落点（命中来自它内部那个弹出层）。事实没错，可模型会以为工具算错了。

2026-09-24 又一次真机复验（Google 搜索结果页）确认了点击改造本身：折叠线以下的元素现在真的被点中并跳转、遮罩盖住时默认拒绝并指名接收者（一次是 `div "agent browser 最 佳 实践"`，一次是 `svg ""`）、加 `force: true` 能照发并在回报里写明"谁收到了这一击"、跨页旧 ref 被拒、视口外落点连 `force` 也不放行。同一轮新增两项摩擦：

5. **无名接收者读起来没有线索**：Google 结果页的整块链接（`a` 包住标题与网址）落点常落在同一行的"关于这条结果的详细信息"三点控件上，探针按 `aria-label ?? textContent` 取名，于是拒绝消息里写的是 `svg ""`——模型看不出那是什么，也看不出该改成点内层的 `heading` ref。事实没错，但**下一步不可执行**，而当前最顺手的下一步（`force: true`）恰恰是错的。
6. **别人已经证明有用的两件事我们还没有**：Playwright MCP 的 `browser_find`（按文本/正则搜当前快照，只回匹配节点加它在树里的路径，比整张快照便宜得多）与 `browser_snapshot` 的 `boxes: true`（每个元素附视口坐标）；vercel-labs 的 agent-browser 则把快照参数做成了 `-i`（只要可交互）、`-c`、`-d`、`-s <selector>` 加 `--json`。两者都指向同一件事：**筛快照比印快照更重要**，而我们现在只有 `target=` 与 `depth=`。

还有一项与工具无关但同在清单里：**重启会留下一份 20–30 MB 的 profile 目录**（实测 4 个 `dsh-browser-*` 共 56.7 MB，其中一个是重启前那个会话留下的）。

2026-09-24 的第二轮真机复验（同一张 Google 搜索结果页，这次载入的是含[取消修复](../../implemented/bug-fix/2026-09-24-cancelled-calls-and-bounded-waits.md)的新产物）先确认了那条修复：`browser_evaluate('await new Promise(() => {})')` 在 **120 s 预算到点后返回** `Error: tool call timed out after 120000ms`（旧产物在这里永远不返回，只能手动关浏览器），紧接着一次 `evaluate` 立刻答 42、页面仍是原来那一页——浏览器没被丢弃。点击与快照那几项也都成立：折叠线以下的元素真的被点中并跳转（press 落在 `clientY 889 / 视口 900`、`isTrusted: true`）、遮罩默认拒绝并指名 `div "fixed panel over the button"`、`force` 照发并回报接收者、视口左侧的元素连滚都滚不进来、跨页旧 ref 被拒。**输入侧的假成功也是这一轮量到并修掉的**：只读输入框报 `Typed … into textbox "readonly"` 而值为空，见[输入也要问页面能不能接](../../implemented/bug-fix/2026-09-24-typing-actionability.md)。

同一轮新增与加深三项摩擦：

7. **点击引起导航时回报的是旧 URL。** 点 Google 结果跳去 `cnblogs.com` 与 `cloud.tencent.com` 两次，回报都是 `Page: https://www.google.com/search?…`，真地址只出现在标题里（`"Loading https://www.cnblogs.com/itech/p/20045683"`）——导航的提交落在 settle 窗口之后，于是 `changed` 只有 `title`，而模型只读 URL 会以为点击失败（下一次 `evaluate` 才看到真地址）。这与已经修掉的"点击后回报旧 URL"是同一类症状的不同触发条件。
8. **`depth=` 又一次印了整页。** `target=#rso`（Google 的结果容器）配 `depth=4` 仍打印了整个结果列表，截断提示 `… 28 nodes are deeper than depth=4 and were not printed` 没有说那 28 个挂在哪一支上。第 2 项的"把节点数与内容深度区间并进 page info"因此更值得做。
9. **`emphasis` 这类无名行内标记是纯噪声。** Google 为加粗命中的关键词，每段摘要里插 3–6 个 `<em>`，于是每个结果白白多出 3–6 行；在浅 `depth=` 下它们连子节点一起被截掉，印成 `- emphasis [ref=e99]` 这种**没有文字的空行**，比不印更糟。

另一个不是缺陷但值得记的观察：快照里 Google 结果的 `url=` 是 `https://www.google.com/goto?url=CAESYAHrOzAVk51zljn1f2RAWryX…`——站点自己的跳转，还被打印预算截断，所以**从快照看不出链接真正去哪**，只能点开或 evaluate 取 `href`。判断落点时 `changed: url` 比 `url=` 可靠。

## Proposal

- 把节点数与内容深度区间并进 page info 头（例如 `364 nodes, content at depth 4-9`），让模型有依据挑 `depth=`。
- 给快照一种"精简列表"的表达（同类元素只留一个字段），或者先只在文档里把 `target=` 与 `depth=` 的组合写法讲清楚。
- 遮挡回报同时给出落点上"画着"的节点（`elementsFromPoint` 栈顶）作为上下文。
- 接收者没有可访问名时，沿祖先链取第一个有名祖先当作名字（`svg ""` → 那个 `div`/`button` 的名字），都没有才回退到标签名；拒绝消息里再加一句"如果目标是标题，去点它内层的 heading ref"。
- 给 `browser_snapshot` 加两个参数（**不加新工具**）：`find`（文本或正则，只回匹配节点与它在树里的路径）与 `boxes`（每个元素附视口坐标）。两者都只影响打印形状，不动 ref 的稳定性。
- 清理 profile 残留必须带所有权判据（每个 profile 写一个 PID 锁，启动时只删锁已死的目录），**不能按名字通配**。
- 点击按下之后如果这一帧已经开始导航，就等它提交一小会儿（或把 `navigating to <url>` 写进回报），别让模型拿着旧 URL 判断点击是否成功。
- 快照过滤把 `emphasis` 这类"不带可访问名、只包一段文字"的行内标记并进它所在的那一行，而不是各占一行；浅 `depth=` 下更不该印成空行。

## Alternatives considered

**什么都不做**：这些项都不影响正确性，但每一项都在消耗后续每一轮的上下文，而且第 2 项已经实际浪费过一次（本意是省上下文的一次 `depth=6` 反而印了整页）。**按名字通配清理 `%TEMP%\dsh-browser-*`**：会删掉另一个 dsh 实例正在运行的浏览器，[临时 profile 泄露](../../implemented/bug-fix/2026-09-24-temp-profile-leak.md) 已经否掉过一次。**把 `depth=` 改成从内容首元素算起**：会让同一个数字在不同页面上含义不同，比现在更难预测。**拒绝消息里直接把"内层哪个 ref 更该点"算出来**：要读 AX 树，让一次拒绝多一次快照级的开销，而"沿祖先链取名字"只用探针已经拿到的 DOM；先做便宜的。**把 `find` 做成新工具**：工具面固定 6 个，筛快照本来就是 `browser_snapshot` 的一种形状，参数足够。

## Acceptance criteria

每项要么落地并带一条真机断言（可量：快照行数、page info 字段、`obstructed` 的附带信息、`find` 命中数与路径、`boxes` 的坐标、残留目录数），要么被明确记为"不做"并从本笔记删除。

## Risks

精简快照的表达可能与"ref 属于页面"的稳定性冲突（同一个元素在不同形状的快照里应保持同一个 ref）；page info 加字段会让每次快照多一行；PID 锁在 profile 被两个进程同时打开时会误判，需要先确认只有一个写入者。**按祖先取名可能把更大的容器说成接收者**（一个被命名的页脚 wrapper），所以只在直接命中者没有名字时用，并且名字仍要标明它来自祖先。
