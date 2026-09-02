# Code Intelligence v0.4 main_paths 设计规格

日期：2026-08-21

## 0. 版本定位

v0.4 的目标不是把 Code Intelligence 做成完整 Java 运行时调用链引擎，也不是接入 JDT LS。v0.4 的目标是：

```text
基于 GitNexus 关系证据和 Code Intelligence 专项索引，围绕目标代码线索稳定输出 1 到 3 条可解释的 Java 主链路候选。
```

v0.4 面向两个优先场景：

- 线上排障：从日志、错误码、接口、SQL、方法等线索出发，快速理解问题可能经过哪些核心代码节点。
- 代码理解：从一个目标方法或业务词出发，理解它的上游触发点和下游核心业务动作。

流程图 Skill 暂时不在 v0.4 实现，但 v0.4 的 `main_paths` 会作为后续流程图 Skill 的输入底座。

字段契约是 v0.4 的交付物之一，不是附属文档。没有字段契约，复杂 JSON 对上游 Agent 只是半结构化噪声；v0.4 必须同时交付 `main_paths` 输出、`coverage` 降级语义、`budget_summary` 预算说明和 `docs/2026-08-21-code-intelligence-v04-output-contract.zh-CN.md` 字段契约文档。

## 1. 背景

v0.3.2 已经修正了 `explore` 的几个关键问题：

- 同名方法 summary 不再显示成 `preCheckRebate <--calls-- preCheckRebate`。
- 签名 query 会优先匹配方法名和参数类型，不再把 helper 方法当 anchor。
- `limit` 和 `relationBudget` 已拆分。
- 顶层预算诊断不再自动污染每条 `candidate_paths`。

但 v0.3.2 仍然只提供：

```text
relations + candidate_paths
```

它能说明“当前预算内有哪些关系证据和候选片段”，但还不能明确回答：

```text
哪条链路最像排障和代码理解需要的主链路？
哪些节点是业务主线？
哪些方法只是校验、参数组装、异常构造、工具调用或旁支关系？
```

真实项目中，GitNexus context 返回的是图谱邻域，不是业务主链路。如果把所有邻域边都交给上游 Agent，Agent 仍然要从大量关系中自己猜主线，容易不稳定。

v0.4 要解决这个问题。

## 2. 核心目标

新增 `main_paths` 输出。

`main_paths` 表示：

```text
围绕目标 anchor，经过评分、剪枝、折叠后，工具认为最适合排障和代码理解的主链路候选。
```

默认只返回 1 到 3 条 `main_paths`。

每条 `main_path` 必须具备：

- 有序节点。
- 有序关系。
- 可读 summary。
- 置信度。
- `confidence_reason`。
- `score_breakdown`。
- `coverage`。
- `folded_steps`。
- 对应 evidence 来源。

## 3. 非目标

v0.4 不做：

- 不接入 JDT LS。
- 不承诺完整运行时调用链。
- 不穿透所有反射、AOP、动态代理、MQ、事件驱动、RPC 和跨服务边界。
- 不做完整 PDG 或数据流分析。
- 不直接生成流程图。
- 不把 `relations` 宣称为完整 GitNexus 图谱。
- 不把 `main_paths` 宣称为最终根因证明。

## 4. 关键设计原则

### 4.1 剪枝不能伪装成完整图谱

v0.4 会做主链路优先探索和剪枝。剪枝是必要的，否则 GitNexus 邻域关系会因为 fanout 快速爆炸。

但剪枝后的结果必须明确说明：

```text
relations 是本次预算内收集到的关系证据子集，不是完整 GitNexus 图谱。
main_paths 是在预算内证据上生成的主链路候选，不代表项目里只有这些路径。
side_relations 是被降权、折叠或旁路保留的证据子集，不代表完整旁支。
```

不得让上游 Agent 得出以下错误结论：

```text
没有返回某条关系 = 项目里不存在这条关系。
main_paths 只有 1 条 = 项目里只有 1 条调用路径。
coverage.complete=false 时仍然可以当完整图谱使用。
```

### 4.2 主链路置信度和图谱覆盖度分离

v0.4 必须区分：

```text
main_path.confidence:
  这条主链路候选自身证据质量如何。

coverage.complete:
  本次探索是否覆盖完整关系图。
```

如果 `relationBudget` 或 fanout 触顶，但某条 main path 自身由连续强关系组成，它仍然可以是 `medium` 置信度。

不能因为顶层 `RELATION_LIMIT_REACHED` 就自动把所有 `main_paths` 降为 `low`。

### 4.3 评分必须可解释、可测试、可调整

v0.4 不允许只输出一个神秘分数。

每条 `main_path` 必须输出：

- `score`
- `score_breakdown`
- `confidence_reason`

评分体系必须有 fixture 测试和真实项目 eval case 验证。

### 4.4 折叠不是丢弃

v0.4 不应该简单丢掉细节方法。应把校验、参数组装、异常构造、工具方法、DTO/VO 等放进 `folded_steps` 或 `side_relations`。

这样主链路简洁，但证据仍可按需展开。

## 5. 输出模型

v0.4 在 `ExploreResponse` 上新增字段：

```ts
type ExploreResponse = {
  request_id: string
  project: ProjectRef
  query: QueryRef
  index_status: IndexStatus
  anchors: CodeLocation[]
  relations: CodeRelation[]
  candidate_paths: CodePath[]
  main_paths: MainPath[]
  side_relations: SideRelation[]
  coverage: ExploreCoverage
  budget_summary: BudgetSummary
  diagnostics: Diagnostic[]
  summary: string
}
```

兼容策略：

- 保留现有 `relations`。
- 保留现有 `candidate_paths`。
- 新增 `main_paths` 和 `side_relations`，不破坏 v0.3.2 消费方。

## 6. MainPath 模型

```ts
type MainPath = {
  id: string
  path_type: "target_upstream_downstream" | "target_upstream" | "target_downstream"
  path_status: "candidate" | "partial" | "verified" | "low_confidence"
  confidence: "high" | "medium" | "low"
  score: number
  score_breakdown: ScoreFactor[]
  confidence_reason: string[]
  coverage: MainPathCoverage
  nodes: CodeLocation[]
  relations: CodeRelation[]
  folded_steps: FoldedStep[]
  evidence_sources: Array<"java_index" | "gitnexus" | "grep" | "semantic_lite">
  diagnostics: Diagnostic[]
  summary: string
}
```

### 6.1 path_type

```text
target_upstream_downstream:
  同时包含目标方法上游和下游核心链路。

target_upstream:
  只找到目标方法上游主链路。

target_downstream:
  只找到目标方法下游主链路。
```

### 6.2 path_status

```text
candidate:
  当前证据支持的主链路候选。

partial:
  只找到上游或下游局部链路，仍有明显缺口。

verified:
  预留给底层 trace 或后续 provider 明确验证的路径。v0.4 默认不会伪造 verified。

low_confidence:
  路径主要依赖弱关系、anchor 歧义或断链补齐。
```

## 7. Coverage 模型

### 7.1 全局 ExploreCoverage

```ts
type ExploreCoverage = {
  complete: boolean
  strategy: "main_path_first"
  relation_budget: number
  relation_count: number
  relation_budget_reached: boolean
  fanout_limited: boolean
  depth_limited: boolean
  meaning: string
}
```

语义：

```text
complete=false
```

表示本次结果不是完整 GitNexus 图谱，未返回关系不能解释为不存在。

### 7.2 MainPathCoverage

```ts
type MainPathCoverage = {
  complete: boolean
  path_edges_complete_in_collected_graph: boolean
  upstream_continuation_possible: boolean
  downstream_continuation_possible: boolean
  side_relations_truncated: boolean
}
```

语义：

```text
path_edges_complete_in_collected_graph=true
```

表示这条主链路内部边在已收集图中是连续的，不是断链拼出来的。

## 8. BudgetSummary 模型

```ts
type BudgetSummary = {
  expanded_nodes: number
  skipped_frontier_nodes: number
  relation_budget: number
  relation_count: number
  main_path_limit: number
  side_relation_limit: number
  folded_step_count: number
  omitted_reason_counts: Record<string, number>
}
```

`omitted_reason_counts` 示例：

```json
{
  "low_score": 12,
  "fanout_limit": 4,
  "relation_budget": 8,
  "test_code": 3,
  "weak_relation_type": 9,
  "folded_detail": 14
}
```

这个字段不列出所有被省略的关系，但告诉上游 Agent 本次剪枝发生在哪里。

## 9. SideRelation 模型

```ts
type SideRelation = {
  relation: CodeRelation
  reason: "weak_relation_type" | "test_code" | "detail_method" | "low_score" | "fanout_overflow" | "not_on_main_path"
  score?: number
  related_main_path_ids: string[]
}
```

`side_relations` 用于保留不适合进入主链路第一屏的关系。

示例：

- `imports`
- `references`
- `accesses`
- 测试代码关系
- DTO/VO/Param/Result 相关关系
- Exception 构造
- Util/Helper/Converter/Builder

## 10. FoldedStep 模型

```ts
type FoldedStep = {
  id: string
  parent_node_id: string
  node: CodeLocation
  relation: CodeRelation
  reason: "validation" | "parameter_assembly" | "exception_construction" | "utility" | "dto_vo" | "lock_or_transaction" | "other_detail"
  expandable: boolean
}
```

折叠示例：

```text
SettlementAndRebateServiceImpl.preCheckRebate
  folded:
    - checkPreCheckParam: validation
    - getHashParamsOrThrow: parameter_assembly
    - BizException.BizException: exception_construction
    - RedissonLockUtil.executeWithHashLock: lock_or_transaction
```

## 11. 主链路定义

v0.4 采用方案 B：

```text
目标方法上下游主链路。
```

定义：

```text
上游：入口候选或调用方 -> 目标方法
下游：目标方法 -> 核心业务动作 / Repository / Mapper / SQL / 外部依赖
```

不强制要求一定从 Controller 开始，也不强制要求一定到 SQL 结束。

对 `preCheckRebate` case，理想主链路类似：

```text
SettlementBillCommandProviderImpl.preCheckRebate
  -> SettlementBillCommandServiceImpl.preCheckRebate
  -> SettlementAndRebateServiceImpl.preCheckRebate
  -> SettlementAndRebateServiceImpl.executePreCheckRebate
```

细节方法进入 `folded_steps` 或 `side_relations`。

## 12. 主链路优先探索策略

v0.4 不应继续使用普通 BFS 作为主策略。

普通 BFS 的问题是高 fanout 节点会快速占满预算，导致主链路还没找到，关系预算已经耗尽。

v0.4 采用：

```text
main_path_first best-first / beam search
```

语义：

```text
每一轮不是展开所有节点，而是优先展开最像主链路的前 N 个节点。
```

内部参数：

```text
beamWidth:
  每一层最多继续展开多少个高价值节点。

fanout:
  单个节点最多接受多少条邻接关系。

relationBudget:
  本次最多收集多少条关系证据。
```

默认值建议：

```text
mainPathLimit = 3
relationBudget = 80
beamWidth = 4
fanout = 20
sideRelationLimit = 50
depth = 2
```

CLI/MCP 第一版不需要暴露所有内部参数。用户侧仍保持简单：

```bash
code-intel explore mi-intl-scheme --query "<query>" --direction both --depth 2 --limit 20 --relation-budget 80
```

其中 `--limit` 继续控制 `candidate_paths` 或展示数量；`mainPathLimit` 内部默认 3。

## 13. 评分体系

评分体系必须分层，不能只靠类名/包名硬编码。

### 13.1 关系类型分数

最通用，来自图谱语义。

```text
calls                 高
method_implements     高
method_overrides      高
maps_to_sql           中高
uses_table            中高
implements            中
has_method            低到中
accesses              低
references            低
imports               很低
```

### 13.2 源码集合分数

```text
src/main    加分
src/test    默认降权或排除
generated   降权
target      排除
build       排除
```

### 13.3 路径连续性分数

```text
连续 calls 链路加分
从上游 incoming 接到目标 anchor 加分
从目标 anchor 接到下游 calls 加分
断点或弱关系补齐降分
循环降分
重复节点降分
```

### 13.4 角色识别分数

角色识别是半通用规则。v0.4 可以内置默认规则，但必须集中在独立模块，后续可配置。

入口候选：

```text
Controller
Provider
Scheduler
Job
Consumer
Listener
Handler
Bpm
Facade
```

业务节点：

```text
Service
CommandService
DomainService
Manager
Processor
Executor
ApplicationService
```

持久化节点：

```text
Repository
Mapper
Dao
```

细节节点：

```text
DTO
VO
Param
Result
Builder
Converter
Util
Helper
Exception
```

### 13.5 Query 相关性分数

```text
方法名精确匹配 query 加分
参数类型匹配 query 加分
文件路径接近 anchor 加分
业务词在 symbol/file/snippet 中出现加分
```

## 14. ScoreBreakdown 模型

```ts
type ScoreFactor = {
  factor: string
  delta: number
  reason: string
}
```

示例：

```json
{
  "score": 0.82,
  "score_breakdown": [
    {
      "factor": "strong_relation_chain",
      "delta": 0.25,
      "reason": "路径主要由 calls 和 method_implements 组成"
    },
    {
      "factor": "source_set",
      "delta": 0.15,
      "reason": "节点均来自 src/main"
    },
    {
      "factor": "target_anchor_exact",
      "delta": 0.2,
      "reason": "目标 anchor 方法名和参数类型匹配 query"
    },
    {
      "factor": "entry_candidate",
      "delta": 0.1,
      "reason": "上游包含 Provider/Controller/Scheduler 类型入口候选"
    }
  ]
}
```

## 15. 置信度规则

### high

满足：

- anchor 精确。
- 路径连续。
- 主要由强关系组成。
- 节点均来自 `src/main`。
- 节点角色序列合理。
- 没有明显断链。

### medium

满足：

- anchor 明确。
- 路径主要由强关系组成。
- 可能存在全局预算触顶或旁支未覆盖。
- 主链路内部仍连续。

### low

出现：

- anchor 歧义明显。
- 需要 `imports` / `references` / `accesses` 等弱关系拼路径。
- 路径断裂。
- 主要节点来自测试代码。
- 目标方法本身像工具方法或 DTO 方法。
- GitNexus 没有足够 calls 证据。

硬规则：

```text
RELATION_LIMIT_REACHED / FANOUT_LIMIT_REACHED / DEPTH_LIMIT_REACHED 不能单独导致 main_path.confidence=low。
```

## 16. Diagnostics

新增或强化以下诊断：

```text
MAIN_PATHS_BUILT
MAIN_PATH_LOW_CONFIDENCE
MAIN_PATH_COVERAGE_PARTIAL
MAIN_PATH_ANCHOR_AMBIGUOUS
MAIN_PATH_BUDGET_REACHED
MAIN_PATH_SIDE_RELATIONS_TRUNCATED
MAIN_PATH_FOLDED_DETAILS
MAIN_PATH_NO_STRONG_RELATION_CHAIN
```

示例：

```json
{
  "level": "info",
  "code": "MAIN_PATH_COVERAGE_PARTIAL",
  "message": "已生成主链路候选，但本次关系探索达到预算边界，旁支关系可能不完整。"
}
```

## 17. 上游 Agent 使用规则

上游 Agent 可以：

- 基于 `main_paths` 做排障初始分析。
- 基于 `main_paths` 画业务主流程图草稿。
- 基于 `folded_steps` 展开细节方法。
- 基于 `side_relations` 检查旁支影响。
- 基于 `coverage` 判断是否需要提高预算或精确指定 UID。

上游 Agent 不可以：

- 把 `relations` 当完整 GitNexus 图谱。
- 因为某关系没返回就判断不存在。
- 因为 `main_paths` 只有 1 条就判断项目只有 1 条路径。
- 忽略 `coverage.complete=false` 直接下最终根因。
- 把 `main_paths` 当成完整运行时调用链。

## 18. 测试策略

### 18.1 Fixture 测试

构造一个稳定 Java fixture：

```text
Controller -> Provider -> CommandService -> TargetService.target -> CoreService.execute -> Repository.query -> SQL
TargetService.target -> checkParam
TargetService.target -> buildParam
TargetService.target -> BizException
TargetService.target -> LockUtil.execute
TargetService.target -> DTO.getX
```

期望：

- `main_path` 包含 Provider / CommandService / TargetService / CoreService / Repository。
- `folded_steps` 包含 checkParam / buildParam / BizException / LockUtil / DTO。
- `side_relations` 包含弱关系。
- `imports` / `references` / `accesses` 不进入 `main_path`。
- `score_breakdown` 非空。
- `confidence_reason` 非空。

### 18.2 真实项目 eval

继续使用：

```text
/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820
```

目标 query：

```text
PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);
```

期望：

- 至少返回 1 条 `medium` 置信度 `main_path`。
- `main_path.summary` 包含 `SettlementBillCommandServiceImpl.preCheckRebate`。
- `main_path.summary` 包含 `SettlementAndRebateServiceImpl.preCheckRebate`。
- 下游优先包含 `executePreCheckRebate`。
- `buildPreCheckRebateParam` 不作为 anchor。
- `imports` / `references` / `accesses` 不进入 `main_path`。
- `main_path.score_breakdown` 非空。
- `main_path.confidence_reason` 非空。
- `coverage.complete=false` 不会把主链路降为 `low`。

## 19. 建议实现模块

为避免继续膨胀 `explore-symbol.ts`，v0.4 建议拆分模块：

```text
packages/core/src/search/main-path/types.ts
packages/core/src/search/main-path/role-classifier.ts
packages/core/src/search/main-path/scoring.ts
packages/core/src/search/main-path/pruner.ts
packages/core/src/search/main-path/builder.ts
packages/core/src/search/main-path/coverage.ts
packages/core/src/search/main-path/folding.ts
```

职责：

```text
types.ts:
  v0.4 输出类型和内部模型。

role-classifier.ts:
  节点角色识别。

scoring.ts:
  路径和关系评分。

pruner.ts:
  弱关系、低分关系、测试关系、预算剪枝。

builder.ts:
  从 anchors、relations、candidate_paths 构建 main_paths。

coverage.ts:
  生成 coverage 和 budget_summary。

folding.ts:
  识别 validation、parameter assembly、exception、utility 等 folded_steps。
```

## 20. 实施顺序建议

1. 扩展 schema，新增 `main_paths`、`side_relations`、`coverage`、`budget_summary`。
2. 补 fixture 测试，先红。
3. 实现 role classifier。
4. 实现 scoring 和 score_breakdown。
5. 实现 folded_steps。
6. 实现 main_path builder。
7. 接入 `exploreSymbol()`。
8. 更新 CLI/MCP 输出，不新增用户复杂参数。
9. 更新 docs。
10. 更新真实 eval case。
11. 运行完整验证。

## 21. 验收标准

v0.4 通过的最低标准：

- `npm run build` 通过。
- `npm run typecheck` 通过。
- `npm run test` 通过。
- fixture main path 测试通过。
- `mi-intl-scheme preCheckRebate` eval 通过。
- 默认返回 1 到 3 条 `main_paths`。
- 至少 1 条 `main_path.confidence=medium`。
- `relations` 文档明确是预算内证据子集。
- `coverage.complete=false` 时，上游 Agent 不会被误导成全图完整。
- `score_breakdown` 和 `confidence_reason` 非空。

## 22. 结论

v0.4 的价值不是“找全所有关系边”，而是：

```text
把 GitNexus 邻域关系转化成 Agent 可消费的主链路候选。
```

它通过主链路优先探索、分层预算、可解释评分、细节折叠、coverage 和 diagnostics，解决 v0.3.2 仍然存在的两个问题：

- 图谱关系边容易爆炸。
- 上游 Agent 很难从大量候选片段中稳定识别主链路。

v0.4 成功后，Code Intelligence 就从“候选路径探索工具”进一步变成“排障和代码理解的主链路证据底座”。
