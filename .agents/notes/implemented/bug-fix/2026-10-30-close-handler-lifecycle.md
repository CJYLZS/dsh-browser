# Agent Note: 关闭 handler 的生命周期归插件 fiber

Status: implemented

## Problem

同一页面里第二次加载这个插件时，`apply()` 抛 `sidebarRight: close handler already registered for cdpBrowser`，插件条目进 `FAILED`，此后该页的浏览器面板挂不上、`browser_*` 工具不可用，热重载也救不回来，只能整页刷新。这是 [issue #1](https://github.com/CJYLZS/dsh-browser/issues/1) 报的形状（0.2.3，Desktop + `patchReload: "live"`），`registerCloseHandler` 的守卫与 `closeHandlers` 那个 Map 我都在 `@deepseek-ai/dsh-client-ui-sidebar-right` 里核对过：守卫是 `has(kind)` 即抛，Map 挂在常驻的 `SidebarRightController` 上，比插件 fiber 活得久。

根因是**一次性**的：`registerCloseHandler` 的契约写明返回 "an effect-scoped unregister callback"，而 `apply()` 里只有这一处裸调用、把返回的注销函数丢掉了——同一函数里 locale、`sidebarRightTabs`、两个 slot 注入、设置页五处都包了 `ctx.effect`。丢了注销函数，Map 就永远留着 `cdpBrowser` 这一项。

这个缺陷只会在**第二次** `apply()` 时才现形，而触发第二次的路径有三条：设置页的「重试本页同步」（`ClientEntries.retry()`）、HMR 的 `reload(id, rev)`、`reconcile()` 的 `replace()`。更糟的是 `reconcile` 会在每一轮都重新 apply 那个已失败的条目，所以错误是粘住的。

## Decision

`src/client/close.ts` 的 `followPageCloses(ctx)` 用 `ctx.effect(...)` 注册，标签 `'dsh-browser: close handler'`；`index.ts` 只调用这个函数，**不再直接出现 `registerCloseHandler`**。handler 的内容一个字没动：仍然从 `tab.contentId` 解出 target id、`markClosing` 记账、`closePageRequest` 发出关闭；guide 入口那种不指向任何页面的 tab 仍然什么都不做。

抽成独立模块不是为了好看，是为了**能被测试**：`index.ts` import 了 `view.tsx` / `settings.tsx`，Node 的类型剥离加载不了 `.tsx`，所以 `apply()` 本身进不了 `node --test`。`definition.ts` 把图标作为入参收下、`reveal.ts` 自己持有 `ctx.effect`，是同一条分工——能被 Node import 的模块里，注册与它的生命周期成对出现。

## Testing

`test/client-close.test.ts` 用**真的 cordis fiber**（`root.plugin()` / `fiber.dispose()`）跑 `关闭 → 卸载 → 再关闭` 三轮，把 `sidebarRight` 换成一个照抄真件守卫与注销回调的假 controller。修之前三条红、报错原文就是 issue 里那句；修之后五条绿。除了「二次加载不抛」，另外两条钉住了修法不会退化成两种假绿：**加载期间 handler 确实在**（什么都没注册也能骗过"不抛"），以及**卸载后 Map 干净**（注册了但没进 effect 也骗不过这一条）。handler 的行为另有用例覆盖——重载之后那一个 handler 仍按页面而不是按 tab 关闭、guide 入口仍然不发送任何请求。

`pnpm test` 全绿（497 条）。真机那一半不适用：这是客户端半边的注册生命周期，`scripts/` 里的回归在真浏览器上跑的是工具层。

## Alternatives considered

- **只加 try/catch 或 `if (has(kind)) return`。** 让第二次不抛，但注销函数仍然没人管，Map 里那一项永远属于**第一次**加载的那个闭包——此后每次加载都用第一个 fiber 的 handler，卸载后仍然在。这是把症状藏起来，而且假件只要断言"handler 属于这一次加载"就会红。
- **在 `apply()` 里手工调一次注销。** 没有卸载钩子可挂：`apply()` 不是 async、也拿不到 fiber 的 dispose 时机，唯一的出口就是 `ctx.effect`。
- **把注册移到 `inject` 惰性路径上（等 `sidebarRight` 出现再注册）。** 服务已经在 `inject` 里声明为必需项，插件只在服务齐全时才跑；搬到惰性路径不改变生命周期问题，只是让注册时机难懂。
- **改成"每个 kind 允许多个 handler"（改上游 Sidebar）。** 那是另一个包的决定，而且会让"关闭 tab 时调哪个 handler"变成需要排序的语义。这里的契约本来就是 effect-scoped 的单占位注册。

## Consequences

- 注册的生命周期与 fiber 对齐后，三条重载路径（重试、HMR、reconcile 的 replace）都幂等。
- `index.ts` 不再直接 import `markClosing` / `targetIdOf` / `closePageRequest` / `BROWSER_KIND`，这些挪到了 `close.ts`；`BROWSER_KIND` 在 `index.ts` 里仍由 `browserDefinition` 间接使用，但 import 行已按 `noUnusedLocals` 收窄。
- 代价是模块边界多了一层：想知道"关 tab 做了什么"要打开 `close.ts` 而不是 `index.ts`。对这条规则来说反而更好找——`reveal.ts` 已经是同样的形状。
- 这条经验有普适性：**凡是 `ctx.<service>.register(...)` 返回 disposer 的调用，都必须出现在 `ctx.effect` 里**，否则缺陷只在第二次 apply 时出现。issue 里作者也提了这条，`apply()` 现在没有第二处裸调用了。
