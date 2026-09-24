# Agent Note: 启动默认值与 tab kind

Status: implemented

## Problem

插件要在无人值守的环境里稳定出帧、接受输入，并决定以哪种 UI 形态接入右栏。

## Decision

把启动默认值定成 headless、tab kind 定成 `cdpBrowser`，版本基线定在 0.1.5-rc.2——理由与实测见下。

## 决定：默认 headless

headless 下 screencast 稳定 20fps、`Input.dispatch*` 生效、帧内容经人工确认是真实页面渲染。无窗口意味着遮挡与最小化这两个问题根本不存在。默认 `headless: true`，headful 保留为配置项（用于需要人工直接操作真实窗口的场景）。

## 决定：tab kind 用 `cdpBrowser`，不占用 `browser`

0.1.7 的 `@deepseek-ai/dsh-client-ui-sidebar-browser` 已占用 `BROWSER_KIND = "browser"`（web-app patch 第 253-254 行已装）。它是「iframe / Electron webview 把网页嵌在界面里」的路线：没有真实浏览器进程、没有 profile、没有 CDP 端口、没有 agent 工具。本插件用自己的 kind（`cdpBrowser`）与 id（`dsh-browser`），两者并存；接管能力保留但默认不动用。

## 实测结论

脚本 `scripts/prove.mjs`、`diagnose.mjs`、`occlusion.mjs`、`modes.mjs`、`cmdline.mjs`，证据在 `.prove/`。

| 前提 | 结论 | 证据 |
|---|---|---|
| `--remote-debugging-port` 与 Playwright 自带的 `--remote-debugging-pipe` 共存 | 成立 | `/json/version` 返回 HTTP 200，`Browser=Chrome/153.0.8010.53` |
| 端口发现方式 | 不能用 `DevToolsActivePort` | 有 pipe 时该文件不写；改为轮询 `/json/version` |
| headless 渲染 | 成立 | 20fps，帧为真实页面（计数 80 + 按钮），输入生效，零 ACK 失败 |
| headful 遮挡/最小化 | 不停流 | 最小化（人工确认窗口确实最小化）时 20.3fps |
| 停流的真实原因 | **Playwright 默认参数，不是我们的 flag** | 命令行含 `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-background-timer-throttling`；带/不带 `CalculateNativeWinOcclusion` 结果一致 |
| `Input.dispatch*` 操控真实窗口 | 成立 | 点击后 `#out = "clicked 1"`；`Input.insertText` 落进输入框 |

由此修正原计划的两处判断：

- 原计划把遮挡/最小化列为最高 UX 风险并要求默认带 anti-occlusion 参数。实测中该参数不是起作用的一方，Playwright 默认已禁用后台化。参数仍可保留（无害，且在 headful 下有额外保险），但不应再作为默认 headful 的理由。
- screencast 是重绘驱动的：完全没有画面变化时几乎不出帧。侧栏 canvas 保留最后一帧即可，不需要为此轮询。

## 版本基线修正

开发基线是 **0.1.5-rc.2**（仓库当前 checkout）。0.1.5-rc.2 上不存在的 API：`multiple`、`keepMounted`、`ctx.browserUse`、`ui-sidebar-browser`、`ui-sidebar-terminal`。计划中按 0.1.7 写的位置在 0.1.5 上的对应关系不同：`cordis.patch.yml` 的 `ui-sidebar-right` 在 224 行（不是 240），跨包注册 tab 的范例是 `ui-sidebar-documentpreview`（不是 `ui-sidebar-terminal`），tab 定义的 `title` 是函数、没有 `multiple`。

## 其他实测修正

- body 注册进 `sidebar.right.pane.tab` 时以 definition 的 **`id`** 为 key，不是 kind；title 另有 `sidebar.right.pane.tab.title` 槽位。
- 0.1.5 的 page 类型是每个 kind 一个 tab（`pageAddress(kind)` 是固定地址），所以 M1 是单标签；多标签要等 0.1.7 的 `multiple`。
- 信任检查用 `ctx.connection.requestRejection(req)`（gateway 自己在 `packages/api/gateway/src/index.ts:215` 就是这么做的），它等于 `isTrustedApiRequest → 403` 加浏览器鉴权 `→ 401` 两段。`webServer.register()` 的普通路由同样不过信任拦截，JSON 控制路由也要加。
- 客户端 bundle 的 external 只能是 `PLATFORM_MODULES`（react 系列、cordis、client-store、ui-slots、ui-primitives、ui-dockkit），其余 `@deepseek-ai/*` 只能 type-only 导入，否则要内联。

## M1 已完成并在真实 UI 里验证

代码在 `src/`（host：config / browser/{launch,manager,screencast,input} / view/server / tools / index；client：definition / view / locales / index），`pnpm install && pnpm run build` 后经 `dsh plugin add --profile web link:...` 装入 web profile，重启 harness 生效。

验证链路（全部在真实 UI 里跑通）：

| 环节 | 证据 |
|---|---|
| tab 类型注册与双语文案 | guide 条目渲染出「浏览器 / 镜像本机真实浏览器，可操控，也可用同一端口附加 DevTools。」 |
| 打开 tab 后自动起浏览器 | 侧栏状态行显示 `CDP 127.0.0.1:9333`，UA 为 `HeadlessChrome/153` |
| 画面镜像 | canvas 解码出帧（764x485），内容是镜像进程加载的真实页面 |
| 侧栏导航驱动镜像 | 地址栏提交后状态行变为目标 URL，镜像浏览器随之前往该地址 |
| **侧栏点击驱动镜像** | 经外部 CDP 端口在镜像页注入全屏按钮，从 canvas 点击后按钮文本由 `off` 变为 `ON`，并由外部 CDP 独立读回确认 |
| 外部附加（计划验收项 4） | 用独立进程通过 `/json/version`、`/json/list`、`Runtime.evaluate` 完整驱动该浏览器 |

过程中修掉的真实缺陷：

1. **坐标换算**：客户端送归一化坐标（0..1），而 CDP 需要 CSS 像素。原先直接把分数当像素传给 CDP，所有点击都会落在左上角。现由 manager 按 `Page.getLayoutMetrics` 的视口尺寸换算，并缓存 1 秒避免每次指针移动都往返一次。
2. **错误被静默吞掉**：服务端把失败作为 `{type:'error'}` 回送，而客户端只处理 `status`，导致「点了没反应」无法解释。现已显示错误文本。
3. **无头视口过小**：`viewport: null` 在没有真实窗口时取到的是虚拟窗口尺寸，实测仅 764x485，多数站点被裁切。现由 `viewportWidth` / `viewportHeight`（默认 1440x900）显式指定；headful 仍保留真实窗口尺寸。
4. **letterbox 偏移**：canvas 用 `object-fit: contain` 把画面按比例居中放入元素盒，而坐标换算原先针对元素盒而非绘制区域，宽高比不一致时每次点击都会偏。现已按绘制区域换算并夹取到 `0..1`。

真实站点验证：侧栏访问 `https://example.com/` 完整渲染（标题、正文、链接可读），按外部 CDP 给出的链接精确坐标点击后跳到 `https://www.iana.org/help/example-domains`，证明坐标换算在真实页面布局上准确。

键盘与工具验证：

- 侧栏画布逐键输入后，镜像页输入框的值变为 `hello world`（按键 → WS → host → CDP `Input.insertText`）。
- 在一个新会话里让 agent 依次调用 `browser_navigate` 与 `browser_screenshot`：对话记录显示 2 次工具调用，返回 example.com 的 URL 与标题，并落盘一张 1440x900、17,318 字节的 JPEG。计划验收第 6 条通过。

M1 收口。已知限制（写入 README）：IME 中文输入不工作（组合输入期间 `event.key` 是 `Process`）；一个进程一个浏览器实例，多标签/多会话共享；画面仅在重绘时更新；headful 下最小化会停。

M2 的起点：按会话多实例（0.1.7 的 `multiple` 才有真正的多标签）、工具补齐（click / type / press / scroll / wait_for / AX 快照 / tab 切换）、profile 管理与设置卡片。

## Alternatives considered

**默认 headful**：用户关掉窗口或最小化就影响画面，而且 headless 的真实性已实测通过，所以只把它留作配置项。**kind 用 `browser`**：0.1.7 的 `ui-sidebar-browser` 已占用它，那是 iframe/Electron webview 的嵌入路线，与本插件的"镜像真实 Chrome 进程"不是同一能力，两者并存。

## Consequences

无窗口意味着"遮挡"这类问题在这个插件里不存在，判据只剩页面自身；反过来，headless 的 UA 会带 `HeadlessChrome`，于是有了 stealth 那一项（见 stealth 笔记）。
