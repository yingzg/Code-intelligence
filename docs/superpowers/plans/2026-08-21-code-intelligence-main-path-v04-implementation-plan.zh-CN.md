# Code Intelligence V0.4 主链路能力实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留 V0.3 `relations` / `candidate_paths` 的基础上，新增面向上游 Agent 可直接消费的 `main_paths` 主链路输出，并用字段契约、覆盖度、预算摘要和可解释评分解决“关系边爆炸后结果低置信度、上游 Agent 不知道该信什么”的问题。

**Architecture:** 继续以 GitNexus 图谱为主要关系来源，Code Intelligence 不替代 GitNexus 做完整静态分析，而是在 GitNexus 返回的关系邻域上做 Agent 友好的二次组织：优先保留主链路相关边，折叠低价值细节，显式声明覆盖度与预算截断。输出分为“主消费层”和“证据审计层”：上游 Agent 默认使用 `main_paths + coverage + diagnostics`，需要深入时再读取 `relations + side_relations + candidate_paths + budget_summary`。

**Tech Stack:** TypeScript、Node.js、Zod、Vitest、现有 CLI/MCP 架构、GitNexus CLI/MCP 输出适配层、真实项目 `mi-intl-scheme` eval case。

---

## 0. 关键结论

V0.4 的输出模型会比 V0.3 更丰富，但不能让上游 Agent 靠猜字段含义使用结果。必须同时交付一份字段契约文档，并在工具输出里保持字段命名稳定、语义稳定、降级语义稳定。

字段契约文档要解决三个问题：

1. 人能看懂：每个字段是什么、什么时候可信、什么时候只能作为线索。
2. 上游 Agent 能按规则使用：默认读哪些字段、哪些字段不能当成完整事实、看到哪些 diagnostics 需要二次追问。
3. 后续迭代不破坏兼容：新增字段允许，改变字段语义必须更新契约和测试。

V0.4 不追求“完整 Java 运行时调用链”。V0.4 要交付的是“稳定、可解释、可降级的候选主链路”。这对线上排障和业务理解已经有直接价值，因为上游 Agent 可以先沿主链路定位核心业务，再按需扩展细节。

---

## 1. 输出契约设计

### 1.1 新增字段分层

V0.4 的 `explore` 返回继续保留 V0.3 字段：

```ts
{
  request_id: string;
  project: ProjectInfo;
  query: CodeQuery;
  index_status: IndexStatus;
  anchors: CodeAnchor[];
  relations: CodeRelation[];
  candidate_paths: CandidatePath[];
  diagnostics: Diagnostic[];
  summary: string;
}
```

新增字段：

```ts
{
  main_paths: MainPath[];
  side_relations: SideRelation[];
  coverage: ExploreCoverage;
  budget_summary: BudgetSummary;
}
```

主消费层：

```ts
main_paths
coverage
diagnostics
summary
```

证据审计层：

```ts
anchors
relations
side_relations
candidate_paths
budget_summary
```

上游 Agent 的默认消费规则：

1. 优先读取 `main_paths`。
2. 如果 `main_paths` 非空，并且至少一条 `confidence >= medium`，可以基于该主链路做初步排障、业务解释或流程图草稿。
3. 如果 `coverage.complete === false`，结论必须表述为“基于当前预算和图谱证据的候选主链路”，不能表述为“完整调用链”。
4. 如果 `diagnostics` 包含 `MAIN_PATH_LOW_CONFIDENCE` 或 `MAIN_PATH_NO_STRONG_RELATION_CHAIN`，上游 Agent 必须继续补证据，不能直接给根因定论。
5. `relations` 是预算内证据子集，不代表完整 GitNexus 图谱。
6. `side_relations` 是被降级为辅助证据的边，不代表无价值，只是不适合作为主链路骨架。
7. `candidate_paths` 保留兼容和审计价值，不建议上游 Agent 作为第一消费入口。

### 1.2 `MainPath` 字段契约

```ts
type MainPath = {
  id: string;
  path_type: 'upstream' | 'downstream' | 'entry_to_target' | 'target_to_data' | 'mixed';
  path_status: 'complete_candidate' | 'partial_candidate' | 'truncated' | 'low_confidence';
  nodes: CodeAnchor[];
  relations: CodeRelation[];
  folded_steps: FoldedStep[];
  side_relation_ids: string[];
  score: number;
  confidence: 'high' | 'medium' | 'low';
  score_breakdown: ScoreFactor[];
  confidence_reason: string;
  coverage: MainPathCoverage;
  summary: string;
};
```

字段语义：

`id`：本次响应内稳定的主链路编号，例如 `main_path_1`。不承诺跨请求稳定。

`path_type`：主链路类型。`upstream` 表示入口或调用方到目标方法；`downstream` 表示目标方法到核心业务、仓储、SQL 或外部依赖；`entry_to_target` 表示入口到目标的清晰路径；`target_to_data` 表示目标到数据访问的清晰路径；`mixed` 表示链路同时包含上下游片段。

`path_status`：链路状态。`complete_candidate` 表示在当前预算和图谱内没有被截断；`partial_candidate` 表示链路可用但覆盖不完整；`truncated` 表示预算、深度或 fanout 导致截断；`low_confidence` 表示边类型、节点角色或连续性不足。

`nodes`：主链路节点，按业务阅读顺序排列。对 `upstream` 和 `entry_to_target`，方向通常是入口或调用方到目标；对 `downstream` 和 `target_to_data`，方向通常是目标到下游。

`relations`：连接 `nodes` 的主链路边。这里只放主链路骨架边，不放所有邻接边。

`folded_steps`：被折叠的细节步骤，例如校验、参数组装、异常构造、锁工具、DTO getter/setter。折叠不等于丢弃，表示这些步骤通常不影响主链路理解。

`side_relation_ids`：与主链路相关但未进入骨架的边 ID。用于上游 Agent 需要展开细节时回查。

`score`：主链路排序分数。只用于比较同一次响应内的多个主链路，不作为跨项目绝对质量分。

`confidence`：主链路置信度。它不是 GitNexus 准确率，而是 Code Intelligence 对“这条链路适合作为主链路”的判断。

`score_breakdown`：评分来源，必须可解释。例如 `CALL_EDGE_CONTINUITY +0.35`、`TEST_NODE_PENALTY -0.25`。

`confidence_reason`：给人和上游 Agent 看的短理由，例如“连续 calls 边覆盖入口到目标，且未命中测试代码惩罚”。

`coverage`：该条主链路自身的覆盖情况。

`summary`：人类可读摘要。必须包含类名或限定符，不能只显示同名方法，否则会出现 `preCheckRebate --> preCheckRebate` 看不出谁调用谁的问题。

### 1.3 `ExploreCoverage` 字段契约

```ts
type ExploreCoverage = {
  complete: boolean;
  relation_budget_reached: boolean;
  fanout_limit_reached: boolean;
  depth_limit_reached: boolean;
  anchor_ambiguous: boolean;
  used_sources: Array<'gitnexus' | 'java-index' | 'grep' | 'manual'>;
  omitted_relation_count?: number;
  note: string;
};
```

字段语义：

`complete`：是否可以把本次探索视为当前图谱和预算内完整。只要命中预算、fanout、depth 或 anchor 歧义，通常为 `false`。

`relation_budget_reached`：是否触发关系预算。触发后不代表主链路不可用，只代表 `relations` 不是完整关系集合。

`fanout_limit_reached`：是否有单个节点邻接关系过多被裁剪。

`depth_limit_reached`：是否因为深度停止扩展。

`anchor_ambiguous`：是否存在多个候选起点。该字段为 `true` 时，上游 Agent 应优先展示多个主链路或要求用户精确到类名/方法签名。

`used_sources`：本次实际使用的证据来源。

`omitted_relation_count`：能计算时给出被裁剪关系数量，不能稳定计算时不返回该字段。

`note`：面向人类和上游 Agent 的一句话解释。

### 1.4 `BudgetSummary` 字段契约

```ts
type BudgetSummary = {
  requested_depth: number;
  requested_limit: number;
  relation_budget: number;
  explored_relation_count: number;
  returned_relation_count: number;
  main_path_count: number;
  side_relation_count: number;
  folded_step_count: number;
  budget_hit: boolean;
  budget_hit_reasons: string[];
};
```

字段语义：

`requested_limit`：用户输入的 `--limit` 或默认值，主要影响传统 `candidate_paths` 和展示数量。

`relation_budget`：V0.4 内部关系探索预算。默认值高于 V0.3 的 `limit`，用于避免随便一个查询都被 `limit=20` 截断。

`explored_relation_count`：实际探索到的关系数量。

`returned_relation_count`：放到 `relations` 中返回的关系数量。

`budget_hit`：是否有预算命中。

`budget_hit_reasons`：命中的预算类型，例如 `relation_budget`、`fanout`、`depth`。

### 1.5 字段契约文档交付物

新增文档：

```text
docs/2026-08-21-code-intelligence-v04-output-contract.zh-CN.md
```

文档必须包含：

1. V0.4 输出总览。
2. 字段分层：主消费层、证据审计层、兼容层。
3. 每个新增字段的含义。
4. 上游 Agent 消费规则。
5. “可以相信什么 / 不能相信什么”。
6. `coverage.complete=false` 时的标准话术。
7. `MAIN_PATH_LOW_CONFIDENCE` 时的降级动作。
8. 一个 `preCheckRebate` 风格的简化 JSON 示例。
9. 与 V0.3 的兼容说明。

---

## 2. 实施范围

### 2.1 本版本必须完成

- [ ] 新增 V0.4 输出字段契约文档。
- [ ] 扩展 Zod schema 和 TypeScript 类型。
- [ ] 新增主链路构建模块。
- [ ] 新增角色识别模块，避免只靠硬编码项目名。
- [ ] 新增可解释评分模块。
- [ ] 新增折叠细节模块。
- [ ] 新增覆盖度与预算摘要模块。
- [ ] 在 `exploreSymbol()` 中接入 `main_paths`。
- [ ] 调整 GitNexus 关系扩展顺序，让 calls / implements / method_implements / repository / mapper / SQL 类边优先于 imports / tests / DTO / util 噪声。
- [ ] 补充单元测试、集成测试和真实项目 eval case。
- [ ] 更新用户指南、当前能力文档、踩坑总结、面试问答。

### 2.2 本版本不做

- [ ] 不接入 JDT LS。
- [ ] 不宣称完整 Java 运行时调用链。
- [ ] 不处理所有反射、AOP、事件、消息队列、动态代理场景。
- [ ] 不删除 V0.3 的 `candidate_paths`。
- [ ] 不把 `relations` 改成完整图谱返回。

### 2.3 成功标准

功能标准：

- [ ] `explore` 默认输出至少包含 `main_paths`、`coverage`、`budget_summary`、`side_relations`。
- [ ] `main_paths[].summary` 不再出现无法区分调用双方的摘要，例如裸 `preCheckRebate --> preCheckRebate`。
- [ ] 在常见 A+B 场景下，能返回 1 到 3 条主链路。
- [ ] 对 `preCheckRebate` 真实项目 eval，默认参数下至少返回 1 条 `confidence >= medium` 的主链路。
- [ ] 命中 `RELATION_LIMIT_REACHED` 或 `FANOUT_LIMIT_REACHED` 时，不再自动把所有主链路降为低置信度。
- [ ] `coverage.complete=false` 明确告诉上游 Agent 结果是预算内候选主链路，不是完整调用图。

测试标准：

- [ ] `npm run build` 通过。
- [ ] `npm run typecheck` 通过。
- [ ] `npm run test` 通过。
- [ ] 新增 fixture 测试覆盖 upstream、downstream、both 三种方向。
- [ ] 新增 relation explosion 测试：当 imports / tests 噪声在前、fanout 有限时，核心 calls 链路仍能进入 `main_paths`。
- [ ] 真实 `mi-intl-scheme` eval case 输出归档。

文档标准：

- [ ] 字段契约文档能让人和上游 Agent 理解字段含义。
- [ ] 用户指南说明默认用法，不要求用户理解所有内部预算。
- [ ] 面试材料记录 V0.4 的设计取舍、踩坑和演进思路。

---

## 3. 文件清单

计划新增文件：

```text
docs/2026-08-21-code-intelligence-v04-output-contract.zh-CN.md
docs/superpowers/plans/2026-08-21-code-intelligence-main-path-v04-implementation-plan.zh-CN.md
packages/core/src/search/main-path/role-classifier.ts
packages/core/src/search/main-path/scoring.ts
packages/core/src/search/main-path/folding.ts
packages/core/src/search/main-path/coverage.ts
packages/core/src/search/main-path/builder.ts
packages/core/src/search/main-path/pruner.ts
packages/core/src/search/main-path/index.ts
packages/core/tests/main-path/role-classifier.test.ts
packages/core/tests/main-path/scoring.test.ts
packages/core/tests/main-path/folding.test.ts
packages/core/tests/main-path/coverage.test.ts
packages/core/tests/main-path/builder.test.ts
packages/core/tests/explore-symbol-main-path.test.ts
```

计划修改文件：

```text
packages/core/src/schemas.ts
packages/core/src/search/explore-symbol.ts
packages/cli/src/index.ts
packages/mcp/src/server.ts
packages/core/tests/explore-symbol.test.ts
packages/cli/tests/index.test.ts
packages/mcp/tests/server.test.ts
docs/current-tool-capabilities.zh-CN.md
docs/user-guide.zh-CN.md
docs/code-intelligence-pitfalls-and-evolution.zh-CN.md
docs/interview-qa.zh-CN.md
docs/2026-08-21-code-intelligence-main-path-v04-design.zh-CN.md
```

真实 eval 输出目录：

```text
/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-main-path-v04-20260821/
```

当前目录不是标准 git 仓库，本计划不包含 commit 步骤。执行时用构建、类型检查、单元测试和真实 eval 输出作为交付检查点。

---

## 4. 实施步骤

### 4.1 写字段契约文档

- [ ] 新增 `docs/2026-08-21-code-intelligence-v04-output-contract.zh-CN.md`。

文档结构：

```md
# Code Intelligence V0.4 输出字段契约

## 1. 契约目标

## 2. 字段分层

## 3. 主消费层

## 4. 证据审计层

## 5. 兼容层

## 6. 字段明细

## 7. 上游 Agent 消费规则

## 8. 降级规则

## 9. 示例

## 10. 版本兼容
```

- [ ] 在文档中写清楚：`relations` 是预算内证据子集，不是完整图谱。
- [ ] 在文档中写清楚：`main_paths` 是候选主链路，不是完整运行时调用链。
- [ ] 在文档中写清楚：`coverage.complete=false` 时，上游 Agent 应该使用谨慎话术。
- [ ] 在文档中写清楚：`confidence=medium` 可以用于初步定位，`confidence=low` 只能用于线索扩展。
- [ ] 在文档中给出一个简化 JSON 示例：

```json
{
  "main_paths": [
    {
      "id": "main_path_1",
      "path_type": "entry_to_target",
      "path_status": "partial_candidate",
      "summary": "SettlementBillCommandProviderImpl.preCheckRebate --calls--> SettlementBillCommandServiceImpl.preCheckRebate --calls--> SettlementAndRebateServiceImpl.preCheckRebate",
      "confidence": "medium",
      "confidence_reason": "连续 calls 边连接应用层 Provider、领域服务和目标方法；部分下游细节被折叠。",
      "folded_steps": [
        {
          "relation_id": "relation_5",
          "fold_type": "validation",
          "summary": "checkPreCheckParam 被折叠为参数校验步骤"
        }
      ],
      "coverage": {
        "complete": false,
        "reason": "命中 relation_budget，主链路可用但不能声明为完整调用图。"
      }
    }
  ],
  "coverage": {
    "complete": false,
    "relation_budget_reached": true,
    "fanout_limit_reached": false,
    "depth_limit_reached": true,
    "anchor_ambiguous": true,
    "used_sources": ["gitnexus"],
    "note": "本次返回预算内候选主链路，relations 不是完整图谱。"
  }
}
```

验收：

- [ ] 文档中不存在“让 Agent 自己理解字段”的隐含假设。
- [ ] 文档中明确给出“可以使用”和“不能使用”的边界。

### 4.2 扩展 Schema

- [ ] 修改 `packages/core/src/schemas.ts`，新增以下 Zod schema：

```ts
export const ScoreFactorSchema = z.object({
  name: z.string(),
  weight: z.number(),
  reason: z.string(),
});

export const FoldedStepSchema = z.object({
  relation_id: z.string(),
  fold_type: z.enum([
    'validation',
    'parameter_assembly',
    'exception',
    'lock',
    'dto_accessor',
    'utility',
    'test',
    'low_priority_detail',
  ]),
  summary: z.string(),
  evidence: z.array(RelationEvidenceSchema).default([]),
});

export const MainPathCoverageSchema = z.object({
  complete: z.boolean(),
  reason: z.string(),
  missing_segments: z.array(z.string()).default([]),
});

export const ExploreCoverageSchema = z.object({
  complete: z.boolean(),
  relation_budget_reached: z.boolean(),
  fanout_limit_reached: z.boolean(),
  depth_limit_reached: z.boolean(),
  anchor_ambiguous: z.boolean(),
  used_sources: z.array(z.enum(['gitnexus', 'java-index', 'grep', 'manual'])),
  omitted_relation_count: z.number().int().nonnegative().optional(),
  note: z.string(),
});

export const BudgetSummarySchema = z.object({
  requested_depth: z.number().int().nonnegative(),
  requested_limit: z.number().int().positive(),
  relation_budget: z.number().int().positive(),
  explored_relation_count: z.number().int().nonnegative(),
  returned_relation_count: z.number().int().nonnegative(),
  main_path_count: z.number().int().nonnegative(),
  side_relation_count: z.number().int().nonnegative(),
  folded_step_count: z.number().int().nonnegative(),
  budget_hit: z.boolean(),
  budget_hit_reasons: z.array(z.string()),
});

export const SideRelationSchema = CodeRelationSchema.extend({
  id: z.string(),
  side_type: z.enum(['import_noise', 'test_noise', 'utility_detail', 'dto_detail', 'parallel_branch', 'low_score_relation']),
  reason: z.string(),
});

export const MainPathSchema = z.object({
  id: z.string(),
  path_type: z.enum(['upstream', 'downstream', 'entry_to_target', 'target_to_data', 'mixed']),
  path_status: z.enum(['complete_candidate', 'partial_candidate', 'truncated', 'low_confidence']),
  nodes: z.array(CodeAnchorSchema),
  relations: z.array(CodeRelationSchema),
  folded_steps: z.array(FoldedStepSchema).default([]),
  side_relation_ids: z.array(z.string()).default([]),
  score: z.number(),
  confidence: ConfidenceSchema,
  score_breakdown: z.array(ScoreFactorSchema),
  confidence_reason: z.string(),
  coverage: MainPathCoverageSchema,
  summary: z.string(),
});
```

- [ ] 将 `ExploreResponseSchema` 扩展为包含：

```ts
main_paths: z.array(MainPathSchema).default([]),
side_relations: z.array(SideRelationSchema).default([]),
coverage: ExploreCoverageSchema,
budget_summary: BudgetSummarySchema,
```

- [ ] 导出对应类型：

```ts
export type MainPath = z.infer<typeof MainPathSchema>;
export type SideRelation = z.infer<typeof SideRelationSchema>;
export type ExploreCoverage = z.infer<typeof ExploreCoverageSchema>;
export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;
```

测试：

- [ ] 更新或新增 schema 测试，断言新增字段能被 `ExploreResponseSchema.parse()` 接收。
- [ ] 断言缺少 `main_paths` 时不能作为 V0.4 响应通过最终构造函数，避免实现层漏填字段。

验收：

- [ ] 类型检查能识别新增字段。
- [ ] 现有 V0.3 测试如果构造响应，需要补齐新增字段或使用统一构造函数。

### 4.3 建立主链路模块目录

- [ ] 新增目录：

```text
packages/core/src/search/main-path/
```

- [ ] 新增 `index.ts` 统一导出：

```ts
export * from './role-classifier.js';
export * from './scoring.js';
export * from './folding.js';
export * from './coverage.js';
export * from './pruner.js';
export * from './builder.js';
```

验收：

- [ ] 后续 `explore-symbol.ts` 只从 `main-path/index.js` 引入能力，避免散乱 import。

### 4.4 实现角色识别

- [ ] 新增 `packages/core/src/search/main-path/role-classifier.ts`。

角色枚举：

```ts
export type NodeRole =
  | 'entry'
  | 'controller'
  | 'provider'
  | 'application_service'
  | 'domain_service'
  | 'repository'
  | 'mapper'
  | 'sql'
  | 'external_dependency'
  | 'validation'
  | 'parameter_assembly'
  | 'exception'
  | 'lock'
  | 'utility'
  | 'dto'
  | 'test'
  | 'unknown';
```

识别原则：

1. 不绑定 `mi-intl-scheme` 的具体业务包名。
2. 使用通用 Java 企业项目信号：注解、文件路径、类名后缀、方法名、节点类型。
3. 包层级只作为弱信号，不作为唯一依据。
4. 识别结果要附带 `reasons`，方便评分解释。

核心函数：

```ts
export type ClassifiedNode = {
  id: string;
  role: NodeRole;
  score: number;
  reasons: string[];
};

export function classifyNode(anchor: CodeAnchor): ClassifiedNode;
```

通用规则：

```ts
Controller / RestController / RequestMapping -> controller
Provider / Facade / ApiImpl -> provider
ApplicationService / CommandService / QueryService -> application_service
DomainService / ServiceImpl / Manager -> domain_service
Repository / Dao / Gateway -> repository
Mapper / XML mapper path -> mapper
SQL evidence / sql map anchor -> sql
Test path or class suffix Test -> test
DTO / VO / ValObj / Request / Response / Param -> dto
check / validate / assert / ensure -> validation
build / assemble / convert / mapTo -> parameter_assembly
Exception / ErrorCode / throw -> exception
Lock / Redisson / synchronized -> lock
Util / Helper / StringUtils / CollectionUtils -> utility
```

测试文件：

```text
packages/core/tests/main-path/role-classifier.test.ts
```

测试用例：

- [ ] `SettlementTestController.java` 识别为 `controller`。
- [ ] `SettlementBillCommandProviderImpl` 识别为 `provider`。
- [ ] `SettlementBillCommandServiceImpl` 识别为 `application_service` 或 `domain_service`，并给出类名后缀理由。
- [ ] `ActivitySettlementLineRebateRepositoryImpl` 识别为 `repository`。
- [ ] `BizException` 识别为 `exception`。
- [ ] `RedissonLockUtil.executeWithHashLock` 识别为 `lock` 或 `utility`，优先 `lock`。
- [ ] `SettlementAndRebateServiceImplTest` 识别为 `test`。

验收：

- [ ] 没有任何规则只匹配 `mi-intl-scheme` 专有路径。
- [ ] 每个分类结果都有非空 `reasons`。

### 4.5 实现评分模块

- [ ] 新增 `packages/core/src/search/main-path/scoring.ts`。

评分目标：

1. 让业务主链路优先于噪声边。
2. 让连续 `calls` 链路优先于 `imports`、`has_method`、`accesses`。
3. 让入口、Provider、Service、Repository、Mapper、SQL 等主流程角色优先。
4. 让 test、DTO、getter/setter、utility 细节降权。
5. 所有加减分必须进入 `score_breakdown`。

核心函数：

```ts
export function scoreRelationForMainPath(relation: CodeRelation): ScoreFactor[];

export function scorePathForMainPath(input: {
  nodes: CodeAnchor[];
  relations: CodeRelation[];
  targetAnchorIds: Set<string>;
  direction: 'upstream' | 'downstream' | 'both';
}): {
  score: number;
  confidence: Confidence;
  score_breakdown: ScoreFactor[];
  confidence_reason: string;
};
```

关系类型基础分：

```text
calls: +0.45
method_implements: +0.25
implements: +0.20
has_method: +0.10
accesses: -0.05
imports: -0.30
references: -0.10
unknown: -0.15
```

角色分：

```text
controller/provider/application_service/domain_service/repository/mapper/sql: +0.20
validation/parameter_assembly/lock/exception: -0.05
utility/dto/test: -0.25
```

连续性分：

```text
连续 calls 边数量 >= 2: +0.30
路径包含 target anchor: +0.30
路径方向与请求 direction 一致: +0.20
路径出现自环: -0.30
路径节点重复超过 1 次: -0.20
```

置信度规则：

```text
score >= 0.75 -> high
0.40 <= score < 0.75 -> medium
score < 0.40 -> low
```

注意：`RELATION_LIMIT_REACHED`、`FANOUT_LIMIT_REACHED` 不直接决定单条 `main_path.confidence=low`。这些预算信号进入 `coverage`，不替代路径自身评分。

测试文件：

```text
packages/core/tests/main-path/scoring.test.ts
```

测试用例：

- [ ] `Provider -> Service -> Target` calls 链路得分高于 `Test -> Target`。
- [ ] `imports` 链路不能排在 `calls` 主链路前。
- [ ] 自环 `A -> A` 降权。
- [ ] `score_breakdown` 非空，并包含可读 reason。
- [ ] 预算截断不自动导致路径评分为 low。

### 4.6 实现折叠模块

- [ ] 新增 `packages/core/src/search/main-path/folding.ts`。

折叠目标：

1. 不把校验、参数构造、异常构造、锁、DTO getter/setter 当成主链路骨架。
2. 不丢弃这些证据，而是放入 `folded_steps` 或 `side_relations`。
3. 让流程图 Skill 能默认画主链路，需要细节时再展开。

核心函数：

```ts
export function classifyFoldedStep(input: {
  relation: CodeRelation;
  from?: CodeAnchor;
  to?: CodeAnchor;
}): FoldedStep | undefined;

export function foldPathDetails(input: {
  nodes: CodeAnchor[];
  relations: CodeRelation[];
}): {
  nodes: CodeAnchor[];
  relations: CodeRelation[];
  folded_steps: FoldedStep[];
};
```

折叠规则：

```text
check / validate / assert / ensure -> validation
build / assemble / convert / mapTo -> parameter_assembly
Exception / throw -> exception
Lock / Redisson -> lock
getX / setX / isX / DTO / VO / ValObj -> dto_accessor
Util / Helper -> utility
test path -> test
```

测试文件：

```text
packages/core/tests/main-path/folding.test.ts
```

测试用例：

- [ ] `preCheckRebate -> checkPreCheckParam` 折叠为 `validation`。
- [ ] `preCheckRebate -> getHashParamsOrThrow` 折叠为 `validation` 或 `parameter_assembly`，并保留 evidence。
- [ ] `preCheckRebate -> BizException.BizException` 折叠为 `exception`。
- [ ] `preCheckRebate -> RedissonLockUtil.executeWithHashLock` 折叠为 `lock`。
- [ ] `Service -> Repository.query` 不被折叠。

### 4.7 实现覆盖度和预算摘要

- [ ] 新增 `packages/core/src/search/main-path/coverage.ts`。

核心函数：

```ts
export function buildExploreCoverage(input: {
  diagnostics: Diagnostic[];
  usedSources: Array<'gitnexus' | 'java-index' | 'grep' | 'manual'>;
  anchorCount: number;
  omittedRelationCount?: number;
}): ExploreCoverage;

export function buildBudgetSummary(input: {
  requestedDepth: number;
  requestedLimit: number;
  relationBudget: number;
  exploredRelationCount: number;
  returnedRelationCount: number;
  mainPathCount: number;
  sideRelationCount: number;
  foldedStepCount: number;
  diagnostics: Diagnostic[];
}): BudgetSummary;
```

诊断映射：

```text
RELATION_LIMIT_REACHED -> relation_budget_reached=true
FANOUT_LIMIT_REACHED -> fanout_limit_reached=true
PATH_TRUNCATED / depth stop -> depth_limit_reached=true
ANCHOR_AMBIGUOUS -> anchor_ambiguous=true
GITNEXUS_RELATIONS_USED -> used_sources 包含 gitnexus
```

`coverage.complete` 规则：

```text
没有预算截断、没有 fanout 截断、没有 depth 截断、没有 anchor 歧义 -> true
其他情况 -> false
```

测试文件：

```text
packages/core/tests/main-path/coverage.test.ts
```

测试用例：

- [ ] 有 `RELATION_LIMIT_REACHED` 时 `coverage.complete=false`。
- [ ] 有 `ANCHOR_AMBIGUOUS` 时 `anchor_ambiguous=true`。
- [ ] 有 `GITNEXUS_RELATIONS_USED` 时 `used_sources` 包含 `gitnexus`。
- [ ] `budget_summary.budget_hit_reasons` 准确包含命中的预算类型。

### 4.8 实现关系剪枝和扩展优先级

- [ ] 新增 `packages/core/src/search/main-path/pruner.ts`。

目标：

1. 解决“limit 太小导致核心 calls 边还没返回就被 imports/test 噪声占满”的问题。
2. 不宣称返回完整图谱。
3. 让主链路相关边优先进入 `relations` 和 `main_paths`。

核心函数：

```ts
export function relationExpansionPriority(relation: CodeRelation): number;

export function splitSideRelations(input: {
  relations: CodeRelation[];
  mainPathRelationKeys: Set<string>;
}): {
  mainRelations: CodeRelation[];
  sideRelations: SideRelation[];
};
```

优先级：

```text
calls -> 100
method_implements -> 85
implements -> 80
has_method -> 65
repository / mapper / sql 相关 references -> 60
accesses -> 35
references -> 30
imports -> 10
test path relation -> 5
self-loop -> 0
```

接入点：

- [ ] 在 `packages/core/src/search/explore-symbol.ts` 的 GitNexus 关系扩展逻辑里，将原本按返回顺序 `slice(0, fanout)` 的逻辑改成：

```ts
const prioritized = [...mapped].sort((a, b) => relationExpansionPriority(b) - relationExpansionPriority(a));
const allowed = prioritized.slice(0, fanout);
```

保留诊断：

- [ ] 如果 `mapped.length > fanout`，继续返回 `FANOUT_LIMIT_REACHED`。
- [ ] diagnostics 文案改为说明“已按主链路优先级裁剪”，避免用户误解为随机截断。

测试用例：

- [ ] 构造一个 GitNexus fake 返回：前 30 条都是 imports/test，后 3 条是核心 calls；设置 `fanout=10` 后，核心 calls 仍进入结果。
- [ ] diagnostics 中仍包含 fanout 截断，但 `main_paths` 能给出 medium 主链路。

### 4.9 实现主链路构建器

- [ ] 新增 `packages/core/src/search/main-path/builder.ts`。

核心函数：

```ts
export type BuildMainPathsInput = {
  anchors: CodeAnchor[];
  relations: CodeRelation[];
  candidatePaths: CandidatePath[];
  direction: 'upstream' | 'downstream' | 'both';
  depth: number;
  mainPathLimit: number;
  diagnostics: Diagnostic[];
};

export type BuildMainPathsOutput = {
  main_paths: MainPath[];
  side_relations: SideRelation[];
  diagnostics: Diagnostic[];
};

export function buildMainPaths(input: BuildMainPathsInput): BuildMainPathsOutput;
```

构建流程：

1. 将 `relations` 建成邻接表。
2. 以 `anchors` 中的方法级节点为 target，类级节点作为弱 target。
3. 从 target 做 upstream 搜索，寻找调用方、入口、Provider、Controller。
4. 从 target 做 downstream 搜索，寻找核心业务服务、Repository、Mapper、SQL 或外部依赖。
5. 按 direction 组合路径：
   - `upstream`：返回 upstream 主链路。
   - `downstream`：返回 downstream 主链路。
   - `both`：返回 upstream + target + downstream 的可读组合；如果不能组合，则分别返回最好的 upstream/downstream。
6. 对每条候选路径调用评分。
7. 对低价值节点调用折叠。
8. 生成 `side_relations`。
9. 取前 `mainPathLimit` 条。
10. 生成 diagnostics。

路径构建规则：

```text
优先连续 calls。
method_implements / implements / has_method 可用于连接接口和实现，但不应单独成为主业务链路。
imports 默认不进入 main_path，只进入 side_relations。
test 节点默认不进入 main_path，除非没有任何生产调用方。
self-loop 不进入 main_path。
同名方法 summary 必须带类名。
```

summary 格式：

```text
SettlementBillCommandProviderImpl.preCheckRebate --calls--> SettlementBillCommandServiceImpl.preCheckRebate --calls--> SettlementAndRebateServiceImpl.preCheckRebate
```

不能输出：

```text
preCheckRebate --calls--> preCheckRebate
```

诊断：

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

测试文件：

```text
packages/core/tests/main-path/builder.test.ts
```

测试图谱：

```text
SettlementBillCommandProviderImpl.preCheckRebate
  --calls-->
SettlementBillCommandServiceImpl.preCheckRebate
  --calls-->
SettlementAndRebateServiceImpl.preCheckRebate
  --calls-->
SettlementAndRebateServiceImpl.executePreCheckRebate
  --calls-->
ActivitySettlementLineRebateRepositoryImpl.query
  --calls-->
ActivitySettlementLineRebateMapper.select
```

同时加入噪声：

```text
Test.preCheckRebate_shouldThrowWhenReqIsNull --calls--> SettlementAndRebateServiceImpl.preCheckRebate
SettlementAndRebateServiceImpl.preCheckRebate --calls--> checkPreCheckParam
SettlementAndRebateServiceImpl.preCheckRebate --calls--> getHashParamsOrThrow
SettlementAndRebateServiceImpl.preCheckRebate --calls--> BizException.BizException
SettlementAndRebateServiceImpl.preCheckRebate --calls--> RedissonLockUtil.executeWithHashLock
SomeFile --imports--> SettlementAndRebateService
```

断言：

- [ ] `main_paths.length` 为 1 到 3。
- [ ] 最优 `main_paths[0].summary` 包含 `SettlementBillCommandProviderImpl`、`SettlementBillCommandServiceImpl`、`SettlementAndRebateServiceImpl`。
- [ ] `main_paths[0].confidence` 为 `medium` 或 `high`。
- [ ] `folded_steps` 包含校验、异常、锁。
- [ ] `imports` 不进入主链路。
- [ ] `Test` 不进入主链路，除非没有生产调用方。
- [ ] `score_breakdown` 非空。
- [ ] `confidence_reason` 非空。

### 4.10 接入 `exploreSymbol()`

- [ ] 修改 `packages/core/src/search/explore-symbol.ts`。

接入位置：

1. GitNexus relations 已经收集完成。
2. `candidate_paths` 已经生成完成。
3. 最终 response 组装之前。

伪代码：

```ts
const mainPathResult = buildMainPaths({
  anchors,
  relations,
  candidatePaths,
  direction,
  depth,
  mainPathLimit,
  diagnostics,
});

const coverage = buildExploreCoverage({
  diagnostics: [...diagnostics, ...mainPathResult.diagnostics],
  usedSources,
  anchorCount: anchors.length,
});

const budgetSummary = buildBudgetSummary({
  requestedDepth: depth,
  requestedLimit: limit,
  relationBudget,
  exploredRelationCount: relations.length,
  returnedRelationCount: relations.length,
  mainPathCount: mainPathResult.main_paths.length,
  sideRelationCount: mainPathResult.side_relations.length,
  foldedStepCount: mainPathResult.main_paths.reduce((sum, path) => sum + path.folded_steps.length, 0),
  diagnostics: [...diagnostics, ...mainPathResult.diagnostics],
});
```

- [ ] response 新增：

```ts
main_paths: mainPathResult.main_paths,
side_relations: mainPathResult.side_relations,
coverage,
budget_summary: budgetSummary,
```

- [ ] summary 更新为：

```text
找到 2 个探索起点，60 条关系证据，2 条候选主链路。direction=both, depth=2, limit=20, relationBudget=60。
```

- [ ] 如果 `main_paths.length === 0`，追加 diagnostic：

```ts
{
  level: 'warning',
  code: 'MAIN_PATH_NO_STRONG_RELATION_CHAIN',
  message: '未能从当前关系证据中构建稳定主链路；建议提高 relationBudget、缩小 query 或使用更精确方法签名。'
}
```

测试：

- [ ] 新增 `packages/core/tests/explore-symbol-main-path.test.ts`。
- [ ] 用 fake GitNexus adapter 测试 `exploreSymbol()` 返回 V0.4 字段。
- [ ] 断言 `coverage.complete=false` 时，主链路仍可能是 `confidence=medium`。
- [ ] 断言默认 `limit=20` 不导致主链路必然低置信度。

### 4.11 CLI 参数和输出

- [ ] 修改 `packages/cli/src/index.ts`。

CLI 保持傻瓜式默认：

```bash
node packages/cli/dist/index.js explore mi-intl-scheme --query "preCheckRebate" --direction both
```

用户不需要理解所有预算参数。

保留高级参数：

```text
--depth
--limit
--relation-budget
--fanout
```

新增可选参数：

```text
--main-path-limit
```

默认：

```text
depth=2
limit=20
relationBudget=80
fanout=20
mainPathLimit=3
```

CLI help 文案：

```text
--main-path-limit <n>  返回的候选主链路数量，默认 3
--relation-budget <n>  内部关系探索预算，默认 80；普通用户通常不需要调整
```

测试：

- [ ] 更新 `packages/cli/tests/index.test.ts`。
- [ ] 断言 `explore --help` 包含 `--main-path-limit`。
- [ ] 断言 CLI 输出 JSON 中包含 `main_paths`、`coverage`、`budget_summary`。

### 4.12 MCP Tool 契约

- [ ] 修改 `packages/mcp/src/server.ts`。

MCP tool 入参新增：

```ts
main_path_limit?: number
```

MCP tool description 增加简短消费说明：

```text
返回代码锚点、预算内关系证据、候选路径和 V0.4 main_paths。上游 Agent 应优先消费 main_paths；relations 是预算内证据子集，不代表完整图谱；coverage.complete=false 时不得声明完整调用链。
```

测试：

- [ ] 更新 `packages/mcp/tests/server.test.ts`。
- [ ] 断言 schema 中包含 `main_path_limit`。
- [ ] 断言工具说明包含 `main_paths` 和 `coverage.complete=false` 语义。

### 4.13 文档更新

- [ ] 更新 `docs/user-guide.zh-CN.md`。

必须新增：

```md
## 查询主链路

普通使用：

node packages/cli/dist/index.js explore mi-intl-scheme --query "preCheckRebate" --direction both

重点看：

1. main_paths
2. coverage
3. diagnostics

不建议普通用户先看 relations 和 candidate_paths。
```

- [ ] 更新 `docs/current-tool-capabilities.zh-CN.md`。

必须说明：

```text
V0.4 起，explore 输出 main_paths，用于给上游 Agent 一个更稳定的主链路入口。relations 仍是预算内证据集合，不是完整 GitNexus 图谱。
```

- [ ] 更新 `docs/code-intelligence-pitfalls-and-evolution.zh-CN.md`。

新增踩坑：

```text
只返回关系边集合会让上游 Agent 难以判断主次；单一 limit 会让查询轻易截断；解决方式是主链路优先、预算分层、折叠细节、覆盖度声明和可解释评分。
```

- [ ] 更新 `docs/interview-qa.zh-CN.md`。

新增问答：

```text
问：输出模型这么复杂，上游 Agent 怎么理解？
答：不能靠猜。V0.4 把输出分成主消费层和证据审计层，并提供字段契约文档。上游 Agent 默认消费 main_paths、coverage、diagnostics；relations/candidate_paths 用于补证据和审计。这样既降低使用复杂度，又保留可追溯性。
```

- [ ] 更新 `docs/2026-08-21-code-intelligence-main-path-v04-design.zh-CN.md`。

补充：

```text
字段契约是 V0.4 的交付物之一，不是附属文档。没有字段契约，复杂 JSON 对上游 Agent 只是半结构化噪声。
```

### 4.14 真实项目 Eval Case

- [ ] 新建目录：

```text
/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-main-path-v04-20260821/
```

- [ ] 保存请求：

```json
{
  "project": "mi-intl-scheme",
  "query": "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);",
  "type": "symbol",
  "direction": "both",
  "depth": 2,
  "limit": 20,
  "relation_budget": 80,
  "main_path_limit": 3
}
```

- [ ] 保存原始输出：

```text
raw-output.json
```

- [ ] 保存归一化摘要：

```text
normalized-summary.md
```

摘要必须包含：

```md
## Main Paths

## Coverage

## Diagnostics

## Folded Steps

## Side Relations

## 是否符合预期
```

- [ ] 保存期望：

```text
expectations.json
```

期望：

```json
{
  "main_paths_min": 1,
  "main_paths_max": 3,
  "required_confidence_at_least": "medium",
  "summary_must_include_any": [
    "SettlementBillCommandProviderImpl",
    "SettlementBillCommandServiceImpl",
    "SettlementAndRebateServiceImpl"
  ],
  "summary_must_not_equal": [
    "preCheckRebate --calls--> preCheckRebate",
    "preCheckRebate <--calls-- preCheckRebate"
  ],
  "coverage_complete_can_be_false": true,
  "relations_may_be_budgeted_subset": true
}
```

执行命令：

```bash
node packages/cli/dist/index.js explore mi-intl-scheme \
  --query "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);" \
  --type symbol \
  --direction both \
  --depth 2 \
  --relation-budget 80 \
  --main-path-limit 3 \
  > /root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-main-path-v04-20260821/raw-output.json
```

校验脚本命令：

```bash
node -e '
const fs = require("fs");
const out = JSON.parse(fs.readFileSync("/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-main-path-v04-20260821/raw-output.json", "utf8"));
if (!Array.isArray(out.main_paths) || out.main_paths.length < 1 || out.main_paths.length > 3) throw new Error("main_paths count invalid");
if (!out.coverage || typeof out.coverage.complete !== "boolean") throw new Error("coverage missing");
if (!out.budget_summary) throw new Error("budget_summary missing");
if (out.main_paths.some(p => p.summary === "preCheckRebate --calls--> preCheckRebate" || p.summary === "preCheckRebate <--calls-- preCheckRebate")) throw new Error("ambiguous same-name summary");
if (!out.main_paths.some(p => p.confidence === "medium" || p.confidence === "high")) throw new Error("no medium/high main path");
console.log("v0.4 eval passed", { main_paths: out.main_paths.length, complete: out.coverage.complete });
'
```

预期输出：

```text
v0.4 eval passed { main_paths: 1到3之间的数字, complete: true或false }
```

### 4.15 验证命令

- [ ] 构建：

```bash
npm run build
```

预期：

```text
无 TypeScript 编译错误
```

- [ ] 类型检查：

```bash
npm run typecheck
```

预期：

```text
无类型错误
```

- [ ] 单元测试：

```bash
npm run test
```

预期：

```text
所有测试通过
```

- [ ] 真实项目 eval：

```bash
node packages/cli/dist/index.js explore mi-intl-scheme \
  --query "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);" \
  --type symbol \
  --direction both \
  --depth 2 \
  --relation-budget 80 \
  --main-path-limit 3
```

预期：

```text
输出包含 main_paths、coverage、budget_summary；
至少一条 main_path 为 medium 或 high；
summary 不出现裸同名方法调用；
coverage.complete 可以为 false，但必须说明原因。
```

---

## 5. 风险和取舍

### 5.1 评分体系可能不够准

风险：评分规则是启发式，不是 Java 编译器级精确调用层级。

处理：

1. `score_breakdown` 必须展示理由。
2. `confidence_reason` 必须可读。
3. 真实项目 eval case 必须归档，作为后续调参依据。
4. 不把 `medium` 说成“绝对正确”，只说“适合优先验证的主链路”。

### 5.2 剪枝可能误删重要边

风险：主链路优先级裁剪可能把某些业务项目里的关键工具、事件、消息边降级。

处理：

1. 被剪掉的边进入 `side_relations` 或通过 `coverage` 声明预算截断。
2. 上游 Agent 需要深入时，可以用主链路节点继续二次 explore。
3. 后续根据 eval case 调整优先级，而不是把规则写死到某一个项目。

### 5.3 输出字段增多导致用户困惑

风险：用户和上游 Agent 面对更多字段，不知道该看什么。

处理：

1. 用户指南只推荐看 `main_paths`、`coverage`、`diagnostics`。
2. 字段契约文档解释所有字段。
3. CLI summary 给出一句话结果，不要求普通用户先读完整 JSON。

### 5.4 与 GitNexus 原始能力边界不清

风险：面试或生产使用时被问“为什么不直接用 GitNexus？”

回答：

GitNexus 提供代码图谱和关系证据，Code Intelligence 负责把图谱结果转成上游 Agent 可消费的任务模型。V0.4 的价值不是重复造图谱，而是做主链路选择、证据分层、覆盖度声明、降级策略和面向线上排障/业务理解的输出契约。

---

## 6. 面试讲解要点

V0.4 可以作为面试中体现工程演进的核心案例：

1. 第一版只返回位置和关系边，能检索，但不够好用。
2. 真实项目试用暴露问题：同名方法摘要不可读、limit 导致截断、candidate_paths 只是片段、上游 Agent 难判断主次。
3. 没有盲目接 JDT LS，因为冷启动和项目导入成本高，不适合先做轻量工具底座。
4. 选择 GitNexus + 主链路二次组织：先把已有图谱能力转成上游 Agent 需要的任务证据。
5. 不是隐藏不确定性，而是通过 `coverage`、`budget_summary`、`diagnostics` 把不确定性暴露出来。
6. 不是把复杂度丢给用户，而是给默认消费规则：上游默认看 `main_paths`。
7. 评分体系可解释、可测试、可用 eval case 复盘优化。

---

## 7. 执行检查清单

- [ ] 完成字段契约文档。
- [ ] 完成 schema 扩展。
- [ ] 完成 role classifier。
- [ ] 完成 scoring。
- [ ] 完成 folding。
- [ ] 完成 coverage。
- [ ] 完成 pruner。
- [ ] 完成 builder。
- [ ] 接入 exploreSymbol。
- [ ] 更新 CLI。
- [ ] 更新 MCP。
- [ ] 补齐测试。
- [ ] 更新用户文档。
- [ ] 更新面试文档。
- [ ] 跑 build/typecheck/test。
- [ ] 跑 mi-intl-scheme eval。
- [ ] 根据 eval 输出修正文档中的演示命令和示例。

---

## 8. 自审结果

自审维度：

1. 是否覆盖用户提出的“输出模型上游 Agent 看不懂”的问题：已覆盖，字段契约文档是 V0.4 必交付物。
2. 是否覆盖关系边爆炸和 limit 截断问题：已覆盖，增加 relationBudget、主链路优先级、side_relations、coverage。
3. 是否覆盖主链路可用性问题：已覆盖，新增 main_paths、评分、折叠、真实 eval。
4. 是否避免只为面试做展示：已覆盖，设计目标是线上排障和业务理解生产场景，面试只是讲解场景之一。
5. 是否明确边界：已覆盖，不宣称完整运行时调用链，不接 JDT LS，不处理全部动态机制。
6. 是否有可执行测试：已覆盖，包含单元测试、集成测试、真实项目 eval。

Plan complete and saved to `docs/superpowers/plans/2026-08-21-code-intelligence-main-path-v04-implementation-plan.zh-CN.md`. Two execution options:

1. Subagent-Driven (recommended)：适合把 role classifier、scoring、builder、docs/test 分给多个独立执行单元并行实现。
2. Inline Execution：由当前 Agent 在一个连续流程里按步骤实现，节奏更稳，便于你持续审查需求取舍。

Which approach?
