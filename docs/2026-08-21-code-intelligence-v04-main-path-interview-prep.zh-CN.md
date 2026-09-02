# Code Intelligence v0.4 主链路能力面试准备

日期：2026-08-21

本文档用于记录 v0.4 设计讨论中可以转化为面试讲解的点，包括问题、取舍、解决思路和可被追问的回答。

## 1. 一句话定位

v0.4 的核心不是继续堆更多关系边，而是把 GitNexus 图谱邻域转化为上游 Agent 更容易消费的主链路证据。

推荐表达：

> v0.3 能从一个代码线索出发返回 anchors、relations 和 candidate_paths，但真实排障发现，上游 Agent 真正需要的不是一堆关系边，而是“围绕目标方法的主链路候选”。所以 v0.4 我新增 `main_paths`，通过主链路优先探索、可解释评分、细节折叠和 coverage 诊断，把底层图谱证据变成排障和代码理解更直接可用的结构。

## 2. 为什么 v0.4 暂时不接 JDT LS

### 可能面试问题

JDT LS 有成熟的 Java Call Hierarchy，为什么不直接接 JDT LS？

### 推荐回答

JDT LS 确实有价值，但它更像 IDE 后台语言服务。接入成本不是简单调 API，而是要启动 Language Server，导入 Maven/Gradle 项目，解析依赖，建立 workspace model，再通过 LSP JSON-RPC 查询 Call Hierarchy。

对于真实企业 Java 多模块项目，冷启动和项目导入成本可能很高，甚至接近一次 IDE 打开项目的成本。Code Intelligence 的定位是 CLI/MCP 工具链底座，排障场景需要快速返回证据。如果首次查询要等十几分钟，生产体验就不可接受。

所以 v0.4 的取舍是：

```text
不把 JDT LS 作为主线依赖。
先基于 GitNexus + Code Intelligence 自身规则做主链路候选。
JDT LS 保留为后续 spike 或 provider，不阻塞 v0.4。
```

这个取舍体现的是工程判断：不是最强能力一定最适合当前版本，而是要看成本、稳定性、场景时效性和集成风险。

### 可追问回答

如果面试官问“以后是否会接 JDT LS”，可以回答：

> 会考虑，但会先以 spike 方式验证。只验证能否在真实项目上稳定启动、导入项目并返回 incoming/outgoing calls。如果 spike 成功，再封装成 `JavaCallHierarchyProvider`。Code Intelligence 的架构会保留 provider 扩展点，但不会在 v0.4 直接强依赖它。

## 3. 只靠 GitNexus 能做到什么程度

### 可能面试问题

不接 JDT LS，只靠 GitNexus 和你自己的规则，能做到生产可用吗？

### 推荐回答

如果目标是“完整 IDE 级静态调用层级”或者“完整运行时链路”，只靠 GitNexus + 当前规则并不够。

但 v0.4 的目标不是完整调用链，而是：

```text
围绕目标方法稳定输出 1 到 3 条主链路候选。
```

在常见 Java 后端同步调用场景里，例如：

```text
Controller / Provider / Scheduler / Consumer
  -> CommandService / ApplicationService
  -> DomainService
  -> Repository / Mapper / SQL
```

GitNexus 的 calls、method_implements、implements、has_method，再结合 Code Intelligence 的 Java 专项索引，可以支撑实用的主链路候选。

重点是不能宣称“找全所有路径”，而要明确：

```text
main_paths 是主链路候选。
relations 是预算内证据子集。
coverage 说明探索是否完整。
diagnostics 说明是否有预算、fanout、歧义、降级。
```

这对排障和代码理解已经有价值。

## 4. 为什么新增 main_paths，而不是改 candidate_paths

### 可能面试问题

既然已经有 `candidate_paths`，为什么还要新增 `main_paths`？

### 推荐回答

`candidate_paths` 的语义已经在 v0.3 定义清楚：它表示当前证据能拼出的候选路径片段，不承诺是主链路。

如果把 `candidate_paths` 直接改造成主链路，会破坏已有契约，也会让上游 Agent 难以区分：

```text
哪些是普通候选片段？
哪些是工具评分后推荐的主链路？
哪些只是旁支或弱关系？
```

所以 v0.4 保留：

```text
relations       = 预算内关系证据集合
candidate_paths = 图谱能拼出的候选片段
main_paths      = 经过评分、剪枝、折叠后的主链路候选
side_relations  = 不进入主链路但保留的旁支证据
```

这样契约更清晰，也方便后续流程图 Skill 使用 `main_paths`，排障 Agent 使用 `side_relations` 和 `folded_steps` 做深挖。

## 5. 关系边爆炸的问题

### 可能面试问题

图谱关系边很容易爆炸，你加 limit 不还是会截断吗？

### 推荐回答

是的，图搜索一定需要预算，否则 fanout 会失控。但 v0.4 的关键不是简单把 limit 调大，而是改变探索策略。

v0.3 更像普通 BFS：

```text
从 anchor 出发，一层层展开关系，直到 depth 或 relationBudget 停止。
```

这样高 fanout 节点会很快占满预算，主链路可能还没排出来。

v0.4 改成主链路优先探索：

```text
不是先拿全图再找主链路，
而是从一开始就优先展开更像主链路的节点和关系。
```

比如优先：

- `calls`
- `method_implements`
- `method_overrides`
- `src/main`
- 上游入口候选
- Service / CommandService / DomainService
- Repository / Mapper / SQL

降权：

- `imports`
- `references`
- `accesses`
- `src/test`
- DTO / VO / Param / Result
- Exception 构造
- Util / Helper / Converter / Builder

这不是无脑截断，而是任务相关性优先的剪枝。

## 6. 剪枝会不会误导上游 Agent

### 可能面试问题

既然你剪枝了，返回的 relations 就不是完整图谱。上游 Agent 会不会被误导？

### 推荐回答

这是 v0.4 的核心设计约束：剪枝不能伪装成完整图谱。

v0.4 会明确输出：

```text
relations 是本次预算内收集到的证据子集，不是完整 GitNexus 图谱。
coverage.complete=false 表示不能把没返回的关系解释为不存在。
budget_summary 说明哪些节点、关系或旁支因为预算、低分、fanout 被省略。
```

所以 v0.4 不是说：

```text
没返回 = 不存在
```

而是说：

```text
当前预算内没有作为主链路证据返回。
```

这对 Agent 工具非常重要。上游 Agent 可以用 `main_paths` 做初步分析，但如果要下最终根因，必须结合 coverage、diagnostics、日志、trace 或继续展开。

### 推荐补充

可以这样讲：

> 我把“证据可信度”和“探索覆盖度”分开了。main_path 的 confidence 描述这条主链路自身证据质量，coverage 描述本次图谱探索是否完整。即使 coverage.complete=false，只要主链路内部由连续强关系组成，也可以是 medium confidence。

## 7. 为什么 main_path 不能因为 RELATION_LIMIT_REACHED 自动低置信

### 可能面试问题

如果已经 `RELATION_LIMIT_REACHED`，为什么 main_path 还能是 medium？

### 推荐回答

因为这是两个不同概念。

`RELATION_LIMIT_REACHED` 表示：

```text
本次图谱探索没有覆盖完整关系空间。
```

`main_path.confidence` 表示：

```text
这条主链路候选自身证据是否连续、强关系是否足够、anchor 是否明确。
```

如果一条 main path 是：

```text
Provider.preCheckRebate
  -> CommandService.preCheckRebate
  -> SettlementAndRebateServiceImpl.preCheckRebate
  -> executePreCheckRebate
```

并且边都是 `calls` / `method_implements`，节点都来自 `src/main`，anchor 也精确匹配，那么即使旁支关系没探索完，这条主链路仍然有中等可信度。

不能说“全图没穷尽，所以当前已找到的强关系链路都低可信”。这会让工具变得几乎不可用。

正确表达是：

```text
这条主链路候选可用于排障和理解，但不能代表完整图谱已经穷尽。
```

## 8. 评分体系怎么避免拍脑袋

### 可能面试问题

你怎么证明评分体系合理？是不是一堆硬编码？

### 推荐回答

v0.4 的评分体系不应该是黑盒分数，也不应该只靠类名硬编码。它分成五层：

1. 关系类型分数  
   `calls`、`method_implements` 比 `imports`、`references` 更接近执行链路。

2. 源码集合分数  
   `src/main` 优先，`src/test` 默认降权或排除。

3. 路径连续性分数  
   连续强关系链路加分，断链、循环、弱关系补齐降分。

4. 角色识别分数  
   Controller/Provider/Scheduler/Consumer 等作为入口候选，Service/CommandService/DomainService 作为业务节点，Repository/Mapper/SQL 作为下游持久化节点。

5. Query 相关性分数  
   方法名、参数类型、文件路径、业务词和 query 越匹配，分数越高。

而且每条 `main_path` 不只输出 `score`，还输出：

```text
score_breakdown
confidence_reason
```

这样人和上游 Agent 都能看到为什么这条链路被选中。

### 推荐补充

如果被追问“换项目是否有效”，可以回答：

> 关系类型、源码集合、路径连续性是比较通用的；角色识别确实有项目命名约定，所以我把它集中到独立 classifier，后续可以配置化。v0.4 不把评分散落在业务逻辑里，而是拆成独立模块并通过 fixture 和真实 eval case 验证。

## 9. 折叠细节方法的价值

### 可能面试问题

你把 checkParam、buildParam、Util、Exception 折叠，会不会丢失排障细节？

### 推荐回答

折叠不是丢弃。

主链路第一屏应该帮助人和 Agent 快速理解业务主线：

```text
入口 -> CommandService -> 目标 Service -> 核心执行方法 -> Repository/SQL
```

但校验、参数组装、异常构造、工具方法、DTO/VO 也可能在排障时有价值。所以 v0.4 会把它们放进：

```text
folded_steps
side_relations
```

默认不污染主链路，但可以按需展开。

这对流程图 Skill 也很重要：默认画主流程，必要时再展开校验或异常分支。

## 10. v0.4 输出如何帮助上游排障 Agent

### 推荐表达

v0.4 输出不是让排障 Agent 自己面对几十条关系边，而是给它一个结构化入口：

```text
main_paths:
  推荐主链路候选。

folded_steps:
  主链路节点下可展开的细节方法。

side_relations:
  旁支证据。

coverage:
  本次图谱覆盖边界。

diagnostics:
  歧义、预算、降级、低置信原因。
```

排障 Agent 可以先基于 `main_paths` 分析日志影响范围，再根据日志关键词或异常位置展开某个 `folded_step`。

这样上游 Agent 的上下文成本会低很多，因为它不用从原始图谱关系里找主线。

## 11. v0.4 输出如何帮助流程图 Skill

### 推荐表达

流程图 Skill 不应该直接消费所有 `relations`，否则图会非常乱。

它应该优先消费：

```text
main_paths.nodes
main_paths.relations
folded_steps
coverage
```

默认流程图只画主链路。  
校验、参数组装、异常构造、工具方法作为可展开子节点或注释。  
如果 `coverage.complete=false`，图上应该标注“候选主流程，非完整运行时链路”。

这能避免把不确定证据画成确定业务流程。

## 12. v0.4 的风险

### 风险 1：评分规则针对 mi-intl-scheme 过拟合

应对：

- 关系类型和路径连续性作为核心规则。
- 角色识别集中模块化。
- 后续支持项目配置。
- 用 fixture 和真实项目 eval 双重验证。

### 风险 2：主链路没找全

应对：

- `coverage.complete=false`。
- `budget_summary` 说明 omitted 情况。
- diagnostics 给出提高预算或指定 UID 的建议。

### 风险 3：低置信结果误导 Agent

应对：

- `confidence_reason` 必填。
- `score_breakdown` 必填。
- 弱关系拼出的路径必须 low。
- 全局预算触顶不能单独导致 low。

### 风险 4：输出模型太复杂

应对：

- 保持 `relations` 和 `candidate_paths` 兼容。
- `main_paths` 是新核心字段。
- CLI/MCP 不暴露所有内部预算。
- 上游 Agent 优先读 `main_paths`，高级场景再读 `side_relations` 和 `coverage`。

## 13. 面试高价值讲述点

### 讲述点 1：真实试用驱动迭代

推荐表达：

> v0.4 不是凭空设计出来的。v0.3 在真实项目 preCheckRebate 上试用后，我发现 candidate_paths 虽然能返回关系片段，但上游 Agent 仍然需要自己从很多关系里找主线。所以 v0.4 才引入 main_paths，把图谱邻域进一步转成主链路候选。

### 讲述点 2：证据契约比模型能力更重要

推荐表达：

> 对 Agent 工具来说，最危险的不是返回少，而是返回结果却不说明边界。v0.4 用 coverage、budget_summary 和 diagnostics 告诉上游：哪些是预算内证据，哪些地方可能没覆盖，不能把没返回解释成不存在。

### 讲述点 3：主链路置信度和图谱覆盖度分离

推荐表达：

> 一条主链路可以是 medium confidence，同时 coverage.complete=false。前者说明这条路径本身证据连续，后者说明全图没有穷尽。这两个概念分开，才能避免 Agent 把全局预算问题误判成每条路径都不可用。

### 讲述点 4：折叠不是丢弃

推荐表达：

> v0.4 不会简单剪掉细节方法，而是把校验、参数组装、异常构造、工具调用放进 folded_steps。这样主链路保持清晰，但排障时仍能按需展开。

### 讲述点 5：没有盲目接 JDT LS

推荐表达：

> JDT LS 是成熟能力，但接入成本和冷启动成本很高。对 CLI/MCP 排障工具来说，先把 GitNexus-first 的主链路候选做好更实际。JDT LS 保留为后续 provider spike，而不是 v0.4 强依赖。

## 14. 模拟面试问题清单

1. Code Intelligence v0.4 为什么要新增 `main_paths`？
2. `main_paths` 和 `candidate_paths` 的区别是什么？
3. 为什么不直接把 GitNexus relations 全部返回给 Agent？
4. 剪枝后的 relations 不完整，如何避免误导上游 Agent？
5. `coverage.complete=false` 时，上游 Agent 应该如何使用结果？
6. 为什么 `RELATION_LIMIT_REACHED` 不应该自动让所有 main paths 低置信？
7. 评分体系怎么设计，如何证明不是拍脑袋？
8. 类名、包名规则是不是硬编码，换项目怎么办？
9. 为什么暂时不接 JDT LS？
10. 如果 JDT LS 更准，未来怎么接入？
11. `folded_steps` 和 `side_relations` 分别解决什么问题？
12. 流程图 Skill 应该消费哪些字段？
13. v0.4 不能解决哪些场景？
14. 怎么验证 v0.4 真的比 v0.3.2 好？
15. 真实项目 `preCheckRebate` case 的验收标准是什么？

## 15. 简短回答模板

### 30 秒版本

> v0.4 是把 Code Intelligence 从“候选路径探索”推进到“主链路证据生成”。v0.3 能返回 relations 和 candidate_paths，但真实排障里上游 Agent 需要的是 1 到 3 条可解释主链路。v0.4 新增 main_paths，同时保留 relations、candidate_paths、side_relations、folded_steps 和 coverage，既提供主线，又不伪装成完整图谱。

### 2 分钟版本

> 我在真实项目试用 v0.3 时发现，只返回 GitNexus 邻域关系还不够。关系边会爆炸，candidate_paths 也只是候选片段，上游 Agent 仍然要从大量关系里猜主线。v0.4 的设计是主链路优先探索：先围绕目标 anchor 找上游调用方和下游核心业务动作，再用评分体系选择 1 到 3 条 main_paths。评分不是黑盒，而是由关系类型、源码集合、路径连续性、角色识别和 query 相关性组成，并输出 score_breakdown 和 confidence_reason。同时我把 coverage 和 confidence 分开，避免 relationBudget 触顶时所有路径都变成低置信。剪枝后的 relations 明确只是预算内证据子集，不能被上游解释为完整图谱。这个设计重点体现的是 Agent 工具证据契约，而不是简单把图谱结果包装给 LLM。

## 16. 需要记住的核心句子

- `relations` 是预算内证据子集，不是完整 GitNexus 图谱。
- `candidate_paths` 是候选片段，`main_paths` 是评分后的主链路候选。
- `main_path.confidence` 描述路径自身证据质量，`coverage.complete` 描述图谱探索完整性。
- `RELATION_LIMIT_REACHED` 不能单独让所有 main paths 变成 low。
- 剪枝必须可诊断，评分必须可解释。
- 折叠不是丢弃，细节仍然可以通过 `folded_steps` 和 `side_relations` 展开。
- JDT LS 有价值，但 v0.4 不把它作为主线依赖。
