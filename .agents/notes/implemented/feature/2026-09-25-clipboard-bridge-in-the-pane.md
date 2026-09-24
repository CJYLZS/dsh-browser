# Agent Note: 剪贴板快捷键由面板自己接管

Status: implemented

## Problem

在侧栏面板里按 `Ctrl+C` / `Ctrl+V`：`Ctrl+A` 正常（选中页面），复制没有任何事情发生、粘贴没反应。第一层缺陷在键盘那一轮就修掉了（面板单独按 Ctrl 时把它拼成 `Control+Control`，host 拒收，而拒收被面板显示成带「重启浏览器」的整屏提示）。剩下的是这一层：**这三个键根本到不了镜像页**，所以"让页面自己去复制粘贴"这条路是堵死的。

实测（2026-09-25，插件正在跑的那个浏览器 = `channel: chrome`、headless、Windows、`Chrome/153.0.8010.53`；探针 [`clipboard-commands-probe.mjs`](../../../../.prove/clipboard-commands-probe.mjs)，它把 fixture 写进镜像页、从外部用 CDP 派发按键、再读回页面状态）：

- 同一个 fixture 上，`Ctrl+K`、`Ctrl+A`、`Ctrl+Z` 都在页面里留下 `keydown`；`Ctrl+C`、`Ctrl+V`、`Ctrl+X` **一条都没有**。
- CDP `Input.dispatchKeyEvent` 的 `commands` 字段是通的：`Ctrl+a` 带 `commands: ["moveToEndOfLine"]` 把光标从 0 移到了 10。
- 但 `commands: ["copy"]` / `["paste"]`（换大小写拼法也一样）既不产生 `copy`/`paste` 事件，也不动剪贴板。
- 给页面授予 `clipboardReadWrite` + `clipboardSanitizedWrite` 之后（`navigator.permissions.query` 两个都回 `granted`，页面自己的 `navigator.clipboard.writeText` / `readText` 都能用），这两条命令**依然无效**。
- headless 的剪贴板是浏览器进程内部的那一个，不是系统的（外部同结论：[chromedp #1542](https://github.com/chromedp/chromedp/issues/1542)）。

外部对照：[agent-browser #1453](https://github.com/vercel-labs/agent-browser/issues/1453) 里，CDP `commands` 是 Chromium 在 macOS 上把 select-all / copy / paste / undo / 光标移动交给 responder chain 的入口；Playwright 的[复制粘贴那一期](https://github.com/microsoft/playwright/issues/8114)里维护者说快捷键"在所有浏览器里都可用"——那是**他们打过补丁的 Chromium 构建**，而本插件按设计驱动用户装的那一个 Chrome。

## Decision

**面板在用户自己的浏览器里跑，那里的 `Ctrl+C/V/X` 是可信事件、系统剪贴板就在一个 Web API 之外**——所以这三个键由面板接管，镜像页只负责提供/接收文本。这正是浏览器里的远程桌面一直以来的做法（VS Code 网页版的剪贴板用 `navigator.clipboard` 并在被拒时退到隐藏 textarea + `execCommand('copy')`；xterm.js 的终端在粘贴快捷键上读 `navigator.clipboard.readText()`；Guacamole 给自己的桥立的规矩是"本地剪贴板没变就不要动它"）。

- **粘贴（`Ctrl/Cmd+V`）走浏览器自己的粘贴动作，不要权限。** 面板里放一个隐藏的可编辑元素（paste sink）。按下粘贴时**不拦截、不转发**，只把焦点交给 sink：浏览器随后执行的粘贴落在它身上，`paste` 事件里读 `clipboardData.getData('text')`，作为 `text` 输入消息发给镜像页（host 的 `Input.insertText`，`browser_type` 的文本路径同一条），然后清空 sink 并把焦点还给画布。用户真的按了粘贴，浏览器才肯把剪贴板内容交给页面——所以这条路不需要任何剪贴板权限，也不弹授权框。
- **复制/剪切（`Ctrl/Cmd+C`、`+X`）先问 host 要选区。** 选区在镜像页里，只有 host 读得到：面板拦截这两个键、记下这次是复制还是剪切，发一条新的 `selection`；host 用 `Runtime.evaluate` 读"聚焦控件自己的选区，否则 `window.getSelection()`"（文本框里文档选区通常是塌的，字段自己的范围才是复制会拿走的东西），回一条 `clipboard` 帧；面板把文本写进系统剪贴板，失败就退到隐藏 textarea + `execCommand('copy')`。剪切在写下之后多派发一个 `Delete`——这是它与复制的全部区别。
- **空选区不碰剪贴板**（`clipboardReply`）：浏览器自己的复制在没有选区时什么都不改，面板也一样，否则就是把用户没打算动的内容擦掉。

两个"有正确答案"的决定（哪个键归面板、回复到手之后做什么）在 [`src/client/clipboard.ts`](../../../../src/client/clipboard.ts)，与 DOM 无关、可单测；sink 与写剪贴板的 DOM 管道在 `view.tsx`。

## 证据

- **探针**：`node .prove/clipboard-commands-probe.mjs <调试端口>` 自包含（自己写 fixture）、可重复，上面每一条数字都是它跑出来的。
- **活面板**（GUI 里量，HMR 推新 `lib/client.js` 后不用刷新）：
  - 合成 `Ctrl+V` → 线上**一帧都不发**，焦点落到 sink（`document.activeElement === sink`）；
  - 给 sink 一个带 `clipboardData` 的 `paste` 事件 → 线上出现 `{"type":"input","message":{"type":"text","text":"PASTED-FROM-CLIPBOARD"}}`，sink 的值是空的，焦点回到画布；
  - 合成 `Ctrl+C` / `Ctrl+X` → 线上出现 `{"type":"selection"}`；`Ctrl+A` / `Ctrl+K` 仍按原样发和弦（没有回归）。
  - 真实的 `Ctrl+V` 只有人手能产生：注入的按键到不了浏览器进程，正是这一篇的开头——所以这一步由用户在自己的 GUI 里按一次确认。
- **单元**：`clipboardChord` / `clipboardReply` / `pasteMessage`（含"空选区不写"与"AltGr 不是快捷键"）在 `test/client-clipboard.test.ts`；host 的 `selectionText` 在 `test/session-browser.test.ts`（含"页面答了非字符串也不能变成 `undefined` 写进剪贴板"）。

## Alternatives considered

- **给 host 的按键派发加 `commands`（`copy`/`cut`/`paste`/`selectAll`）。** 试过，代码已回退：机制本身可用（caret 命令实测生效），但剪贴板那几条在注入路径上不执行，授予剪贴板权限后也不执行。顺带一条教训：**CDP 不校验命令名**，写错一个名字不报错、只是静默不做事，所以"调用没失败"不能当作"命令跑了"。
- **只把镜像改成 headful（`headless: false`）。** 系统剪贴板确实只存在于有窗口的浏览器里，但"注入的按键到不了浏览器进程"与有没有窗口无关。没有实测，不作承诺；真要试就先量（探针按端口跑）。
- **粘贴也走 `navigator.clipboard.readText()`**（VS Code / xterm.js / noVNC 的做法）。它是这些项目的主路径，但要 `clipboard-read` 权限（Chrome 会弹授权）；隐藏 sink 那条不需要权限，所以这里选 sink 作主路径。若某个浏览器不认 sink，`readText` 就是升级/兜底的位置。
- **什么都不做，只把限制写进 README。** 用户要的就是这两个键；而且面板这一侧本来就持有"可信按键 + 系统剪贴板"这两样别处都没有的东西，把能力挂在别处都不可能成立。

## Consequences

- 面板里的 `Ctrl+C/V/X` 现在做的是**用户浏览器与镜像页之间的搬运**，与镜像页自己的剪贴板无关：页面里 JS 调 `navigator.clipboard.writeText`（比如站点自己的"复制"按钮）写的仍是浏览器进程内部那个剪贴板，headless 下不会到系统剪贴板。
- 只搬纯文本，且只有一条通道：富文本、图片、文件都不在里面（浏览器自己的粘贴事件里有这些类型，将来要扩就从 `clipboardData.types` 扩）。
- 复制/剪切是一次往返（面板 → host 读选区 → 回帧 → 写剪贴板）。写剪贴板落在回复上，而 Chrome 的临时用户激活窗口是秒级，所以没有用 VS Code 那套"在手势里先 `new ClipboardItem({... promise})` 占位"的写法；WebKit（Safari）要求写入必须发生在手势栈里，真支持它时要换成那套。
- host 多了一个 viewer 动词（`selection`）和一条下行帧（`clipboard`）。两半必须同一次构建一起上：只换客户端半边时，`selection` 会落到"未知消息"分支并如实报错。
- agent 侧不受影响：`browser_type` 插入文本、`browser_evaluate` 读写页面，都和剪贴板无关。
