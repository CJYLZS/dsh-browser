# Agent Note: 设置页的样式只用主题 token

Status: implemented

## Problem

切到浅色模式后，浏览器设置页的每一行都读不出来：插件自造了 `--dsh-border`、`--dsh-input-background`、`--dsh-danger`、`--dsh-button-background` 四个名字，而 harness 的主题只定义 `--dsw-*`。名字没有定义时 `var()` 会退到逗号后面的兜底值，那几个兜底恰好都是深色（`#1b1f24`、`#333b44`、`#e06c75`、`#2b6cb0`），于是深色模式下看着完全正常、浅色模式下输入框仍是近黑底而文字继承成近黑字。同一个插件里 `view.tsx` 用的是真的 `--dsw-alias-*`，所以只有设置页坏了——这也说明这个缺陷不会在深色模式下暴露，任何人只按一种主题看都会漏掉。

## Decision

两半的样式只用 ui-theme 的 `--dsw-*` 语义 token，材料照官方设置页抄：控件 `--dsw-alias-bg-layer-3` + `0.5px var(--dsw-alias-border-l4)` + `var(--dsw-radius-md)`，标签 13px/500 `label-primary`，说明 12px `label-tertiary`，卡片 `var(--dsw-radius-xl)` + `settings-card-fill`/`settings-card-stroke`，错误文字 `state-error-primary`，焦点用 `state-business-primary`（与 `ConfigField`/`fields.module.css` 逐条相同）。**`var()` 里不再写兜底**：缺一个 token 时要立刻看得出来，而不是悄悄退回一个只适合某一模式的常量。用的名字由 `test/client-tokens.test.ts` 双向钉住——出现新名字要改清单，清单里不再用的名字要删。

## Alternatives considered

**直接用 ui-primitives 的 `SettingsForm` + `SettingsValueField`**：那是官方给插件设置页的现成框与控件，但它按“暂存草稿、点保存才写、卸载即丢弃”设计（`fields.tsx` 的头注释），而这个插件的设置页是即时写入、靠状态横幅给出“生效”的证据——改用它等于换掉已定的交互，不是这次要修的东西。剩下四个枚举字段（窗口模式、浏览器、Profile、自动化标记）官方也没有对应的选择控件，混用两套控件反而更不统一。**给插件加自己的 CSS 文件**：本插件在 harness 的样式管线之外构建（tsdown 直接出 `lib/client.js`），CSS import 没有属主，内联是既定前提。**在内联样式里按 `prefers-color-scheme` 分支**：那正是 web-styling.md 禁止的“在功能组件里写主题分支”，而且会把主题归属从 ui-theme 挪到插件里。

## Consequences

- 浅色与深色都由主题决定，插件不再持有任何颜色常量（面板里覆盖在镜像页上的那层深色遮罩与画布底色是有意的例外：它们压在页面内容上，不属于主题 chrome）。
- 回归有牙：`test/client-tokens.test.ts` 三条——每个 `var(--…)` 必须是清单里的名字、不得带兜底、清单里的名字必须都还在用。
- 代价：harness 改名一个 token 时，插件会以“声明无效、该属性丢失”的样子暴露（而不是静默退回深色），这只能靠真机加载发现——本仓库的单测看不到主题。
