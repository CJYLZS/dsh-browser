# Agent Note: 设置页两层布局与折叠可见性

Status: implemented

## Problem

12 个字段平铺在一页上，而普通用户不需要碰其中大多数。

## Decision

按"是否影响浏览器能不能起来"分两层：常显的只有窗口模式、浏览器、Profile 三项，其余折进「高级设置」的三块里。字段表离开组件（`src/client/settings-layout.ts`），新增字段要同时登记 `FIELD_PLACEMENTS` 与 `FIELD_COPY`，控件那侧由 `unreachableField(field: never)` 兜底（漏写控件 `tsc` 直接失败）。**折叠会连重置按钮一起藏起来**，所以 summary 必须带"n 项已自定义"的计数，否则改过的高级项从合上的页面完全看不出来。

起因：P1 往页面里加了两行之后，设置页变成 11 个控件平铺 —— 常用项和"装错了才会去动"的项混在一起，还各自带一段解释，视觉上就是一团。

## 决定：按"是否影响能不能用"分两层

- **常显（3 项）**：窗口模式、浏览器（Chrome/Edge）、Profile（临时/长期，选了长期才出现目录输入框）。这三项决定"浏览器能不能起来、登录态留不留"，出问题时用户第一眼要能看到。
- **折进「高级设置」（8 项，三块）**：
  - 浏览器进程：自动化标记、可执行文件路径、CDP 端口；
  - 镜像与页面尺寸：宽、高、画质；
  - Agent 快照：打印哪些属性、忽略哪些选择器。
- `channel` 没有折进去：机器上只装了 Edge 时，它是"起不来"的直接修法，藏在折叠里等于把故障排除路径也藏了。

## 决定：折叠里的改动必须还看得见

折叠会把重置按钮一起藏起来，`user` 层持有高级字段时从合上的页面完全看不出来。所以 summary 上带计数（`高级设置 · 2 项已自定义`）。默认不自动展开：自动展开会让"某人改过一次"永久改变页面形状。

顺带把状态横幅里的会话明细也收进 `<details>`：常显的仍然是"有几个在跑"，逐会话的 CDP 端口/页数点开才看。

## 实现：布局表离开组件

- `src/client/settings-layout.ts`（新）：`FIELD_PLACEMENTS`（字段→分组，一行一个字段）、`FIELD_COPY` / `GROUP_COPY` / `PROFILE_DIR_COPY`（标签与提示的 key）、`ADVANCED_GROUPS`，以及从组件里搬出来的纯函数 `statusLine` / `instanceLine` / `advancedSummary` / `overriddenCount`。
- `settings.tsx` 只负责把 placement 变成控件：`placementsIn(group).map(placedRow)`，控件本身是一个对 `keyof BrowserSettingsView` 穷尽的 switch，兜底调 `unreachableField(field: never)` —— 加字段忘了写控件，`tsc` 直接报 `TS2345`（已实测：把 `case 'quality'` 改名后 typecheck 立刻失败）。`settings-layout.ts` 用块级 `<section aria-label>` 而不是 `<h4>`：设置页本身没有文档大纲，在这里发明标题层级只会让读屏的层级更乱。
- copy 变了：新增 `settingsAdvanced*`、`settingsGroup*`、`settingsSessionsCount`；删掉不再用的 `settingsPage`；`settingsWidth`/`settingsHeight` 从 aria-label 变成可见标签；`settingsExecutable` 的中文去掉"上面的选择"（那个选择现在在折叠外面）。
- 测试 `test/settings-layout.test.ts`（11 例）：字段表 == schema 里 volatile 的那批字段（新增配置项忘了上页面会失败）、每字段只放一次、可视层恰好是那三项、每个放置都落在页面真会渲染的块里、放下的字段都有两种语言的标签、折叠计数、状态横幅与会话行的文案。

## 顺带确认：客户端产物是热更新的

改完 `lib/client.js` 之后**不需要重启 host**：`@deepseek-ai/dsh-client-hmr`（web-app preset 里的一行，500ms stat 轮询）比对 mtime/ctime/size，把新一代 bundle 推进 `clientModules` 并沿 `/plugins/events` SSE 通知页面。实测：`pnpm run build` 之后用 mirror 浏览器（未经认证也可访问 `/plugins/`）取 `/plugins/??dsh-browser/client.js&rev=<rev>`，两次构建各自可达且内容不同（`rev = sha1("plugin-artifact\0" + framed(mtimeMs, ctimeMs, size))` 前 12 位）。所以这一轮改的是客户端半边时，只有 host 半边（`lib/index.js`、配置 schema）才需要重载插件。

---

## Alternatives considered

**继续平铺**：普通用户被 12 个字段劝退，而其中 8 项只在排查时才需要。**只折叠、不加计数**：用户改过的高级项从合上的页面上完全不可见，等于把状态藏了起来。

## Consequences

设置页的"生效证据"（见设置页笔记）与两层布局共同成立：常显的是"能不能起来"，折叠里的是"怎么起来"。客户端产物走 `dsh-client-hmr` 热更新，改客户端半边不必重启 host；改 `lib/index.js`（host 半边、配置 schema）才需要重载插件。
