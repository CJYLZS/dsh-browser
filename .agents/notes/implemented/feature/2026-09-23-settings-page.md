# Agent Note: 设置页与"生效"反馈

Status: implemented

## Problem

配置写入是即时的，但用户看不到的是"浏览器有没有按新值重来"——一个只报"已保存"的设置页等于没说话。

## Decision

12 个字段走 harness 的 settings 能力（持久化 + 即时重配）；状态横幅从插件的 `GET /dsh-browser/status` 读**正在跑的实例**，而不是当前配置；写入与「重置」走同一个 `commit()`。多实例之后横幅列出每个会话的实例，明细收进 `<details>`，常显的只有"有几个在跑"。

## 设置页（提前于 M2 完成）

设置 → 「浏览器」标签页，接入方式与 remote-development 的「远程开发」标签相同（`settings.section` 槽位），但持久化没有自己开路由，而是用 harness 的 settings 能力：

- host：`ctx.inject(['settings'], …)` + `settings.installSection(ctx, 'dsh-browser', Config, entry, hooks)`。组合配置是 base 层，用户改动落在其上；`hooks.setSource` 给出当前权威值，`hooks.onChange` 触发重配。
- client：`ctx.settingsScope.bind({ namespace: 'dsh-browser' })` 拿到 `SettingsScope`，`useSyncExternalStore` 订阅快照，`scope.set(field, value)` 写字段、`scope.unset(field)` 回落到组合值。覆盖过的字段显示「重置」。
- 写入落在 `~/.dsh/settings.yaml` 的 `dsh-browser` 命名空间。provider 挂在 **base** bundle，所有 profile 都有；没有 provider 时页面不注册，配置等于组合值。

可选字段：窗口模式（headless/headful）、profile（临时/长期目录）、浏览器（chrome/msedge）、可执行文件路径、CDP 端口、页面尺寸、镜像画质。

manager 增加 `reconfigure(next)`：启动项变化即关闭浏览器（订阅者保留，下次取帧时按新值重启）；只有画面编码变化时原地重启流。

实测：设置页渲染出全部控件与默认值；把 profile 改成长期目录并填路径后，`settings.yaml` 出现 `dsh-browser.userDataDir: C:\Users\rookie\dsh-browser-profile`，随后打开侧栏标签时该目录被创建并填充——设置 → 持久化 → 重配 → 用新 profile 启动，整条链路闭环。

---

## 设置页的"生效"反馈（2026-09-23 补）

问题：设置页只有"写入"，没有"生效"的证据——用户改完只看到自己填的值，分不清已保存和已生效。

结果：设置页顶部加一条**浏览器状态**，数据来自插件自己的 `GET /dsh-browser/status` 路由（和 viewer 一样走 `requestRejection` 信任检查；无凭据访问实测返回 401，说明路由不是敞开的）。状态取自正在跑的那个实例而不是当前配置，所以"待重启"时不会报出没在跑的浏览器的模式。每次写入后 1.5s / 4s / 8s 各重读一次，另配「刷新」按钮与「已保存」「保存失败」提示。

实测（真实 UI，改的是 CDP 端口这个启动项，会真的重启浏览器）：

| 操作 | 横幅 |
|---|---|
| 起始 | 浏览器运行中 CDP 127.0.0.1:9333 · headless |
| 端口改成 9334 | 浏览器运行中 CDP 127.0.0.1:9334 · headless |
| 点该行的「重置」 | 浏览器运行中 CDP 127.0.0.1:9333 · headless |

中途发现并修掉的一个真缺陷：**「重置」走的是 `scope.unset`，没有接上重读**，所以重置后横幅仍显示上一个浏览器的端口（浏览器其实已经重启正确）。现在重置和写入走同一个 `commit()`。

顺带确认一件事：**纯客户端改动不需要重启 harness**，浏览器里重载页面即可（host 侧改动仍要重启）。`scripts/cdp.mjs` 增加了 `eval <expression>` 子命令，用来从宿主机读镜像页的状态。

`stealth` 也进了设置页（自动化标记：隐藏 / 保留），默认隐藏。

## Alternatives considered

**横幅读配置**：会一直报上一个浏览器，用户以为改生效了。**「重置」只写不重读**：同上，横幅停在旧实例上。

## Consequences

设置页的结论从此以"实例状态"为准，这也决定了后面端口窗口不能进 launch field：改窗口不该把用户正在看的浏览器关掉。
