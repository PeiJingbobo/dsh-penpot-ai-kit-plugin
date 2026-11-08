# dsh-penpot-ai-kit-plugin

[![Sync upstream & release](https://github.com/PeiJingbobo/dsh-penpot-ai-kit-plugin/actions/workflows/sync-and-release.yml/badge.svg)](https://github.com/PeiJingbobo/dsh-penpot-ai-kit-plugin/actions/workflows/sync-and-release.yml)
[![Upstream](https://img.shields.io/badge/upstream-penpot%2Fpenpot--ai--kit-8b5cf6)](https://github.com/penpot/penpot-ai-kit)
[![License](https://img.shields.io/badge/license-MIT%20(code)%20%2F%20CC--BY--4.0%20(content)-green)](#license)

把 [penpot/penpot-ai-kit](https://github.com/penpot/penpot-ai-kit) 的 14 个设计技能做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生 skill bundle，并加了一层 **MCP 门禁**：

> 没有可用的 Penpot MCP，就不进入 Penpot 工作流。
> 此时技能目录里只剩 `penpot-setup`，会话首步会收到一条 durable 规则提醒：**必须拒绝设计请求，并引导用户配置**。配置好之后，14 个技能才会出现。

- **零运行时依赖**、无构建步骤、纯 ESM。`dsh plugin add` 不会触发 build 脚本审批。
- **跟随上游**：`scripts/sync-upstream.mjs` 覆盖 `skills/ shared/ policies/ workflows/ prompts/ skills.json`，写 `UPSTREAM.json`；`--check` 落后即 `exit 1`。
- **自动发版**：GitHub Actions 每 6 小时轮询上游，版本取上游 `skills.json`，测试 → 打包 → `gh release create v<version>`。

---

## 已验证 / 降级方案

两个 spike 都在 **Linux Docker（`node:22-alpine`）** 里跑，挂载本机 DSH profile 的 `@deepseek-ai/*`（`0.1.1-rc.2`）与真实 `@deepseek-ai/dsh-mcp-client`，没有启动本机 DSH。

### Spike (a)：嵌套挂载 MCP client —— 7/7 通过

问题：bundle 插件能不能在 `apply()` 里 `ctx.plugin(@deepseek-ai/dsh-mcp-client, config)`，让 `mcp__penpot__*` 真正注册到 `ctx.tools`？

结论：**能**。用真实的 `Context` + `SystemPrompt` + `ToolRuntime` + 一个 Streamable HTTP 的假 Penpot MCP server 验证：

| 检查 | 结果 |
|---|---|
| 嵌套挂载后注册 `mcp__penpot__{high_level_overview,execute_code,export_shape}` | ✅ 3 个 |
| 通过 `ctx.tools.execute()` 调用嵌套注册的工具 | ✅ 返回 MCP 结果 |
| dispose 子 fiber 后工具全部注销 | ✅ 0 个残留 |
| URL 不可达 + `failOnStartupError: false` 不拒绝宿主启动 | ✅ 无异常、0 工具 |
| 重复 `serverName` 的第二个实例在 load 时被拒绝，第一个不受影响 | ✅ 抛错且保留 3 个工具 |
| 宿主 `ctx.plugin()` 返回值可 await、可 dispose | ✅ |

正式实现采用 **`failOnStartupError: true` + try/catch**：连接失败时子 fiber 回滚，gate 拿到真实 cause（如 `fetch failed`），宿主照常启动；比静默“0 工具”更容易诊断。

### Spike (b)：14 个 SKILL.md 引用完整性 —— 0 缺失

上游快照 `fe4f99e`（v0.5.1，14 个 skills，103 条 `requires`）：

| 扫描对象 | 数量 | 缺失 |
|---|---|---|
| `skills/ shared/ policies/ workflows/ prompts/` 文本文件 | 194 个 | — |
| 相对路径引用（`shared/ references/ scripts/ workflows/ prompts/ policies/`） | 704 个（去重前） | **0** |
| frontmatter `requires:` 条目 | 103 | **0** |

两个必须处理的“坑”，已经写进实现和 `scripts/check-refs.mjs`：

1. **一个 `resourceBase` 解析两个根**。`shared/…`、`policies/…`、`workflows/…`、`prompts/…` 相对 kit 根；`references/…`、`scripts/…` 相对技能目录。因此 `get()` 返回 `resourceBase.path = 包根`，并在渲染时把技能内相对路径重写成 `skills/<name>/references/…`（文件本身逐字节保持上游原样）。
2. **跨技能引用**。例如 `penpot-build-deck` 的正文引用 `references/04-deck-tells.md`，该文件实际在 `penpot-anti-slop` 里。重写器会按“本技能目录 → 其他技能目录”解析，而不是盲目拼本技能路径。
3. **开发脚本不是发行内容**。`scripts/dev/*.mjs` 属于上游仓库的开发工具，不在 vendored 清单里；`check-refs` 显式排除，其余 `scripts/` 引用全部校验。

### 降级方案（已内建）

如果运行环境里动态 `import('@deepseek-ai/dsh-mcp-client')` 失败、或宿主没有 `ctx.plugin`：

- 插件**不会**抛错，也不会让宿主启动失败；
- gate 进入 **probe-only** 形态：只探测 `ctx.tools` 中是否已有 `mcp__<serverName>__*`（即 profile 里静态配置了 mcp-client loader row 的情况），自身不挂载；
- `penpot_kit_status.error` 会明确写出“cannot load …”或“no ctx.plugin()”；
- 门禁保持关闭：目录里只有 `penpot-setup`。

也就是说，动态挂载是首选路径，静态 loader row 是天然可用的降级路径；两条路径共用同一个“工具存在即放行”的判定。

---

## 安装

```sh
# 从 git 安装（纯 ESM，无依赖，无 build）
dsh plugin add github:PeiJingbobo/dsh-penpot-ai-kit-plugin

# 或者下载 Release 的 tarball
gh release download --repo PeiJingbobo/dsh-penpot-ai-kit-plugin -p '*.tgz'
dsh plugin add ./dsh-penpot-ai-kit-plugin-*.tgz

# 或本地目录（开发）
dsh plugin add /path/to/dsh-penpot-ai-kit-plugin
```

启动后日志：

```
dsh-penpot-ai-kit-plugin: gate closed (0 mcp__penpot__* tools; config ~/.dsh/penpot-ai-kit/config.json)
dsh-penpot-ai-kit-plugin: serving only "penpot-setup" until a Penpot MCP config exists at ...
```

### 从旧包名升级（v0.5.1-dsh.1 / dsh.2）

早期版本的包名是 `dsh-penpot-ai-kit`，与仓库名不一致；两者会作为两个 bundle 同时存在，必须先移除旧包：

```sh
dsh plugin remove dsh-penpot-ai-kit
dsh plugin add github:PeiJingbobo/dsh-penpot-ai-kit-plugin
```

`v0.5.1-dsh.3` 起包名、bundle row 与 tarball 统一为 `dsh-penpot-ai-kit-plugin`。

## 配置

默认路径 `~/.dsh/penpot-ai-kit/config.json`（`PENPOT_AI_KIT_CONFIG` 可覆盖为绝对路径），权限必须是 `0600`（含 token；启动时权限过宽只告警，不阻断）：

```json
{
  "version": 1,
  "mcp": {
    "serverName": "penpot",
    "transport": "streamable-http",
    "url": "http://localhost:4401/mcp",
    "headers": {},
    "toolCallTimeoutMs": 120000
  }
}
```

Penpot SaaS 用 `https://design.penpot.app/mcp/stream?userToken=YOUR_MCP_KEY`。

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 是 | 固定 `1` |
| `mcp.serverName` | 否 | 默认 `penpot`；`[A-Za-z0-9_-]{1,32}` |
| `mcp.transport` | 否 | `streamable-http`（默认，有 `url` 时）或 `stdio` |
| `mcp.url` | http 必填 | `http(s)://` |
| `mcp.headers` | 否 | 字符串键值对 |
| `mcp.toolCallTimeoutMs` | 否 | 默认 `120000` |
| `mcp.command` / `args` / `env` / `cwd` | stdio 必填/可选 | 走 stdio bridge 时使用 |

校验是**严格**的：未知字段、类型错误、非法 URL 都会变成 `penpot_kit_status.error`，而不是静默回退。

```sh
mkdir -p ~/.dsh/penpot-ai-kit
chmod 700 ~/.dsh/penpot-ai-kit
$EDITOR ~/.dsh/penpot-ai-kit/config.json
chmod 600 ~/.dsh/penpot-ai-kit/config.json
```

启动顺序：读配置 → 若 `ctx.tools` 已有 `mcp__<serverName>__*` 则复用 → 否则动态挂载 `dsh-mcp-client`（最多等 `connectTimeoutMs`，默认 10s）→ 注册 provider / `penpot_kit_status` / durable 提醒。任何一步失败都只关小门，不阻断宿主。

## 门禁行为

| 层 | 无可用 MCP | 有可用 MCP |
|---|---|---|
| 技能目录 | 只有 `penpot-setup` | 14 个上游技能 + `penpot-setup` |
| `skill({name})` 加载 | 上游技能返回 unknown；`penpot-setup` 可加载 | 全部可加载 |
| 会话首步 | 注入一次 durable `<EXTREMELY_IMPORTANT>`：不得执行任何 Penpot 设计操作，必须拒绝并引导配置 | 不注入 |
| `penpot_kit_status` | `configured/connected=false`，带 `error` 与 `configPath` | `connected=true`，`toolCount>0`，`error=null` |
| MCP 工具调用 | 模型看不到 Penpot 工具（也不应调用） | `mcp__penpot__*` 正常 |

`penpot_kit_status` 的 canonical 输出（也是模型看到的 JSON）：

```json
{
  "configured": true,
  "connected": true,
  "serverName": "penpot",
  "toolCount": 3,
  "error": null,
  "configPath": "/Users/you/.dsh/penpot-ai-kit/config.json"
}
```

`penpot-setup` 会调用 status、给出要写的文件路径、可粘贴的 JSON、`chmod 600`、重启与验证步骤。配置在宿主启动后才创建时，调用一次 status 会自动重新读取并尝试挂载（self-heal）。

## 上游同步

```sh
node scripts/sync-upstream.mjs              # 从 UPSTREAM.json 拉取并覆盖 vendored 内容
node scripts/sync-upstream.mjs --check      # 只检查漂移，落后 exit 1
node scripts/sync-upstream.mjs --from ../penpot-ai-kit   # 从本地克隆同步（离线）
node scripts/sync-upstream.mjs --repo <url> --ref <branch>
node scripts/check-refs.mjs                 # 引用完整性（CI 也跑）
```

- 覆盖 `skills/ shared/ policies/ workflows/ prompts/ skills.json`，刷新 `LICENSE-PENPOT`。
- 写 `UPSTREAM.json`：`{repo, ref, commit, upstreamVersion, syncedAt}`；tracking facts 不变时不改文件（避免 CI 空 commit）。
- 版本：`package.json.version` 默认等于上游版本；本地修订用 `-dsh.N` 后缀。上游版本变化时 sync 会改成纯上游版本，重新开始本地修订。
- provider 监听 `skills/`，同步后运行中的 harness 无需重启即可刷新目录。

`.github/workflows/sync-and-release.yml`：

| 触发 | 行为 |
|---|---|
| `push` main | sync → 提交漂移 → `node --test` → `check-refs` → `npm pack` → 版本 tag 不存在则 release |
| `schedule` `'23 */6 * * *'` | 轮询上游；有更新则提交并发版 |
| `workflow_dispatch` | 手动，可选 `repo` / `ref` |

`permissions: contents: write`，`concurrency.cancel-in-progress: false`（不取消进行中的同步/发版）。

## 测试

```sh
node --test test/*.test.mjs
```

覆盖：配置校验/缺失/权限、frontmatter（14 个真实文件 + 引号/数组/块序列边界）、门禁目录裁剪、`resourceBase` 与跨技能引用、`penpot_kit_status` 返回、durable 提醒只注入一次、bad URL、tools/change 失效、self-heal。

`test/integration.test.mjs` 需要能 import `@deepseek-ai/*`；在普通 checkout 上自动 skip，在 Docker 验证镜像里跑真实嵌套挂载 + 真实 mcp-client：

```sh
docker run --rm \
  -v "$PWD":/work \
  -v "$HOME/.dsh/profiles/node_modules":/work/node_modules:ro \
  -v /path/to/deepseek-harness:/path/to/deepseek-harness:ro \
  -w /work node:22-alpine node --test test/*.test.mjs
```

## 目录结构

```
index.js                      bundle 入口：apply / provider / status / reminder
lib/config.mjs                配置路径、加载、严格校验
lib/frontmatter.mjs           SKILL.md frontmatter 子集解析
lib/gate.mjs                  MCP 探测、嵌套挂载、状态机
lib/provider.mjs              门禁目录裁剪、resourceBase、路径重写、watch
lib/reminder.mjs              durable 首步提醒
skills/ shared/ policies/     vendored 上游内容（逐字节一致）
workflows/ prompts/ skills.json
skills-local/penpot-setup/    本地 setup 技能（门禁关闭时唯一可见）
scripts/sync-upstream.mjs     上游同步 / --check
scripts/check-refs.mjs        引用完整性
test/                         node:test 套件
UPSTREAM.json                 上游 commit / 版本 / 同步时间
cordis.patch.yml             dsh.bundle patch
```

## 已知边界

- `connected` 的判定是“工具注册表里有 `mcp__<serverName>__*`”。服务连上但一个工具都不暴露时，按不可用处理（`error` 会说明）。
- `stdio` transport 支持配置，但默认验收路径是 `streamable-http`；远程 URL 的 token 建议放在 URL 或 `headers` 里，文件权限 0600。
- `penpot-setup` 不会替用户写配置；它输出路径/样例/验证方法，写入由用户完成（避免把 token 写进项目或会话）。
- 上游 `templates/ docs/ evals/` 未 vendored（技能正文不引用它们；`check-refs` 会持续守住这一点）。

## License

- 本仓库的插件代码：MIT，见 [LICENSE](LICENSE)。
- vendored 的 Penpot AI Kit 内容：**CC-BY-4.0**，版权归 Penpot，见 [LICENSE-PENPOT](LICENSE-PENPOT) 与 [上游仓库](https://github.com/penpot/penpot-ai-kit)。
