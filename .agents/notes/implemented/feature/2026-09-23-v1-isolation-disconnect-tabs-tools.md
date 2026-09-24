# Agent Note: v1：会话隔离、断开观察、标签跟随与工具补齐

Status: implemented

## Problem

骨架跑通后，一次复核列出三处"现在是坏的"：浏览器断开无人观察（`state` 永远停在 `ready`，之后每次工具调用都抛 Playwright 的英文错误且没有恢复路径）、新标签失控（一条 `target=_blank` 就足以让 agent 在旧页面上打转）、失败态在 UI 不可见（画过第一帧之后提示恒为空）。工具也只有 3 个，且插件不在版本控制里、零测试。

## Decision

按 session 隔离（`BrowserPool` 按 session 持有 + `SessionBrowser` 只服务一个会话）；`context.on('close')` 观察断开并带原因进 `closed`，`ensure()` 在下次请求时换掉死实例；`context.on('page')` 跟随新标签并在激活页关闭时退到剩下的第一个；工具补齐到 6 个；截图继续返回文件路径；插件独立成 git 仓库、`pnpm test`（`node --test`，不用 tsx）。

## A. 现在是坏的（不是缺功能）

1. **浏览器断开无人观察。** 全插件只有一处 `close` 监听，在 viewer 的 WebSocket 上（`src/view/server.ts:81`）；`context.on('close')`、`browser.on('disconnected')`、`isConnected()` 一个都没有。用户关掉真实窗口或浏览器崩溃后：`state` 永远停在 `ready`，`ensure()` 早退，面板停在最后一帧且没有任何提示，此后每次工具调用都抛 Playwright 的原始英文错误，**也没有任何恢复路径**（连面板的「刷新」都走同一条 `ensure()`）。
2. **新标签失控。** `window.open` / `target=_blank` / 用户在真实窗口 Ctrl+T 都会在同一浏览器里新建 page；manager 只持有 `pages()[0]`、只为它建 CDP 会话，没有 `context.on('page')`。实测：新标签出现后 `/json/list` 里有两条 page target，插件仍只驱动第一条，镜像不跟随、面板不显示、agent 不知道它存在。一条 `target=_blank` 链接就足以让 agent 在旧页面上打转。
3. **失败态在 UI 不可见。** `view.tsx` 的提示是 `painted ? undefined : …`，画过第一帧之后 `note` 恒为 undefined；而 `failure` 只在收到 `{type:'error'}` 时设置，浏览器死亡只发 status。结果是"画面卡住 + 没有任何说明"。

## B. 工具不足以真的用起来

4. 只有 3 个工具，缺 click / type / press / scroll / wait_for / tabs（list/switch/new/close）。没有它们，agent 每次点击都在手写 `browser_evaluate` 脚本——贵且脆。
5. 截图返回文件路径而不是图片内容块。实现注释说插件无法自己造 attachment；需要确认 dsh 是否给了插件产出图片块的途径（browser-use 已支持图片结果）。有就应该用。

## C. 发布工程

6. **插件不在版本控制里。** `git rev-parse --show-toplevel` 给出的是 harness 根，而 harness 忽略 `lib/`——目前没有仓库可装，也没有历史。
7. `private: true`，缺 `license` / `repository` / `author`。
8. `lib/` 必须随仓库提交。对照 `dsh-remote-development`：从 GitHub 装、无 `prepare` 脚本、`files: ["lib","cordis.patch.yml","THIRD-PARTY-NOTICES.md"]`。
9. **零测试。** `scripts/*.mjs` 都要真浏览器 / 真网络，不能当回归。对照件有 `"test": "tsx --test test/*.test.ts"`。
10. README 只有中文；对照件是英文 `README.md` + `README.zh.md`。
11. 没有 LICENSE 文件。
12. `peerDependencies` 写 `^0.1.5-rc.2`，且从未在 0.1.7 上跑过。

## v1 实施记录（2026-09-23，正确性与功能部分已按 TDD 完成）

### 一、正确性

**1. 按 session 隔离（已完成）。** 结构：`BrowserPool`（按 session id 持有实例）+ `SessionBrowser`（原先的 `BrowserManager`，现在只服务一个会话）。

- 端口：`debugPort` 是基准，`PortAllocator` 从基准向上探一个能绑定的端口并**持有**它直到浏览器关闭（探测本身有竞态，所以分配是串行的，且分配出去就算占用）。
- profile：`userDataDir` 变成父目录，每会话一个子目录；段名用 harness 自己的转义规则（`session-persistence-jsonl` 的 `encodeSegment`），所以 `..`、分隔符、超长 id 都不会造成越界或碰撞。
- 面板：会话作用域的 keyed 槽位，注册方的 `inject` 工厂拿到 `sessionId`，WS 用 `?session=<id>` 指名要看哪个浏览器。
- 工具：`exec.agent?.id` 定位实例；没有 session 的调用直接报错，不会落到别人的浏览器。
- 回收：`session/disposed` 关掉该会话的实例；`maxInstances`（默认 4）到顶时**报错**而不是驱逐正在被看的浏览器。
- 设置页的 profile 文案已改成"每会话一个子目录"，`/dsh-browser/status` 改成实例列表。

**实测（两个真实会话，同一台机器）：** 会话 A 面板 9333 / 会话 B 面板 9334，各自 `about:blank`。通过外部 CDP 端口把 B 导航到 `https://example.com/`：B 的面板跟随，A 的面板与实例仍是 `about:blank`。随后在 B 里让 agent 调用 `browser_evaluate('location.href')`，返回 `"https://example.com/"`——工具驱动的正是面板所看的那个实例，两个方向都指向同一个 session。

**2. 断开观察（已完成）。** `context.on('close')` 且不是自己发起的关闭 → `forget()` + `closed` + 原因（Playwright 不提供原因，固定为 "the browser was closed or crashed"）。`ensure()` 不再在 `ready` 时早退——死掉的实例会在下一次请求（工具调用、面板重连、面板上的「重启浏览器」）时被换掉。

**实测：** 杀掉 9334 的进程（面板未挂载）→ 实例变 `closed` 并带原因，9333 不受影响；面板挂着时杀掉 → 面板显示"浏览器已停止。 the browser was closed or crashed" + 「重启浏览器」，点一下即恢复（端口也回到 9334）。顺带修掉一个真问题：提示是浅灰字浮在画面上，白底页面里看不见，现在带了半透明深色卡片。

**3. 新标签跟随之（已完成）。** `context.on('page')` → 新页面成为激活页（镜像与工具都切过去），激活页关闭时退到剩下的第一个，没有就新建一个。`navigate` / `snapshot` 的结果都带标签摘要（`[active] url`），所以 agent 能看到页面换了。

**实测发现并修掉的缺陷：换浏览器后 viewer 永远收不到帧（2026-09-23）。** 用户报告：agent 调用工具时侧栏始终白屏，工具本身正常。定位：状态通道是活的（面板地址栏跟着更新），但 screencast 死了——`Page.startScreencast` 属于**某一个 CDP 会话**，而重启/崩溃恢复/改启动项都会换掉浏览器与它的 CDP 会话；仍在订阅的 viewer 只能靠"0→1 订阅"时的 `openStreamForViewers()` 挂流，于是只要面板没被卸载重挂，画面就永远停在上一帧。我之前的验证之所以没发现：每次都先切走再切回（正好触发了 0→1）。

修法：`start()` 在 `setState('ready')` 之后，只要还有 viewer 就 `await this.openStream()`——所有"起一个新浏览器"的路径（首次、重启按钮、死亡后下一次请求、改启动项）都经过这里，一处覆盖四条路径。回归测试三条：重启、崩溃后自动替换、改启动项（`test/session-browser.test.ts`）。

### 二、功能

**4. 工具补齐到 6 个（已完成）。** 新增 `browser_snapshot`（ARIA 树 + ref）、`browser_click`（ref → `DOM.getContentQuads` → 真实鼠标事件）、`browser_type`（`DOM.focus` + `Input.insertText` + 可选按键）。ref 只在当前页有效，导航即失效，失效时报错并指向 `browser_snapshot`。

**实测：** 让 agent 走一遍 navigate → snapshot → click：snapshot 在前几行给出 `- RootWebArea "Example Domain" [ref=e1]`、`- heading "Example Domain" [ref=e2]`，用 `ref=e7` 点击 "Learn more" 后页面真的跳到 `https://www.iana.org/help/example-domains`，面板同步显示该地址——说明坐标换算（content quad 是页面坐标，输入是视口坐标）在真实 Chrome 上是对的。

**5. 截图仍是文件路径（已确认，无需改）。** `ImageBlock` 要的是 `ImageAttachmentRef`（"owned by the attachment service"），插件无法自行签发；而且 `packages/llm/llm/src/types.ts:71` 写明只有 user 消息可以带图，工具结果这条路径在当前适配器下用不了。留给 0.1.7 之后的 `browser-use` 图片结果能力。

### 三、发布工程

**6. 独立仓库（已建并已推送）。** `lib/dsh-browser` 自己是一个 git 仓库（`lib/` 入库，`.gitignore` 排除 `node_modules` / `.pnpm-store` / `.prove`，`.gitattributes` 固定 LF），远程在 https://github.com/CJYLZS/dsh-browser（public，与 `dsh-remote-development` 一致；默认分支 `main`，本地原来的 `master` 在首次推送前改名对齐）。构建产物与源码一致已核对：重新 `pnpm run build` 之后 `git status` 干净，所以从 GitHub 装不需要构建步骤——`lib/index.js`、`lib/client.js` 与四张截图都在推送的树里。README 重写为英文主 + `README.zh.md`，安装说明改成 `dsh plugin add --profile web github:CJYLZS/dsh-browser`。

**7. `private: true` 已去掉**，补齐 `license: MIT`、`keywords`、`repository`、LICENSE 文件；`peerDependencies` 列出 profile 必须提供的 8 个包（`^0.1.5-rc.2`）。

**8. 测试集（已完成）。** `pnpm test` = `node --test`，不用 tsx——Node 24 原生剥离类型，代价是插件代码不能出现 enum / 参数属性这类不可擦除语法。当前 78 个用例，覆盖输入映射、坐标换算、screencast 确认/终止顺序、配置校验、profile 段名转义、端口分配、池的隔离/上限/回收/重启、AX 树格式化，以及面板与工具两侧的会话解析。涉及浏览器的用例跑在 `test/support/browser.ts` 的记录型启动器上，不需要真 Chrome。

仍缺的：真实浏览器上的 `browser_type`（`insertText` 本身已在输入转发里用过，但没单独实测这个工具）、`maxInstances` 到顶时面板上的提示。

**9. 0.1.7 适配（未做，卡在网络）。** 起了一个 pin 到 0.1.7 的临时副本想跑 `tsc` + `test`，但注册表下载在这个环境里持续失败（`UND_ERR_DESTROYED`，tarball 全部失败而 `npm view` 的元数据查询正常；关掉沙箱重试同样失败，所以是本机网络/代理的问题，不是沙箱）。副本已删除。

顺带查清两件对适配有用的事实：

- **各包版本不同步。** 截至今天（2026-09-23）：`dsh-tools` / `dsh-host-webserver` / `dsh-client-connection` / `dsh-session` / `dsh-settings` / `dsh-agent` / `dsh-client-store` 有 `0.1.7-rc.1`，但客户端包 `dsh-client-locale` / `dsh-client-ui-slots` / `dsh-client-ui-sidebar-right` / `dsh-client-ui-settings` **只到 `0.1.7-alpha.2`**（`dsh-client-store` 的 rc.1 存在，dockkit 的要看）。所以"升到 0.1.7"必须逐包选版本，不能一把替换。
- **`^0.1.5-rc.2` 不覆盖 0.1.7 的预发布版。** semver 规则：范围里带预发布标签时，只有同一 `major.minor.patch` 的预发布版才可能满足它。要让 0.1.7 的 rc/alpha 满足 peer 区间，得显式写出来（例如 `^0.1.5-rc.2 || ^0.1.7-alpha.2`），否则 profile 里装 0.1.7 时会报 peer 不满足。
- 另外 `next` 线上已经是 `0.1.5-rc.3`（比本 checkout 的 rc.2 新）。
10. **跨平台未验证**：整个开发都在 Windows 上，macOS / Linux 一次没跑过（`channel: 'chrome'` 的查找、临时目录、进程回收）。

### 还需要你定的

- 发布形式：GitHub 安装（跟 remote-development 一样）还是 npm。
- 跨平台进不进 v1，还是先只声明 Windows。
- 长期 profile 的粒度：按会话（已按此实现）还是全局一份——后者会让登录态跨会话共享，与"真实隔离"矛盾。

## 地址栏改版（2026-09-23）

原来是一个普通输入框加「前往」「刷新」两个大按钮，与"浏览器"这个身份不符。现在是一个现代 omnibox 胶囊：

- 左边是**连接指示**：https 显示锁（`label-tertiary`），明文 http 显示地球 + 琥珀色（`state-warn-label`），`title` 是本地化文案（新增 `secure` / `insecure` 两个键，中英各一份）。
- 输入框无边框无背景，聚焦时**全选内容**（浏览器的习惯：给你整个地址替换，而不是在里面放个插入点）。
- 右边一个圆形图标按钮：地址与浏览器当前页**一致时是刷新**，一旦被编辑就变成**前往箭头**（同一个位置，两个语义，省掉一个大按钮）。
- 颜色全部走主题 token（`--dsw-alias-bg-layer-2` / `border-l2` / `interactive-bg-hover` / `label-*`），所以深浅两套主题都对：暗色靠底色分层，亮色靠描边。悬停态用 React state 而不是 `:hover`——客户端 bundle 没有自己的样式表，所有外观都是内联样式。

顺带修掉一个真问题：**回车以前不提交**（只填了隐式表单提交，实测在应用里 Enter 没有任何反应），现在输入框上有显式的 `onKeyDown`，Enter 与箭头按钮走同一个 `submit()`。

实测（真实 UI）：暗色与亮色两套主题各截图确认；编辑态出现前往箭头、提交后变回刷新；回车成功导航到 example.com（画布取样 238,238,238）；悬停态计算样式 `rgba(38,49,72,0.06)` + 图标转 `label-primary`；明文地址显示琥珀地球。

## Alternatives considered

**「关闭浏览器」放进侧栏标签菜单**：标签菜单要按 tab 类型过滤，而这两个动作属于"这个会话的浏览器"，放在看着它的面板状态行里更直接。**接 `browser().on('disconnected')`**：Playwright 的断开事件不带原因，两条路径的结论是同一句话。**截图返回图片内容块**：`ImageBlock` 要的是 attachment service 签发的引用，插件无法自行签发，且工具结果这条路径在当前适配器下用不了。

## Consequences

修完这一轮，插件才算"能用"：断开有原因、新标签跟得上、失败看得见。仍然缺的两项写在正文里（真实浏览器上的 `browser_type`、`maxInstances` 到顶时面板上的提示），另一项是 0.1.7 适配与跨平台，见发布待定项。
