# Agent Note: 风控排查与 stealth 启动项

Status: implemented

## Problem

目标站点会拦自动化浏览器。Playwright 启动的浏览器一律 `navigator.webdriver === true`，headless 还多带一个 `HeadlessChrome` UA。

## Decision

不换引擎，靠关掉自动化标记：配置项 `stealth`（默认开）加 `--disable-blink-features=AutomationControlled`，并用 CDP 把 UA 里的 `Headless` 去掉。受控对比（每种配置一个全新临时 profile、同一网络同一时间窗、搜同一个词，交替 3 轮）：带这两个标记 0/3 通过，关掉后 3/3 通过。

脚本 `scripts/risk.mjs`，证据在 `.prove/risk/`（每个配置一张截图）与 `.prove/risk.log`。

## 受控对比（每种配置一个全新临时 profile，搜同一个词）

| 配置 | webdriver | UA | 结果 |
|---|---|---|---|
| Edge 真实窗口（对照，用户说能正常搜） | true | Chrome/153 | **被拦**（`/sorry/index`，两次都拦） |
| Chrome headless（插件当前默认） | true | **HeadlessChrome**/153 | 被拦 + recaptcha |
| Chrome 真实窗口 | true | Chrome/153 | 被拦 + recaptcha |
| Edge headless | true | Chrome/153 | 被拦 + recaptcha |
| **Chrome headless + `--disable-blink-features=AutomationControlled` + 非 Headless UA** | **false** | Chrome/153.0.8010.53 | **通过，6 条结果** |
| Edge 真实窗口（第二次） | true | Chrome/153 | 被拦 |
| **纯 curl（完全没有浏览器）** | — | Chrome UA | **通过，3/3** |

被拦页面自带说明："我们的系统检测到您的计算机网络中存在异常流量"，并打印了它看到的 IP。各次运行的出口 IPv6 都不同（`2602:fa4f:...` 下不同 /64）——这台机器走 TUN 代理且出口在轮换。

## 读出来的结论

**触发点是自动化标记，不是网络，也不是 headless。** 决定性的一轮 A/B（同样两条配置交替跑 3 轮，同一时间窗、同一网络，避开出口轮换带来的时间偏倚）：

| 配置 | webdriver | UA | 通过 |
|---|---|---|---|
| 插件原默认（headless + 插件参数） | true | `HeadlessChrome/153` | **0/3**（三次全部 `/sorry/index`） |
| 原默认 + `--disable-blink-features=AutomationControlled` + 非 Headless UA | false | `Chrome/153.0.8010.53` | **3/3**（每次 6 条结果） |

前面那张表里"真实 Edge 窗口也被拦"不再矛盾：**Playwright 启动的浏览器一律带 `navigator.webdriver === true`，headful 也一样**，所以 headful 对照被拦不代表"真实浏览器也会被拦"——它只是"被 Playwright 启动的浏览器也会被拦"。纯 curl 能过，正是因为它根本没有这个标记。headless 只是额外多带了一个 `HeadlessChrome` UA。

## 落地与验证

配置项 `stealth`（默认 `true`）：launch 时加 `--disable-blink-features=AutomationControlled`；页面第一条请求之前用 CDP `Network.setUserAgentOverride` 把 `HeadlessChrome` 去掉——值取自页面自己报的 UA，只删 `Headless` 一词，不猜版本号。改 `stealth` 会重启浏览器（已并入 `LAUNCH_FIELDS`）。

在**真实的 DSH 浏览器**里验证（侧栏画布点击 + 输入，走插件自己的 WS → CDP 输入链路，不是脚本直连）：

| 序号 | 查询 | 结果 |
|---|---|---|
| 1 | `playwrightplaywright browser testing` | 9 条结果，无 `/sorry/` |
| 2 | `typescript compiler` | 9 条结果，无 `/sorry/` |
| 3 | `vite build config` | 7 条结果，无 `/sorry/` |

同时读回的指纹：`navigator.webdriver === false`，UA 里已无 `Headless`（第 1 条的查询词重复是我第一次尝试用 `cua.type` 输入时留下的残留，不影响结论）。

## 关于 CloakBrowser（评估结论：不换）

`CloakHQ/CloakBrowser`，31.6k star / 2.6k fork / 315 commit，最后一次提交 2026-09-18；Python 40% / C# 29.7% / TS 28.7%。它是**在 C++ 源码层打了 87 个补丁的 Chromium 二进制**（canvas / WebGL / 音频 / 字体 / GPU / 屏幕 / WebRTC / 网络时序 / 自动化信号 / CDP 输入行为），并且是 Playwright 的 drop-in 替代（`launch()` 之后就是普通的 Playwright browser），支持 `launch_persistent_context`、代理、geoip、humanize。它打的确实是这次被拦的那一类信号——但同样的信号两个 flag 就关掉了，不值得为它引入下面的代价。

不换的三个理由：

- **许可**（`BINARY-LICENSE.md` v1.3）：wrapper 是 MIT，但**二进制是专有**的；"最新大版本需要付费订阅"，免费额度是**1 个并发会话**；并且明确禁止 redistribute / "include it in any product or service distributed to third parties"。我们的插件是要分发给别人用的，这一条直接挡死；而且按 session 隔离的设计天然需要多个并发浏览器，免费额度也不够。
- **不需要**：两个 flag 已经把 webdriver 与非 Headless UA 都关掉了，A/B 证明这就够了。
- **代价**：首次运行要下载约 200MB 的第三方专有二进制 + 需要 license key 与账号，对本地开发工具来说是很重的一层信任与运维依赖。

保留的可能性：插件的 `executablePath` 已经能把浏览器换成任意 Chromium 二进制，所以"用户自己装了 CloakBrowser，把路径填进设置页"这条路**不需要写任何集成代码**，也不需要我们把二进制打包进去。真到需要二进制级隐身时走这条路。

README 与许可文本有一处对不上（README 说最新构建免费可试，许可说最新大版本需要付费订阅），以许可文本为准，真要采用前先确认。

## 仍未验证的

- 出口 IP 确实在轮换（每次运行的 IPv6 都不同），但既然同一时间窗内两组配置能跑出 0/3 与 3/3，网络不是这次的触发因素。
- `navigator.webdriver` 是服务端无法直接看到的，所以 Google 到底读了什么（CDP 输入行为？请求特征？）还没有定论；能确定的只是"关掉这两个标记后不再被拦"。`stealth` 关掉后可在设置页复现这个对照。
---

## Alternatives considered

**换 CloakBrowser 之类的隐身引擎**：评估结论是不换（正文有对比）。**保留为逃生门**：真需要二进制级隐身时用 `executablePath` 指向用户自备的隐身 Chromium——第三方二进制不进仓库。

## Consequences

反检测成了启动参数的一部分，所以"不要重复 Playwright 已有的反后台化"这条同时成立：它默认已经带了 `--disable-backgrounding-occluded-windows` 等三个参数，实测最小化与遮挡下画面都继续出帧。
