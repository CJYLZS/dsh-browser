# Agent Note: 工具面：6 个工具与"以代码为主"的原则

Status: implemented

## Problem

要给 agent 一组刚好够用的浏览器工具。工具太多会稀释注意力，而缺了可信输入就只能靠 `browser_evaluate` 手写脚本——贵且脆。

## Decision

6 个：`browser_navigate`、`browser_snapshot`（ARIA 树 + ref，既是"不写代码也能看懂页面"的唯一途径，也是 click/type 的 ref 来源）、`browser_click`、`browser_type`（可信的真实输入，`element.click()` 不是可信事件）、`browser_screenshot`、`browser_evaluate`（主力与兜底）。其余留给 evaluate：back/forward、hover/drag/select/upload/download、`wait_for`、标签管理都不单独给工具。

## 工具集（2026-09-23 定）

原则：以 ZCode 内置浏览器能力为参照，只保留必要工具，**以代码工具为主**（evaluate 是主力，工具是那些代码做不好或做不对的事）。

| 工具 | 为什么必要 |
|---|---|
| `browser_navigate` | 已有。唯一的导航入口 |
| `browser_snapshot` | 新增。返回 ARIA/AX 树（ZCode 的主读法：`domSnapshot`）。这是"不写代码也能看懂页面"的唯一途径，也是给 click/type 提供稳定坐标（ref/选择器）的来源 |
| `browser_click` | 新增。按 ref/选择器点击，走插件已有的 CDP 输入通道，是**真实**鼠标事件；`evaluate` 里的 `element.click()` 不是可信事件，会被部分站点忽略 |
| `browser_type` | 新增。按 ref/选择器输入，走真实按键（`Input.insertText`）；`key` 参数覆盖 Enter/Tab 这类提交键 |
| `browser_screenshot` | 已有。视觉判断（布局、图表、canvas）没有代码替代品 |
| `browser_evaluate` | 已有。主力与兜底：取值、跑逻辑、滚动、`history.back()`、等待条件…… |

明确**不做**的（用 evaluate 或上面六个覆盖）：back/forward/reload（reload 在面板上有，back 用 `history.back()`）、hover/drag/select/upload/download（各自只在真需要时再加）、`wait_for`（轮询写在 evaluate 里更灵活）、hover 相关的悬停菜单（真遇到再加）。新标签页不单独给工具：插件跟随新页面并把标签摘要放进 navigate/snapshot 的结果里，等确有需要再加 `browser_tabs`。

理由：ZCode 的面很宽（约 40 个成员）是因为它是给模型直接写 Playwright 用的 SDK；DSH 这边有 `browser_evaluate`，等价能力用代码表达即可，工具只补代码表达不了的语义（可信输入、ARIA 读取）。

## Alternatives considered

**照 ZCode 的 SDK 面（约 40 个成员）**：那是给模型直接写 Playwright 用的 SDK，而 DSH 这边有 `browser_evaluate`，等价能力用代码表达即可，工具只补代码表达不了的语义（可信输入、ARIA 读取）。

## Consequences

新能力优先做成参数而不是新工具名——这条在后面每一轮都被遵守（`force`、`target`、`depth` 都是参数）。工具数量至今仍是 6。
