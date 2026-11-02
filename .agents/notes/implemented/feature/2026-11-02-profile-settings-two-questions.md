# Agent Note: profile 设置：一个模式回答"留不留"，一个目录只回答"放哪儿"

Status: implemented

## Problem

设置页的 profile 部分有三行，实际只有两个字段：

| 行 | 字段 |
|---|---|
| Profile sharing | `profileMode` |
| Profile（临时 / 长期目录） | `userDataDir` |
| Profiles 目录（路径输入框） | `userDataDir` |

`userDataDir` 被渲染了两次：一次是一个"临时 / 长期目录"下拉，一次是路径输入框。于是**一个字段被问了两个问题**，而其中一个它答不了。这个重复不是设计，是留级：`8e55365`（v0.1.0）只有"目录空 = 临时、非空 = 每会话一个"这条判定；`04b1617` 加了 `profileMode` 放在上面，却没撤掉旧的那条。

重复下面压着三个真实缺陷，都是"页面说一套、浏览器做另一套"：

1. **默认状态下页面在说谎。** 默认 `profileMode: 'session'`、`userDataDir: ''`，页面据此显示「长期目录」，而 `chooseProfile` 在目录为空时返回 `dir: undefined`，浏览器走 `mkdtemp`——关闭即删。用户看到"长期"，得到"临时"。
2. **「临时」不生效。** `profileMode: 'temp'` 只写模式；`chooseProfile` 在目录非空时**根本不看** `temp`，照样解析出 `<目录>/<session>` 并保留。而选「临时」会把目录行藏起来（`persistentChoice=false`），于是用户在看不见的地方得到了一个持久 profile。
3. **相对路径静默指错地方。** `userDataDir` 是裸 `z.string()`，没有绝对性校验。填 `profiles` 时它按**宿主进程的 CWD** 解释：Web 是启动 `dsh` 的目录，Desktop 是应用目录。同一个值在两个部署下落到不同位置，而页面什么都不说。

## Decision

### 两个字段，两个问题

`profileMode` 独占"谁共享、留不留"；`userDataDir` 只回答"放哪儿"，并且**空是一个合法的答案**（= 这个模式的默认位置）。目录行不再是持久化开关：

| 模式 | 目录为空 | 目录填了 | 谁共享 | 留不留 |
|---|---|---|---|---|
| `temp` | `mkdtemp` | **被无视** | 无人 | 否 |
| `session` | `<临时目录>/dsh-browser-profiles/<session>` | `<目录>/<session>` | 本对话 | 是 |
| `workspace` | `<项目>/.dsh/browser/workspace-<id>` | `<目录>/workspace-<id>` | 整个工作区 | 是 |

`temp` 无视目录是这张表的要害：一个说"什么都不保留"的模式，不该因为字段里残留一个路径就往磁盘上写 profile。

### 默认值改成 `temp`

原先的默认（`session` + 空目录）实际行为就是"关闭即删"，但因为模式叫 `session`，页面无法正确描述它——这是缺陷 1 的根。两条路：把默认模式改成 `temp`（行为零变化，名实相符），或让 `session` + 空目录派生出一个保留的默认目录（名实相符，但默认行为变了，且开始为所有人写 profile）。

取前者。默认值不是新功能的入口：谁想要登录态延续，就在设置页上选——那是模式存在的意义。

### 目录必须是绝对路径，但**不能**由 schema 拒绝

第一版把校验写成 `z.transform(...)`，理由是"错误出现在用户敲下那个值的地方"。**这个做法把整个设置节弄挂了**，而原因值得单独记下来：

配置 schema 要跨线。设置外壳在浏览器里用 `new Schema(JSON.parse(JSON.stringify(Config)))` 把 schema **重建**出来，而 `transform` 的序列化形式是 `{type:'transform', inner, callback}`——`callback` 只是一个**函数源码字符串**，重建时被重新求值。于是：

- 回调里引用模块级的 `ABSOLUTE_DIRECTORY` → `ABSOLUTE_DIRECTORY is not defined`，整节渲染失败。
- 改成自包含的字面量正则后能过，但这是**靠运气**的形状，不该用。

真正的症状是：`运行中` 的浏览器设置节永远停在「正在载入设置…」，而「通用设置」等其它节完全正常——因为重建失败只影响这一个 namespace。

结论：**`transform` 不能用在要跨线的配置 schema 上。** 绝对路径校验改到宿主侧、真正使用目录的地方（`profile-choice.ts` 的 `requireAbsoluteDirectory()`），坏值在那里让启动失败并给出原因。schema 保持 `z.string().default('').volatile()`。

代价说清楚：错误从"敲下值时"推迟到"浏览器启动时"。这是可接受的交换——页面能打开比错误更早出现重要得多，而且一台起不来的浏览器会把它写进日志与面板。

**`.default('')` 必须写在原 `transform()` 外面**（这条在改回纯 string 后自然消失，但教训留下）：transform 不携带内层 schema 的 default，写在里面会让所有没设过该字段的部署解析出 `undefined`（实测：`transform(string.default(''))` 的 `.get()` 是 `undefined`，`transform(string).default('')` 是 `''`）。

### 默认目录落在临时目录下

`DEFAULT_PROFILE_BASE = <tmpdir>/dsh-browser-profiles`。本插件是外部插件，不解析 `$DSH_HOME`，而临时目录是每个部署都有、且本来就是浏览器工作区的位置。想要持久位置就显式填一个绝对目录。

代价说清楚：**`session` 模式在临时目录下的 profile 会被系统的临时目录清理带走**，而插件自己不删它们（只有 `temp` 的 `mkdtemp` 由 `removeTemporaryProfile()` 删）。这一条写在这里而不是留在代码注释里，因为它是这个默认值的真实代价。

## Testing

单测 547 条全绿（改前 534），其中与本决定直接相关的新增：

- `a relative profile directory is refused where it is used, not where it is edited` —— 三种相对写法被拒、五种绝对写法放行，且拒绝发生在 `chooseProfile()` 而不是 schema。
- `a profile directory is carried as a plain string, so the settings page can edit it` —— 钉住 schema 里**不许**再出现 transform 类校验：`userDataDir.type` 必须是 `string`。
- `the schema survives the settings shell's round trip` —— 把 `Config.toJSON()` 用 `new Schema(...)` 重建，断言 13 个 volatile 字段一个不少。这条是那次"设置节永远加载中"的回归守卫：它在 transform 版本上会红。
- `the default profile mode keeps nothing, which is what the plugin always did`。
- `the temp mode keeps nothing even when a directory is configured` —— 缺陷 2 的回归：带目录的 temp 必须解析出 `dir: undefined`。
- `the session mode keeps its profiles, under the default directory when none is named` —— 缺陷 1 的反面：`session` 不许再悄悄变成临时。
- `the default profile base is the one the page tells the user about` —— 占位符与解析器必须指同一个位置，否则页面承诺一个浏览器永远不会打开的目录。
- `a configured directory is the parent in session mode too, not the directory itself` —— 两对话指同一目录会让第二个启动被 Chrome 交接掉。
- `the directory row exists exactly where a directory can matter` / `the directory row explains itself differently in each mode that keeps` / `the profile section asks two different questions` —— 页面结构的形状，以及旧键 `settingsProfileTemp`/`settingsProfilePersistent` 确实不存在了。
- `a page too busy to answer a timer is not called a document without script` / `a busy page is asked again rather than remembered as frozen` —— 顺带修掉的冻结文档误判（见下面 Consequences）。

`test/pool.test.ts` 与 `test/support.test.ts` 里两个原本依赖默认模式的用例改成显式写 `profileMode: 'session'`：它们测的是 session 模式对目录的处理，不该靠默认值取到它。

真机（隔离 `DSH_HOME`、profile `webtest`、`:9061`）：设置 → 浏览器 三行只剩下「窗口模式 / 浏览器 / 登录态」，「Profile 目录」在 `temp` 下不渲染；切到「本对话」出现且提示是"每对话一个子目录"；切到「整个工作区」提示变成"留空则放在项目自己的 .dsh\browser 下"，占位符同步；切回「临时」行再次消失。

## Alternatives considered

- **保留两个下拉。** 不动 UI，只修上面三个缺陷。这样页面仍然把同一个字段问两次，而"临时 / 长期目录"这个下拉在 `workspace` 模式下尤其没有意义（那里的空值意思是"跟项目走"，不是"临时"）。
- **删掉目录字段。** 每个模式只用自己的默认位置。最简洁，但拿掉了唯一能把 profile 放到别处（另一个盘、一个备份目录）的手段，而 `workspace` 模式"跟着项目走"与"放到统一目录"是两个都真实存在的需求。
- **把 `temp` 的空目录回退保留。** 即 `session` + 空 = 临时（旧行为）。这就是缺陷 1，名实不符的根源。

## Consequences

- 目录行在 `temp` 模式下**不渲染**，因此那一个字段在页面上可能出现也可能不出现；`FIELD_PLACEMENTS` 不变（它仍是常显层的字段），显隐规则在 `profileDirVisible()` 里，可测。
- 提示文案按模式分叉（`settingsProfileDirHintSession` / `settingsProfileDirHintWorkspace`），因为"每对话一个子目录"在 `workspace` 模式下恰好是错的。
- `settingsIntro` 与 `settingsDebugPortHint` 里"每个对话各有一个浏览器"在 `workspace` 模式下不成立，一并改掉。
- 相对路径现在**一启动就失败**（在 `chooseProfile` 里，不是加载时）。这是有意的收紧，但意味着任何现存配置里写相对路径的部署会在下次开浏览器时失败，错误信息里点名了原因与改法。错误从"设置页写入时"推迟到"浏览器启动时"，是放弃 schema 层校验换回设置页可用的代价。
- **顺带修掉一个冻结文档的误判。** 真机第一次访问一个刚起好的 GUI 时，它被报成 `staticDocument: true`——而那页有 12 个脚本且已 `complete`。原因是 `scriptVerdict()` 只看"定时器有没有在 250 ms 内答复"，而一个正在启动的主线程看起来与一个被 CSP 冻结的文档完全一样。现在改成两级判据：定时器没答就再问一次**同步求值**（冻结文档 0–1 ms 就答，忙页面两者都不答），只有"定时器没答 + 同步求值答了"才是冻结，且**只有那时才缓存**——忙页面下一次会重新问。两条测试钉住它，去掉这道二次判断两条都会红。
