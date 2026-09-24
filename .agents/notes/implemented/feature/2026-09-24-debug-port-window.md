# Agent Note: CDP 端口从单点改成范围

Status: implemented

## Problem

`debugPort` 是单值：同一台机器上第二个会话就会撞端口，而"换一个端口"当时意味着改配置并重启，等于关掉用户正在看的浏览器。

## Decision

`debugPortMin`/`debugPortMax` 是一段分配窗口，每实例一个端口，`PortAllocator` 取窗口内最小的可绑定端口并**持有**到浏览器关闭；窗口里没有空端口就报错并写出范围，绝不越界。**端口窗口不是 launch field**（`LAUNCH_FIELDS` 里故意没有它）：浏览器监听的是分配到的那个端口，改窗口只影响之后启动的浏览器。想知道某个会话在哪个端口，读 `/dsh-browser/status`，不要假设是配置里的值。

## 决定：`debugPort` → `debugPortMin`/`debugPortMax`

起因：用户指出这一个数字"意义有限"——每个会话各有一个浏览器、各自一个端口，一个数字不可能是地址。原来的语义是"起点 + 固定向上探 100 个"（`PORT_SCAN_RANGE`），上界藏在代码里；现在上界是配置值，默认 `9333`–`9400`。

- `PortAllocator` 改成吃 `PortWindow {low, high}`（`src/browser/ports.ts`），取窗口内最小的可绑定端口；`PORT_SCAN_RANGE` 删掉。窗口耗尽时报 `no free CDP port in <low>-<high>`，并说明可能是窗口比会话数窄——**绝不越界**，因为上界存在的意义就是别跑进这台机器上别的服务（本机 9430 就有别的服务）。
- `portWindow(min, max)` 会把两端排序：填反了是同一个窗口。为这个专门做一次报错（浏览器起不来）比直接用更糟。
- **端口窗口不是 launch field**：浏览器监听的是分配到的那个端口（`LaunchConfig.debugPort`，由 allocator 给），配置里的窗口只决定"下一台浏览器可以去哪"。所以改范围**不重启**正在跑的浏览器，只影响之后的分配合；已经发出去的端口继续被 allocator 持有，直到那台浏览器关闭。为此把 `LaunchConfig`（`BrowserConfig & { debugPort }`）从 `BrowserConfig` 里分出来，顺便消掉原来 `{...this.config, debugPort: this.port}` 里两个 `debugPort` 撞名的写法。
- schema 加 `.min(1)`：`0` 对 Chrome 是"随便挑一个端口"，而插件必须知道去哪附加（实测 `DevToolsActivePort` 在 pipe 在场时不写），所以 0 现在是非法值。
- 设置页两行（`CDP 端口范围（起）/（止）`），`FIELD_PLACEMENTS`/`FIELD_COPY` 照旧对账；折叠计数不受影响。
- 测试：`test/ports.test.ts` 重写（12 例，含"不越过上界""窗口只剩一个端口""两端填反""移动窗口后旧端口仍被持有"）；`config.test.ts` 增默认窗口 ≥ `maxInstances`、拒绝 0；`pool.test.ts` 增"改窗口不重启、下一台用新窗口"。

## Alternatives considered

**`--remote-debugging-port=0`**（让内核自选）：实测不可用，端口发现拿不到（见正文）。**改窗口就重启浏览器**：会把用户正在看的浏览器关掉，而改窗口的本意只是影响以后。

## Consequences

端口成了会话级资源，因此"谁拿哪个端口"必须由插件自己记账（分配串行、分配出去就算占用），设置页的实例列表也变成端口真相的唯一入口。
