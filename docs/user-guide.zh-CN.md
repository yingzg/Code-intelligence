# 用户指南

本文面向直接使用 Code Intelligence 的用户，覆盖本地数据目录、项目注册、索引和常见检索命令。

## 构建

```bash
bun install
npm run build
```

当前仓库使用 npm workspaces 和 TypeScript project references。已有构建产物后，可以直接用 Node 执行 CLI：

```bash
node packages/cli/dist/index.js where
```

如果后续通过 npm link 或包管理器安装了 CLI，也可以使用：

```bash
code-intel where
```

## 本地安装

开发目录中提供了本地安装脚本：

```bash
bash scripts/install-local.sh
```

脚本会完成三件事：

- 安装依赖并构建 TypeScript 产物。
- 创建默认数据目录 `~/.code-intelligence`。
- 在 `~/.local/bin` 下生成两个命令：
  - `code-intel`：CLI 命令。
  - `code-intel-mcp`：MCP Server stdio 启动命令。

如果 `~/.local/bin` 不在 PATH 中，添加：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

也可以自定义安装位置和数据目录：

```bash
CODE_INTEL_BIN_DIR=/usr/local/bin CODE_INTEL_HOME=/data/code-intel bash scripts/install-local.sh
```

## 查看数据目录

```bash
code-intel where
```

默认数据目录是：

```text
~/.code-intelligence
```

可以用 `CODE_INTEL_HOME` 指定：

```bash
CODE_INTEL_HOME=/tmp/code-intel code-intel where
```

## 注册项目

```bash
code-intel register trade-service /path/to/trade-service
```

也可以显式指定技术栈：

```bash
code-intel register trade-service /path/to/trade-service --stack java-spring-mybatis
```

当前支持的技术栈：

- `java-spring-mybatis`
- `java-spring`
- `java-dubbo-mybatis`
- `java-generic`

不传 `--stack` 时，工具会基于 `pom.xml`、Spring 注解、MyBatis XML/注解、Dubbo 注解等线索自动探测。

## 查看项目

```bash
code-intel projects
```

## 建立索引

```bash
code-intel index trade-service
```

这是推荐的默认用法。默认 `gitnexus-mode` 是 `auto`：

- 如果 GitNexus 索引不存在，且本地 GitNexus 可用，会自动执行基础 GitNexus 分析。
- 如果 GitNexus 索引已存在且状态可识别为最新，会直接复用，不重复跑重型分析。
- 如果 GitNexus 不可用，本地 Java 专项索引仍会生成，结果通常是 `partial`。

索引过程中 CLI 会把进度打印到 stderr，最终 JSON 结果仍打印到 stdout，方便脚本消费：

```text
[code-intel] gitnexus: started
[code-intel] route_index: completed 72000ms
[code-intel] sql_index: completed 18000ms
```

最终结果会包含：

- `gitnexus_mode`：本次使用的 GitNexus 模式。
- `counts`：每类本地索引的命中数量。
- `timings_ms`：每个阶段耗时。
- `warnings`：是否发生 GitNexus 不可用、索引缺失、能力降级等情况。

### GitNexus 索引模式

可以显式指定 GitNexus 模式：

```bash
code-intel index trade-service --gitnexus-mode auto
code-intel index trade-service --gitnexus-mode none
code-intel index trade-service --gitnexus-mode basic
code-intel index trade-service --gitnexus-mode full
```

| 模式 | 含义 | 适用场景 |
| --- | --- | --- |
| `auto` | 默认模式。缺索引或明确过期时自动跑基础 GitNexus 分析；已有可用索引时复用。 | 日常使用、低门槛默认用法、上层 Agent 默认触发。 |
| `none` | 不执行 GitNexus 分析，只生成 Code Intelligence 的 Java 专项索引。 | 已经手动跑过 GitNexus，或者只想快速刷新路由、SQL、错误码索引。 |
| `basic` | 强制执行基础 GitNexus 分析，等价于底层 `gitnexus analyze`。 | GitNexus 索引缺失、怀疑索引过期、需要刷新代码图谱。 |
| `full` | 强制执行完整 GitNexus 分析，等价于 `gitnexus analyze --embeddings --skills --pdg --verbose`。 | 面试演示、首次准备完整图谱、需要 embedding/skill/PDG 等增强能力。 |

旧参数仍然可用：

```bash
code-intel index trade-service --with-gitnexus
```

`--with-gitnexus` 是兼容旧脚本的写法，等价于：

```bash
code-intel index trade-service --gitnexus-mode basic
```

新脚本建议使用 `--gitnexus-mode`，语义更清楚。

### 建议用法

首次准备面试演示环境：

```bash
code-intel register trade-service /path/to/trade-service --stack java-spring-mybatis --gitnexus-repo <gitnexus-repo-label>
code-intel index trade-service --gitnexus-mode full
```

日常刷新索引：

```bash
code-intel index trade-service
```

只刷新 Code Intelligence 的 Java 专项索引，不碰 GitNexus：

```bash
code-intel index trade-service --gitnexus-mode none
```

## 常见检索

接口路由：

```bash
code-intel search trade-service --type route --query "/api/trade/order/detail" --json
code-intel search trade-service --type route --query "GET /api/trade/order/detail" --json
```

异常、错误码和日志：

```bash
code-intel search trade-service --type error --query "ClientAbortException" --json
code-intel search trade-service --type error --query "ORDER_STATUS_INVALID" --json
```

表名和 SQL：

```bash
code-intel search trade-service --type table --query "order_item_snapshot" --json
code-intel search trade-service --type sql --query "select count(*) from order_item_snapshot" --json
```

语义查询：

```bash
code-intel search trade-service --type semantic --query "订单详情页打开超时" --json
```

符号查询：

```bash
code-intel search trade-service --query "OrderController.detail" --json
```

不传 `--type` 时，工具会按查询文本自动分类。

## 单点探索：explore

`explore` 用于从一个真实线索出发探索代码上下文，比 `trace --from --to` 更适合排障初始阶段。

典型命令：

```bash
code-intel explore trade-service --query "ORDER_STATUS_INVALID" --direction upstream --depth 3 --limit 20
code-intel explore trade-service --query "/api/trade/order/detail" --direction downstream --depth 3 --limit 20
code-intel explore trade-service --query "order_item_snapshot" --direction upstream --depth 3 --limit 20
code-intel explore trade-service --query "OrderController.detail" --direction both --depth 2 --limit 20
code-intel explore trade-service --query "OrderController.detail" --direction both --relation-budget 200
code-intel explore trade-service --query "OrderControllerTest" --type symbol --include-tests
```

参数说明：

| 参数 | 含义 |
| --- | --- |
| `--query` | 接口、错误码、日志片段、SQL、表名、类名、方法名或业务词 |
| `--type` | 可选，手动指定查询类型：`route`、`error`、`sql`、`table`、`symbol`、`semantic` 等 |
| `--direction` | 探索方向：`upstream`、`downstream`、`both`，默认 `both` |
| `--depth` | 最大探索深度，默认 2，最大 4 |
| `--limit` | 最大返回候选路径数量，默认 20 |
| `--relation-budget` | 最大关系扩展预算，默认 60；关系多但只想少展示路径时，优先调这个参数 |
| `--exclude-tests` | 排除测试代码，当前默认行为，保留该参数是为了让命令语义更显式 |
| `--include-tests` | 包含测试代码；排查测试用例、单测覆盖或测试调用关系时使用 |

输出重点字段：

- `anchors`：探索起点，通常由本地 Java 专项索引或 GitNexus query 定位。
- `relations`：关系边集合，不等于完整调用链。
- `candidate_paths`：候选路径，必须结合 `path_status` 和 `confidence` 读取。
- `diagnostics`：索引、GitNexus、歧义、截断、低置信等诊断。

读取 `candidate_paths` 时要注意：

- 它是候选路径片段，不是完整调用链证明。
- `relations` 会保留更完整的关系证据，`candidate_paths` 会过滤掉默认不适合作为路径片段的关系。
- 默认不会把 `imports`、`references`、`accesses` 和 `src/test` 测试端点包装进 `candidate_paths`。
- 默认只把更适合路径片段的关系放进 `candidate_paths`，例如 `calls`、`method_implements`、`method_overrides`、`implements`、`has_method`、`maps_to_sql`、`uses_table`。
- `upstream` / `both` 反向遍历时，summary 使用 `<--calls--` 表达反向走边，但 `relations.from -> relations.to` 仍保持事实方向。
- 如果顶层 diagnostics 出现 `RELATION_LIMIT_REACHED`、`FANOUT_LIMIT_REACHED`、`DOWNSTREAM_DEPTH_LIMIT_REACHED` 或 `UPSTREAM_DEPTH_LIMIT_REACHED`，说明本次关系探索受预算或深度限制；这不代表当前 path 片段本身不可用。
- 需要分析测试调用关系时使用 `--include-tests`。

`candidate_paths` 的 `path_status`：

| 状态 | 含义 |
| --- | --- |
| `candidate` | 当前证据支持的候选路径，不代表完整调用链证明 |
| `verified` | 底层 trace 已验证的路径；v0.3 的 explore 默认不会伪造这个状态 |
| `partial` | 只找到局部链路 |
| `truncated` | 预留给路径本身被明确截断的场景；v0.3.2 起，预算和深度风险主要放在顶层 diagnostics，不再默认污染每条 path |

注意：`candidate_paths=[]` 不能解释为“确认没有路径”，要结合 `diagnostics` 判断是 GitNexus 不可用、索引缺失、符号歧义、没有关系证据，还是被限制截断。

## 处理索引状态

`SearchResponse.index_status.state` 表示当前索引状态：

- `ready`：索引可用。
- `missing`：索引不存在，执行 `code-intel index <project>`。
- `stale`：代码已变化或 manifest 与当前项目路径不一致，建议重新索引。
- `partial`：部分索引完成或部分索引文件缺失，工具会降级检索。
- `failed`：索引不可用，当前 CLI 尚未实现 `doctor` 命令，建议重新执行 `code-intel index <project>` 并查看错误输出。

## 输出说明

`code-intel search` 输出完整 JSON，其中最重要的是：

- `locations`：代码候选位置。
- `relations`：关系候选。`search --include-relations` 和 `explore` 会尝试通过 GitNexus 生成关系边。
- `candidate_paths`：仅 `explore` 返回，表示候选路径，不等于完整调用链承诺。
- `diagnostics`：索引缺失、索引过期、grep 兜底、低置信等诊断信息。
- `summary`：简短文本摘要。

上层 Skill 或其他工具应优先读取 `locations` 和 `diagnostics`，不要只依赖 `summary`。

## MCP Server 接入（供 Agent 使用）

Code Intelligence 提供 MCP Server，可接入 Codex、OpenCode 等 AI 编码工具，让 Agent 直接调用代码检索能力。

### 可用的 MCP 工具

- `code.search`：通用代码检索入口。
- `code.locate_route`：按接口路径定位 Java Controller 入口。
- `code.explore_symbol`：从一个代码线索出发探索上下游关系和候选路径。
- `code.trace_call_chain`：查询两个符号之间的调用链（依赖 GitNexus）。
- `code.index_project`：显式重建本地索引，**默认禁用**。

### 启动方式

MCP Server 是 stdio 类型，由客户端（Codex / OpenCode）spawn 进程，构建产物路径：

```text
packages/mcp/dist/server.js
```

如果已经执行过 `bash scripts/install-local.sh`，推荐直接使用：

```text
~/.local/bin/code-intel-mcp
```

如果没有本地安装，也可以使用构建产物路径。下面示例中的 `<code-intelligence-repo>/...` 请替换为你的实际路径。

### 配置到 Codex

编辑 `~/.codex/config.toml`，在 `[mcp_servers]` 段落下添加：

```toml
[mcp_servers.code-intelligence]
command = "/root/.local/bin/code-intel-mcp"
startup_timeout_sec = 60.0

# 可选：允许 Agent 通过 code.index_project 重建索引（不配则默认禁用）
[mcp_servers.code-intelligence.env]
CODE_INTEL_MCP_ALLOW_INDEX = "true"
```

### 配置到 OpenCode

编辑 `~/.config/opencode/opencode.json`，添加 `mcp` 字段：

```json
{
  "mcp": {
    "code-intelligence": {
      "type": "local",
      "command": ["/root/.local/bin/code-intel-mcp"],
      "enabled": true,
      "timeout": 120000,
      "environment": {
        "CODE_INTEL_MCP_ALLOW_INDEX": "true"
      }
    }
  }
}
```

注意：OpenCode 的 MCP 请求 `timeout` 默认只有 **5000 毫秒（5 秒）**。在 WSL 挂载盘或大型仓库上，一次检索可能耗时几十秒，**必须调大 `timeout`**（如上例 120000），否则会报 `Request timed out`。

### 手动开启索引（code.index_project）

`code.index_project` 默认禁用，需要设置环境变量 `CODE_INTEL_MCP_ALLOW_INDEX=true` 才允许 Agent 触发索引。

该环境变量必须在**客户端拉起 MCP Server 时**传入（配置在客户端的 MCP 定义里，见上面两节的 `env` / `environment` 字段），而不是在终端 `export`。

手动在终端启动 MCP Server 并开启索引（调试用）：

```bash
CODE_INTEL_MCP_ALLOW_INDEX=true node packages/mcp/dist/server.js
```

注意：值必须是字符串 `"true"`（代码严格校验 `=== "true"`，`"1"` 或布尔 `true` 都无效）。

`code.index_project` 的索引参数：

```json
{
  "project": "trade-service",
  "gitnexus_mode": "auto"
}
```

`gitnexus_mode` 可选值和 CLI 一致：`auto`、`none`、`basic`、`full`。旧字段 `with_gitnexus: true` 仍兼容，等价于 `gitnexus_mode: "basic"`。

### 建议：默认禁用索引，索引用 CLI 手动做

索引是重操作（大项目需几十秒到几分钟），且会写本地数据目录。默认禁用是防止 Agent 随意触发。建议：

- 索引用 CLI 手动完成：日常执行 `code-intel index <project>`，演示前执行 `code-intel index <project> --gitnexus-mode full`
- MCP 侧保持默认禁用（不配 `CODE_INTEL_MCP_ALLOW_INDEX`），Agent 只做只读检索（`code.search` / `code.locate_route` / `code.trace_call_chain`），仅在确需 Agent 自动重建索引时才临时开启。

### 手动调试（MCP Inspector）

开发联调时可启动官方 MCP Inspector 可视化调试：

```bash
npx -y @modelcontextprotocol/inspector node packages/mcp/dist/server.js
```

启动后浏览器打开打印的地址（如 `http://localhost:6274?...token=...`），即可查看工具列表并手动调用。

## V0.4：查询候选主链路

普通用户和上游 Agent 查询业务主链路时，优先使用 `explore`：

```bash
code-intel explore mi-intl-scheme \
  --query "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);" \
  --type symbol \
  --direction both
```

默认重点看这几个字段：

- `main_paths`：候选主链路，默认第一消费入口。
- `coverage`：本次探索覆盖度，判断是否命中预算、fanout、depth 或 anchor 歧义。
- `diagnostics`：降级和下一步动作建议。
- `summary`：一句话概览。

不建议普通用户先看 `relations` 和 `candidate_paths`。它们仍然有价值，但更适合上游 Agent 深挖、证据审计和问题复盘。

常用高级参数：

```bash
code-intel explore mi-intl-scheme \
  --query "SettlementAndRebateServiceImpl.preCheckRebate" \
  --direction both \
  --depth 2 \
  --limit 20 \
  --relation-budget 80 \
  --main-path-limit 3
```

参数含义：

- `--limit`：控制候选路径展示数量，不等于关系图谱完整度。
- `--relation-budget`：控制内部关系探索预算，普通用户通常不需要调整。
- `--main-path-limit`：控制最多返回几条候选主链路，默认 3。

看到 `coverage.complete=false` 时，应该理解为：

> 本次结果是当前预算和图谱证据下的候选主链路，不是完整运行时调用链。

看到 `RELATION_LIMIT_REACHED` 或 `FANOUT_LIMIT_REACHED` 时，不要直接判定主链路无效。它表示覆盖范围不完整；如果需要更细链路，可以围绕 `main_paths` 中的节点继续二次 explore。
