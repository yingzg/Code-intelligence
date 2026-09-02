# Code Intelligence 当前工具能力结论

日期：2026-08-14

本文档记录 Code Intelligence 当前已经实现并验证的能力，用于面试准备、工具试用和后续业务流程图 Skill 设计。本文区分已落地能力和仍未完成能力，避免在面试或演示中把设计目标讲成已完成事实。

## 1. 工具定位

Code Intelligence 是一个面向 AI Agent 的本地 Java 代码情报底座。它不是单纯的代码搜索脚本，也不是要替代 GitNexus，而是把本地项目注册、索引生成、Java 专项索引、轻量语义召回、grep 兜底、索引诊断和统一输出模型包装成 CLI 与 MCP 两类入口。

它的核心价值是让线上排障 Skill、业务流程图 Skill、新人代码问答工具、PRD/详设辅助工具等上层 Agent 可以稳定获取可引用、可诊断、可降级的代码证据。

一句话定位：

> GitNexus 更像底层代码图谱和代码分析引擎，Code Intelligence 更像面向上层 Agent 的代码证据接入层和场景编排层。

当前版本已经从“点状代码位置证据”增强为“代码位置 + GitNexus 关系边 + 两点 trace + 单点 explore 候选路径”的最小闭环。它仍然不是完整 RAG 或跨项目代码图谱平台，但已经可以支撑线上排障、代码问答和流程图 Skill 的第一层代码证据获取。

## 2. 当前工程形态

源码目录：

```text
<code-intelligence-repo>
```

当前项目是 TypeScript monorepo，分为三层：

| 模块 | 目录 | 职责 |
| --- | --- | --- |
| Core | `packages/core` | 项目注册、索引构建、查询分类、搜索路由、Java 专项索引、诊断、统一 schema |
| CLI | `packages/cli` | 面向开发者和脚本的命令行入口 |
| MCP | `packages/mcp` | 面向 AI Agent 和 Skill 的 MCP stdio server |

这种拆分的价值是：核心能力只实现一次，CLI 和 MCP 都复用 core，避免工具入口之间逻辑分叉。

## 3. 当前已经实现的核心能力

### 3.1 本地项目注册

工具支持把本地已克隆项目注册为一个项目名。上层调用方后续只需要传项目名，不需要每次传完整本地路径。

注册信息包含：

- 项目名
- 本地路径
- 技术栈
- 可选 GitNexus repo label
- 创建时间
- 更新时间

当前支持的技术栈：

- `java-spring-mybatis`
- `java-spring`
- `java-dubbo-mybatis`
- `java-generic`

如果注册时不传 `--stack`，工具会根据项目特征自动探测技术栈。

### 3.2 本地索引生成

工具可以对注册项目生成本地索引，索引默认写入：

```text
~/.code-intelligence
```

也可以通过环境变量覆盖：

```bash
CODE_INTEL_HOME=/tmp/code-intel
```

每个项目的主要索引产物包括：

- `manifest.json`
- `java-route-map.jsonl`
- `java-sql-map.jsonl`
- `error-map.jsonl`
- `semantic-lite.jsonl`

### 3.3 Spring 路由定位

工具会扫描 Java Spring 常见路由注解，例如：

- `@RequestMapping`
- `@GetMapping`
- `@PostMapping`
- `@PutMapping`
- `@DeleteMapping`
- `@PatchMapping`

可以根据接口路径和可选 HTTP method 定位 Controller 入口。

典型输入：

```text
GET /api/trade/order/detail
```

典型输出会包含：

- Controller 文件
- 起止行号
- 方法符号，例如 `OrderController.detail`
- 匹配原因
- 代码片段
- 置信度
- 证据来源

### 3.4 异常、错误码和日志定位

工具会索引 Java 代码中的异常、错误码、日志语句等错误信号。

适合从线上日志或错误码反查代码，例如：

```text
ORDER_STATUS_INVALID
ClientAbortException
log.error 中的关键字
```

输出可以帮助上层排障工具定位：

- 错误码定义位置
- 错误码抛出位置
- 异常类或异常抛出位置
- 日志语句位置

### 3.5 MyBatis SQL 和表名定位

工具会索引 MyBatis XML 和 Java 注解 SQL，提取：

- SQL 片段
- 表名
- mapper namespace
- mapper id
- 文件位置
- 行号

适合从慢 SQL、表名、Mapper 方法反查代码。

典型查询：

```text
order_item_snapshot
select count(*) from order_item_snapshot
```

### 3.6 semantic-lite 轻量语义召回

工具提供不依赖向量数据库的轻量语义召回，主要基于文件名、类名、方法名、中文注释、配置 key、SQL 和业务词等文本信号。

适合业务描述类查询，例如：

```text
订单详情页打开超时
```

注意：semantic-lite 是中等置信度召回能力，不等同于完整 RAG，也不保证能还原完整业务链路。

### 3.7 grep 兜底

当结构化索引未命中或索引缺失时，工具会使用受控 grep 做兜底搜索。

grep 兜底的价值是保证工具在索引不完整时仍能返回最低限度的代码证据。但它必须被视为低一级能力，因为 grep 只能做文本匹配，不能完整表达代码结构。当前 grep 的增强点不是语义理解，而是限定文件类型、忽略构建目录、限制扫描成本、结构化输出低置信结果。

工具会通过 `diagnostics` 标明是否使用了 grep 兜底。

### 3.8 索引状态和诊断

当前工具会在 `SearchResponse` 中返回 `index_status` 和 `diagnostics`。

索引状态包括：

- `ready`：索引可用
- `missing`：索引不存在
- `stale`：索引可能过期
- `partial`：部分索引可用，部分能力降级
- `failed`：预留失败状态

常见诊断码包括：

- `PROJECT_NOT_REGISTERED`
- `PROJECT_PATH_NOT_FOUND`
- `INDEX_MISSING`
- `INDEX_DISABLED`
- `INDEX_STALE`
- `GITNEXUS_UNAVAILABLE`
- `GITNEXUS_INDEX_MISSING`
- `SEMANTIC_INDEX_MISSING`
- `GREP_FALLBACK_USED`
- `LOW_CONFIDENCE`
- `ANCHOR_AMBIGUOUS`
- `RELATION_LIMIT_REACHED`
- `FANOUT_LIMIT_REACHED`
- `DOWNSTREAM_DEPTH_LIMIT_REACHED`
- `UPSTREAM_DEPTH_LIMIT_REACHED`
- `PATH_TRUNCATED`
- `PATH_EXTRACTION_PARTIAL`
- `PATH_VERIFICATION_SKIPPED`

这部分是面向 Agent 的关键设计：工具不仅返回结果，也告诉上层 Agent 当前结果是否可靠、是否降级、是否需要重新索引。

注意：这里的“可诊断”诊断的是代码证据生成过程和可信度，不是诊断业务代码一定存在 bug。例如它会说明索引是否过期、GitNexus 是否可用、结果是否来自 grep 兜底、是否低置信。

v0.3 的 `explore` 会额外关注路径探索诊断：

- `ANCHOR_AMBIGUOUS`：查询命中了多个探索起点，结果会合并多个 anchor 的关系；上层 Agent 应提示用户缩小符号、文件或 UID。
- `RELATION_LIMIT_REACHED`：本次关系数量达到 `relationBudget`，探索被受控停止；它限制关系扩展，不限制最终展示的候选路径条数。
- `FANOUT_LIMIT_REACHED`：某个节点的邻接关系过多，超过 fanout 限制后被截断。
- `DOWNSTREAM_DEPTH_LIMIT_REACHED`：下游探索达到 `depth` 上限，仍存在未继续展开的候选节点。
- `UPSTREAM_DEPTH_LIMIT_REACHED`：上游探索达到 `depth` 上限，仍存在未继续展开的候选节点。
- `PATH_TRUNCATED`：预留给路径本身被明确截断的场景。v0.3.2 起，`depth`、`relationBudget`、fanout 的风险主要放在顶层 diagnostics，不再默认把每条候选 path 标成 `truncated/low`。
- `PATH_EXTRACTION_PARTIAL`：只抽取到局部路径片段，不能当成完整调用链。
- `PATH_VERIFICATION_SKIPPED`：当前结果是候选路径；除 GitNexus trace 结果外，不标记为 verified。

这些诊断只描述**本次查询预算内**的结果状态。下一次如果仍使用相同 query、`depth`、`relationBudget` 和 fanout，通常还会得到相同预算诊断；它不会自动证明“项目里没有更多路径”。正确降级方式是：缩小 anchor、提高 `--relation-budget` 或 `--depth`、用 `--limit` 控制展示条数、用 `--from-uid` / `--to-uid` / 文件路径消歧，或者改用 `trace` 验证明确的两点路径。

### 3.9 GitNexus 关系边和调用链证据

当前版本已经接入本地 GitNexus 图谱索引，前提是目标项目目录下存在 `.gitnexus/run.cjs` 和已建立的 GitNexus 索引。

已落地能力：

- 注册项目时可以保存 `gitnexus_repo`，用于显式指定 GitNexus repo label。
- `search --include-relations` 会尝试调用 GitNexus `query` 和 `context`。
- GitNexus `definitions` 会被归一成 `source=gitnexus` 的 `CodeLocation`。
- GitNexus `incoming/outgoing/typed_properties` 会被归一成 `CodeRelation`。
- `CodeRelation` 同时保留归一后的 `relation_type` 和 GitNexus 原始 `raw_relation_type`，避免封装时丢失底层语义。
- `trace` 命令会调用 GitNexus `trace`，把 `hops/edges` 归一成有序调用链关系边。
- `trace` 支持 `--from-uid`、`--to-uid`、`--from-file`、`--to-file`，用于解决重名符号歧义。
- GitNexus 返回 `not_found`、`no_path`、`ambiguous` 时，工具会保留为结构化 `diagnostics`，而不是把空 `relations` 误解释成“确认没有调用关系”。
- GitNexus 返回未知关系类型时，工具会把归一关系降级为 `references`，但保留 `raw_relation_type`，并返回 `GITNEXUS_UNKNOWN_RELATION_TYPE` 诊断。

当前已归一的关系类型包括：

- `calls`
- `implements`
- `maps_to_sql`
- `handles_route`
- `throws`
- `logs`
- `reads_config`
- `uses_table`
- `contains`
- `has_method`
- `has_property`
- `imports`
- `accesses`
- `extends`
- `method_overrides`
- `method_implements`
- `typed_as`
- `references`

其中 `references` 是弱关系。它只表示“存在某种引用或当前未细分的关系”，不能直接解释为调用链。如果 `references` 带有 `raw_relation_type`，应优先查看原始类型再判断语义。

## 4. 当前 CLI 命令

构建后可以通过 Node 直接运行：

```bash
node packages/cli/dist/index.js <command>
```

如果后续安装为 bin，也可以使用：

```bash
code-intel <command>
```

### 4.1 查看数据目录

```bash
node packages/cli/dist/index.js where
```

用于确认当前 `CODE_INTEL_HOME` 实际指向哪里。

### 4.2 注册项目

```bash
node packages/cli/dist/index.js register <name> <path>
```

指定技术栈：

```bash
node packages/cli/dist/index.js register trade-service /path/to/trade-service --stack java-spring-mybatis
```

绑定 GitNexus repo label：

```bash
node packages/cli/dist/index.js register trade-service /path/to/trade-service --stack java-spring-mybatis --gitnexus-repo <gitnexus-repo-label>
```

### 4.3 查看已注册项目

```bash
node packages/cli/dist/index.js projects
```

### 4.4 生成索引

```bash
node packages/cli/dist/index.js index <project>
```

默认索引模式是 `auto`：缺少 GitNexus 索引或明确过期时自动跑基础 GitNexus 分析，已有可用索引时复用。

可以显式指定 GitNexus 索引模式：

```bash
node packages/cli/dist/index.js index <project> --gitnexus-mode auto
node packages/cli/dist/index.js index <project> --gitnexus-mode none
node packages/cli/dist/index.js index <project> --gitnexus-mode basic
node packages/cli/dist/index.js index <project> --gitnexus-mode full
```

| 模式 | 含义 | 适用场景 |
| --- | --- | --- |
| `auto` | 默认模式。缺索引或明确过期时自动跑基础 GitNexus 分析；已有可用索引时复用。 | 日常使用、上层 Agent 默认触发。 |
| `none` | 不执行 GitNexus 分析，只生成 Code Intelligence 的 Java 专项索引。 | 已手动跑过 GitNexus，或只想快速刷新路由、SQL、错误码索引。 |
| `basic` | 强制执行基础 GitNexus 分析，等价于底层 `gitnexus analyze`。 | 修复缺失索引或刷新基础图谱。 |
| `full` | 强制执行完整 GitNexus 分析，等价于 `gitnexus analyze --embeddings --skills --pdg --verbose`。 | 演示前准备完整图谱、需要 embedding/skill/PDG 等增强能力。 |

旧参数 `--with-gitnexus` 仍可用于兼容已有脚本，等价于 `--gitnexus-mode basic`。新脚本建议使用 `--gitnexus-mode`，语义更清楚。

注意：GitNexus 不可用或索引不存在时，本地 Java 专项索引仍可用，工具会返回 `partial` 或诊断信息说明调用链能力降级。

### 4.5 检索代码

通用格式：

```bash
node packages/cli/dist/index.js search <project> --query "<query>" --json
```

指定类型：

```bash
node packages/cli/dist/index.js search <project> --type route --query "GET /api/trade/order/detail" --json
node packages/cli/dist/index.js search <project> --type error --query "ORDER_STATUS_INVALID" --json
node packages/cli/dist/index.js search <project> --type table --query "order_item_snapshot" --json
node packages/cli/dist/index.js search <project> --type sql --query "select count(*) from order_item_snapshot" --json
node packages/cli/dist/index.js search <project> --type semantic --query "订单详情页打开超时" --json
node packages/cli/dist/index.js search <project> --type symbol --query "<symbol-name>" --limit 3 --include-relations --json
```

当前 CLI 支持的查询类型：

- `route`
- `error`
- `sql`
- `table`
- `symbol`
- `keyword`
- `semantic`
- `call_chain`

注意：`call_chain` 不建议通过 `search --type call_chain` 直接使用。调用链请使用专门的 `trace` 命令。

### 4.6 查询调用链

基础格式：

```bash
node packages/cli/dist/index.js trace <project> --from "<source-symbol>" --to "<target-symbol>" --depth 10 --json
```

如果 GitNexus 提示符号重名或找不到，可以使用 UID 或文件路径消歧：

```bash
node packages/cli/dist/index.js trace <project> \
  --from "<source-symbol>" \
  --to "<target-symbol>" \
  --depth 3 \
  --from-uid "<source-gitnexus-uid>" \
  --to-uid "<target-gitnexus-uid>" \
  --json
```

## 5. 当前 MCP Server 和 MCP tools

构建后通过 stdio 启动 MCP Server：

```bash
node packages/mcp/dist/server.js
```

手动debug测试：
```bash
cd <code-intelligence-repo>
npx -y @modelcontextprotocol/inspector node packages/mcp/dist/server.js
```


当前已经注册的 MCP tools 有五个。

### 5.1 `code.search`

通用代码检索入口。

输入示例：

```json
{
  "project": "trade-service",
  "query": "ORDER_STATUS_INVALID",
  "type": "error",
  "limit": 10,
  "include_relations": false
}
```

`include_relations=true` 时，工具会尝试使用 GitNexus `query/context` 生成关系边。该开关表示“需要关系证据”，不是“保证返回完整调用链”。

`type` 可选，支持：

- `route`
- `error`
- `sql`
- `table`
- `symbol`
- `keyword`
- `semantic`
- `call_chain`

### 5.2 `code.locate_route`

按接口路径定位 Java Controller 入口。

输入示例：

```json
{
  "project": "trade-service",
  "method": "GET",
  "route": "/api/trade/order/detail",
  "include_downstream": false,
  "downstream_depth": 2
}
```

如果传入 `method`，工具会按 HTTP method 过滤，减少 GET/POST 同路径时的误命中。

`include_downstream` 是路由专用开关，语义是“定位 Controller 入口后尝试返回下游关系”。当前实现复用 `include_relations` 的最小闭环，深度参数已进入 MCP 入参契约，后续还需要继续增强为真正多跳下游展开。

### 5.3 `code.trace_call_chain`

使用 GitNexus 查询两个符号之间的调用链。

输入示例：

```json
{
  "project": "<project>",
  "from": "<source-symbol>",
  "to": "<target-symbol>",
  "from_uid": "<source-gitnexus-uid>",
  "to_uid": "<target-gitnexus-uid>",
  "depth": 3
}
```

返回仍然是统一 `SearchResponse`，其中 `query.type=call_chain`，调用链边放在 `relations`。

### 5.4 `code.explore_symbol`

从一个代码线索出发探索上下游关系和候选路径。它比 `trace_call_chain` 更适合排障初始阶段，因为用户通常只知道一个接口、错误码、日志片段、SQL、表名、类名、方法名或业务词。

输入示例：

```json
{
  "project": "<project>",
  "query": "ORDER_STATUS_INVALID",
  "type": "error",
  "direction": "upstream",
  "depth": 3,
  "limit": 20,
  "relation_budget": 60,
  "exclude_tests": true
}
```

`exclude_tests` 默认按 `true` 处理，即默认排除 `src/test` 下的测试代码。需要分析测试用例、单测覆盖或测试调用关系时，显式传 `false`。

`limit` 只控制最多返回多少条 `candidate_paths`。`relation_budget` 控制最多扩展多少条关系证据。两者拆开后，默认 `limit=20` 不会再把关系探索也限制成 20 条。

返回独立 `ExploreResponse`，关键字段包括：

- `anchors`：探索起点。
- `relations`：从 GitNexus context 或本地专项索引得到的关系边集合。
- `candidate_paths`：由关系边组装出的候选路径。
- `diagnostics`：GitNexus、索引、歧义、截断、低置信等诊断信息。

v0.3 回归修正后，`relations` 和 `candidate_paths` 的语义边界更明确：

- `relations` 保留更完整的 GitNexus context 证据，包括 `imports`、`accesses`、测试关系等。
- `candidate_paths` 默认只使用更适合路径片段的关系，例如 `calls`、`method_implements`、`method_overrides`、`implements`、`has_method`、`maps_to_sql`、`uses_table`。
- 默认 `exclude_tests=true` 时，测试代码关系可以保留在 `relations`，但不会进入 `candidate_paths`。
- `method_implements` 已作为一等关系类型保留，不再降级为 `references`。
- `both` / `upstream` 反向遍历时，summary 会尊重真实关系方向。例如真实关系是 `A --calls--> B`，从 `B` 反向探索时会显示 `B <--calls-- A`，不会误写成 `B --calls--> A`。
- v0.3.2 起，顶层预算诊断不会自动让每条 `candidate_paths` 变成 `truncated/low`。path 表示当前可证实的候选片段，完整性风险通过顶层 diagnostics 读取。

注意：`candidate_paths` 是候选路径，不等于完整调用链证明。只有 `path_status=verified` 的路径才能视为底层 trace 已验证路径；v0.3 的 `explore` 默认不会伪造 verified 状态。

### 5.5 `code.index_project`

显式索引本地项目。

默认禁用，需要启动 MCP Server 时设置：

```bash
CODE_INTEL_MCP_ALLOW_INDEX=true node packages/mcp/dist/server.js
```

输入示例：

```json
{
  "project": "trade-service",
  "gitnexus_mode": "auto"
}
```

旧字段 `with_gitnexus` 仅用于兼容历史客户端，语义等价于 `gitnexus_mode="basic"`；新配置建议使用 `gitnexus_mode`。

默认禁用索引操作是合理的：MCP 面向 Agent 调用，索引可能是重操作，不应该在没有显式授权时被 Agent 随意触发。

## 6. 当前统一输出模型

核心输出结构包括 `SearchResponse` 和 `ExploreResponse`，上层 Agent 应优先消费结构化字段，而不是只读 `summary`。

关键字段：

| 字段 | 作用 |
| --- | --- |
| `request_id` | 当前请求 id |
| `project` | 项目信息、路径、commit、dirty 状态 |
| `query` | 查询类型和查询文本 |
| `index_status` | 索引状态 |
| `summary` | 简短摘要 |
| `locations` | 代码候选位置 |
| `relations` | 关系候选，包括 GitNexus context/trace 生成的关系边；它是边集合，不等于完整调用链路径 |
| `diagnostics` | 诊断信息、降级信息、建议动作 |

`ExploreResponse` 专用于单点探索：

| 字段 | 作用 |
| --- | --- |
| `request_id` | 当前请求 id |
| `project` | 项目信息、路径、commit、dirty 状态 |
| `query` | 查询类型和查询文本 |
| `index_status` | 索引状态 |
| `anchors` | 探索起点，通常来自 `searchCode()` 的候选位置 |
| `relations` | 围绕 anchors 展开的关系边集合 |
| `candidate_paths` | 候选有序路径，必须结合 `path_status`、`confidence` 和 `diagnostics` 使用 |
| `diagnostics` | 诊断信息、降级信息、截断信息、建议动作 |
| `summary` | 简短摘要 |

`locations` 是当前最重要的证据字段，常用子字段：

- `file`
- `start_line`
- `end_line`
- `symbol`
- `language`
- `location_type`
- `snippet`
- `match_reason`
- `score`
- `confidence`
- `source`

`relations` 常用子字段：

- `from`
- `to`
- `relation_type`
- `raw_relation_type`
- `confidence`
- `evidence`

其中 `relation_type` 是 Code Intelligence 归一后的稳定类型，`raw_relation_type` 是 GitNexus 原始关系类型。上层 Agent 可以优先使用 `relation_type` 做通用判断，在需要更细语义或排查 mapper 漏洞时查看 `raw_relation_type`。

## 7. 已验证的试用闭环

已在 fixture 项目上完成本地试用：

```text
<code-intelligence-repo>/fixtures/java-order-service
```

试用数据目录：

```text
/tmp/code-intelligence-demo-20260814
```

验证命令包括：

```bash
npm run build
npm run test
```

验证结果：

```text
13 个测试文件通过
109 个测试通过
```

CLI 试用结果：

- `where` 可以正确输出数据目录。
- `register` 可以注册 `java-order-service`。
- `index` 可以生成本地 Java 索引。
- 未接入 GitNexus 索引时返回 `partial` 或 diagnostics，提示调用链能力降级。
- `route` 查询可以定位 `OrderController.detail`。
- `error` 查询可以定位 `ORDER_STATUS_INVALID` 的抛出处和枚举定义。
- `table` 查询可以定位 `OrderMapper.xml` 中的 `order_item_snapshot` SQL。
- `semantic` 查询可以根据“订单详情页打开超时”召回 Controller、Service、枚举等候选代码位置。
- `search --include-relations` 可以把 GitNexus definitions/context 归一成 locations 和 relations。
- `trace` 可以把 GitNexus trace 的 hops/edges 归一成有序调用链 relations。
- 未识别的 GitNexus 关系类型会保留 `raw_relation_type`，并通过 diagnostics 提醒。

MCP handler 也已验证：`code.search`、`code.locate_route`、`code.trace_call_chain` 返回检索响应或诊断 JSON；`code.index_project` 返回索引结果和索引诊断。

v0.3 还补充了真实 explore 问题的 eval case 复盘机制。一次有效 case 至少包含：

- `request.json`：复现请求，包括 query、direction、depth、limit、是否排除测试等输入。
- `response.raw.json`：真实 CLI/MCP 返回的原始响应。
- `response.normalized.json`：去掉易变字段后，适合后续 diff 的稳定响应。
- `expectations.json`：机器可检查的断言，例如 `method_implements` 必须保留、`imports` 不应进入 `candidate_paths`、默认不应包含测试端点、反向 summary 不应写反。
- `notes.md`：人工复盘说明，记录当时的问题、诊断码、降级边界和后续优化方向。

这个机制的价值是把“真实试用发现的问题”变成可重复验证的回归样本。后续做 v0.4 `call-path`、更强路径抽取或业务流程图 Skill 前，应先跑这些 eval case，确认 `imports` 污染、测试关系污染、反向 summary 写反、`method_implements` 降级等问题没有复发。

已在真实本地 Java 项目上验证。对外展示时建议只讲验证项，不展示真实 repo label、commit、业务符号或本机路径：

- 本地 GitNexus repo label 能绑定并被 CLI/MCP 复用。
- GitNexus 索引 commit 和当前 commit 能被读取并用于 stale 诊断。
- Code Intelligence 本地索引状态可以返回 `ready` / `stale` / `partial` 等状态。
- `search --include-relations` 可以返回 GitNexus relations。
- `trace` 可以返回两点调用链关系。
- 目标项目工作区 dirty 时，普通 search 响应可能保守标记 `INDEX_STALE`；这代表代码证据需要注意工作区未提交改动，不代表工具调用失败。

## 8. 当前边界和不能夸大的能力

当前第一版不能夸大为完整代码理解系统。

明确边界：

- 不支持远程 GitLab 仓库索引，只处理本地已克隆目录。
- 不做跨项目调用链。
- 不做完整 RAG 问答。
- 不直接输出线上故障根因，只提供代码证据、候选位置和诊断信息。
- `relations=[]` 仍不能解释为“确认没有调用关系”，只能说明当前没有生成关系证据；需要结合 diagnostics 判断是无路径、符号歧义、GitNexus 不可用还是检索未命中。
- `search --include-relations` 返回的是围绕代码锚点的一跳邻域关系边集合，不是完整业务调用链。
- `explore` 支持受控多跳上下游探索和 `candidate_paths`，但 `candidate_paths` 仍是候选路径，不是完整调用链证明。
- `include_downstream` 当前只是路由入口关系增强的最小闭环；更完整的下游探索应优先使用 `code.explore_symbol`。
- GitNexus trace 的准确性受动态派发、反射、框架代理、外部 API 边界影响；工具会保留 `no_path` 等诊断，不能编造链路。

## 9. 仍未完成的规划能力

以下能力在文档或设计中出现，但当前还没有完整落地：

- `code.search_error`
- `code.search_sql`
- `code.diagnose`
- `code.register_project`
- `code.find_callers`
- `code.find_callees`
- `code.find_entry_paths`
- `code.find_downstream_paths`
- 多跳 downstream 的完整业务路径模板化
- Git diff 影响分析
- 爆炸半径分析
- 完整业务流程图自动生成
- 新人问答式完整 RAG

面试中建议表达为：

> 当前版本已经完成项目注册、本地 Java 专项索引、轻量语义召回、grep 兜底、GitNexus definitions/context/trace 接入、`explore_symbol` 单点探索、CLI、MCP 和统一证据模型。它能提供代码位置、关系边和候选路径证据，并保留 GitNexus 原始关系类型，但还不是完整 RAG，也不做线上根因自动判定。下一阶段重点是路径模板化、影响分析和业务流程图 Skill。

## 10. v0.2 本地 GitNexus 验证结论

v0.2 已完成最小闭环：工具从“代码位置检索”升级为“代码位置 + GitNexus 关系边 + 调用链证据”。

本次迭代只依赖本地源码和本地 GitNexus 索引，不访问远程 GitLab，不做远程仓库索引。

目标 Java 项目验证信息已脱敏。该项目已有本地 GitNexus 索引，验证项包括：

```text
status: up-to-date
files: 5386
nodes: 74541
edges: 161711
processes: 300
graph: available
fts: available
vectorSearch: unavailable
```

已落地设计要点：

- 注册项目时支持 `--gitnexus-repo <repo>`，保存 Code Intelligence 项目名到 GitNexus repo label 的映射。
- 所有 GitNexus 调用显式传 `--repo <gitnexus_repo>`，避免多个本地索引并存时歧义。
- `include_relations=true` 时，先用 Java 专项索引定位代码锚点，再调用 GitNexus `context` 扩展关系边。
- `include_downstream=true` 已进入 MCP 参数契约，当前最小实现复用关系增强；完整多跳下游展开仍是后续任务。
- 新增或补全 `code.trace_call_chain`，底层优先使用 GitNexus `trace`。
- 将 GitNexus `query/context/trace` 输出归一成 `CodeLocation`、`CodeRelation` 和 `Diagnostic`，并通过 `raw_relation_type` 保留 GitNexus 原始关系类型。
- 中文业务词仍优先走 semantic-lite，再用命中的英文 symbol/class/method 调 GitNexus；英文 symbol 或类名可以直接走 GitNexus。
- 不复制 GitNexus 全量索引，v0.2 先实时调用本地 GitNexus CLI；后续再考虑缓存 GitNexus 子集。

v0.2 仍不做：

- 不做远程仓库索引。
- 不做完整 RAG。
- 不做业务流程图 Skill。
- 不做 Web UI。
- 不做跨项目调用链。
- 不做完整 Java AST 自研图谱。

## 11. 面试展示建议

推荐演示顺序：

1. 用 `where` 展示工具有独立数据目录，不污染业务项目。
2. 用 `register` 展示多项目注册模型。
3. 用 `index` 展示 Java 专项索引和 GitNexus 降级诊断。
4. 用 `route` 查询展示接口路径定位 Controller。
5. 用 `error` 查询展示线上日志或错误码反查代码。
6. 用 `table/sql` 查询展示慢 SQL 或表名定位 Mapper。
7. 用 `semantic` 查询展示业务词召回。
8. 打开 `SearchResponse`，重点讲 `locations`、`source`、`confidence`、`diagnostics`。

推荐核心话术：

> 我做的不是一个人肉搜索替代品，而是给上层 AI Agent 使用的代码证据底座。Agent 需要的不只是搜索结果，还需要知道证据来自哪里、索引是否可靠、是否发生降级、下一步应该怎么处理。这就是为什么我把 `diagnostics`、`source`、`confidence` 和统一 `SearchResponse` 设计成一等公民。

## 12. V0.4 已落地：main_paths 候选主链路

V0.4 已把 `explore_symbol` 从“关系边 + 候选路径片段”推进到“候选主链路 + 覆盖度声明 + 预算摘要”。

新增输出字段：

- `main_paths`：上游 Agent 默认消费的候选主链路。
- `side_relations`：未进入主链路骨架的辅助关系，例如 imports、测试调用、工具细节。
- `coverage`：本次探索是否命中 relation budget、fanout、depth 或 anchor 歧义。
- `budget_summary`：本次请求和预算使用摘要。

新增 CLI 参数：

```bash
code-intel explore <project> \
  --query "<symbol or route>" \
  --direction both \
  --relation-budget 80 \
  --main-path-limit 3
```

新增 MCP 能力：

- `code.explore_symbol` 返回 V0.4 字段。
- 入参支持 `main_path_limit`。
- tool description 明确提醒：上游 Agent 应优先消费 `main_paths`，`relations` 是预算内证据子集，`coverage.complete=false` 时不得声明完整调用链。

当前边界：

- `main_paths` 是候选主链路，不是完整 Java 运行时调用链。
- 暂不接入 JDT LS。
- 暂不完整处理反射、AOP、事件、消息队列和动态代理。
- 复杂场景下应围绕 `main_paths` 节点继续二次 explore。
