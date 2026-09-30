# dsh-browser

[English](README.md) | 中文

<img src="docs/img/preview_zh.png" alt="插件在工作：左侧是 agent 的浏览器工具调用，右侧栏镜像着同一台浏览器" width="100%">

<p align="center">
  <img src="docs/img/settings_zh.png" alt="浏览器设置：每个对话一个正在运行的实例，各有自己的 CDP 端口，另含窗口模式、自动化标记与 profile 位置" width="45%">
</p>

**每个对话一台真实的本机浏览器。** agent 在里面开页面、做事，侧栏镜像同一台浏览器，你能看着它工作，也能随时自己上手。Web 界面与 Desktop 应用都能用。

## 概述

Chrome 或 Edge 以独立进程运行，有自己的 profile、自己的 CDP 端口，而且每个对话各有一台：标签、登录态、端口都不跨对话共享。agent 用九个工具驱动它，侧栏显示的是同一批页面——两边都能操作。

它不是内嵌的网页视图。页面跑在一个普通浏览器进程里，所以站点看到的是正常浏览器，镜像运行时 DevTools 或另一个 Playwright 可以附加进来，关掉 harness 也不会留下一个假装属于界面的浏览器进程。

<a id="highlights"></a>
## 特点

- **两个界面都能用。** Web 界面与 Desktop 应用跑的是同一个插件、同一台浏览器；各自装一次，之后没有任何差别，设置页也一样。
- **一个对话一台浏览器。** 标签、登录态、端口都属于一个对话：侧栏面板在它连接的 socket 上报出自己的会话，工具调用按调用来源的会话解析自己的浏览器。
- **看着它做，也可以随时接手。** 浏览器每开一个页面，侧栏就多一个带实时画面的标签，在标签里的点击与输入会到达真实页面。
- **不写选择器也能读陌生页面。** `browser_snapshot` 把页面的无障碍树打印成一行一个节点、每个节点带一个 `ref`——这既是 agent 读陌生页面的方式，也是它指名某个元素去点击的方式；`find` 把大页面收敛到回答问题的那些路径，`boxes` 不上截图就能说出元素在哪。
- **站点会接受的输入。** 在元素自身的位置派发真实鼠标与文本事件——忽略合成 `element.click()` 的页面同样接受——另含 `Ctrl+A` 这类组合键、原生下拉与勾选、由触发它的那一次调用回答的对话框，以及"会被别人接收"时的明确拒绝。
- **九个工具，其余交给代码。** `browser_evaluate` 是通用那个，其余只补代码表达不了的语义，比如不先知道选择器就能读页面、或者问页面失败时自己说了什么。见[工具](#tools)。
- **可附加。** 每台浏览器都监听一个对外 CDP 端口，`chrome://inspect`、另一个 Playwright、或随仓库的 `scripts/cdp.mjs` 都能附加到侧栏正在镜像的那一台。
- **工作纪律写在模型会读的地方。** 插件贡献一份技能——先读再动、一次观察一个状态变更动作、页面的文字是数据而不是指令——并附五篇按问题索引的短文，只有遇到那个问题才读。

## 目录

- [特点](#highlights)
- [安装](#install)
- [版本适配](#compatibility)
- [使用](#usage)
- [理解设计](#understand-the-design)
- [配置](#configuration)
- [工具](#tools)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发](#dev-note)
  - [第三方代码](#third-party-code)

-----

<a id="install"></a>
## 安装

先确认宿主 dsh 版本：

```sh
dsh -V
```

再按该版本对应的 `#<tag>` 引用安装——一份构建只针对一个 dsh 世代，而不带 ref 的 `github:` 安装会取默认分支的 HEAD，那个位置会漂：

| 你的 dsh | 插件版本 | 安装命令 |
| --- | --- | --- |
| ≥ 0.1.7-rc.1 | v0.2.3（最新） | `dsh plugin add --profile web github:CJYLZS/dsh-browser#v0.2.3` |
| 0.1.5-rc.2 | v0.1.x | `dsh plugin add --profile web github:CJYLZS/dsh-browser#v0.1.0` |

属于当前世代的 dsh，装最新版就是这条：

```sh
dsh plugin add --profile web github:CJYLZS/dsh-browser#v0.2.3
```

构建产物 `lib/` 随每个 tag 提交，所以按 tag 安装不需要构建。profile 的 `package.json` 会记下你选的 ref；换版本就用新 ref 重新 add，移除插件用 `dsh plugin remove --profile web dsh-browser`。装完都要重启 harness。机器上需要已安装 Chrome 或 Edge；`playwright-core` 是运行依赖，它自己不会下载浏览器。

### Desktop

Desktop 应用自己拥有它的 profile，而普通 CLI 有意拒绝管理 `--profile desktop`，所以走随应用一起发布的 Desktop CLI：

```sh
"<Desktop 安装目录>/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add github:CJYLZS/dsh-browser#v0.2.3
```

macOS 与 Linux 用 `<Desktop 安装目录>/resources/runtime/cli/bin/dsh`。装完重启应用，和 Web profile 用 `dsh plugin add` 之后一样；卸载用同一个 `remove`。

-----

<a id="compatibility"></a>
## 版本适配

一份构建只针对一个 dsh 世代，按你的 dsh 选配对的那个插件版本。分叉落在客户端半边——dsh 0.1.7-rc.1 换掉了设置模型且没有兼容层——所以一份构建无法同时服务两个世代。

这个分叉落在客户端半边的 import 上，因此一份构建无法同时针对两个世代，插件按世代配对：

- **v0.2.x → dsh ≥ 0.1.7-rc.1**，声明为 `peerDependencies: >=0.1.7-rc.1`，不封顶，所以同一份构建能跑在它实测过的整条 0.2.0 线上（[为什么去掉封顶](.agents/notes/implemented/process/2026-09-30-peer-range-floor-only.md)）。设置页的字段在 schema 上标为 volatile，编辑经 `loader/volatile-update` 抵达正在运行的浏览器。
- **v0.1.x → dsh 0.1.5-rc.2**，声明为 `peerDependencies: ^0.1.5-rc.2`。设置页注册 namespace scope 并自行渲染控件。

版本旧了会明确失败：只有当插件的 dsh peer 满足声明的区间时 dsh 才激活它，否则报出插件名与未满足的区间。更高的世代会被这条检查放行，所以这份构建在某一代上还跑不跑得起来，是验证的问题而不是版本号的问题。

<a id="usage"></a>
## 使用

三步，而且 agent 不需要任何额外交代：

1. **通常什么都不用做。** 第一次需要浏览器的工具调用会自己起一台，右侧栏随即自己打开到那个会话的「浏览器」标签——第一帧就看着。也可以手动打开：**新标签页 → 浏览器**。
2. **让它做事。** 「打开文档，告诉我安装那一节写了什么」就够了：工具作用于面板显示的那台浏览器，所以你能看着事情发生。
3. **需要时接上自己的工具。** 浏览器运行时 `curl http://127.0.0.1:9333/json/version` 有响应；`chrome://inspect`、用 `chromium.connectOverCDP` 的另一个 Playwright、以及 `scripts/cdp.mjs` 都能附加进去。

侧栏与浏览器始终一一对应：浏览器每开一个页面就多一个标签，关掉标签就是关掉它镜像的那个页面，最后一个也关掉时浏览器停下，直到再有东西需要浏览器。工具作用于哪一页由 agent 决定（`browser_tabs`），与你看的是哪个标签无关。其余细节见[理解设计](#understand-the-design)。

-----

<a id="understand-the-design"></a>
## 理解设计

插件用 harness 的 session id 做一切索引，这一条决定解释了它的大部分行为：

- **两条互不相干的路径解析到同一个会话。** 侧栏面板注册在会话作用域的槽位里，于是它的注册工厂拿到 session id，并在 viewer socket 上报出它；工具调用没有面板，就从执行它的 agent 取会话（`exec.agent.id`，与 API 层恢复会话用的 `SessionId` 是同一个）。两条路径都够不到别的对话的浏览器；没有会话的调用（定时任务、没有会话的子代理）会直接失败，而不是落进某个人的浏览器。
- **一个进程一个 profile。** Chrome 的 profile 目录被单个运行中的进程独占，所以配置里的 profile 目录是**父目录**：每个会话的浏览器在其中各有自己的子目录，子目录名用 harness 自己的会话 id 转义规则生成。由此而来的结果值得直说，因为它是隔离的代价：**登录态不跨会话共享。** 在一个对话里登录的站点，在另一个对话里是未登录状态。会话在重新打开时保持自己的身份，所以一个对话会回到它自己的 profile。
- **端口是分配出来的，不是假设的。** 配置给的是一段**端口范围**（`debugPortMin`–`debugPortMax`），因为一个数字不可能是地址：每个会话各有一个浏览器、各自一个监听端口。每台浏览器在范围里取它能绑定的最小端口并持有到退出——因为探测给出的答案在给出的那一刻就已经过期。范围的上界是防止探测跑进这台机器上别的服务里：范围里没有空端口时它会直接报错，并把范围写进消息。`GET /dsh-browser/status` 报告每个会话最终落在哪个端口；任何地方都不应该假设它是配置里的某个值。
- **镜像属于 CDP 会话，不属于面板。** `Page.startScreencast` 挂在某一个 CDP 会话上，而每一条"起一台浏览器"的路径——面板重启、崩溃恢复、改启动项——都会换掉那个会话。因此新起的浏览器一就绪，只要还有人在看就重新挂流；否则一次重启之后仍开着的面板会永远停在最后一帧，而它的状态行却一直在更新。
- **浏览器死了会被换掉，而不是干等。** 关窗口或进程消失会把实例置为 `closed` 并带上原因、发布给面板，下一次请求就会起一台新的。没有任何情况需要手工修，包括浏览器进程恰好在两次工具调用之间死掉。
- **快照是与模型之间的约定。** `Accessibility.getFullAXTree` 被打印成一行一个节点，被 Chrome 标记忽略的包装节点被丢掉，每个背后有 DOM 节点的行都带一个 `ref`。ref 只属于某一页的某一次快照：导航会让它们全部失效，而过期的 ref 会报错并指向 `browser_snapshot`，绝不会点到那个位置上现在的东西。
- **ref 或定位：定位命中多个就拒绝，不猜。** ref 是某一次快照就某一份文档给出的答案——查起来便宜，但会过期。定位（`role` 配 `name`、`text`、`selector`）是这个答案背后的那个问题，在动作执行时才再问一遍，所以重渲染和导航都拦不住它。命中多个元素时**拒绝**而不是挑一个，而且拒绝里会列出每个候选项与它最近的具名祖先——那是区分两个同名控件的唯一事实。匹配读的是无障碍树，所以定位能匹配到的，恰好就是快照会打印出来的；`selector` 由页面自己走查，因此进得去开着的影子根与同源帧——那是从文档根查起看不见的地方，`target` 与 `snapshotIgnore` 用的是同一次走查。
- **点击是算出来的，不是猜的。** 一次点击把 ref 解析成 backend node id，把元素滚进视口，读它的 content quad，再把页面坐标换算成 CDP 派发输入所用的视口坐标；然后发出移动、按下、抬起三个事件——这正是它可信的原因。
- **一个页面有自己的标签。** 侧栏里浏览器每开一个页面就有一个标签，用页面的 CDP target id 作地址，所以两个同址页面是两个标签，客户端重载后每个标签也还能接回它原来在看的页面。一个面板的画面、输入与地址栏都属于它自己的页面——无论工具此刻作用于哪一页；浏览器关掉一个页面，它的标签跟着走，关掉一个标签就是关掉那个页面。**入口的每一页都来自一次点击**：引导页入口开出的那个没有页面的标签，挂载时会向 host 要一个页面（幂等键是这条标签记录自己的 id，所以切走再切回、刷新客户端都不会多开），host 对已经跑起来的浏览器开新页、对没跑起来的浏览器用它启动时的页面作答；工具作用的那一页则由 `browser_tabs` 的 `open`/`select` 决定，与面板在看哪一页无关。
- **插件自己的路由自带信任检查。** viewer socket、状态路由与页面路由（开页与关页）由本插件提供，而 webserver 的路由路径本身不做任何认证，所以每一条都在应答之前先走 Connection 的拒绝逻辑（`isTrustedApiRequest` 与浏览器认证）。未认证的请求会得到 401。
- **设置是用户覆盖，不是状态。** 设置页写入 harness 的 settings 文档，`cordis.yml` 里的条目始终是它下面的基础层；清空某项即删除覆盖。每个字段都改变浏览器的启动或编码方式，所以一次写入会重启正在运行的浏览器，面板会自行重连。

-----

<a id="configuration"></a>
## 配置

设置页（设置 → 浏览器）编辑下表字段，并报告**真正在跑的东西**——这与"配置成什么"不是一回事：横幅列出每个会话的浏览器，以及它实际持有的端口、窗口模式与页面数。没有设置服务的部署什么都不注册，组合配置就是全部配置。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `channel` | `chrome` | 驱动哪个已安装的浏览器：`chrome` 或 `msedge`。 |
| `executablePath` | 空 | 显式指定浏览器可执行文件，用于 channel 查找不到的安装；设置后覆盖 `channel`。 |
| `headless` | `true` | 无窗口运行。无头没有可被遮挡或最小化的东西，是推荐值。 |
| `stealth` | `true` | 去掉 Playwright 启动的浏览器所带的两个标记：`navigator.webdriver`，以及无头时写成 `HeadlessChrome/…` 的 UA。 |
| `userDataDir` | 空 | 每会话 profile 的父目录；留空则每台浏览器一个临时 profile，退出时删除。 |
| `debugPortMin` / `debugPortMax` | `9333` / `9400` | 每会话 CDP 端口的分配范围；每台浏览器取其中最小的空闲端口。改动只影响**之后**启动的浏览器，正在跑的浏览器保留它已经持有的端口。 |
| `viewportWidth` / `viewportHeight` | `1440` / `900` | 无头模式下的页面尺寸——无头没有真实窗口可取值。 |
| `quality` | `70` | 镜像帧的 JPEG 质量。 |
| `maxWidth` / `maxHeight` | `1600` / `1200` | 镜像帧的最大边长（设备像素）。 |
| `everyNthFrame` | `1` | 每 N 帧镜像一帧。 |
| `snapshotNodes` | `300` | 一次 `browser_snapshot` 最多打印多少个无障碍树节点，超出会被截断并注明。 |
| `maxInstances` | `4` | 同时允许多少个会话浏览器；到顶时请求报错，而不是驱逐正在被人看的浏览器。 |
| `startupUrl` | `about:blank` | 浏览器启动后首先打开的地址。 |
| `extraArgs` | `[]` | 追加的浏览器启动参数，接在插件自己的参数之后。 |

`stealth` 默认开启，因为这是**测出来的**而不是假设的：带标记时 Google 连续三次搜索全部被拦，去掉后三次全部返回结果——包括用同样方式启动的真实 Edge 窗口，正是它说明决定因素是标记而不是浏览器。这个开关存在，是为了让那次对照可以复现。当真需要标记之外的手段时，`executablePath` 接受用户自备的任意 Chromium 二进制（含加固过的构建）；本插件不打包也不下载任何第三方二进制。

-----

<a id="tools"></a>
## 工具

| 工具 | 作用 |
| --- | --- |
| `browser_navigate` | 打开地址；返回最终 URL、标题与标签列表。 |
| `browser_snapshot` | 把页面读成角色、名称与 ref（`- button "Sign in" [ref=e2]`）；同样返回标签列表。`find` 只回匹配一段文本或 `/正则/` 的节点与到它的路径；`boxes` 给每个元素附上视口坐标；`target` 与 `depth` 取一棵子树到某一层。 |
| `browser_click` | 点击快照 ref 指名的元素，或点击调用那一刻才用 `role` + `name`、`text`、`selector` 找到的那个，在它自己的位置派发真实鼠标事件。`button` 选右键或中键，`double` 派发页面读作一次双击的那两组按下抬起；页面说这次点击会被别的元素收下时**默认拒绝**，加 `force` 才照发并回报是谁收下的。原生 `<select>` 与勾选框是**按不动的**——弹层属于浏览器进程、option 没有盒子可点，而勾选框被切换时不写任何 attribute——所以 `select: ["Two"]` 按 option 的 value 或可见 label 选中，`checked: true|false` 设置状态；两者都派发页面自己的 `input`/`change`、回报 `selected`/`checked`，且**不派鼠标事件**。 |
| `browser_type` | 向 ref 指名的元素输入，或向调用那一刻用 `role` + `name`、`text`、`selector` 找到的那个输入（默认替换原内容），之后可按一个 `key`——`Control+A`、`Shift+Tab` 这样的组合键同样可以。**要插入的字符是 `value`**；`text` 和 `browser_click` 上一样，是用来指名元素的（对应 Playwright 的 `getByText`），所以 `{ text: "Search", value: "univer" }` 就是"找到搜索框并输入 univer"。**不给元素**时 `value` 与 `key` 都发给页面当前焦点、什么都不替换，这也是"Escape 关掉菜单"的写法。它还会回报 `focused`——焦点最后落在哪个元素上，这是看清一次裸 `Tab` 把焦点送到哪里的唯一办法。 |
| `browser_wait` | 等到页面到达某个状态，然后说明到没到：`text`、`role` + `name`、`selector`、`url`，或 `time`（固定等待，最后手段）——**恰好一个**，`timeoutMs` 最大 30 s。条件没成立**不是错误**：结果里带 `matched: false`、等了多久、页面现在在哪、以及这段时间页面改了什么。它等的是**已经打开的那一页**，不会自己起浏览器。 |
| `browser_console` | 读页面与浏览器从当前地址加载以来"自己说过的话"：console 输出、未捕获异常、以及浏览器日志条目（请求失败、资源被拦）。可选 `levels`、`filter`、`limit`。**不留 DOM 痕迹的失败只能在这里看见**，而且它是整段历史、不只是最近一次调用——导航即清空。 |
| `browser_screenshot` | 截图为 JPEG 文件并返回路径：默认视口，`fullPage: true` 整篇文档，或按动作工具同一套写法指定一个元素。`inline: true` 会把图片一并附在结果里（需要声明 image 输入的模型；不支持时会拒绝，而文件依然可要）。 |
| `browser_evaluate` | 在页面里求值 JavaScript 表达式：取值、滚动、`history.back()`，以及任何用参数列表表达会更糟的事。返回 promise 会被 await，返回函数会被调用，顶层 `await` 与 `return` 都能用；字符串原样返回，其余按 JSON 打印，大到印不下的结果会写进文件并把路径带回来。 |
| `browser_tabs` | 看这台浏览器的页面并改它们：`list` 列出每个页面（id、地址，以及**工具现在作用于哪一页**，和侧栏的标签是同一份列表）；`open` 要一个新页面并切到它；`select` 把工具作用页换成已经打开的另一页；`close` 关掉一页，关掉最后一页就停下浏览器。它**不会自己切页**：面板显示哪一页与工具作用于哪一页是两件事，用户在侧栏点标签不会改后者。 |

**动作回报里还写着一份紧凑的变更清单。** `changed` 只说页面动过（`dom`），而"动过"分不出"点开了它指名的东西"和"只是重画了一个转圈"。所以动作返回时还会带上页面**头几条**具体变化，每一条只写页面自己说得出的事实（标签、它声明的 `role`、一小段它说的话）：`dom: +1 status "先在实例表里点一行"; ~ p "24.1k" → "24.2k"; ~ button "启动并连接" disabled: (none) → "true"`。条数封顶（5 条），没写进去的**计数**而不是丢掉；每种变化都是结构化字段（`kind`/`tag`/`role`/`preview`/`attribute`/`from`/`to`），PTC 下的程序可以直接分支。这份清单是**页面自己**的描述，用来说明去哪里看；元素的无障碍 role 与名字仍以 `browser_snapshot` 为准。

**对话框由打开它的那次调用回答。** `confirm`、`prompt`、`alert` 会阻塞页面直到有人回答，所以不存在"后来的调用去回答"的时刻：在触发它的那次调用上带 `dialog: "accept"`（prompt 另带 `dialogText`），否则默认的拒绝（dismiss）会写进结果。每个对话框都在调用返回前被回答，而且没有一个是无声的：结果写明页面问的是什么、被怎么回答，`changed` 里出现 `dialog`——于是"页面没有变化"永远不会成为"站点停下来等你确认"那一次点击的回报。

工具集刻意小，因为 `browser_evaluate` 就在那里：一个工具只有做到代码做不到的事才配得上自己的位置，而这里"做不到"指的是可信输入、不先知道选择器就能读页面，以及两个**不能事后补问**的问题——页面到没到某个状态（`browser_wait`），和它失败时自己说了什么（`browser_console`，它的监听必须在页面自己的脚本跑起来之前就装上）。这三条是"新能力做成参数、不加工具名"这条规则的**有意破例**（第三条是 `browser_tabs`：页面不是当前页的属性，页内 JS 也看不到别的 target）；截图的几种形状则是规则本身：`fullPage`、元素目标、`inline` 都做成已有工具上的参数。下拉与勾选也是同一个形状——`select` 与 `checked` 是 `browser_click` 上的参数，因为一次按下做不到这两件事。刻意没有的是 `back`/`forward`/`reload`（面板上有刷新，历史就是一句表达式）、悬停、拖拽、上传、下载——每一个都等到真有场景需要时再加，而不是先加上等场景。

截图总要写一个文件并把路径带回来（这样它在会话日志里是持久的）；`inline: true` 额外把图片本身附在结果上，省掉第二次调用。附件引用由 harness 的附件服务签发（插件以**结构化声明**的方式使用该服务，不依赖它的包）；而调用方模型若没有声明 image 输入，**在截图之前**就会被拒绝——图片块是工具结果的一部分，给读不了图的模型附上它，会失败那一次请求以及之后的每一次请求。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **只在 Windows 上验证过。** macOS 与 Linux 一次没跑过：`channel` 的查找、临时目录、进程回收是最可能出差异的部分。
- **面板显示它自己的页面，浏览器自己开/关的页面只有插件被告知时才被跟随。** 插件得知的页面（工具调用、被驱动页面的 `window.open`）各有自己的标签与镜像；带窗口的浏览器用它自己的标签条切页时，各个镜像都停在原地，因为插件并不知情。
- **侧栏里走 IME 的中文输入不工作。** 组合输入期间 `event.key` 是 `Process` 而不是字符，没有可转发的东西。非组合状态下，面板把可打印字符按文本发送、命名键按按键事件发送、带 Ctrl/Alt/Meta（或 Shift）的按键按它本来的组合键发送——所以 `Ctrl+A` 是选中页面而不是往页面里插一个 "a"；AltGr 组合仍按文本发送，因为它在 Windows 上就是 Ctrl+Alt。粘贴与直接键入 ASCII 不受影响；agent 的 `browser_type` 也不受影响，它插入文本而不是重放按键。
- **剪贴板快捷键由面板自己处理。** `Ctrl/Cmd+C`、`Ctrl/Cmd+X`、`Ctrl/Cmd+V` 在面板里可用：复制/剪切把**镜像页里的选区**写进你的系统剪贴板，粘贴把你的剪贴板文本发给镜像页（`Input.insertText`，不重放按键）。镜像页自己收不到这些按键——Chromium 把剪贴板快捷键放在浏览器进程，注入的按键事件到不了那里（实测页面连 `keydown` 都没有）——所以走的是面板这一侧，那里的按键是可信事件。只搬纯文本；页面里 JS 调 `navigator.clipboard.writeText`（站点自己的"复制"按钮）写的仍是浏览器进程内部那个剪贴板，headless 下不会到系统剪贴板。
- **对话框在问题被读到之前就要回答。** 页面会阻塞到对话框被回答为止，所以答案必须由打开它的那次调用声明；没声明的那次调用会拒绝（dismiss）它并如实上报。常见形状是两次调用：第一次告诉你页面问了什么，第二次换成另一种回答。
- **只在页面重绘时出帧。** `Page.startScreencast` 是重绘驱动的，完全静止的页面几乎不出帧，面板保留最后一帧。这不是卡住。
- **最小化时不可交互。** 无头模式不受影响，但被最小化的带窗口浏览器会同时停掉画面与输入。
- **`maxInstances` 在面板上没有对应动作。** 到顶时工具调用会失败、新面板会被拒绝，错误信息里点名了这个上限，但面板没有提供释放一个槽位的操作；唯一办法是在某个面板里关掉浏览器，或者让那个会话被销毁。
- **工具作用页不会跟着面板走。** 在侧栏里点另一个浏览器标签只换你在看的那一页，不会换工具作用的页面——这是有意的（面板给眼睛、工具给 agent），要换就用 `browser_tabs` 的 `select`。
- **浏览器正在启动的那一瞬间连点两次入口只会得到一页。** 启动中的两次请求会 join 同一次启动，而一次启动只有一页初始页面；等它起来之后再点，每点一次就多一页。
- **没有 profile 选择器。** 会话的 profile 由它的 id 推导，因此无法让这个对话指向一个已有的 Chrome profile，也没有可供选择的 profile 列表。
- **不处理下载、上传、文件选择器与权限弹窗。** 这些发生在浏览器进程里，既没有呈现在面板上，也无法通过面板应答。
- **不做请求拦截与网络检查。** 这个插件驱动浏览器，它不是代理；要做这类事请用附加的 CDP 端口。
- **没有会话的调用会被拒绝。** 定时任务或没有自己会话的子代理会按设计失败；把它的调用算到别的对话的浏览器上，比失败更糟。
- **console 历史按页保存且有上限。** `browser_console` 保留当前文档最近 200 条（丢了多少会报出来），导航即清空：一条消息属于产生它的那份文档，和 ref 同一个道理。每条消息截到 500 字符，对象参数按协议自带的 preview 渲染——够看到 `{code: 500}`，不是深挖。
- **截图可以变成图片内容块**：当组合挂载了附件服务、且调用方模型声明了 image 输入时（`inline: true`）；否则文件路径就是答案，而在读不了图的模型上要 `inline` 会被**明确拒绝并说明原因**，不会静默忽略。
- **没有发布到 npm。** 从 GitHub 或本地检出安装——见[安装](#install)。

-----

<a id="dev-note"></a>
## 开发

插件目录是自包含的 pnpm workspace（`packages: [- .]`、`storeDir: .pnpm-store`），因此 pnpm 够不到 harness 仓库的 workspace。dsh 框架包声明为 `peerDependencies`（`>=0.1.7-rc.1`，由 host profile 提供），并在 `devDependencies` 里精确钉住，供本地类型与构建使用。

想跑本地检出而不是 tag，就把它链接进 profile——之后 `pnpm run build` 的产物在下次重启 harness 时生效，不必重新 add：

```sh
cd dsh-browser
pnpm install          # 自包含 workspace；store 在 .pnpm-store/
pnpm run build        # 产出 lib/index.js（host）与 lib/client.js（浏览器端）
dsh plugin add --profile web link:/absolute/path/to/dsh-browser
```

命令：`pnpm run build`（tsdown，两半都产出）、`pnpm run typecheck`、`pnpm test`，以及 `scripts/` 下的实测脚本（`prove.mjs` 验证 CDP 端口、screencast、输入派发与截图；`modes.mjs` 对照无头/带窗口/最小化；`cdp.mjs` 通过对外端口读写一台运行中的浏览器，用 `--port=` 指定某个会话的）。

`pnpm test` 跑在 Node 自己的 TypeScript 支持上（`node --test "test/**/*.test.ts"`），不依赖任何 loader——这同时是对源码的一条约束：enum、参数属性这类不可擦除语法跑不起来。涉及浏览器的行为用记录型启动器测试（`test/support/browser.ts` 发放假页面与假 CDP 会话），所以整个套件不需要 Chrome。而假件证明不了的部分——真实无障碍树的形状、真实点击的坐标空间、真实点击是否可信——都在真机上验证过一次，记在 [`.agents/notes/`](.agents/notes/README.md) 的决策笔记里。

构建产物 `lib/` 是提交进仓库的：改完源码必须重新构建并一起提交，否则从 GitHub 装的人拿到的是旧代码。

<a id="third-party-code"></a>
### 第三方代码

没有打包任何第三方代码。`lib/index.js` 以运行时依赖的形式 import `playwright-core`（Apache-2.0）与 `ws`（MIT），`lib/client.js` 只需要宿主 shell 的平台模块——因此上游的安全更新通过用户自己的安装到达用户，而不是通过本仓库转发。插件也不附带浏览器：它通过 `playwright-core` 的 `channel` 查找驱动机器上已有的 Chrome 或 Edge，所以"捆绑浏览器"那种约 200MB 的下载不属于安装的一部分。
