# Code Intelligence explore v0.3 回归修正规格

日期：2026-08-20

## 1. 背景

`explore` v0.3 的目标是从一个线索出发，返回：

```text
anchors + relations + candidate_paths + diagnostics
```

它已经解决了两个关键问题：

- 用户不需要预先知道 `trace --from --to`。
- GitNexus anchor 后续 context 使用 UID，避免短方法名导致关系扩展失败。

但在 `mi-intl-scheme` 上真实试用后发现，当前 v0.3 仍存在几个会影响可信度的问题：

- `both` 模式下反向遍历 relation 时，summary 可能把真实调用方向显示反。
- `candidate_paths` 混入 `imports`、`accesses`、大量结构边，容易被误读为调用链。
- 默认只过滤了测试 anchors，没有过滤 path endpoint，导致候选路径仍然出现测试类。
- `method_implements` 被降级成 `references`，丢失 Java 接口方法到实现方法的关键语义。
- anchor 排序不符合 Java 排障直觉，接口类可能排在实现方法前面，造成 imports 扩散。
- `limit` 截断后，低价值关系可能先进入候选路径，真正有用的调用边反而被挤掉。

本规格只修正 v0.3 的基础正确性，不把 v0.3 扩展成完整调用链工具。完整调用路径提取放到 v0.4 `call-path`。

## 2. v0.3 定位

v0.3 的准确定位：

```text
单点图谱探索和候选路径片段生成。
```

v0.3 应该做到：

- 从 query 定位一个或多个 anchor。
- 使用 GitNexus context 展开上下游关系。
- 返回原始关系证据集合 `relations`。
- 从关系证据中筛选出更适合作为路径片段的 `candidate_paths`。
- 用 diagnostics 明确歧义、截断、降级和低置信情况。

v0.3 不承诺：

- 生成完整运行时调用链。
- 自动判断线上根因。
- 自动穿透反射、AOP、动态代理、MQ、RPC、事件机制。
- 自动合并跨项目链路。
- 自动输出业务流程图。

核心原则：

```text
candidate_paths 可以不完整，但不能方向错误；可以保守，但不能误导。
```

## 3. 需要修复的行为

### 3.1 both 模式不能反转真实调用方向

当前问题：

```text
真实关系：A --calls--> B
从 B 反向探索时展示：B --calls--> A
```

这是错误的。`CodeRelation.from -> CodeRelation.to` 是事实方向，路径遍历方向不能改变事实方向。

修正要求：

- path 内部可以从 `to` 反向走到 `from`。
- summary 必须尊重 relation 的事实方向。
- 如果本次 path 是反向遍历，summary 应显示反向箭头：

```text
B <--calls-- A
```

或者采用等价但更直观的正向表达：

```text
A --calls--> B
```

v0.3 优先采用第一种，避免大改输出结构。

### 3.2 candidate_paths 默认只使用 path-eligible 关系

`relations` 是完整关系证据集合，可以包含：

```text
calls
implements
imports
accesses
has_method
has_property
contains
extends
method_implements
method_overrides
maps_to_sql
uses_table
logs
references
```

但 `candidate_paths` 不应该直接使用所有关系。默认可进入路径的关系：

```text
calls
method_implements
method_overrides
implements
has_method
maps_to_sql
uses_table
```

默认不进入路径的关系：

```text
imports
accesses
has_property
contains
logs
references
```

说明：

- `imports` 只表示文件 import，不代表业务执行路径。
- `accesses` 可能是字段读写，v0.3 不做数据流，不默认进入调用路径。
- `has_property`、`contains` 是结构关系，不作为业务路径。
- `references` 语义弱，默认不进入路径。
- `has_method` 只能作为类到方法的桥接关系，不能无限扩散。

被过滤的关系仍保留在 `relations` 中，供上层 Agent 或调试者查看。

### 3.3 默认排除测试代码要覆盖 candidate_paths

当前已经默认过滤 `src/test` anchors，但 relation endpoint 仍可能来自测试代码。

修正要求：

当 `excludeTests=true` 时：

- `anchors` 排除 `src/test`。
- `candidate_paths` 排除包含 `src/test` endpoint 的路径。
- `relations` 可以保留测试关系，但默认不进入候选路径。

原因：

- 线上排障和业务理解默认应该以生产代码为主。
- 测试关系对单测分析有价值，但不能默认污染生产候选路径。
- 用户显式传 `--include-tests` 或 MCP `exclude_tests=false` 时，才允许测试 endpoint 进入 `candidate_paths`。

### 3.4 method_implements 是一等关系，不应降级为 references

真实输出中出现：

```text
raw_relation_type = method_implements
relation_type = references
```

这会丢失关键语义。

修正要求：

- `method_implements` 加入 `RelationTypeSchema`。
- `method_implements` 加入 GitNexus 已知关系类型。
- mapper 归一化后输出：

```text
relation_type = method_implements
raw_relation_type = method_implements
```

- 不再触发 `GITNEXUS_UNKNOWN_RELATION_TYPE`。
- `method_implements` 可进入 `candidate_paths`。

面试可解释点：

```text
Java 后端大量调用依赖接口，method_implements 是接口方法和实现方法之间的关键桥接边。
把它降级成 references 会让 Agent 低估路径证据强度。
```

### 3.5 anchor ranking 要符合 Java 排障直觉

当前 query：

```text
PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);
```

返回 anchors：

```text
SettlementAndRebateService
SettlementAndRebateService.preCheckRebate
SettlementAndRebateServiceImpl.preCheckRebate
```

当前排序会先从接口类扩展，导致大量 `imports` 关系进入结果。

修正要求：

anchor 排序优先级：

```text
1. src/main 优先于 src/test
2. Method 优先于 Class/Interface/File
3. 查询文本包含方法名时，方法名精确命中优先
4. 实现类方法优先于接口方法
5. direction=downstream 时，实现方法优先
6. direction=upstream 时，接口方法和实现方法都保留，但 class/interface anchor 降权
7. File anchor 默认最低
```

排序只影响默认输出顺序和路径生成优先级，不删除原始可用 anchor。歧义仍通过 `ANCHOR_AMBIGUOUS` 暴露。

### 3.6 limit 保留，但不能让低价值关系优先污染 candidate_paths

`limit` 是必要的安全阀，用于控制：

- GitNexus context 关系数量。
- 输出体积。
- LLM 消费成本。
- 查询时间。

但用户不应该靠猜 `limit` 得到高质量结果。

v0.3 修正要求：

- `relations` 仍受 `limit` 限制。
- `candidate_paths` 构建前对关系排序：

```text
calls > method_implements > method_overrides > maps_to_sql > uses_table > implements > has_method
```

- `imports` 等低价值关系不进入 `candidate_paths`。
- 如果发生 `RELATION_LIMIT_REACHED` 或 `FANOUT_LIMIT_REACHED`，路径标记为 `truncated`。
- diagnostics 需要提醒用户可以缩小 query、指定更精确方法、使用 `--direction` 或提高 limit。

## 4. 输出语义

### 4.1 relations

`relations` 表示原始关系证据集合。

特点：

- 保留更多 GitNexus context 返回结果。
- 保留 `raw_relation_type`。
- 可包含 imports、accesses、测试关系。
- 不等于调用链。

### 4.2 candidate_paths

`candidate_paths` 表示经过筛选和排序后的候选路径片段。

特点：

- 必须有方向正确的 summary。
- 默认不包含 `src/test` endpoint。
- 默认不包含 `imports`、`accesses` 等低价值边。
- 可以是局部片段，不保证完整。
- 如果被 depth、limit、fanout 影响，必须标记 `truncated`。

### 4.3 diagnostics

v0.3 应重点返回这些 diagnostics：

| code | 场景 |
| --- | --- |
| `ANCHOR_NOT_FOUND` | 未找到探索起点 |
| `ANCHOR_AMBIGUOUS` | 多个候选 anchor 被选中 |
| `GITNEXUS_RELATIONS_USED` | 已使用 GitNexus 生成关系证据 |
| `GITNEXUS_RELATIONS_UNAVAILABLE` | GitNexus 不可用或无关系证据 |
| `GITNEXUS_UNKNOWN_RELATION_TYPE` | 出现未知 GitNexus 关系类型 |
| `RELATION_LIMIT_REACHED` | 关系数超过 limit |
| `FANOUT_LIMIT_REACHED` | 单节点关系数超过 fanout |
| `PATH_VERIFICATION_SKIPPED` | candidate path 未经 trace 验证 |
| `PATH_TRUNCATED` | 路径受限被截断 |
| `PATH_EXTRACTION_PARTIAL` | 有 relations 但无法组装 candidate path |

### 4.4 diagnostics 的作用域和 eval 复盘机制

`diagnostics` 是请求级诊断，不是对某个代码点的永久判定。

例如：

```text
RELATION_LIMIT_REACHED
FANOUT_LIMIT_REACHED
PATH_TRUNCATED
```

表示：

```text
在本次 query + direction + depth + limit + fanout + 当前索引状态下，结果被截断或置信度降低。
```

它不表示：

```text
这个代码点永远无法检索。
```

但如果相同输入、相同预算、相同索引状态下重复执行，大概率会稳定复现同样的 diagnostics。此时它应该被视为工具能力缺口信号，而不是只靠用户手工调参解决。

因此，v0.3 需要定义 eval case 机制，用于沉淀真实试用中发现的问题。

#### 4.4.1 eval case 存放位置

eval case 存放在项目索引同级目录下：

```text
<CODE_INTEL_HOME>/projects/<project>/eval-cases/
```

例如：

```text
/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/
```

推荐目录结构：

```text
/root/.code-intelligence/projects/mi-intl-scheme/
  manifest.json
  java-route-map.jsonl
  java-sql-map.jsonl
  error-map.jsonl
  semantic-lite.jsonl
  eval-cases/
    precheck-rebate-both-direction-20260820/
      case.json
      request.json
      response.raw.json
      response.normalized.json
      expectations.json
      notes.md
```

这样 eval case 和项目索引同属一个 project data dir，便于记录索引状态、GitNexus repo label、commit、dirty 状态和真实响应。

#### 4.4.2 eval case 文件语义

`case.json` 记录 case 元信息：

```json
{
  "case_id": "precheck-rebate-both-direction-20260820",
  "project": "mi-intl-scheme",
  "project_path": "/mnt/g/workSpace/mi-intl-scheme",
  "gitnexus_repo": "mi-intl-scheme",
  "commit_hash": "d465a5102d59942e49e73ae2353e750f29aad823",
  "dirty": true,
  "created_reason": "真实试用发现 both 模式方向反转、imports/test 污染、method_implements 降级。"
}
```

`request.json` 记录原始请求：

```json
{
  "tool": "explore",
  "project": "mi-intl-scheme",
  "query": "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);",
  "type": "symbol",
  "direction": "both",
  "depth": 3,
  "limit": 20,
  "exclude_tests": true
}
```

`response.raw.json` 保存完整原始输出，用于人工复盘和后续调试。

`response.normalized.json` 保存归一化输出，用于稳定比较。归一化建议：

- 移除 `request_id`。
- 移除时间戳。
- relations 按 `from/to/relation_type/raw_relation_type` 排序。
- candidate paths 只保留 `summary`、`path_status`、`relation_types`、节点 symbol/file。
- snippet 可截断或只保留 hash。
- diagnostics 只保留 code、level、message。

`expectations.json` 记录机器可判断的期望：

```json
{
  "must_have": [
    {
      "type": "relation",
      "from_contains": "SettlementBillCommandServiceImpl.preCheckRebate",
      "to_contains": "SettlementAndRebateServiceImpl.preCheckRebate",
      "relation_type": "calls"
    },
    {
      "type": "relation_type",
      "relation_type": "method_implements"
    }
  ],
  "must_not_have": [
    {
      "type": "candidate_path_relation_type",
      "relation_type": "imports"
    },
    {
      "type": "candidate_path_file_contains",
      "pattern": "src/test"
    },
    {
      "type": "summary",
      "pattern": "SettlementAndRebateServiceImpl.preCheckRebate --calls--> SettlementBillCommandServiceImpl.preCheckRebate"
    },
    {
      "type": "diagnostic_code",
      "code": "GITNEXUS_UNKNOWN_RELATION_TYPE",
      "when_message_contains": "method_implements"
    }
  ],
  "allowed_diagnostics": [
    "INDEX_STALE",
    "ANCHOR_AMBIGUOUS",
    "RELATION_LIMIT_REACHED",
    "FANOUT_LIMIT_REACHED",
    "PATH_VERIFICATION_SKIPPED"
  ]
}
```

`notes.md` 记录人工复盘说明，解释为什么这个 case 有价值、修复前问题是什么、修复后应该如何判断。

#### 4.4.3 触发 eval case 的 diagnostics pattern

不是所有 diagnostics 都需要记录 eval case。建议记录这些能力缺口信号：

- `RELATION_LIMIT_REACHED` 且 candidate paths 质量低。
- `FANOUT_LIMIT_REACHED` 和 `ANCHOR_AMBIGUOUS` 同时出现。
- `GITNEXUS_UNKNOWN_RELATION_TYPE`。
- `PATH_EXTRACTION_PARTIAL`。
- `ANCHOR_NOT_FOUND` 但用户确认代码存在。
- `LOW_CONFIDENCE` 但用户确认应该命中。
- candidate path 方向错误。
- candidate path 包含测试代码并污染生产排障结果。
- candidate path 包含 `imports`、`accesses` 导致误导。

#### 4.4.4 v0.3 和 v0.4 的边界

v0.3 本轮只定义 eval case 机制，并保存首个手工 eval case。暂不实现完整 eval CLI。

v0.3 可以手工保存：

```text
precheck-rebate-both-direction-20260820
```

v0.4 或 v0.3.x 再考虑实现：

```bash
code-intel eval capture <project> --case <case-id>
code-intel eval list <project>
code-intel eval run <project>
code-intel eval diff <project> <case-id>
```

这个取舍避免 v0.3 回归修正范围失控，同时保留真实问题复盘和持续优化闭环。

#### 4.4.5 数据安全和规模控制

eval case 默认只保存在本地 `CODE_INTEL_HOME`，不自动提交到仓库。

原因：

- `response.raw.json` 可能包含内部代码片段、业务名称、路径和注释。
- 真实项目响应可能很大，不适合直接进入 docs 或 git。
- 后续做 CLI 时需要显式 capture，不默认记录所有请求。

记录规则：

- `response.raw.json` 用于人工复盘，可以保留完整输出。
- `response.normalized.json` 用于稳定比较，应尽量减少敏感内容。
- snippet 建议截断或保存 hash。
- 单个 case 应有大小上限，后续 CLI 实现时再确定具体默认值。
- 如果需要分享给面试官或外部人员，只展示脱敏后的 `notes.md`、`expectations.json` 和少量摘要。

## 5. 自动化测试设计

### 5.1 方向测试

构造：

```text
A --calls--> B
```

从 B 做 `direction=upstream` 或 `direction=both`。

断言：

- summary 不能出现 `B --calls--> A`。
- summary 应出现 `B <--calls-- A`，或等价正向表达 `A --calls--> B`。

### 5.2 imports 不进入 candidate_paths

构造：

```text
FileX --imports--> Service
Caller --calls--> Service.method
```

断言：

- `relations` 包含 `imports`。
- `candidate_paths` 不包含 relation_type=`imports` 的路径。

### 5.3 默认过滤测试 endpoint

构造：

```text
TestClass.test --calls--> Service.method
ProdCaller.run --calls--> Service.method
```

默认 `excludeTests=true`。

断言：

- `relations` 可以包含测试 relation。
- `candidate_paths` 不包含 `src/test` 节点。

显式 `excludeTests=false` 时：

- `candidate_paths` 可以包含测试节点。

### 5.4 method_implements 归一化

构造：

```text
Impl.method --method_implements--> Interface.method
```

断言：

- `relation_type=method_implements`。
- `raw_relation_type=method_implements`。
- 不出现 `GITNEXUS_UNKNOWN_RELATION_TYPE`。
- 可进入 `candidate_paths`。

### 5.5 anchor ranking

GitNexus query 返回：

```text
Interface class
Interface method
Impl method
```

query 包含方法名。

断言：

- `anchors[0]` 是实现类方法。
- `candidate_paths` 优先从实现类方法生成。
- 仍返回 `ANCHOR_AMBIGUOUS`，提示存在多个候选起点。

### 5.6 limit 下路径关系排序

构造：

```text
20 条 imports
2 条 calls
```

断言：

- `candidate_paths` 优先包含 `calls`。
- 不因为 imports 抢占而导致 path 全是 import。
- diagnostics 包含 `RELATION_LIMIT_REACHED`。
- 受截断影响的 path 标记 `truncated`。

### 5.7 真实 Java fixture 测试矩阵

补充一个小型 Java fixture，可以是一个 fixture 目录，也可以复用 fake GitNexus runner 加 Java 文件组合。关键不是 fixture 数量，而是覆盖 upstream、downstream、both 三类探索方向。

建议 fixture 结构：

```text
SettlementController
SettlementBillCommandService
SettlementAndRebateService
SettlementAndRebateServiceImpl
SettlementMapper
SettlementAndRebateServiceImplTest
```

关系模拟：

```text
SettlementController.preCheck
  --calls-->
SettlementBillCommandService.preCheckRebate

SettlementBillCommandService.preCheckRebate
  --calls-->
SettlementAndRebateServiceImpl.preCheckRebate

SettlementAndRebateServiceImpl.preCheckRebate
  --method_implements-->
SettlementAndRebateService.preCheckRebate

SettlementAndRebateServiceImpl.preCheckRebate
  --calls-->
SettlementAndRebateServiceImpl.checkPreCheckParam

SettlementAndRebateServiceImpl.preCheckRebate
  --calls-->
SettlementAndRebateServiceImpl.executePreCheckRebate

SettlementAndRebateServiceImpl.executePreCheckRebate
  --calls-->
SettlementMapper.selectSettlement

SettlementAndRebateServiceImplTest.preCheckRebate_shouldThrowWhenReqIsNull
  --calls-->
SettlementAndRebateServiceImpl.preCheckRebate

SettlementController.java
  --imports-->
SettlementAndRebateService
```

测试矩阵：

| 场景 | direction | 输入 | 期望 |
| --- | --- | --- | --- |
| 下游调用 | `downstream` | `SettlementAndRebateServiceImpl.preCheckRebate` | candidate path 包含当前方法到 `checkPreCheckParam` / `executePreCheckRebate` 的 `calls` |
| 上游调用 | `upstream` | `SettlementAndRebateServiceImpl.preCheckRebate` | candidate path 包含 `SettlementBillCommandService.preCheckRebate --calls--> SettlementAndRebateServiceImpl.preCheckRebate` |
| 双向探索 | `both` | `SettlementAndRebateServiceImpl.preCheckRebate` | 上游和下游都可出现，但 summary 不得反转真实 `calls` 方向 |
| 接口桥接 | `both` | `SettlementAndRebateService.preCheckRebate` 或实现方法 | `method_implements` 保留为一等关系，不降级为 `references` |
| 默认排除测试 | `upstream` / `both` | 实现方法 | candidate paths 不包含 `src/test` |
| 显式包含测试 | `upstream` / `both` + `excludeTests=false` | 实现方法 | candidate paths 可以包含测试方法 |
| 低价值关系过滤 | `both` | 接口或方法 | `imports` 保留在 relations，但不进入 candidate paths |
| 截断诊断 | `both` + 小 `limit` | 接口或方法 | path_status=`truncated`，diagnostics 可解释 limit/fanout |

总体断言：

- 调用方向正确。
- `method_implements` 被保留。
- `candidate_paths` 不包含 imports。
- 默认不包含测试 endpoint。
- 显式包含测试时可包含测试 endpoint。
- 输出仍标记为 candidate，不标记 verified。

### 5.8 mi-intl-scheme eval case

`mi-intl-scheme` 的 `preCheckRebate` 真实试用问题应沉淀为首个手工 eval case：

```text
<CODE_INTEL_HOME>/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/
```

case 记录：

- 原始请求。
- 当前项目路径、GitNexus repo label、commit、dirty 状态。
- 修复前完整响应 `response.raw.json`。
- 归一化响应 `response.normalized.json`。
- 机器可判断的 `expectations.json`。
- 人工说明 `notes.md`。

该 eval case 的核心断言：

- 必须包含 `SettlementBillCommandServiceImpl.preCheckRebate --calls--> SettlementAndRebateServiceImpl.preCheckRebate` 方向正确的关系或路径表达。
- 必须识别 `method_implements`。
- candidate paths 默认不得包含 `src/test`。
- candidate paths 默认不得包含 `imports`。
- 不得把 `SettlementAndRebateServiceImpl.preCheckRebate --calls--> SettlementBillCommandServiceImpl.preCheckRebate` 作为 summary 输出。
- `GITNEXUS_UNKNOWN_RELATION_TYPE` 不得再因为 `method_implements` 出现。

## 6. mi-intl-scheme 验收标准

验收命令：

```bash
node packages/cli/dist/index.js explore mi-intl-scheme \
  --query "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);" \
  --type symbol \
  --direction both \
  --depth 3 \
  --limit 20
```

验收要求：

### 6.1 不再出现明显反向 summary

如果真实关系是：

```text
SettlementBillCommandServiceImpl.preCheckRebate
  --calls-->
SettlementAndRebateServiceImpl.preCheckRebate
```

则不允许显示成：

```text
SettlementAndRebateServiceImpl.preCheckRebate
  --calls-->
SettlementBillCommandServiceImpl.preCheckRebate
```

### 6.2 method_implements 不再降级

不应再出现：

```text
GITNEXUS_UNKNOWN_RELATION_TYPE: method_implements
```

不应再出现：

```text
relation_type=references
raw_relation_type=method_implements
```

### 6.3 默认 candidate_paths 不包含测试路径

默认不应出现：

```text
SettlementAndRebateServiceImplTest
AutomaticAccrualTaskTest
LegacySettlementAutomaticAccrualTaskTest
```

### 6.4 imports 不进入 candidate_paths

这些关系可以留在 `relations`：

```text
File -> Interface imports
```

但不应包装成 `candidate_paths`。

### 6.5 candidate_paths 更像有效路径片段

可以出现：

```text
SettlementBillCommandServiceImpl.preCheckRebate
  --calls-->
SettlementAndRebateServiceImpl.preCheckRebate
```

也可以出现：

```text
SettlementAndRebateServiceImpl.preCheckRebate
  --calls-->
checkPreCheckParam
```

但不能把大量 `imports` 或测试类调用包装成主候选路径。

## 7. 不纳入本轮 v0.3 修正的内容

本轮不做：

- 新增 `call-path` 命令。
- 新增 `primary_path` / `alternative_paths` 输出结构。
- 自动寻找完整入口链路。
- 自动寻找 SQL 终点链路。
- GitNexus trace 验证整条路径。
- 反射、AOP、Spring Bean、多实现运行时解析。
- MQ、定时任务、Dubbo/RPC 语义桥接。
- 业务流程图 Skill。

这些进入 v0.4 或更后续版本。

## 8. v0.4 衔接点

v0.3 修正完成后，v0.4 应从 `explore` 中拆出更明确的调用路径能力：

```bash
code-intel call-path <project> --query "<symbol>"
```

v0.4 重点：

- `primary_path`
- `alternative_paths`
- `supporting_relations`
- `entry_paths`
- `downstream_paths`
- `sql_endpoints`
- 更强的 anchor 消歧
- 更强的路径排序和主路径选择

`explore` 继续保留为图谱邻域探索工具，不承担完整调用链职责。

## 9. 面试讲述口径

这次修正可以这样讲：

```text
我在真实项目里试用 explore 时发现，第一版能返回关系边，但 candidate_paths 仍然有几个生产级问题：both 模式会把反向遍历的 calls 展示成错误方向，imports 和 has_method 这类结构边会混进路径，测试代码也会污染生产排障结果。这个问题本质不是 GitNexus 不准，而是上层 Agent 工具没有把“图谱邻域”和“调用路径”区分清楚。

所以我先没有急着做更复杂的 call-path，而是回头修 v0.3 的证据语义：关系边可以保留得更全，但 candidate_paths 必须更保守；method_implements 这种 Java 接口实现关系要作为一等关系；path summary 必须尊重事实方向；默认排除测试 endpoint。这个过程体现的是 Agent 工具工程化里很重要的一点：工具不仅要能返回结果，还要保证结果不会误导上层 Agent。
```

## 10. 完成标准

本轮 v0.3 回归修正完成标准：

- 所有新增测试先红后绿。
- `npm run build` 通过。
- `npm run typecheck` 通过。
- `npm run test` 通过。
- `mi-intl-scheme` 的 `preCheckRebate` case 满足第 6 节验收标准。
- 保存首个手工 eval case：`precheck-rebate-both-direction-20260820`。
- 更新 `current-tool-capabilities.zh-CN.md`、`user-guide.zh-CN.md`、`code-intelligence-pitfalls-and-evolution.zh-CN.md`。
