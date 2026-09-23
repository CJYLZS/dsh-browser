# dsh-browser

[English](README.md) | 中文

在 DSH 右侧栏里镜像一台**真实的本机浏览器**：agent 用工具驱动它，你直接看它、也能直接操作它，同时 DevTools 或另一个 Playwright 可以通过它自己的 CDP 端口附加进去。

与 `ui-sidebar-browser`（那个把网页嵌在界面里的内嵌浏览器）不同，这个插件启动的是一个**独立浏览器进程**：有自己的 profile、自己的登录态、自己的 CDP 端口。两者互不干扰，可以并存。

## 概述

每个对话各有一台浏览器。在右侧栏打开「浏览器」标签，这个会话的 Chrome（或 Edge）进程就启动了；agent 的浏览器工具驱动的是同一个进程，而另一个对话看到的是另一台——不同的页面、不同的 cookie、不同的端口。会话之间什么都不共享，这正是设计的目的。

<a id="highlights"></a>
## 特点

- **一个对话一台浏览器。** 两条路径都做了隔离：侧栏标签在 socket 上报出自己的会话，工具则按调用来源的会话解析浏览器。两个对话永远看不到对方的页面与标签。
- **是真浏览器，不是嵌入的页面。** 独立的 Chrome/Edge 进程、真实的 profile，站点看到的就是真实浏览器；侧栏通过 CDP 镜像画面展示它。
- **双向。** 侧栏里的点击、滚轮、输入会转发到真实页面；agent 的 `browser_click` / `browser_type` 派发的是可信的鼠标与文本事件，忽略合成 `element.click()` 的站点同样接受。
- **可附加。** 同一台浏览器开放外部 CDP 端口，侧栏镜像的同时，`chrome://inspect`、另一个 Playwright 或 `scripts/cdp.mjs` 都能附加进去。
- **工具少而精，以代码为主。** 6 个而不是 40 个：`browser_evaluate` 是主力，其余只补代码做不好的事——不写选择器就能读页面，以及可信输入。

## 目录

- [特点](#highlights)
- [安装](#install)
- [使用](#usage)
- [理解设计](#design)
- [配置](#configuration)
- [工具](#tools)
- [已知限制](#limits)
- [开发](#dev)

-----

<a id="install"></a>
## 安装

从 GitHub 装（推荐）——构建产物 `lib/` 随仓库提交，所以一条命令即可，不需要构建：

```sh
dsh plugin add --profile web github:CJYLZS/dsh-browser
```

开发时改为链接本地检出：

```sh
cd dsh-browser
pnpm install          # 自包含 workspace；store 在 .pnpm-store/
pnpm run build        # 产出 lib/index.js（host）与 lib/client.js（浏览器端）
dsh plugin add --profile web link:/absolute/path/to/dsh-browser
```

`link:` 安装把 profile 指向检出目录，之后 `pnpm run build` 的产物在下次重启 harness 时生效，不必重新 add。

安装后重启 harness。

<a id="usage"></a>
## 使用

**看它、操作它。** 右侧栏点「新标签页」→「浏览器」。打开标签即启动该会话的浏览器，画面出现在里侧；地址栏回车即导航，在画面上点击、滚动、键入都会转发到真实页面。底部状态行显示这个会话的浏览器最终落在哪个 CDP 端口。

**让 agent 用它。** 浏览器工具在每个对话里都可用。让它"打开 example.com 并告诉我标题"，干活的正是侧栏显示的那台浏览器。

**用外部工具附加。**

```sh
curl http://127.0.0.1:9333/json/version     # 这个端口是否在监听
```

DevTools 里用 `chrome://inspect` 的 "Configure…" 添加 `127.0.0.1:9333`，或 `chromium.connectOverCDP('http://127.0.0.1:9333')`。`scripts/cdp.mjs` 是最小客户端（`list` / `inject` / `read` / `point` / `eval` / `goto`，用 `--port=` 指定某个会话的浏览器）。

<a id="design"></a>
## 理解设计

**浏览器属于对话。** 插件用 harness 的 session id 做一切索引：侧栏标签在 WebSocket 上报出会话，拿到该会话的浏览器；工具调用则按调用来源的会话解析。一个对话开三个标签仍然只有一台浏览器，其他对话看不到它。

**侧栏标签是观察窗，不是资源。** 关掉它只是该 viewer 退订，浏览器继续运行——重新打开还在。要停止浏览器，用面板状态行上的「关闭浏览器」。浏览器在工具调用之间保持存活是刻意的：这才让一个对话像是在"有一个浏览器"，而不是一连串页面加载。

**一个进程一个 profile。** Chrome 的 profile 目录被单个运行中的进程独占，所以每个会话的浏览器在配置的 profiles 目录下各有自己的子目录。由此带来的结果是刻意的，值得直说：**登录态不跨会话共享。** 在一个对话里登录的站点，在另一个对话里是未登录状态。

**端口是分配出来的，不是假设的。** `debugPort` 只是第一个候选；每个会话的浏览器向上探一个空闲端口并持有到关闭。想知道哪个会话在哪个端口，读 `/dsh-browser/status`，不要假设就是配置里的那个数。

**浏览器死了会被换掉，而不是干等。** 你关掉窗口或进程崩溃后，实例进入 `closed` 并带上原因，面板显示原因并提供「重启浏览器」，下一次工具调用也会自行起一台新的。

**画面随重绘更新。** `Page.startScreencast` 是重绘驱动的，完全静止的页面几乎不出帧；侧栏保留最后一帧，这不是卡住。

<a id="configuration"></a>
## 配置

**设置页**：设置 → 「浏览器」，可视化改动窗口模式、自动化标记、profile、浏览器选择、页面尺寸、画质与 CDP 端口。顶部横幅读的是插件自己的 `GET /dsh-browser/status` 路由（设置页不属于任何会话，所以列出每个会话的浏览器），报告的是**真正在跑的实例**而不是当前配置——否则分不清"已保存"和"已生效"。

设置页写入的是 harness 的 settings 文档（`~/.dsh/settings.yaml` 的 `dsh-browser` 命名空间），只记录**用户覆盖**：清空某项即回落到下面的组合配置，被覆盖的字段会显示「重置」按钮。

`cordis.yml` 里的 `config` 是**基础层**，设置页的改动叠加在其上：

| 字段 | 默认 | 说明 |
|---|---|---|
| `channel` | `chrome` | 驱动哪个已安装的浏览器（`chrome` / `msedge`） |
| `executablePath` | 空 | 指定浏览器可执行文件；设置后忽略 `channel` |
| `headless` | `true` | 无头模式。无窗口就没有遮挡与最小化问题，是推荐值 |
| `stealth` | `true` | 关掉 Playwright 启动时带的两个自动化标记：加 `--disable-blink-features=AutomationControlled`（`navigator.webdriver` 变 false），并把无头 UA 里的 `Headless` 去掉。实测带标记时 Google 连续三次搜索全部被拦、关掉后三次全部通过；需要复现对照时可设 false |
| `userDataDir` | 空 | 每会话 profile 的**父目录**；留空则每台浏览器用一次性的临时 profile |
| `debugPort` | `9333` | CDP 端口的起点；每台浏览器从这里向上探 |
| `viewportWidth` / `viewportHeight` | `1440` / `900` | **无头模式下的页面尺寸。** 无头没有真实窗口可取值，虚拟窗口远小于页面预期（实测 764×485，页面被裁切） |
| `quality` | `70` | 镜像帧的 JPEG 质量 |
| `maxWidth` / `maxHeight` | `1600` / `1200` | 镜像帧的最大边长 |
| `everyNthFrame` | `1` | 每 N 帧镜像一帧 |
| `snapshotNodes` | `300` | 一次 `browser_snapshot` 最多打印多少个无障碍树节点 |
| `maxInstances` | `4` | 同时允许多少个会话浏览器；到顶时报错，而不是驱逐正在被看的浏览器 |
| `startupUrl` | `about:blank` | 启动后首先打开的地址 |
| `extraArgs` | `[]` | 追加的浏览器启动参数 |

没有挂 settings provider 的部署里，设置页不出现，配置就是 `cordis.yml` 里的值。

<a id="tools"></a>
## 工具

| 工具 | 作用 |
|---|---|
| `browser_navigate` | 打开地址；返回最终 URL、标题与标签列表 |
| `browser_snapshot` | 把页面读成角色/名称/ref 的树（`- button "Sign in" [ref=e2]`），并附带标签列表 |
| `browser_click` | 点击快照 ref 指名的元素，在它的位置上派发真实鼠标事件 |
| `browser_type` | 向 ref 指名的元素输入（默认替换原内容），可再按一个键（如 Enter） |
| `browser_screenshot` | 截取当前页面为 JPEG 并返回文件路径 |
| `browser_evaluate` | 在页面里求值表达式——取值、滚动、等待、后退的通用工具 |

ref 属于某一页的某一次快照：导航即失效，所以过期的 ref 会报错并指向 `browser_snapshot`，绝不会点到别的东西上。

截图返回路径而不是内联图片：图片内容块需要附件服务签发的引用，插件无法自行构造，而当前适配器只允许 user 消息带图。用普通文件工具读取该文件即可。

没有会话的调用（定时任务、没有会话的子代理）会直接报错，不会落到别人的浏览器里。

<a id="limits"></a>
## 已知限制

- **走 IME 的中文输入不工作。** 组合输入期间 `event.key` 是 `Process` 而不是单字符，键盘转发只处理单字符与少量命名键（Enter / Tab / 方向键等）。粘贴与直接键入 ASCII 正常。
- **镜像跟随最新页面。** 打开新标签的链接、`window.open` 会把镜像与工具一起带过去；在浏览器窗口里手动开的标签不会。侧栏还没有多标签条（需要 0.1.7 的 `multiple` 槽位能力）。
- **只在页面重绘时出帧。** 完全静止的页面几乎不出帧，侧栏保留最后一帧。
- **最小化时不可交互。** 无头模式没有这个问题；带窗口时窗口被最小化会同时停掉画面与操作。
- **只在 Windows 上验证过。** macOS / Linux 一次没跑过（`channel: 'chrome'` 的查找、临时目录、进程回收）。

<a id="dev"></a>
## 开发

```sh
pnpm run typecheck
pnpm test                  # node --test（原生剥离类型，不用 tsx）
pnpm run build
node scripts/prove.mjs     # 前提实测：CDP 端口、screencast、输入派发、截图
node scripts/modes.mjs     # headless / 带窗口 / 最小化 对照
node scripts/cdp.mjs list  # 通过外部 CDP 端口读镜像浏览器
```

`pnpm test` 跑单元测试：输入映射、坐标换算、screencast 的确认与终止顺序、配置校验、profile 目录转义、端口分配、实例池的隔离/上限/回收、无障碍树格式化，以及面板与工具两侧的会话解析。涉及浏览器的测试用 `test/support/` 里的记录型启动器，不需要真的 Chrome。

`scripts/` 下是开发期用来验证前提的脚本，保留下来作为回归手段；`.prove/` 是它们的输出目录。
