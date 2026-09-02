# Code Intelligence explore_symbol 设计规格

日期：2026-08-17  
最近修订：2026-08-19

## 0. 版本定位

`explore_symbol` 不是面试特供功能，也不是为了演示强行拼接调用链。它是 Code Intelligence 从“代码位置检索工具”走向“生产可用 Agent 代码证据底座”的关键能力。

v0.3 的定位：

```text
生产可用的候选路径探索 MVP
```

v0.3 不承诺返回理论意义上的完整调用链，也不承诺自动穿透所有动态代理、反射、AOP、RPC、MQ 和跨项目边界。v0.3 承诺的是：

- 从一个真实线索出发，而不是要求用户预先知道 `from/to`。
- 稳定返回 `anchors`、`relations`、`candidate_paths`、`diagnostics`。
- 每条候选路径都必须标注路径状态、置信度和证据来源。
- 结果可以被上层排障 Agent、新人代码问答工具、业务流程图 Skill 安全消费。
- 当结果不完整、被截断、低置信或发生降级时，必须通过 diagnostics 明确说明。

这个版本的核心原则是：

```text
宁可返回带状态的候选路径，也不伪造完整调用链。
```

## 1. 背景

当前 Code Intelligence 已经具备三类基础能力：

- `search`：根据接口、错误码、SQL、表名、symbol、业务词定位代码候选。
- `search --include-relations`：围绕候选代码点返回 GitNexus 邻域关系边。
- `trace --from --to`：在已知起点和终点时，调用 GitNexus trace 验证两点之间是否存在路径。

这些能力可以支撑底层证据获取，但还不够贴近真实排障和代码理解场景。

真实场景里，用户通常只知道一个线索：

- 一个错误码。
- 一条日志。
- 一个接口路径。
- 一个 SQL 表名。
- 一个方法名。
- 一段业务描述。

用户通常不知道完整调用链，也不知道 `from` 和 `to` 应该填什么。因此下一阶段需要一个更自然的入口：从一个线索出发，自动定位 anchor，并探索上下游关系和候选路径。

## 2. 目标

新增单点图谱探索能力：

```bash
code-intel explore <project> \
  --query "<symbol-or-clue>" \
  --direction upstream|downstream|both \
  --depth 2 \
  --json
```

MCP tool：

```text
code.explore_symbol
```

核心目标：

- 输入一个代码线索。
- 自动定位一个或多个 anchor。
- 基于 GitNexus context 扩展上游、下游或双向关系。
- 返回候选路径、关系边和诊断信息。
- 明确 diagnostics，避免把不完整图谱误解释为确定结论。

v0.3 的生产目标不是“给出最终根因”，而是把真实排障输入转换成可追溯的代码上下文证据：

```text
接口路径 -> Controller anchor -> 下游 Service/Mapper/SQL 候选路径
错误码/日志 -> 定义或抛出点 anchor -> 上游入口候选路径
表名/SQL -> Mapper anchor -> 上游 Service/入口候选路径
方法/类名 -> 符号 anchor -> incoming/outgoing 邻域关系
业务词 -> semantic-lite 候选 -> GitNexus 关系扩展
```

## 3. 非目标

本设计不做：

- 不做跨项目调用链。
- 不做远程仓库索引。
- 不做完整 RAG 问答。
- 不直接输出线上故障根因。
- 不直接生成业务流程图。
- 不保证能穿透所有动态派发、反射、Spring AOP、MQ、RPC 和外部 API 边界。
- 不把 `candidate_paths` 宣称为完整调用链。
- 不在 v0.3 实现跨项目链路、深度数据流、影响分析和完整业务流程推断。

## 4. CLI 设计

### 4.1 explore

```bash
code-intel explore <project> \
  --query "<query>" \
  --direction upstream|downstream|both \
  --depth 2 \
  --limit 20 \
  --relation-budget 60 \
  --include-tests \
  --json
```

参数含义：

| 参数 | 含义 |
| --- | --- |
| `project` | Code Intelligence 注册项目名 |
| `query` | 错误码、方法名、类名、表名、接口路径或业务词 |
| `direction` | 探索方向，默认 `both` |
| `depth` | 最大扩展深度，默认 2，最大 4 |
| `limit` | 最大返回候选路径数量，默认 20 |
| `relation-budget` | 最大关系扩展预算，默认 60 |
| `exclude-tests` | 排除测试代码，当前默认行为，保留该参数是为了显式表达意图 |
| `include-tests` | 包含测试代码，用于排查测试用例、单测覆盖或测试调用关系 |
| `json` | 输出 JSON |

### 4.2 语义化快捷命令

后续可以把 `explore` 包装成更明确的命令：

```bash
code-intel find-callers <project> --query "<symbol>" --depth 3 --json
code-intel find-callees <project> --query "<symbol>" --depth 3 --json
code-intel find-entry-paths <project> --query "<symbol>" --depth 4 --json
code-intel find-downstream-paths <project> --query "<symbol>" --depth 4 --json
code-intel trace-between <project> --from "<symbol>" --to "<symbol>" --json
```

这些命令可以先不实现，等 `explore` 的核心能力稳定后再增加。

## 5. MCP 设计

### 5.1 code.explore_symbol

输入：

```ts
{
  project: string
  query: string
  direction?: "upstream" | "downstream" | "both"
  depth?: number
  limit?: number
  exclude_tests?: boolean
  relation_types?: string[]
}
```

输出建议新增 `ExploreResponse`，不要强行塞进 `SearchResponse`：

```ts
{
  request_id: string
  project: ProjectRef
  query: QueryRef
  anchors: CodeLocation[]
  relations: CodeRelation[]
  candidate_paths: CodePath[]
  diagnostics: Diagnostic[]
}
```

原因：

- `SearchResponse.locations` 适合搜索候选。
- `ExploreResponse.anchors` 表达选定的探索起点。
- `candidate_paths` 表达候选有序路径，避免和普通 `relations` 混淆，也避免误导上层 Agent 认为路径一定完整。

## 6. 输出模型

### 6.1 CodePath

建议新增：

```ts
type CodePath = {
  id: string
  path_type: "upstream" | "downstream" | "entry_path" | "data_path" | "sql_path" | "unknown"
  path_status: "candidate" | "verified" | "partial" | "truncated"
  nodes: CodeLocation[]
  relations: CodeRelation[]
  depth: number
  confidence: "high" | "medium" | "low"
  evidence_sources: Array<"java_index" | "gitnexus" | "grep" | "semantic_lite">
  diagnostics: Diagnostic[]
  summary: string
}
```

说明：

- `relations` 是边集合。
- `candidate_paths` 是候选有序路径。
- `CodePath.relations` 内的顺序应该和路径顺序一致。
- `path_status=candidate` 表示这是根据当前关系边组装出的候选路径，还不能等同于完整调用链。
- `path_status=verified` 只用于底层 GitNexus trace 明确验证出的两点路径。
- `path_status=partial` 表示只找到了局部链路，例如只找到 Mapper 到 Service，没有找到入口。
- `path_status=truncated` 表示路径因为 `depth`、`limit` 或 `fanout` 限制被截断。
- 每条路径必须保留 `evidence_sources` 和 `diagnostics`，让上层 Agent 判断能不能把它作为强证据。

### 6.2 ExploreResponse

v0.3 建议新增独立响应模型：

```ts
type ExploreResponse = {
  request_id: string
  project: ProjectRef
  query: QueryRef
  index_status: IndexStatus
  anchors: CodeLocation[]
  relations: CodeRelation[]
  candidate_paths: CodePath[]
  diagnostics: Diagnostic[]
  summary: string
}
```

字段语义：

| 字段 | 含义 |
| --- | --- |
| `anchors` | 本次探索起点。通常来自 `searchCode()` 的 top candidates。 |
| `relations` | 从 GitNexus context 或本地专项索引得到的关系边集合，不等于调用链。 |
| `candidate_paths` | 由关系边组装出的候选有序路径，必须带 `path_status` 和 `confidence`。 |
| `diagnostics` | 对整个探索过程的诊断，例如索引缺失、GitNexus 不可用、结果歧义、路径截断。 |
| `summary` | 给人类阅读的简短摘要，不能替代结构化字段。 |

关键约束：

- `candidate_paths=[]` 不能解释为“确认没有路径”。
- `relations=[]` 不能解释为“确认没有关系”。
- 上层 Agent 必须结合 `diagnostics` 判断证据强度。
- 如果路径不是 trace 验证路径，默认不得标记为 `verified`。

### 6.3 raw_relation_type

`CodeRelation` 必须保留 GitNexus 原始关系：

```ts
type CodeRelation = {
  from: string
  to: string
  relation_type: RelationType
  raw_relation_type?: string
  confidence: Confidence
  evidence: EvidenceRef[]
}
```

这样即使归一关系是 `references`，上层 Agent 仍能看到原始类型。

## 7. 数据流

```text
用户输入 query
  -> classifyQuery
  -> searchCode 定位候选 anchors
  -> 如果多个候选，按 score/source/confidence 排序
  -> 对每个 anchor 调 GitNexus context
  -> 根据 direction 选择 incoming/outgoing/typed_properties
  -> 按 relation type、fanout、depth 和 limit 剪枝
  -> 扩展下一层候选节点
  -> 汇总 relations
  -> 从 relations 中提取 candidate_paths
  -> 为每条 candidate_path 标注 path_status、confidence、evidence_sources、diagnostics
  -> 返回 ExploreResponse
```

### 7.1 示例数据流

以排查接口慢为例，用户输入：

```bash
code-intel explore mi-intl-scheme \
  --query "/api/store/incentive/detail" \
  --direction downstream \
  --depth 3 \
  --limit 20 \
  --json
```

处理过程：

1. `classifyQuery()` 判断 query 像接口路径，优先走 route 搜索。
2. `searchCode()` 从 `java-route-map.jsonl` 找到 Controller 方法，生成 anchor。
3. 如果 `includeRelations` 或 explore 模式启用，使用 anchor 的 symbol/file 信息调用 GitNexus `context`。
4. `direction=downstream` 时优先读取 outgoing 关系，例如 `calls`、`has_method`、`uses_table`。
5. 第一层可能得到 Controller 调用的 Service 方法。
6. 第二层继续对 Service 方法调用 `context`，可能得到 Mapper、Client、其他 Service。
7. 第三层可能得到 Mapper SQL 或表名证据。
8. 工具把这些边汇总成 `relations`。
9. 路径组装器尝试生成候选路径：

```text
Controller.detail
  -> StoreIncentiveService.queryDetail
  -> StoreIncentiveMapper.selectDetail
  -> table: store_incentive_detail
```

10. 如果某一步因为 `depth=3` 停止，则路径标记为：

```text
path_status = truncated
diagnostics += DEPTH_LIMIT_REACHED
```

这个输出不能说“完整链路只有这一条”，只能说“当前证据支持这条候选下游路径”。

## 8. 剪枝策略

图谱探索必须剪枝，否则真实项目会关系爆炸。

默认策略：

- 最大深度默认 2，最大 4。
- 每层最大 fanout 默认 10。
- 总关系边 limit 默认 20。
- anchor 默认最多取前 3 个。
- 默认排除 `src/test`、`target`、`build`。
- 优先保留：
  - `calls`
  - `implements`
  - `extends`
  - `method_overrides`
  - `has_method`
  - `typed_as`
  - `maps_to_sql`
  - `uses_table`
- 弱关系降权：
  - `imports`
  - `references`
- 如果遇到未知 `raw_relation_type`，保留但降低置信度，并写 diagnostics。

### 8.1 为什么不能无限展开

不剪枝不是因为主要担心栈溢出，而是因为真实代码图谱会快速扩散。

例如一个 Service 方法：

- 可能被 5 个 Controller 调用。
- 可能被 3 个 Job 调用。
- 可能被 2 个 MQ Consumer 调用。
- 可能调用 8 个下游 Service。
- 可能调用 10 个 Mapper 方法。
- 每个 Mapper 又可能关联多个 SQL/table。

如果每层 fanout 是 10：

```text
depth=1 -> 10 个邻居
depth=2 -> 100 个候选
depth=3 -> 1000 个候选
depth=4 -> 10000 个候选
```

这会带来四类问题：

- 执行时间不可控。
- 返回 JSON 过大，消耗大量 token。
- 噪声关系过多，上层 Agent 更容易误判。
- 面向人的结果不可读，无法支撑排障决策。

所以 v0.3 默认 `depth=2`，最大 `depth=4`。这不是弱化能力，而是让探索结果保持可消费。

### 8.2 路径置信度规则

候选路径的置信度由证据来源和关系强度共同决定：

| 条件 | 建议置信度 |
| --- | --- |
| GitNexus trace 验证出的 `calls` 有序路径 | high |
| route/java_index anchor + GitNexus `calls`/`has_method`/`uses_table` 组成的短路径 | medium |
| semantic-lite anchor + GitNexus 弱关系组成的路径 | low |
| 包含未知 `raw_relation_type` 或 `references` 的路径 | low |
| 被 `depth/fanout/limit` 截断的路径 | medium 或 low，并标记 `truncated` |
| 只找到局部链路，没有找到入口或终点 | low 或 medium，并标记 `partial` |

## 9. 典型场景

### 9.1 从错误码找上游入口

```bash
code-intel explore mi-intl-scheme \
  --query "ORDER_STATUS_INVALID" \
  --direction upstream \
  --depth 3 \
  --json
```

期望：

- 定位错误码定义或抛出位置。
- 找调用它的 service。
- 继续找 controller/job/listener 入口。

### 9.2 从 SQL 表名找触发链路

```bash
code-intel explore mi-intl-scheme \
  --query "store_incentive_imei_detail" \
  --direction upstream \
  --depth 4 \
  --json
```

期望：

- 定位 mapper SQL。
- 找 mapper 方法。
- 找 service 调用。
- 找入口 controller/job/listener。

### 9.3 从 MQ consumer 找下游处理链

```bash
code-intel explore mi-intl-scheme \
  --query "SGPStoreIncentiveImeiConsumer" \
  --direction downstream \
  --depth 3 \
  --json
```

期望：

- 定位 consumer。
- 找 `onMessage`。
- 找父类模板方法。
- 找 command service 和 mapper 写入。

## 10. diagnostics 设计

新增或复用：

- `GITNEXUS_RELATIONS_USED`
- `GITNEXUS_RELATIONS_UNAVAILABLE`
- `GITNEXUS_QUERY_FAILED`
- `GITNEXUS_UNKNOWN_RELATION_TYPE`
- `ANCHOR_NOT_FOUND`
- `ANCHOR_AMBIGUOUS`
- `RELATION_LIMIT_REACHED`
- `FANOUT_LIMIT_REACHED`
- `DOWNSTREAM_DEPTH_LIMIT_REACHED`
- `UPSTREAM_DEPTH_LIMIT_REACHED`
- `PATH_EXTRACTION_PARTIAL`
- `PATH_TRUNCATED`
- `PATH_VERIFICATION_SKIPPED`
- `LOW_CONFIDENCE`

关键原则：

- 空 `candidate_paths` 不能代表没有路径。
- diagnostics 必须说明是没找到、歧义、超限、降级，还是 GitNexus 不可用。
- 如果关系探索因为 `relationBudget`、fanout 或 depth 到达边界，必须在顶层 diagnostics 显式提示。
- 如果路径只是候选路径，必须提示它不是完整调用链证明。
- 如果路径由 semantic-lite 或 grep anchor 触发，默认不能作为高置信链路。

### 10.1 diagnostics 对上层 Agent 的影响

上层 Agent 必须遵守：

- 有 `GITNEXUS_RELATIONS_UNAVAILABLE` 时，不能声称“没有调用关系”，只能说“当前缺少关系证据”。
- 有 `ANCHOR_AMBIGUOUS` 时，不能直接选择某个同名方法下结论，应该要求更多上下文或使用文件路径/UID 消歧。
- 有 `RELATION_LIMIT_REACHED`、`FANOUT_LIMIT_REACHED` 或 `*_DEPTH_LIMIT_REACHED` 时，不能声称“下游到此为止”，只能说“当前探索在预算或深度边界处停止”。
- 有 `PATH_TRUNCATED` 时，不能声称“下游到此为止”，只能说“当前候选 path 本身被明确截断”。v0.3.2 起，不再把顶层预算诊断自动复制到每条 path。
- 有 `PATH_EXTRACTION_PARTIAL` 时，可以把路径作为理解线索，但不能作为最终根因证明。
- 有 `LOW_CONFIDENCE` 时，应该建议人工确认或继续使用 trace/explore 深挖。

## 11. 分版本演进路线

### 11.1 v0.3：候选路径探索 MVP

目标：

- 实现 `exploreSymbol()` core API。
- 实现 CLI `code-intel explore`。
- 实现 MCP `code.explore_symbol`。
- 返回 `anchors`、`relations`、`candidate_paths`、`diagnostics`。
- `candidate_paths` 必须带 `path_status`、`confidence`、`evidence_sources`。
- 不承诺完整调用链。

重点场景：

- 从接口路径找到 Controller 下游候选路径。
- 从错误码/日志找到定义或抛出点，再找上游调用方候选。
- 从表名/SQL 找 Mapper，再找上游 Service 候选。
- 从方法/类名找 incoming/outgoing 邻域关系。

预计成本：

```text
1.5 到 3 天
```

### 11.2 v0.4：入口路径和下游路径增强

目标：

- 增强 `entry_path`。
- 增强 `downstream_path`。
- 支持更明确的 `find_callers`、`find_callees`、`find_entry_paths`、`find_downstream_paths` 快捷命令。
- 对 Controller、Job、Consumer、Listener 等入口类型做识别和排序。

重点场景：

```text
错误码/日志 -> 抛出点 -> Service -> Controller/Job/Consumer 入口候选
Mapper/SQL -> Service -> Controller/Job/Consumer 入口候选
Controller -> Service -> Mapper/SQL 下游候选
```

预计成本：

```text
3 到 5 天
```

### 11.3 v0.5：Java 后端业务链路模板化

目标：

- 针对 Java 后端高频链路做路径模板。
- 提升 Controller-Service-Mapper-SQL 这类链路的路径稳定性。
- 对 Spring Bean、接口实现、MyBatis XML/注解映射做专项补强。

重点路径类型：

```text
controller_to_sql_path
consumer_to_mapper_path
job_to_mapper_path
error_to_entry_path
service_downstream_path
```

预计成本：

```text
3 到 7 天，取决于 mi-intl-scheme 真实验证结果
```

### 11.4 v0.6：生产增强能力

目标：

- MQ topic 到 consumer 识别。
- Job 入口识别。
- RPC/Dubbo/Feign/HTTP client 边界标注。
- 配置驱动 Bean 关系补强。
- GitNexus PDG/data-flow 能力接入。
- 影响分析和变更爆炸半径分析。

这部分不能靠一次设计拍死，需要基于真实项目试用持续迭代。

预计成本：

```text
2 到 4 周做出明显可用版本，后续持续调优
```

### 11.5 原实施建议更新

原计划：

1. v0.2.1：先修正 `raw_relation_type`，避免关系语义丢失。
2. v0.3.0：实现 `explore` CLI、core `exploreSymbol()` 和 MCP `code.explore_symbol`。
3. v0.3.0：直接返回 `anchors + relations + candidate_paths + diagnostics`，但只承诺候选路径，不承诺完整调用链。
4. v0.4：基于真实试用结果增强入口路径、下游路径和快捷命令。

这样可以避免方向偏成“面试演示玩具”：v0.3 先解决生产排障最常见的单点线索探索，v0.4 以后再逐步增强完整路径能力。

## 12. 面试与生产价值的关系

`explore_symbol` 的第一目标是生产可用，不是为了面试包装。

它适合面试展示，是因为它真实解决了生产问题：

- 真实排障输入通常只有一个线索，不是完整 `from/to`。
- 上层 Agent 需要的是可追溯代码证据，不是 LLM 自己猜链路。
- 关系探索必须有剪枝、置信度和 diagnostics，否则结果越多越危险。
- 候选路径必须和完整调用链区分，否则容易误导排障结论。

面试时应该讲：

> 我没有把 GitNexus 简单包一层，也没有让 LLM 直接读代码猜流程。我把接口、错误码、日志、SQL、业务词这些生产线索统一转换成 anchors，再基于 GitNexus context 和本地 Java 专项索引展开 relations，最后生成带 path_status、confidence、diagnostics 的 candidate_paths。这样上层 Agent 能知道证据来自哪里、是否降级、是否被截断、能不能下结论。

这个能力的展示亮点来自生产约束，而不是演示包装。
