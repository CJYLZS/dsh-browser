# Agent Note: 重启的浏览器打开了另一个 profile

Status: implemented

## Problem

在对话里登录了 kimi.com，关掉浏览器，再打开，登录态没了。真机取证（2026-11-03，desktop profile，`profileMode: workspace`）：

| 证据 | 值 |
|---|---|
| `<项目>/.dsh/browser/workspace-<id>` 里 cookie 数 | **0** |
| 同一个 profile 里的浏览历史 | **0 条** |
| 当时在跑的浏览器 `--user-data-dir` | `%TEMP%\dsh-browser-ZgV2os` |
| 那个临时目录里的历史 | `https://www.kimi.com/`（1 条） |
| workspace 目录创建时间 | 08:54:37 |
| 临时目录创建时间 | 08:55:33 |

也就是说：**第一次启动确实进了 workspace 目录，第二次启动进的是一个全新的临时目录**。登录态留在临时目录里，而那个目录会随进程关闭被删掉——所以看起来像"没有保留"，实际是**第二次启动根本没打开同一个目录**。

根因是一处"值被当成决定"的记账错误，不是 Chrome 的行为：

1. `BrowserPool.get()` 只在**创建进程**时调一次 `chooseProfile()`，把结果写进 `host.profileDir`；
2. `SessionBrowser.ensure()` 把这同一个字段当作启动参数传给 `host.ensure(this.host.profileDir)`；
3. 而 `SharedBrowser.close()` 和 `forget()` 都会把它清成 `undefined` —— 前者是用户关浏览器，后者是崩溃。

于是**回填给启动参数的是一个已经被自己清空的字段**。"这个浏览器当初被指定用哪个目录"和"下一次启动该打开哪个目录"被存在同一个变量里，而这两件事的生命周期不同：前者随进程结束而失效，后者不该。

`temp` 模式的表现是正确的（它本来就该每次换新目录），所以这个缺陷只在 `session` 和 `workspace` 下可见——恰好是"登录态应当保留"的那两个模式。这也解释了为什么它一直没被发现：所有既有测试都是一次 `ensure()`，没有任何一条覆盖"关掉之后再开"。

## Decision

### 目录每次启动重解析，但"这个进程是谁的"只取一次

修法分两半，第二半是我第一版写错过的地方：

`SharedBrowser` 收下一个 `ProfileUnit`——**创建该进程时的 session id 与它所属的 workspace**——在构造时取一次、之后不再查注册表。`ensure()` 每次启动都调 `profileDirForUnit(config, unit)` 现算目录：

```ts
const started = this.start(profileDirForUnit(this.config, this.unit))
```

为什么不能简单地在每次启动时重新 `chooseProfile(this.config, sessionId, lookup)`（我第一版就是）：

- **目录必须每次重算**：关闭后重开、崩溃后重开、以及设置页改了模式或目录之后再开，都必须打开**现在**配置说的那个目录。记一个值必然在这三种情况下过期。
- **但 unit 不能重查**：`workspace` 模式的浏览器比创建它的会话活得久。第一个会话走了以后注册表不再把它算进任何 workspace，而此时幸存会话的重启如果还去问"创建者属于哪个 workspace"，就必然失败。探针 `.prove/probe-survivor-restart.mjs` 实测过这个失败：`session session-a is not accounted to any workspace`。**这条是我改动引入的回归，被探针当场抓住**，不是既有缺陷。

unit 里存整个 workspace 对象而不是只存 id，因为 `userDataDir` 为空时目录由 `workspace.path` 派生——注册表忘掉那个会话之后，光有 id 已经无法再算出目录。

`host.profileDir` 保留，但降级为**诊断用**：它只说"当前这个进程开在哪个目录"，不再被读来回答"下一个开在哪"。`close()` 里那句 `this.profileDir = undefined` 留着是对的——那是它的新语义。

### 三种启动路径一并覆盖

`ensure()` 是唯一的启动入口，`start()` 是唯一的落点，所以一处改动同时修好：

- 面板「关闭浏览器」→ 再「重启浏览器」
- 会话里任意工具调用 / 面板重新订阅（`userClosed` 被清除后重开）
- 崩溃或被杀之后的下一次请求

## Testing

`test/workspace-profile.test.ts` 新增四条，都走真实的 pool → view → host 路径：

- **`a browser started again opens the profile it was told to, not a fresh temporary one`** —— 对 `session` 与 `workspace` 各跑一遍：`ensure()` → `stop()` → `ensure()`，断言两次 `profileDir` 相同且非空。
- **`a restart after a crash reopens the same profile, not a new temporary one`** —— 用 `die()` 走 `forget()` 那条路径，修的是另一半。
- **`a directory edit reaches the browser that restarts because of it`** —— 改 `userDataDir` 触发重启，断言新进程用的是新目录。
- **`a shared browser whose creator left still finds its profile when restarted`** —— 上面那条回归的守卫：创建者被 dispose 之后，幸存会话 stop/ensure 仍然打开同一个目录。

四条都**证明过有牙**：把 `ensure()` 里的解析换成 `this.start(undefined)`，四条全红（20 pass / 4 fail），恢复后全绿。

真机那一遍（坐标：`%TEMP%\dsh-browser-profiles\session-verifylogin`，`session` 模式）：用 CDP 往真实浏览器里写一个一年后过期的 cookie，经插件自己的 `POST /dsh-browser/pages` 关闭浏览器（`instances` 归零），再打开，**同一个端口、同一个目录、cookie 还在**（`found: true, value: "kept"`）。第二个会话仍然拿到自己的端口和目录（9040 / 9041），隔离没被带坏。探针 `.prove/verify-profile-persistence.mjs` 与 `.prove/cdp-cookie.mjs`，后者需要在 Node 侧跑（插件路由带 harness 的信任检查，裸 fetch 会 401）。

一次性探针 `.prove/probe-restart-profile.mjs` 打出两次启动各自的目录，是这条缺陷最小的可复现形式。

## Alternatives considered

**在 `close()` / `forget()` 里不清 `profileDir`。** 最小改动，能让"关闭再开"对，但修不了另一半：改设置页的目录或模式之后再开，字段里还是上一个进程用过的旧路径，用户会得到"我改了目录但它还写在老地方"。而且它把"上次开的目录"当成了"下次该开的目录"——两个问题仍然共用一个变量，只是这次侥幸相等。

**每个 `SessionBrowser` 自己持有一个 `profileOf()`。** 我第一版就是这么写的。它对 `session` 模式正确，但把目录变成了**调用者的**属性：共享浏览器上若两个会话的解析结果不同（改模式的那一瞬间就可能），同一个进程会在两次启动之间换目录，于是两个会话对"我的登录态在哪"给出两个答案。目录必须属于进程，这个不变量比"少一层闭包"重要。

**每次启动重新 `chooseProfile(config, sessionId, lookup)`。** 我第二版是这么写的，它引入了一个回归：`workspace` 模式的浏览器比创建它的会话活得久，创建者被 dispose 之后注册表不再把它算进任何 workspace，幸存会话的重启就抛 `not accounted to any workspace`。**unit 只能取一次、目录必须每次算**——两件事分开才对；把 unit 的解析也放进启动路径，等于假设"创建者永远还在"。

**启动时比对 `profileDir` 与当前解析结果，不一致就重启。** 等于把配置更新的检测从 `reconfigure()`（那里已有 `LAUNCH_FIELDS`）复制一份到启动路径上，两处判断迟早会不一致。`reconfigure()` 已经会在 `profileMode` / `userDataDir` 变化时关掉浏览器，启动路径只需在每次启动问一遍"现在该开哪儿"。

## Consequences

- 关掉浏览器不再丢登录态；崩溃同理。这是用户报的那件事。
- 改模式或目录后重开的浏览器，打开的是新配置说的目录（旧 profile 留在原地，不迁移、不删除——迁移是另一个决定，见下）。
- **共享浏览器在创建者离开之后仍能重启**，因为它记的是自己的 unit，不是去查注册表。没有这一半，`workspace` 模式会在第一个会话结束时坏掉。
- `temp` 模式行为不变：`profileDirForUnit()` 对它返回 `undefined`，仍走 `mkdtemp`，仍在关闭时删除。
- **同一个 workspace 目录仍只能有一个进程**：`session` 模式改目录后，旧目录里的登录态不会自动跟到新目录。这是"目录就是目录"的必然结果，不是缺陷。
- 尚未处理：**切换 `profileMode` 之后，`BrowserPool` 的进程 key 不会重算**。一次 `workspace → session` 的切换会让新进程仍然挂在旧 key 上（探针 `.prove/probe-mode-change.mjs` 实测：两个进程、`pool.size` 仍是 1、`browserId` 都还是 workspace id）。登录态这条不受影响（目录已经正确），但设置页的实例列表会聚合错行。留给下一次改动。
