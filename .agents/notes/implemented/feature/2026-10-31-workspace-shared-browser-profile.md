# Agent Note: 工作区共享 profile：第三种 profile 模式

Status: implemented

## Problem

原先的 profile 只有两种取法：`userDataDir` 为空时 `mkdtemp` 一个一次性目录，非空时 `profileDirFor(base, sessionId)` 给**每个会话**一个子目录。前者登录态用完即弃，后者登录态只属于产生它的那一个对话。

这两种都不满足一个很普通的需求：**同一个项目里的多个对话，应该共享同一份登录态。** 在一个工作区登录过一次的站点，用户在下一个对话里还要再登一次；而"再登一次"在强 2FA 的站点上常常根本做不到。按 session 隔离是 [v1 隔离决定](../../implemented/feature/2026-09-23-v1-isolation-disconnect-tabs-tools.md) 与 [多标签与页面生命周期](../../implemented/architecture/2026-09-23-multi-tab-and-page-lifecycle.md) 的直接后果，那两篇把"登录态跨会话共享"列为被放弃的代价。本笔记提出的是：**隔离的单位选错了**——该隔离的是工作区，不是对话。

同时排除一条曾经看起来更直接的路：附加到用户自己的浏览器。它要求用户开 `edge://inspect` 的调试开关、把 agent 的权限伸进用户日常浏览的全部数据、并引入一整套"谁的标签页"的仲裁。工作区 profile 用"agent 自己第一次登录"换掉这一切，代价小一个数量级。

## Decision

### 三种 profile 模式

`profileMode` 是新的 volatile 字段（设置页可见），`userDataDir` 仍是目录：

| 模式 | 目录 | 谁共享 |
|---|---|---|
| `temp` | `mkdtemp('dsh-browser-')`，关闭即删 | 无人 |
| `session` | `<userDataDir>/<encodeSessionSegment(sessionId)>` | 对话自己 |
| `workspace` | `<userDataDir>/workspace-<encodeSessionSegment(workspaceId)>` | **同一工作区的全部会话** |

默认 `session`，于是不带配置的部署与之前完全一样。`session` + 空目录就是旧的 `temp` 行为，这正是为什么要显式选模式而不是从"有没有填路径"去猜。

`workspace` + 空 `userDataDir` **不报错**：目录取 `<workspace.path>/.dsh/browser`，让 profile 跟项目走。配置了 `userDataDir` 就把它当父目录，每个工作区一个子目录（前缀 `workspace-`，让工作区 id 与 session id 两个名字空间不可能撞在一起）。草稿里"空目录在 schema 层直接报错"与此矛盾，取后者作废：默认开箱可用比强制用户先选目录重要，而**真正该失败的那种情况**是拿不到工作区。

### 进程与对话分成两半

`SessionBrowser` 原来同时是"进程"和"对话"。现在：

```
SharedBrowser (进程、profile、CDP 端口、页注册表、镜像、归属)
  ├─ SessionBrowser A: page 指针、RefLabels、viewports、dialogs
  └─ SessionBrowser B: 同上，各一份
```

`shared-browser.ts` 是进程半边，`session-browser.ts` 是对话半边。这个拆法是有意的：`session-browser.ts` 里那几千行是七八轮真机实测堆出来的（落点探针、settle 观察者、取消语义、对话框策略），围绕另一种形状重写会把测量一起花掉。所以进程级字段在对话半边被写成**委托给 `host` 的访问器**，方法体几乎没动——一眼能看出哪个字段跨了边界。

`BrowserPool` 从 `Map<sessionId, SessionBrowser>` 变成 `Map<browserKey, SharedBrowser>` + `Map<sessionId, SessionBrowser>`。`browserKey` 在 `temp`/`session` 下是 sessionId，在 `workspace` 下是 workspaceId。

### 归属：记账，不是安全边界

- 每会话一个 `ownedTargets` 集合，记在 `SharedBrowser.owners` 上（targetId 只在一个进程内唯一）。
- 会话打开页（`browser_tabs{open}`、`openPage`）时直接记进自己的集合。
- 页面脚本自己开的页（`window.open`、OAuth 弹窗）：**归属判据是"当时在飞的动作"**——`underPolicy` 在每次工具调用前后 `beginAction`/`endAction`，`context.on('page')` 只在恰好一个会话在飞时把页给它；没有动作在飞但整台浏览器只有一个会话时也给它（不歧义）；否则归给"没人"，那张页不出现在任何人的列表里。
- 这一点必须说清楚：协议里的 `Target.getTargets` 没有"谁开的"这个字段，`openerId` 只有 `window.open` 那条路径才有，这台 Edge 的 `/json/protocol` 里没有 TabGroups 域。所以归属只能是插件的记账，而记账能被"执行任意 JS 的会话"伪造。本设计接受这一点：共享 profile 的会话本来就互相信任到可以共享 cookie。

### 一个 gate，而不是每个调用点各写一遍

`pageByTargetId` 是唯一把 targetId 变成 `Page` 的地方，它在里面一并查归属，不属于本会话就返回 `undefined`。于是 `selectPage`、`navigatePage`、`closePage`、镜像、输入、以及工具新增的 `targetId` 参数全部自动被同一道门挡住——一处定义"我能碰哪些页"。

工具侧新增 `targetId` 参数（九个按页工具都收），语义是"先 select 再执行"，所以一个动词只有一种定义"作用在哪一页"，而 `browser_tabs{list}` 只列自己的页。

### 三条硬行为

1. **关最后一页不关浏览器。** 共享模式下关掉一个会话的最后一页只是它没有页了，浏览器属于工作区。`closePage` 仍按会话判：不在本会话的页直接无视。
2. **对话框只替自己的页回答。** `page.on('dialog')` 现在先查 `ownsPage(page)`，不是自己的页就不答——替别人把 `confirm` 答掉是替别人做了决定。
3. **镜像按页挂流不变。** `mirrors` 本来就用 targetId 做键，两个会话各订各的页。变的只是 viewer 连进来时也要过归属这一道。

### 回收按会话计数，不按页

`SharedBrowser.participants` 是一组 `SessionParticipant`，引用计数就是它的大小。两种触发走同一条路：会话 dispose，或用户点设置页的「关闭浏览器」——关掉该会话 owned 的页、从实例上摘除、计数减一；归零才 `stop()` 进程。**不归零时浏览器继续服务，它手里的页一张都不受影响。**

这与 `userClosed` 是两件事：`userClosed` 保护"用户明确让它停"，引用计数决定"还有没有人需要它"。归零时调 `close()` 才同时满足两者。

记录的生命周期跟着会话走：不再持有浏览器的会话从报告里直接消失，不留"已关闭"占位。

### 设置页：一行是一个会话，但多行可以是同一台浏览器

新增 `browserId`（同一台浏览器上的会话共享它）与 `ownedPages`（这个会话在这台浏览器里有多少页）。`temp`/`session` 下两者一一对应，看起来和今天一样；`workspace` 下多行共享一个 `browserId`，行尾写「与 N 个对话共用这个浏览器」，让"三行"不读成"三个进程"。

## 实测

2026-11-02，隔离在 `D:\dsh-verify`，profile `webtest`，`profileMode: workspace`：

1. `/dsh-browser/status` 的 `browserId` 是**工作区 id**（`d7f82693-…`），不是 session id，`debugPort` 9039 只有一个 —— 证明是进程级共享。
2. 派生目录真的落在 `<workspace.path>\.dsh\browser\workspace-d7f82693-…`。
3. 不在任何工作区的 session 调 `POST /dsh-browser/pages` 得到 `{"ok":false}`，没有静默退回私有浏览器。
4. 关闭后 `instances` 变空，`Test-NetConnection 127.0.0.1:9039` 为 `False`（端口真的不监听了）。
5. 关掉再开：`browserId` 不变、端口仍是 9039、`ownedPages` 为 1 —— 共享实例按预期复用。

单测 529 条全绿，其中新增 `test/workspace-profile.test.ts` 15 条覆盖：一工作区一进程/端口/profile、两工作区两进程、页互不可见、跨会话 targetId 与 ref 被拒、各自 select 互不影响、关最后一页不关进程、引用计数归零才关、dispose 只关自己的页、无工作区会话失败、以及 `temp`/`session` 模式行为未变。

## Alternatives considered

**按会话隔离（现状）。** 登录态无法跨对话累积，这正是本笔记要解决的问题；它作为 `session` 模式保留，因为"这个对话不要碰别的对话的登录"仍然是正当需求。

**全局一份 profile（所有工作区共享）。** 更省资源，但不同项目的登录态混在一起：一个项目的 agent 能读到另一个项目的站点会话，隔离彻底消失。工作区是用户本来就在用的边界，用它不需要发明新概念。

**附加到用户自己的浏览器。** 用户不必登录第二次，听起来最省事，代价是：需要用户在 `edge://inspect` 勾选调试开关（Chrome 136+ 对默认 profile 忽略 `--remote-debugging-port`）；agent 的视野伸进用户日常浏览的全部数据；还要解决"谁的标签页"的仲裁，而这件事 CDP 不提供归属信息。它解决的是"登录进不去"而不是"登录要重来"，因此作为后手而不是主线。

**复制用户的 profile 目录。** 实测可行（`Local State` 的 DPAPI 密钥在同一 Windows 用户下仍能解密，复制后 cookie 可用），但它是**一次性快照**：复制之后用户在新站点登录，agent 那边不知道。作为"迁移登录态"的手段可以，作为协作模型不成立。

**让每个会话各起一个浏览器打开同一份 profile。** 已被实测否掉：第二次启动 `msedge --user-data-dir=<同一目录>` 只是把手上的请求转交给已有进程然后自己退出；对 Playwright 表现为第二次 `launchPersistentContext` 报 `Target page, context or browser has been closed`。不是一个可选方案。

**空 `userDataDir` 在 workspace 模式下报错。** 原草稿的写法。改成从 `<workspace.path>/.dsh/browser` 派生：强制用户先选一个目录才能用共享模式，会让"默认情况"变成"必须配置"，而默认可用的收益比"用户显式确认目录"大得多。

## Consequences

- **共享 profile 内的会话可以互相影响。** 同工作区两个会话共用一个 cookie jar：A 的 `browser_evaluate` 能读到 B 的登录态，A 退出登录会让 B 掉线。这是"共享登录态"的另一面，不是缺陷；风险在于用户会以为"不同对话之间是隔离的"。UI 在模式选择处直说了这一点（`settingsProfileModeHint`）。
- **一个进程崩了，整个工作区的会话一起失去浏览器。** 按会话隔离时这是单点故障；共享之后是区域内故障。
- **归属是记账。** `window.open` 与手动指定的 targetId 都可能让归属失真；接受的理由见上，但错误信息说明了这不是安全边界。
- **页面数量膨胀。** 一个工作区只有一个浏览器，页不会随会话结束自动回收（浏览器还活着）。会话 dispose 时**关闭它 owned 的页**，否则长工作区的标签页会越积越多。
- **迁移。** 已经存在的按会话 profile 目录不会自动变成工作区目录，用户在切换模式后需要在新目录里重新登录一次。这必须写进发布说明，否则会被当成"登录态丢了"。
- **`maxInstances` 的含义变了。** 它现在数的是进程，不是会话：`workspace` 模式下四个会话可能只占一个。这正是应该的——它保护的资源是内存和端口，两者都按进程算。
