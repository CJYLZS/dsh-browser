# Agent Note: 发布待定项

Status: proposed

## Problem

插件已经能用（见 [v1：会话隔离、断开观察、标签跟随与工具补齐](../../implemented/feature/2026-09-23-v1-isolation-disconnect-tabs-tools.md)），但发布形态与几个边界问题还没有决定，而每一项都会改变仓库结构或对外承诺的范围。

## Proposal

- **发布形式**：跟 `dsh-remote-development` 一样走 GitHub 安装（`dsh plugin add --profile web github:CJYLZS/dsh-browser`），还是发到 npm。
- **0.1.7 适配**：各包版本不同步（`dsh-tools` 等已有 `0.1.7-rc.1`，客户端包只到 `0.1.7-alpha.2`），必须逐包选版本；peer 区间要显式扩成 `^0.1.5-rc.2 || ^0.1.7-alpha.2`，否则带预发布标签的范围不覆盖另一个 `major.minor.patch` 的预发布版。
- **跨平台**：整个开发都在 Windows 上，macOS / Linux 一次没跑过（`channel: 'chrome'` 的查找、临时目录、进程回收）。先只声明 Windows，还是进 v1 就要求跨平台。
- **长期 profile 的粒度**：按会话（当前实现）还是全局一份——后者会让登录态跨会话共享，与"真实隔离"矛盾。

## Alternatives considered

**发到 npm**：需要一套发版与版本管理流程，而 GitHub 安装已经是 `dsh plugin add` 的一等路径。**先做跨平台再发布**：在这台机器上无法验证，声明一个没跑过的平台比只声明 Windows 更糟。**全局一份长期 profile**：与按会话隔离直接冲突，等于放弃隔离——那条隔离是 [多标签与页面生命周期](../../implemented/architecture/2026-09-23-multi-tab-and-page-lifecycle.md) 的核心决定。

## Acceptance criteria

四项各有结论，且选中的那一项落到具体改动（`package.json` 的 peer 区间、README 的平台声明、`userDataDir` 的粒度、发布路径），未选中的写进对应的 implemented 笔记或被删除。

## Risks

0.1.7 的接口差异已经造成过误判（两个版本对 `ctx.browserUse`、`SidebarRightTabDefinition.multiple`、`cordis.patch.yml` 的行号都不同）；平台声明错了，会让用户在一个从没跑过的平台上踩进程与路径问题。
