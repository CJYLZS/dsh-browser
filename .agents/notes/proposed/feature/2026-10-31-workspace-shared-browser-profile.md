# Agent Note: 工作区共享 profile：第三种 profile 模式

Status: proposed

## Problem

今天的 profile 只有两种取法，见 [session-browser.ts](../../../../src/browser/session-browser.ts) 的 `start()`：`userDataDir` 为空时 `mkdtemp` 一个一次性目录，非空时 `profileDirFor(base, sessionId)` 给**每个会话**一个子目录（[profile.ts](../../../../src/browser/profile.ts)）。前者登录态用完即弃，后者登录态只属于产生它的那一个对话。

这两种都不满足一个很普通的需求：**同一个项目里的多个对话，应该共享同一份登录态。** 在一个工作区登录过一次的站点，用户在下一个对话里还要再登一次；而"再登一次"在强 2FA 的站点上常常根本做不到。按 session 隔离是 [v1 隔离决定](../../implemented/feature/2026-09-23-v1-isolation-disconnect-tabs-tools.md) 与 [多标签与页面生命周期](../../implemented/architecture/2026-09-23-multi-tab-and-page-lifecycle.md) 的直接后果，那两篇把"登录态跨会话共享"列为被放弃的代价，理由是"与真实隔离矛盾"。本笔记要提出的是：**隔离的单位选错了**——该隔离的是工作区，不是对话。

同时排除一条曾经看起来更直接的路：附加到用户自己的浏览器。它要求用户开 `edge://inspect` 的调试开关、把 agent 的权限伸进用户日常浏览的全部数据、并引入一整套"谁的标签页"的仲裁。工作区 profile 用"agent 自己第一次登录"换掉这一切，代价小一个数量级。附加模式留作登录无法在自动化浏览器内完成的场合的后手，不在本笔记范围内。

## 事实（本轮实测，决定了方案的形状）

1. **同一 profile 不能被两个浏览器实例同时打开**，但可以被同一个浏览器进程开很多窗口。第二次启动 `msedge.exe --user-data-dir=<同一目录>` 会把手上的请求**转交**给已有进程然后自己退出（实测：启动 6 秒后第二个 PID 已不存在，主进程仍只有原来那一个，两个可见窗口都挂在同一个 PID 下）。窗口数不等于进程数。
2. **转交对 Playwright 是致命的。** 同一目录连续两次 `launchPersistentContext`：第一次成功，第二次报 `Target page, context or browser has been closed`；先由外部浏览器占住目录、再让 Playwright 指进去，同样报这句话。所以"每个会话各起一个浏览器去打开同一份 profile"这条路不存在。
3. **页面没有归属信息。** `Target.getTargets` 的条目里没有"谁创建的"，`openerId` 只有 `window.open` 那条路径才有值；这台 Edge 的 `/json/protocol` 里**没有 TabGroups 域**。`context.pages()` 返回的是全部页面，任何客户端都一样。因此"每个会话只看得到自己的标签页"只能是**插件侧记账 + 过滤**，不是协议保证。
4. **工作区注册表在两个 web 装配里都有**：`@deepseek-ai/dsh-workspace` 挂在 web-app 的 patch 层（`packages/bundle/web-app/cordis.patch.yml` 的 `id: workspace`），`WorkspaceRegistry.list()` 给出带 `id`、`path`、`sessionIds` 的实体，足以把 session 映射到工作区。

## Proposal

### 第三种 profile 模式

`userDataDir` 现在的两态选择（空 = 临时 / 非空 = 按会话）升成三态，配置字段仍是 `userDataDir`，另加一个 volatile 字段 `profileMode: 'temp' | 'session' | 'workspace'`：

| 模式 | 目录 | 谁共享 |
|---|---|---|
| `temp` | `mkdtemp('dsh-browser-')`，关闭即删 | 无人 |
| `session` | `<userDataDir>/<encodeSessionSegment(sessionId)>` | 对话自己 |
| `workspace` | `<userDataDir>/workspace-<encodeSessionSegment(workspaceId)>` | **同一工作区的全部会话** |

`workspace` 模式下 `userDataDir` 不能为空：空目录含义是"用完即弃"，与"持久共享"矛盾，直接在 schema 层报错而不是偷偷退化成临时 profile。设置页把这三项放进现有的 profile 下拉（现在只有 temp / persistent 两项），`workspace` 退到工作区注册表不可用时**明确失败并说出来**，不静默降级。

工作区目录的默认值取 `<workspace.path>/.dsh/browser`，让 profile 跟项目走；用户仍可把 `userDataDir` 指到别处（例如放不进仓库的盘符）。

### 浏览器实例的键从 session 换成"共享单元"

`BrowserPool` 的 `entries` 现在是 `Map<sessionId, SessionBrowser>`（[pool.ts](../../../../src/browser/pool.ts)）。改成 `Map<browserKey, SharedBrowser>`，`browserKey` 在 `session`/`temp` 模式下就是 sessionId，在 `workspace` 模式下是 workspaceId。同一个工作区的第二个会话 `get()` 时拿到的是**同一个实例**，它开自己的标签页，而不是再起一个浏览器。

这带来的第一个直接后果是**实例的生死不再与单个会话绑定**。现在 `session/disposed` 会 `pool.dispose(sessionId)` 并关掉浏览器；共享模式下那会关掉别人的页面。改成引用计数：最后一个会话释放时才关浏览器；用户从面板显式"关闭浏览器"仍然立即关闭整个共享实例（那是明确的意图，不是回收）。

### 每个会话一份视图，浏览器只有一份

`SharedBrowser` 持有浏览器；**会话作用域的状态搬进 `SessionView`**：

```
SharedBrowser (一个进程、一份 profile、一个 CDP 端口)
  ├─ SessionView A: activeTargetId, ownedTargets, RefLabels, viewports
  └─ SessionView B: activeTargetId, ownedTargets, RefLabels, viewports
```

要搬的四样，都是现在挂在 `SessionBrowser` 上的单例：

- `page`（active 指针）→ 每会话一个。**这同时是"工具不依赖全局 active"的实现**：同工作区的两个会话各有各的指针，谁也抢不走谁。
- `labels`（`RefLabels`）→ 每会话一份。`ref` 本来就只在产生它的那一页有意义，两个会话对同一页取快照会互相覆盖编号，必须按会话隔离。
- `viewports` 缓存 → 每会话一份（同一页在两个会话里不必共享这份缓存）。
- `ownedTargets`（新建）→ 该会话创建过的 targetId 集合。

浏览器级的仍然共享：CDP 端口、`browserCdp`（`Target.getTargets` 用的那条会话）、进程、profile、cookie。

### 工具显式指名页

九个工具里八个作用于"当前页"。给它们加一个可选参数 `targetId`：给了就作用于那一页（必须在**本会话**的 `ownedTargets` 里，否则报错并列出本会话的页），不给就落在本会话的 active 页上。`browser_tabs{list}` 只返回本会话的页；`select` 只能选本会话的页。这样 agent 眼里**只有自己的标签页**，另一个会话的页对它不存在。

注意这与[快照语义](../../implemented/bug-fix/2026-09-25-action-reporting-and-snapshot-semantics.md)里"ref 属于页面"一致：ref 与 targetId 一起构成定位，缺一不可。

### 归属怎么记，以及它的边界

- 会话通过 `browser_tabs{open}` 或工具内部 `newPage` 创建的页，**返回的 targetId 直接记进该会话的 `ownedTargets`**。
- 页面脚本自己开的页（`window.open`、OAuth 弹窗）：`Target.getTargets` 的 `openerId` 可以追到父页，父页属于哪个会话就归哪个；追不到时归给"产生这次动作的会话"（动作是有归属的，页面没有）。
- `context.on('page')` 不再无条件 `adopt`：只有落在本会话 `ownedTargets` 里的页才可能成为本会话的 active。

**已知边界**：归属是记账不是证明。一个会话若能执行任意 JS，它就能通过 `window.open` 造出看起来属于别人的页；本设计接受这一点，因为共享 profile 的会话本来就互相信任到可以共享 cookie。

### 三个必须同时改的硬行为

1. **关最后一页不关浏览器。** 现在 `closePage` 在同一页都没有时走 `stop()`，那是"关掉浏览器"的意思。共享模式下关掉一个会话的最后一页只是那个会话没有页了，浏览器属于工作区，必须还活着。
2. **对话框只替自己的页回答。** `answerDialog` 现在对每一页都装监听、默认 dismiss。共享模式下那会替别的会话（或用户）把 `confirm` 答掉。改成只对 `ownedTargets` 里的页装；不属于自己的页出现对话框时不回答，让它按页面自己的节奏走，靠调用超时兜底。
3. **镜像按页挂流不变。** `mirrors` 本来就用 targetId 做键，两个会话各自订阅各自的页，天然不冲突——这一层不需要改，只需要保证 viewer 连进来时按会话的 `ownedTargets` 校验。

## 设置页：从"看得到"变成"能关掉"

今天设置页只**显示**实例，而且显示的是一段看不懂的 id：`instanceLine` 把 `sessionId` 去掉 `session-` 前缀后截前 8 位（[settings-layout.ts](../../../../src/client/settings-layout.ts)），于是每一行都是 `会话 0599913e · running`——用户既不知道那是哪个对话，也不能把它关掉。

工作区共享之后这一块更要紧：一个工作区只应有一个实例，用户看到三个"会话"行会以为有泄漏。三件事一起改：

1. **一行是一个会话，但多行可以指向同一台浏览器。** 报告仍是"每会话一条"，多出来的两个字段把它和浏览器对上：`browserId`（同一台浏览器上的会话共享它，`status` 里也只出现一个实例）与 `ownedPages`（这个会话在这个浏览器里有多少页）。`temp`/`session` 模式下两者一一对应，看起来和今天一样；`workspace` 模式下三行共用一个 `browserId`，直说"同一台浏览器"。
2. **给人看得懂的名字。** 会话标题由宿主提供：报告里带上 `title`（会话的标题，来自会话记录），设置页显示 `标题 · 最后活跃时间`，id 降级成次级信息（只在需要区分两个同名对话时用）。拿不到标题时退回 id，但要标出"未命名会话"而不是印一串十六进制。
3. **能关掉，而且按钮与会话一一对应。** 每**会话**一行，行尾一个「关闭浏览器」。`temp`/`session` 模式下那本来就是"这台浏览器"；`workspace` 模式下它是"这个会话在这个浏览器里的一切"——关掉该会话 `ownedTargets` 里的全部页，并把该会话从共享实例上摘下来。**浏览器进程停不停由插件按引用计数决定**，用户不直接对进程下命令。

   路由仍是 `POST /dsh-browser/pages`，`close` 分支多认一个 `all: true`：带 `targetId` 时关那一页（现有语义），带 `all` 时关该会话的全部页并摘除该会话。客户端不必知道引用计数，它只说"这个会话不要浏览器了"。

这一步不依赖 profile 模式，可以单独先落地：它修的是"用户看不见、也关不掉"这个当下就存在的问题，而工作区共享只是让它更明显。

### 回收与引用计数

共享实例上挂着一组会话，**计数的是会话，不是页**。两种触发走同一条路径：

- **用户点某会话的「关闭浏览器」** → 关掉该会话 `ownedTargets` 里的全部页 → 该会话从实例上摘除 → 计数减一。
- **会话 dispose** → 同上（页已经随会话没了，直接摘除并减一）。

计数归零 → `stop()` 浏览器；不归零 → 浏览器继续为剩下的会话服务，**它手里的页一张都不受影响**。

这条与现有 `userClosed` 语义（[session-browser.ts](../../../../src/browser/session-browser.ts)："用户关的，别被 viewer 拉回来"）是两件事，不能混用：`userClosed` 保护的是"用户明确让它停"，而引用计数决定的是"还有没有人需要它"。计数归零时调 `stop()` 才同时满足两者。

**记录的生命周期跟着会话走。** 一个会话不再持有浏览器时，它的记录从报告里**直接消失**，不留一行"已关闭"占位——设置页列的是"现在谁在用浏览器"，不是历史。同理，`closed` / `failed` 的实例一旦没有会话持有，也不再出现在 `/dsh-browser/status` 的列表里；失败原因由下一个真正需要浏览器的请求重新报出来。

## Alternatives considered

**按会话隔离（现状）。** 登录态无法跨对话累积，这正是本笔记要解决的问题；它作为 `session` 模式保留，因为"这个对话不要碰别的对话的登录"仍然是正当需求。

**全局一份 profile（所有工作区共享）。** 更省资源，但不同项目的登录态混在一起：一个项目的 agent 能读到另一个项目的站点会话，隔离彻底消失。工作区是用户本来就在用的边界，用它不需要发明新概念。

**附加到用户自己的浏览器。** 用户不必登录第二次，听起来最省事，代价是：需要用户在 `edge://inspect` 勾选调试开关（Edge 实测有效，Chrome 136+ 对默认 profile 忽略 `--remote-debugging-port`）；agent 的视野伸进用户日常浏览的全部数据；还要解决"谁的标签页"的仲裁，而这件事 CDP 不提供归属信息。它解决的是"登录进不去"而不是"登录要重来"，因此作为后手而不是主线。

**复制用户的 profile 目录。** 实测可行（`Local State` 的 DPAPI 密钥在同一 Windows 用户下仍能解密，复制后 cookie 可用），但它是**一次性快照**：复制之后用户在新站点登录，agent 那边不知道。作为"迁移登录态"的手段可以，作为协作模型不成立。

**让每个会话各起一个浏览器打开同一份 profile。** 已被事实 1/2 否掉：第二次启动只是转交请求，Playwright 会报错；不是一个可选方案。

## Acceptance criteria

- `profileMode: 'workspace'` 且 `userDataDir` 为空时，配置校验失败并说明原因。
- 同一工作区的两个会话：第二个会话 `get()` 拿到同一进程（`status` 里只有一个实例、一个 CDP 端口），各自 `browser_tabs{list}` 只看到自己开的页。
- 会话 A 通过 `browser_tabs{open}` 开的页不出现在会话 B 的列表里；B 拿这个 targetId 调任何工具都报"不属于本会话"。
- 两个会话各自 `select` 自己的页互不影响：A 的 active 指针不因 B 的 `select` 或新开页而改变。
- 每个会话的 `ref` 编号互不覆盖：两边对同一页各取一次快照，各自手里的 `e1` 仍指向自己取快照时的元素。
- 会话 A 关掉自己最后一页后，浏览器仍在运行，B 的页还活着；B 仍能继续操作。
- 最后一个会话被 dispose 后浏览器关闭；用户从面板显式关闭时立即关闭。
- A 的页弹出 `confirm` 时 B 不替它回答。
- 工作区注册表不可用（例如 headless 装配）时，`workspace` 模式的启动失败信息指名这一点，且不静默退回 `session` 模式。
- 设置页一行对应一个运行中的浏览器，列出它服务的会话标题；没有标题时显示"未命名会话"而不是裸 id。
- 设置页每一行都能关闭，且按钮与会话一一对应：`workspace` 模式下关掉会话 A 的浏览器后，A 的页全部消失、A 的记录从报告里消失，**会话 B 的页与浏览器进程都还在**。
- 计数归零时浏览器进程真的退出（`status` 里不再有该实例，临时 profile 被清理）；不归零时不退出。
- 关掉之后没有任何"已关闭"占位记录：`/dsh-browser/status` 只列出还有会话持有的浏览器。
- 会话 dispose 后，该会话 owned 的页从浏览器里消失，其他会话的页不受影响。
- 现有 `temp` / `session` 模式行为不变（回归用例全绿）。

## Risks

- **共享 profile 内的会话可以互相影响。** 同工作区两个会话共用一个 cookie jar：A 的 `browser_evaluate` 能读到 B 的登录态，A 退出登录会让 B 掉线。这是"共享登录态"的另一面，不是缺陷；风险在于用户会以为"不同对话之间是隔离的"。UI 必须在模式选择处直说这一点。
- **一个进程崩了，整个工作区的会话一起失去浏览器。** 按会话隔离时这是单点故障；共享之后是区域内故障。
- **归属是记账。** `window.open` 与手动指定的 targetId 都可能让归属失真；接受的理由见上，但错误信息必须说明"这不是安全边界"。
- **页面数量膨胀。** 一个工作区只有一个浏览器，页不会随会话结束自动回收（浏览器还活着）。已定：会话 dispose 时**关闭它 owned 的页**（见 Decision「回收」），否则长工作区的标签页会越积越多。
- **迁移。** 已经存在的按会话 profile 目录不会自动变成工作区目录，用户在切换模式后需要在新目录里重新登录一次。这必须写进发布说明，否则会被当成"登录态丢了"。