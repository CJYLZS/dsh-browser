# Agent Notes

本目录放**决策记录**（Agent Note）：一个决定了本仓库形状或行为的取舍，连同它的理由、被放弃的替代方案、代价和验证方式。代码、测试和 README 能自己说明的部分不写在这里；写在这里的是**为什么这么定、放弃了什么**。

## 位置与命名

路径同时编码两个轴：`{lifecycle}/{class}/yyyy-mm-dd-<slug>.md`。

- **lifecycle**（顶层目录）是状态，笔记随状态在目录间移动：
  - **`proposed/`** —— 还没落地（或只落了一半）的方案。
  - **`implemented/`** —— 已发货的决定。它描述**当前现实**（现在时），并随现实更新：代码搬了文件、改了名字、换了默认值，笔记在同一次改动里跟着改（只改事实，不改决定）。
  - **`rejected/`** —— 考虑过并否决的方案。只有当它还能挡住一个很有诱惑力的错误时才保留。
- **class**（第二层）是决定的种类，取值是一个封闭集合：`feature`（新的用户/模型可见能力）、`bug-fix`（修缺陷或补上一则记录暴露的缺口）、`simplification`（删代码/行为/面积而不加能力）、`architecture`（已发布源码的结构决定）、`process`（围绕代码的工具、政策、流程）、`testing`（测试设施与策略）。

文件名里的日期是**这个话题第一次被提出**的那天。笔记之间用相对 Markdown 链接互指，不要写裸编号——链接是可机械检查的，也能在目录迁移后继续有效。

本目录就是全部索引：按 lifecycle/class 浏览或用 `rg` 搜，**不要**再建 `INDEX.md`。

## 什么时候写

只写"代码、测试和已有文档都说不清"的持久理由。一次决定已经做出就写进 `implemented/`，还没做就写进 `proposed/`；已经在 `implemented/` 里拥有该决定的笔记，就更新它，不要新建重复的。纯机械改动、局部 UI 调整不必开笔记。

**每写一篇新笔记都要做一次取代检查**：搜一遍活跃目录里是否已有覆盖同一决定的笔记。完全被取代的 `implemented/` 笔记可以并入当前的笔记后删除（删除前必须把它独有的理由、替代方案、代价、验证与已知缺口都搬过去）；部分取代则两篇都留着并互相链接。**永远不要**把一篇笔记编辑成另一个决定。

## 文件格式

前两行固定，且 `Status:` 必须与所在 lifecycle 目录一致：

```markdown
# Agent Note: <标题>

Status: implemented
```

`Status:` 只有三种形式：`Status: proposed`、`Status: implemented`、`Status: rejected — <一行理由>`。状态行不带日期、不带括号说明。

正文按 lifecycle 用固定骨架，常设小节用下面这些名字，技术性小节（包结构、协议契约、schema）在它们之间自由命名：

- `implemented/`：`## Problem` → `## Decision` → …自定义小节… → `## Alternatives considered` → `## Consequences`。`## Decision` 用现在时描述已发货的现实；`## Proposal`、`## Plan`、`## Migration plan`、`## Acceptance criteria` 这类提案口气的小节不得出现在这里。需要时可以加 `## Testing`、`## Deferred`、`## Related`。
- `proposed/`：`## Problem` → `## Proposal` → …自定义小节… → `## Alternatives considered` → `## Acceptance criteria` → `## Risks`。`## Proposal` 可以用将来时。
- `rejected/`：保留提案时期的小节，判决写在 `Status:` 行。

**`## Alternatives considered` 是必填的**：每个真实的替代方案与它为什么输了，一段一个。没有记录替代方案的决定会招来重复争论，这正是笔记要防的失败。替代方案是**记录**出来的，不是编出来的；确实无法从记录中还原时，用这一行原样代替该小节：

```markdown
<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
```

正文用中文写；`# Agent Note: ` 与 `Status:` 这两个 token 保持英文原样。

## 与其他层的关系

**一个事实只有一个家**：常驻规则在根 `AGENTS.md`，使用方法在 `README.md` / `README.zh.md`，衡量与对拍产物在 `.prove/`，决定与理由在本目录。别处需要时**链接过去**，不要复述。
