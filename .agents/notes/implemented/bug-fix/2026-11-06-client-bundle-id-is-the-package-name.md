# Agent Note: client bundle 的注册 id 必须是包名

Status: implemented

## Problem

issue #2（Linux）报告的启动失败：

```text
web boot: 1 entry did not activate
@cjylzs/dsh-browser: import failed: client-modules: could not load "@cjylzs/dsh-browser": plugins/??…&rev=bd87
```

（用户写的 `0.2.2.rc1` 是 **dsh 的版本**，不是插件的版本；插件从 npm 装，只会是 0.3.0 或 0.3.1。）

harness 的 client module 系统按 **`package.json` 的 `name`** 给每条 boot row 建键：`packages/client/modules` 里 `graphRow(packageName, …)` 决定 entry id，浏览器侧 `arrive()` 用 `factories.has(row.id)` 判断"这一行到了没有"。bundle 通过 `window.__ModuleLoader__.load({ id, factory })` 注册，注册用的 id 就是 `factories` 的键。

于是注册 id 与 row id 不等时，**脚本执行成功、行没有被注册**：

1. 先记一条 `loaded without registering "@cjylzs/dsh-browser"`，退到这一行的单资源 URL 重试；
2. 单资源 URL 是同一个文件，第二次执行又用错的 id 注册，于是再抛 `duplicate factory registration for "dsh-browser"`；
3. 两次都失败，`arrive()` 抛 `could not load`，整条插件从 boot 里消失——没有侧栏、没有设置页，host 侧的工具还在。

根因是一次改名只改了一半：0.3.0 换成 scoped 名（`dsh-browser` → `@cjylzs/dsh-browser`）时只改了 `package.json`，`tsdown.config.ts` 里手抄的 `PLUGIN_ID = 'dsh-browser'` 原样留着。所以 npm 上的 **0.3.0 与 0.3.1 都带一个注册成短名的 client.js**。

**这与 Linux 无关。** 在 Windows 上用 dsh 0.2.2-rc.1（隔离 `DSH_HOME` 的 web profile，按包名装）实测：把同一份产物的 id 改回 `dsh-browser`，浏览器 console 出现上面那两条一模一样的错误；改回包名，同一条 boot 静默通过。

## Decision

构建期从 `package.json` 读名字，不再手抄：

```ts
const PLUGIN_ID = (JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string }).name
```

## Testing

`test/artifact.test.ts` 在空上下文里执行 `lib/client.js`（只跑外层注册脚本，factory 不执行），断言 `__ModuleLoader__.load` 恰好被调用一次、且 id 等于 `package.json` 的 `name`。

**证明有牙**：把产物里的 id 改回 `dsh-browser`，用例红（错误消息点名"row 永远不会解析"）；重新 build 后绿。

真机（Windows，dsh 0.2.2-rc.1，`D:\dsh-verify` 隔离，端口 9060）：

| 产物 id | 浏览器 console | 插件 UI |
|---|---|---|
| `dsh-browser` | `web boot: 1 entry did not activate` + `duplicate factory registration for "dsh-browser"` | 无 |
| `@cjylzs/dsh-browser` | 空 | 设置页「浏览器」正常渲染，`GET /dsh-browser/status` 200 |

同一次真机里还核对了另一件容易搞混的事：profile 用裸别名装（`"dsh-browser": "file:…"`）时，boot row 的 id 仍然是 `@cjylzs/dsh-browser`（entry 的 `name` 来自 `cordis.patch.yml`），客户端照常加载——**别名不是缺陷的一部分**，两种装法都要的是包名 id。

## Alternatives considered

**只把常量改成 `'@cjylzs/dsh-browser'`。** 这次对了，但下一次改名或换 scope 会再漏一次，而漏掉的症状是"整条插件不启动"，构建不会报任何错。名字只有一个来源（`package.json`），构建期读它是最便宜的防重演。

**在 `dsh.client` 里声明一个 id。** 没有这个字段：`parseDshClient` 只认 `inject` / `external` / `immediately` / `platform`，而且 harness 的 row id 就是包名。加第二个来源只会多一处可能不一致。

**改 harness 让它接受短名。** 那要动上游，理由只有"我们自己的包曾经叫这个名字"。第三方插件同样会踩，但"bundle 注册自己的包名"本来就是公开约定，不值得为它开一个别名口子。

## Consequences

- 已发布的 0.3.0 / 0.3.1 都带这个缺陷，**必须发一个新版本**才修好；用户升级即可，配置不用动。
- `test/artifact.test.ts` 钉住的是**产物**而不是配置：以后谁手改 `lib/client.js`、或者换了构建脚本，都会在 `pnpm test` 里红。
- `BROWSER_ID = 'dsh-browser'`（侧栏 tab kind）、`cordis.patch.yml` 里那一行的 `id` 与 HTTP 路由前缀都是另一回事，保持原样——只有 bundle 注册用的 id 必须等于包名。
