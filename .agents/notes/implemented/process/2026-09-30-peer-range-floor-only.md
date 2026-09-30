# Agent Note: 兼容声明只留地板，不封顶

Status: implemented

## Problem

`package.json` 的 dsh peer 一直写成 `>=0.1.7-rc.1 <0.2.0`。这个上界在 0.2.0-rc.2 上碰巧不拦人——兼容检查是 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`（`packages/boot/app-boot/src/plugin-compatibility.ts`），而 `0.2.0-rc.2 < 0.2.0` 成立，用 harness 自己的 `evaluatePluginCompatibility` 对着本插件清单实测过——但它拦下的是同一条线上**之后的每一个**版本：0.2.0 正式版、0.2.1 直到 0.3 之前。而那条线正是插件开发与实测所在的线，世代已经由下界 `0.1.7-rc.1` 说清楚了。上界同时给出一种虚假的安全感：真正会坏的那种变化是客户端半边 import 的世代切换（0.1.5-rc.2 → 0.1.7-rc.1 那次就是），它不可能由版本号的上界自动发现；而它一旦发生，是插件在加载时失败，不是版本比较失败。

## Decision

peer 只留地板：9 个 dsh 包一律 `>=0.1.7-rc.1`。地板仍然拦住旧世代——0.1.5-rc.2 那一代由 v0.1.x 提供、声明 `^0.1.5-rc.2`，两者不会误配；更高的世代交给实测，README 的版本适配一节写明这份构建对照的版本（当前 0.2.0-rc.2），`AGENTS.md` 的目标版本一节同理。devDependencies 仍精确钉在 0.1.7-rc.1：那是本地类型与构建的输入，与消费者的兼容区间是两件事。

## Alternatives considered

**封顶放宽到 `<0.3.0`**：只是把同一个问题推到下一次世代切换，到那时还要再改一次，而且中间每一次跨越都要重新判断一次语义。**完全去掉 peer 声明**：host profile 正是靠这份声明把安装里的实例交给插件（同一份 cordis 与客户端服务必须共享），去掉它会让"用安装里的那一份"变成碰运气。**让 devDependencies 跟着升到当前世代**：那是一次类型升级，混进兼容声明的改动里会让这次改动的验证边界说不清楚。

## Consequences

- 区间改在 `package.json`、`README.md`、`README.zh.md` 的版本适配与 Dev Note 两节，`AGENTS.md` 的目标版本一节改成 0.2.0-rc.2。
- 旧世代仍被拒：0.1.5-rc.2 装的是 v0.1.x 那份构建，它的 `^0.1.5-rc.2` 与本次改动无关。
- 判据实测（`evaluatePluginCompatibility`，runtime 0.2.0-rc.2）：新老区间都通过，差别只落在之后的 0.2.x 上——所以这次改动的效果要在 0.2.0 正式版或 0.2.1 上才看得出来。
- 代价写在明处：更高的世代会被兼容检查放行，坏掉时表现为插件加载失败（客户端半边的 import 解析不了），只能由真机加载与 `pnpm test` 之外的那些步骤发现。
