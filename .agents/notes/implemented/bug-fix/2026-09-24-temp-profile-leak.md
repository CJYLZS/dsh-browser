# Agent Note: pnpm test 的临时 profile 泄露

Status: implemented

## Problem

`ensure()` 在调用 launcher **之前**就 `mkdtemp` 一个 `dsh-browser-*` 目录，而测试从不 close 自己的浏览器，所以没有任何生产代码会去删它们：修之前每跑一次 `pnpm test` 就往 `%TEMP%` 里丢一个目录（实测单次 45 个）。

## Decision

假启动器记录交给它的临时目录，并在自己的 `after` 钩子里删掉。它删的是**自己见过的**目录，不是 `%TEMP%\dsh-browser-*` 通配——另一个 dsh 实例正在跑的浏览器也是这个名字，删了就是删别人的浏览器（`test/support.test.ts` 把这条钉住）。

## 修掉 `pnpm test` 的临时目录泄露

`ensure()` 在调用 launcher **之前**就 `mkdtemp` 了一个 `dsh-browser-*` 目录，而测试从不 close 自己造的浏览器——没有任何生产代码会去删它们。实测一次 `pnpm test` 在 `%TEMP%` 里留下 45 个空目录（当天累计 304 个空目录 + 7 个真 profile，100.8 MB）。

- 修法在测试侧：`test/support/browser.ts` 记录交给假启动器的临时目录，并在自己的 `after` 钩子里 `rmSync`。判断条件写死"父目录是 `tmpdir()` 且名字以 `dsh-browser-` 开头"，所以配置出来的 `userDataDir` 子目录不会被碰。
- **它删的是自己见过的目录，不是 `%TEMP%\dsh-browser-*` 通配**：另一个 dsh 实例正在跑的浏览器也是这个名字，通配删就是删别人的浏览器（这一轮我自己就犯过一次——见下）。`test/support.test.ts` 三条用例把"删自己见过的""配置目录不碰""没见过的同名前缀目录不碰"钉住。
- 验证方式：跑一次 `pnpm test`，前后数 `%TEMP%\dsh-browser-*`；修之前 +45，修之后 +0。

## 这一轮踩到的事故（写下来免得再犯）

排查"重启前的浏览器有没有关干净"时，我写了个清理脚本，里面"保留在用 profile"的判断被 PowerShell 的字符串处理写坏，等于把活着的那个浏览器的 profile 也列进了删除列表，`Remove-Item` 删掉了没被锁的 117 个文件（202 → 85）。浏览器没死（临时 profile 的磁盘态不完整，且这个目录本来每次启动都会换新），但这是不该发生的事。教训：**清理脚本要先把"保留集合"打印出来核对再删**；以及 `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue` 会把失败伪装成成功，用它做批量删除时必须有事后核对。

## Alternatives considered

**让生产代码在 `ensure()` 失败时清理**：测试从不 close 自己的浏览器，这条路径覆盖不到本次泄露。**按名字通配扫 `%TEMP%`**：会删掉别的实例正在运行的浏览器，比泄露更糟。

## Consequences

跑完 `pnpm test` 后 `%TEMP%` 里不该多出任何 `dsh-browser-*` 目录，这是这条的可验证形式。注意 host 被强杀时留下的 profile 目录仍是操作系统级残留（Chromium 只在优雅退出时删临时 profile），不在本条的范围内。
