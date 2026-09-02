# Code Intelligence 踩坑总结与演进记录

日期：2026-08-17

本文档记录 Code Intelligence 从“代码位置检索工具”演进到“Agent 代码证据底座”过程中遇到的问题、判断过程和修正方案。它不是对外宣传稿，而是面向面试复盘、工程复盘和后续迭代的真实记录。

## 1. 背景

Code Intelligence 的目标不是替代 GitNexus，也不是做一个简单 grep 工具，而是为线上排障 Skill、业务流程图 Skill、新人代码问答、PRD/详设辅助等上层 Agent 提供稳定的代码证据入口。

v0.1 已经能生成本地 Java 专项索引，并返回代码位置证据：

- Spring 路由入口。
- MyBatis SQL 和表名。
- 错误码、异常、日志语句。
- semantic-lite 轻量语义召回。
- 受控 grep 兜底。

v0.2 接入本地 GitNexus 后，工具具备了最小的图谱能力：

- `query`：查定义和候选代码位置。
- `context`：查符号邻域关系。
- `trace`：查两个符号之间的有向路径。

但在试用和复盘过程中发现：能跑通不等于好用，能封装不等于封装正确。

## 2. 踩坑一：封装 GitNexus 时可能丢失原始语义

### 现象

Code Intelligence 为了给上层 Agent 提供统一输出，把 GitNexus 的原始关系类型映射成内部 `relation_type`。

例如：

```text
HAS_METHOD -> has_method
CALLS -> calls
IMPLEMENTS -> implements
```

问题出现在未知类型上：如果 GitNexus 返回一种当前 mapper 没有显式识别的关系，早期实现会把它统一降级成：

```text
references
```

这虽然保证了 schema 不报错，但会丢掉 GitNexus 原始关系类型。

### 风险

第一，语义丢失。

如果 GitNexus 返回 `ANNOTATED_BY`、`RETURNS`、`THROWS`、`CONFIGURES` 等关系，而 Code Intelligence 全部归成 `references`，上层 Agent 就无法区分注解、返回值、异常、配置这些语义。

第二，Agent 可能误判关系强度。

`references` 是弱关系，只能说明存在某种引用，不等于调用、继承、实现或字段声明。如果上层 Agent 把 `references` 误解释为 `calls`，排障链路就会错误。

第三，后续迭代困难。

如果不保留原始类型，就无法知道 GitNexus 返回了哪些新关系，也无法判断 mapper 应该补哪些类型。

### 修正思路

统一契约仍然需要，但不能吞掉原始语义。

修正后的关系模型应同时保留：

- `relation_type`：Code Intelligence 归一后的关系类型，供上层 Agent 稳定消费。
- `raw_relation_type`：GitNexus 原始关系类型，供调试、扩展和高阶 Agent 使用。

当遇到未知类型时：

```text
relation_type = references
raw_relation_type = GitNexus 原始类型
diagnostics 增加 GITNEXUS_UNKNOWN_RELATION_TYPE
```

这体现了一个重要工程原则：

> 封装底层工具时，统一模型是为了稳定消费；保留原始语义是为了避免能力损耗。

## 3. 踩坑二：关系边和调用链路径容易混淆

### 现象

`search --include-relations` 返回的是关系边集合，例如：

```text
A --calls--> B
A --has_method--> C
D --implements--> A
```

这不是完整调用链。

完整调用链是有序路径，例如：

```text
Controller.submit
  -> Service.createOrder
  -> Mapper.insertOrder
```

早期文档容易让人误以为 `relations` 就是调用链。

### 风险

如果上层 Agent 把邻域关系边直接当成业务链路，就会产生错误结论。

例如某个方法有三个 caller：

```text
Job.run --calls--> Service.save
Controller.submit --calls--> Service.save
Listener.onMessage --calls--> Service.save
```

这三个 caller 只是三条潜在路径的入口候选，不代表已经找到了三条完整调用链。

### 修正思路

必须在设计和文档里明确：

- `relations` 是边集合。
- `trace` 是两点路径验证。
- v0.3 `explore_symbol` 负责从单点自动扩展上游、下游和候选路径。

后续实际采用了更保守的字段名：

```ts
candidate_paths: CodePath[]
```

它用于表达候选路径片段，而不是泛化为 `paths` 或把路径塞进普通 `relations`。这个命名是刻意保守的：除非底层 trace 明确验证，否则不能让上层 Agent 把它误读成完整调用链。

## 4. 踩坑三：trace from/to 不符合大多数排障初始输入

### 现象

当前 `trace` 命令需要：

```text
from 起点
to 终点
```

这适合“我已经知道两个代码点，想验证它们是否连通”的场景。

但真实排障中，初始输入通常只有一个线索：

- 一个错误码。
- 一条日志。
- 一个接口路径。
- 一个 SQL 表名。
- 一个方法名。
- 一段业务描述。

这时用户并不知道 `from` 和 `to`。

### 风险

如果只提供 `trace --from --to`，工具会显得像底层图谱调试工具，而不是排障助手。

### 修正思路

下一阶段应新增单点探索能力：

```bash
code-intel explore <project> --query "<symbol-or-clue>" --direction upstream --depth 3 --json
code-intel explore <project> --query "<symbol-or-clue>" --direction downstream --depth 3 --json
code-intel explore <project> --query "<symbol-or-clue>" --direction both --depth 2 --json
```

MCP 可以提供：

- `code.explore_symbol`
- `code.find_callers`
- `code.find_callees`
- `code.find_entry_paths`
- `code.find_downstream_paths`
- `code.trace_between`

其中 `trace_between` 对应当前 `trace from/to`；`explore_symbol` 才是排障和代码理解更自然的入口。

## 5. 踩坑四：GitNexus repo label 不绑定会导致多 repo 歧义

### 现象

Code Intelligence 有自己的项目名，GitNexus 也有自己的 repo label。

本地 GitNexus registry 可能同时存在多个 repo：

```text
java-spring-mybatis-demo
<gitnexus-repo-label>
```

如果调用 GitNexus 时不显式传：

```bash
--repo <gitnexus-repo-label>
```

GitNexus 可能不知道查哪个索引。

### 修正思路

注册项目时支持：

```bash
--gitnexus-repo <gitnexus-repo-label>
```

后续所有 GitNexus 查询都显式带上 repo label。

这不是多余配置，而是跨工具编排时的稳定性设计。

## 6. 踩坑五：空 relations 不能解释成没有调用关系

### 现象

GitNexus trace 可能返回：

- `not_found`：符号没找到。
- `ambiguous`：符号有歧义。
- `no_path`：两个符号都找到了，但没有发现有向路径。
- GitNexus 不可用。
- 索引缺失或过期。

这些情况都可能导致：

```json
"relations": []
```

### 风险

如果上层 Agent 把空数组解释成“代码中不存在调用关系”，就是错误推理。

### 修正思路

必须通过 `diagnostics` 区分原因：

```json
{
  "code": "GITNEXUS_RELATIONS_UNAVAILABLE",
  "message": "GitNexus trace 未找到有向路径。",
  "suggested_action": "Try gitnexus context <symbol>..."
}
```

Agent 应该基于 diagnostics 决定下一步，而不是只看 `relations.length`。

## 7. 当前复用 GitNexus 的能力

已经复用：

| GitNexus 能力 | Code Intelligence 用途 |
| --- | --- |
| `query` | 根据 query 查定义候选，补充 `source=gitnexus` 的 locations |
| `context` | 查符号 incoming/outgoing/typed_properties，生成邻域 relations |
| `trace` | 查两个符号之间的有向路径，生成调用链 relations |
| `.gitnexus/run.cjs` | 本地执行入口，不依赖远程仓库 |
| `--repo` | 多 repo 消歧 |

尚未充分复用：

| GitNexus 能力 | 后续价值 |
| --- | --- |
| `cypher` | 自定义图查询、复杂路径检索 |
| `impact` | 变更影响分析、爆炸半径 |
| process symbols | 业务流程、任务流程、入口识别 |
| PDG / data-flow | 数据流、污染链路、安全和复杂排障 |
| 多跳 callers/callees | 单点上游/下游自动探索 |

## 8. AI Agent 层面的经验

面向 Agent 的工具设计和面向人的 CLI 工具不一样。

Agent 需要的不只是结果，还需要：

- 结果来自哪里。
- 置信度如何。
- 是否发生降级。
- 查询失败是因为没路径、没索引、符号歧义，还是工具异常。
- 当前证据能支持什么结论，不能支持什么结论。
- 下一步应该补充什么查询。

因此 Code Intelligence 的关键不是“搜索出几行代码”，而是构造一套可被 Agent 安全推理的证据协议。

这也是为什么需要：

- `source`
- `confidence`
- `diagnostics`
- `raw_relation_type`
- `relation_type`
- `candidate_paths`

## 9. 面试可讲述版本

可以这样讲：

> 我最开始做的是一个本地 Java 代码检索工具，能查接口、错误码、SQL、表名和业务词。接入 GitNexus 后，我发现简单封装图谱结果并不够，因为 GitNexus 的原始关系类型如果被我统一降级成 references，就会丢失语义；另外 search 返回的是邻域关系边，不是完整调用链，trace from/to 也不符合大多数排障场景的初始输入。所以我把工具定位从“搜索工具”调整成“Agent 代码证据底座”：一方面保留统一输出模型，方便上层 Skill 消费；另一方面保留 raw_relation_type 和 diagnostics，避免过度封装导致语义损失。后来我继续实现 explore_symbol，让工具可以从一个错误码、日志、SQL 或方法出发，自动展开上下游候选路径。

这个过程能体现三个工程判断：

- 不盲目重复 GitNexus，而是复用它的图谱能力。
- 不把底层原始结果直接暴露给上层 Agent，而是提供稳定证据契约。
- 不为了统一模型牺牲原始语义，保留 raw evidence 方便演进和排错。

## 10. 踩坑六：索引命令不应该把实现细节甩给用户

### 现象

早期索引命令只有两种用法：

```bash
code-intel index <project>
code-intel index <project> --with-gitnexus
```

这在实现上简单，但使用体验有明显问题。

第一，用户不知道 `--with-gitnexus` 到底执行了什么。

对熟悉 GitNexus 的人来说，会自然追问：它底层是执行 `gitnexus analyze`，还是执行完整的：

```bash
gitnexus analyze --embeddings --skills --pdg --verbose
```

这两者成本和能力都不同。前者更快，适合基础图谱；后者更完整，适合演示、流程理解、PDG/data-flow 等增强场景。

第二，普通用户不应该被迫理解索引细节。

Code Intelligence 面向的是上层 Agent、排障 Skill、新人问答和面试演示。用户真正关心的是“工具能不能查得准、能不能给调用关系、能不能解释为什么降级”，而不是应该手动选择几条底层索引命令。

第三，长时间索引没有进度反馈。

在真实 Java 项目上，索引 3000+ 个 Java 文件再叠加 GitNexus 分析，可能超过十几分钟。如果 CLI 没有任何输出，用户无法判断是卡死、慢、还是仍在正常处理。

### 风险

这种设计会让工具看起来“不可靠”。

即使结果最终是正确的，用户在等待期间也会产生几个疑问：

- 是不是命令卡住了。
- 是不是 GitNexus 没有真正运行。
- 是不是 Code Intelligence 比 GitNexus 慢很多。
- 是不是应该自己手动跑 GitNexus。

这类疑问会削弱面试演示效果，也会影响 Agent 工具链的信任感。

### 修正方案

把 GitNexus 索引策略从布尔开关升级为显式模式：

```bash
code-intel index <project> --gitnexus-mode auto
code-intel index <project> --gitnexus-mode none
code-intel index <project> --gitnexus-mode basic
code-intel index <project> --gitnexus-mode full
```

四种模式的定位：

| 模式 | 底层含义 | 工程定位 |
| --- | --- | --- |
| `auto` | 默认模式。GitNexus 缺索引或明确过期时跑基础分析，已有可用索引时复用。 | 面向普通用户和上层 Agent 的默认入口。 |
| `none` | 不运行 GitNexus，只刷新 Code Intelligence Java 专项索引。 | 快速刷新路由、SQL、错误码、semantic-lite。 |
| `basic` | 强制运行基础 GitNexus 分析，等价于 `gitnexus analyze`。 | 修复缺失索引或刷新基础图谱。 |
| `full` | 强制运行完整分析，等价于 `gitnexus analyze --embeddings --skills --pdg --verbose`。 | 面试演示、完整能力准备、后续流程图/PDG 场景。 |

旧参数继续保留：

```bash
code-intel index <project> --with-gitnexus
```

它被定义为兼容写法，等价于：

```bash
code-intel index <project> --gitnexus-mode basic
```

这样既不破坏已有脚本，又能让新用户使用更清晰的模式参数。

### 进度反馈

索引过程新增阶段级进度，输出到 stderr：

```text
[code-intel] gitnexus: started
[code-intel] gitnexus: running node /path/.gitnexus/run.cjs analyze --embeddings --skills --pdg --verbose
[code-intel] route_index: completed 72000ms
[code-intel] sql_index: completed 18000ms
```

最终 JSON 仍然输出到 stdout，避免破坏脚本调用。

同时索引结果和 manifest 增加：

```json
{
  "gitnexus_mode": "full",
  "counts": {
    "routes": 120,
    "sql": 340,
    "errors": 80,
    "semantic": 3935
  },
  "timings_ms": {
    "gitnexus": 600000,
    "route_index": 72000,
    "sql_index": 18000,
    "error_index": 9000,
    "semantic_index": 30000,
    "total": 729000
  }
}
```

这让用户和 Agent 都能知道：工具到底做了什么、花了多久、产出了多少证据。

### 为什么暂时不做 Promise.all 并行索引

复盘时发现：`route-indexer`、`sql-indexer`、`error-indexer`、`semantic-lite-indexer` 当前是串行执行，理论上可以用 `Promise.all` 并行，缩短总耗时。

但这次没有立刻做并行化，原因是：

- 当前首要问题是“索引策略不清楚”和“没有进度反馈”，不是单纯性能问题。
- 并行会让多个 indexer 同时扫描同一个大仓库，在 WSL 挂载 Windows 盘时可能放大 IO 抖动。
- 并行后的日志、错误归因、资源占用控制都需要重新设计。
- 当前串行虽然慢，但行为稳定、故障边界清楚。

因此这次采取的取舍是：

先补可观察性和模式控制，让用户知道工具在做什么；并行索引作为后续性能专项优化，在有基准数据后再做。

### 面试可讲述版本

可以这样讲：

> 我在试用时发现，工具不是只要能跑就行。最早 `--with-gitnexus` 是一个布尔开关，但用户根本不知道它底层跑的是基础索引还是完整索引；大项目索引很久没有进度，也会让人误以为卡死。所以我把索引策略改成 `auto/none/basic/full` 四种模式：默认 auto 屏蔽实现细节，普通用户直接用；需要面试演示或完整能力时用 full；只刷新 Java 专项索引用 none；旧的 `--with-gitnexus` 保留为 basic 兼容。这个改动体现的是 Agent 工具设计里很重要的一点：既要给高级用户控制权，又要给普通用户一个可靠默认值，同时把耗时、产物数量和降级原因暴露出来，建立可诊断性。

## 11. 踩坑七：candidate_paths 不能包装成完整调用链

### 现象

v0.3 引入 `explore` 后，工具可以从一个接口、错误码、日志、SQL、表名、类名、方法名或业务词出发，自动定位 anchor，再基于 GitNexus context 展开上下游关系。

这很容易产生一个诱惑：为了让演示效果更好，把若干关系边直接串起来，对外说“这就是完整调用链”。

例如：

```text
Controller.detail
  -> OrderService.detail
  -> OrderMapper.countSnapshotItems
```

这条链路对理解代码很有价值，但如果它只是由邻域关系边组装出来，而不是底层 trace 明确验证出来，就不能被称为完整调用链证明。

### 风险

第一，会误导排障结论。

真实生产代码里存在动态代理、接口实现、Spring Bean 注入、AOP、反射、MQ、RPC、配置驱动等边界。候选路径看起来连上了，不代表运行时一定这样走。

第二，会削弱上层 Agent 的安全性。

如果 Agent 把候选路径当作强证据，可能直接输出错误根因，甚至给出错误修改方案。

第三，面试时容易被问穿。

经验丰富的面试官会追问：

- 这条链路是静态关系拼出来的，还是 trace 验证的？
- 你怎么处理动态代理和接口多实现？
- 如果图谱不完整，你怎么告诉上层 Agent？
- 空路径是否代表没有调用？

如果工具没有 `path_status`、`confidence`、`diagnostics`，这个问题很难自洽。

### 修正方案

v0.3 把路径字段明确命名为：

```text
candidate_paths
```

并要求每条路径都带：

```ts
path_status: "candidate" | "verified" | "partial" | "truncated"
confidence: "high" | "medium" | "low"
evidence_sources: Array<"java_index" | "gitnexus" | "grep" | "semantic_lite">
diagnostics: Diagnostic[]
```

语义边界：

| 状态 | 含义 |
| --- | --- |
| `candidate` | 当前证据支持的候选路径，不代表完整调用链证明 |
| `verified` | 底层 trace 已验证的路径，不能由普通 context 拼接伪造 |
| `partial` | 只找到局部链路 |
| `truncated` | 因 `depth`、`limit` 或 `fanout` 限制被截断 |

同时在全局 diagnostics 中增加：

- `PATH_VERIFICATION_SKIPPED`
- `PATH_EXTRACTION_PARTIAL`
- `PATH_TRUNCATED`
- `RELATION_LIMIT_REACHED`
- `FANOUT_LIMIT_REACHED`
- `ANCHOR_AMBIGUOUS`

这让上层 Agent 可以判断：

- 当前路径能不能作为强证据。
- 是否需要继续 trace 验证。
- 是否需要让用户提供更精确 symbol、文件路径或 UID。
- 是否因为截断不能继续下结论。

### 面试可讲述版本

可以这样讲：

> 我在做 explore 的时候刻意没有把结果叫完整调用链，而是叫 candidate_paths。因为它是从 search anchor 和 GitNexus context 关系边组装出来的候选路径，除非底层 trace 明确验证，否则不能标记为 verified。这个设计看起来保守，但对生产排障很重要：上层 Agent 不能因为看到一条路径就直接下根因结论，必须结合 path_status、confidence 和 diagnostics 判断证据强度。这体现了 AI Agent 工具设计里很关键的一点：工具不仅要返回答案，还要告诉 Agent 这个答案是否可靠、是否降级、是否被截断、下一步该如何验证。

## 12. 踩坑八：真实项目 explore 时，anchor 不能只用短 symbol 继续查 context

### 现象

在一个真实 Java 服务上试用：

```bash
code-intel explore <project> \
  --query <business-entry-symbol> \
  --type symbol \
  --direction downstream \
  --depth 2 \
  --limit 5
```

早期实现可以通过 GitNexus query 找到生产代码里的 `<business-entry-symbol>.<handler-method>`，但后续调用 GitNexus context 时使用的是短 symbol：

```text
<handler-method>
```

这会导致 GitNexus 无法稳定定位到同一个方法，最终 `relations=[]`、`candidate_paths=[]`。

手动用 GitNexus UID 查询时可以拿到下游关系：

```text
Method:<module>/src/main/java/<package>/<BusinessEntryClass>.java:<BusinessEntryClass>.<handlerMethod>#1
```

### 根因

短 symbol 对人可读，但对图谱检索不够稳定。

在 Java 项目里，`onMessage`、`execute`、`handler`、`save`、`query` 这类方法名高度重复。Code Intelligence 如果拿短方法名继续查 context，本质上是在把一个已经精确定位的图谱节点退化成模糊文本查询。

### 修正方案

规则调整为：

- 如果 anchor 来源是 GitNexus，后续 context 使用 `location.id`，也就是 GitNexus UID。
- 如果 anchor 来源是本地 Java 专项索引，才使用 `location.symbol` 作为 context key。
- 多跳扩展时，下一跳节点继续使用 relation endpoint UID。

这个修正后，同一个命令可以得到：

```text
<BusinessEntryClass>.<handlerMethod>
  -> <AbstractBusinessHandler>.<dispatchMethod>
  -> <CommandService>.<writeMethod>
```

但输出仍然标记为 `candidate_paths`，不伪造成完整调用链证明。

### 面试可讲述版本

可以这样讲：

> 我真实试用时发现，第一版 explore 能定位到方法，但拿不到下游关系。排查后发现是我把 GitNexus 已经返回的精确 UID 丢了，后续 context 又退回用短方法名查询，导致重名方法场景下不稳定。修正后我保留 GitNexus UID 作为图谱节点主键，同时在输出里保留人类可读 symbol。这个坑说明 Agent 工具不能只追求人类可读，内部证据链必须保留稳定 ID，否则多跳探索会漂移。

## 13. 踩坑九：默认不排除测试代码，会让生产排障入口跑偏

### 现象

在真实项目上查询一个业务 Consumer 类名时，GitNexus query 可能同时返回：

- `src/test` 下的测试类。
- `src/main` 下的生产类。
- 测试类里的测试方法。
- 生产类里的业务方法。

如果不做默认过滤，`explore` 可能从测试类开始扩展，得到的关系边都是测试代码调用关系。这个结果对排查测试失败有价值，但对线上问题排障是错误入口。

### 取舍

Code Intelligence 的默认使用场景是线上排障、代码理解、业务流程梳理。对这些场景来说，生产代码优先级应该高于测试代码。

因此 v0.3 采用：

- CLI 默认排除 `src/test`。
- MCP `code.explore_symbol` 默认 `exclude_tests=true`。
- CLI 提供 `--include-tests`，需要分析测试用例或单测覆盖时显式打开。
- MCP 可以传 `exclude_tests=false` 包含测试代码。

### 面试可讲述版本

可以这样讲：

> 我在真实项目试用时发现，图谱检索经常先命中测试类。这个不是 GitNexus 的问题，而是 Code Intelligence 的上层场景默认值没有设计好。线上排障时默认应该从生产代码开始，否则 Agent 会拿测试调用链解释生产问题。后来我把默认策略改成排除测试代码，同时保留显式 include-tests 开关。这体现的是工具产品化里的一个点：同样的底层检索能力，在不同场景下默认值会直接影响 Agent 输出质量。

## 14. 踩坑十：图谱邻域不等于候选调用路径

### 现象

真实试用一个业务预检查方法时，`explore` 能返回大量 GitNexus 关系边，但早期 v0.3 把所有邻域关系都包装进 `candidate_paths`，导致结果看起来像调用链，实际却会误导上层 Agent。

典型问题包括：

- `imports` 出现在 `candidate_paths` 里，但 import 只说明文件依赖，不说明业务执行路径。
- 测试方法调用生产方法的关系进入默认候选路径，导致线上排障入口混入单测语义。
- 从目标方法反向探索上游调用方时，summary 把事实关系 `A --calls--> B` 显示成 `B --calls--> A`。
- `method_implements` 被降级成 `references`，Java 接口方法和实现方法之间的关键桥接语义被削弱。

### 根因

GitNexus context 返回的是图谱邻域，不是业务调用路径。

邻域关系里既有执行相关边，也有结构边、弱引用边、测试边。对上层 Agent 来说，如果工具不区分这些边的语义强弱，就会把“可参考证据”包装成“候选调用路径”，最终让 Agent 得出过强结论。

这不是 GitNexus 的问题，而是 Code Intelligence 的封装层需要定义更清楚的证据契约：

- 哪些边应进入 `relations`。
- 哪些边适合进入 `candidate_paths`。
- 反向遍历时如何显示方向。
- 哪些诊断需要沉淀成可复盘 case。

### 修正方案

v0.3 回归修正后，规则调整为：

- `relations` 继续保留更完整的原始关系证据，包括 `imports`、`accesses`、测试关系等。
- `candidate_paths` 默认只使用更适合作为路径片段的关系：`calls`、`method_implements`、`method_overrides`、`maps_to_sql`、`uses_table`、`implements`、`has_method`。
- 默认 `exclude_tests=true` 时，测试关系可以保留在 `relations`，但不会进入 `candidate_paths`。
- `method_implements` 是一等 `relation_type`，不再降级为 `references`。
- `upstream` / `both` 反向走边时，summary 使用 `<--calls--`，不改变 `relations.from -> relations.to` 的事实方向。
- 真实试用问题沉淀为本地 eval case；对外材料只展示 eval case 的文件结构和断言，不展示本机路径。

### Eval case 的价值

这次没有只写一段文字复盘，而是保存了：

- `request.json`：复现请求。
- `response.raw.json`：真实 explore 原始输出。
- `response.normalized.json`：适合后续 diff 的稳定字段。
- `expectations.json`：机器可判断的 must-have / must-not-have 规则。
- `notes.md`：人工解释和边界说明。

这样后续继续做 v0.4 `call-path` 或业务流程图 Skill 时，可以先跑这个 case，确认基础证据质量没有回退。

### 面试可讲述版本

可以这样讲：

> 我在真实项目上跑一个业务预检查方法时发现，图谱邻域不能直接当调用链展示。imports、测试调用、结构边都可能混进结果，甚至反向遍历时 summary 会把调用方向说反。这个问题如果交给上层 LLM 自己理解，很容易让 Agent 产生过强结论。所以我把输出契约拆成两层：`relations` 保留完整证据，`candidate_paths` 只做保守路径片段，并用 diagnostics 说明截断和不确定性。更重要的是，我把这次线上真实试用沉淀成 eval case，而不是靠记忆复盘。这样后续每次迭代都能用同一个请求和期望验证工具有没有退化。

## 15. 踩坑十一：把全局预算诊断扩散到每条 candidate path，会让工具看起来全部低置信

### 现象

真实项目上执行：

```bash
code-intel explore mi-intl-scheme \
  --query "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);" \
  --direction both \
  --depth 2
```

早期 v0.3 会出现两个体验问题：

- 默认 `limit=20` 同时控制关系扩展数量和候选路径返回数量，导致稍微复杂一点的业务方法很快触发 `RELATION_LIMIT_REACHED`。
- 一旦顶层 diagnostics 出现 `RELATION_LIMIT_REACHED`、`FANOUT_LIMIT_REACHED` 或 depth limit，所有 `candidate_paths` 都被标记成 `path_status=truncated`、`confidence=low`。

用户看到的结果就是：每条 path 都是低置信，像是工具自己承认“我返回的全不可靠”。

### 根因

这里混淆了两个不同层级的语义：

- 关系扩展预算：控制本次最多从 GitNexus/JDT LS 等 provider 拉多少关系证据。
- 候选路径展示数量：控制最终最多展示多少条 path，避免输出太长。

同时也混淆了两个不同层级的诊断：

- 顶层 diagnostics 描述“本次探索是否触碰预算边界”。
- path diagnostics 应描述“这条 path 本身是否被明确截断或无法解释”。

如果把顶层预算风险复制到每条 path，上层 Agent 会误以为每条 path 片段本身都低可信。实际更准确的说法是：这些 path 片段是当前证据支持的候选片段，但本次探索没有覆盖完整图谱。

### 修正方案

v0.3.2 做了三处调整：

- `limit` 只控制返回的 `candidate_paths` 数量。
- 新增 `relationBudget` / CLI `--relation-budget` / MCP `relation_budget`，专门控制关系扩展预算。
- 顶层预算或深度诊断不再自动污染每条 path；`candidate_paths` 默认保持 `path_status=candidate`，完整性风险由顶层 diagnostics 表达。

示例：

```bash
code-intel explore mi-intl-scheme \
  --query "SettlementAndRebateServiceImpl.preCheckRebate" \
  --direction both \
  --limit 20 \
  --relation-budget 200
```

这表示：最多展示 20 条候选路径片段，但允许底层最多扩展 200 条关系证据。

### 面试可讲述版本

可以这样讲：

> 我在试用时发现一个 Agent 工具契约问题：预算诊断如果直接下沉到每条 path，会让上层 Agent 误判所有路径都低可信。后来我把预算拆成两层，`limit` 控制展示数量，`relationBudget` 控制关系扩展；同时把完整性风险放在顶层 diagnostics，path 本身只表达“当前证据支持的候选片段”。这个调整看起来是一个参数改名，实际上是把“证据可信度”和“探索覆盖范围”分开，避免 LLM 对工具结果产生错误解释。

## 16. 踩坑十二：只返回关系边集合，上游 Agent 仍然不知道主次

### 现象

V0.3.2 虽然修正了 `limit` 和 `relationBudget` 的语义，但真实项目里仍然会出现另一个问题：`relations` 里同时包含 `calls`、`imports`、`has_method`、测试调用、工具方法、校验方法、异常构造。上游 Agent 如果直接读这些边，很难判断哪条是业务主链路，哪条只是辅助证据。

典型表现：

- 同名方法摘要不带类名，例如 `preCheckRebate --calls--> preCheckRebate`，人看不出谁调用谁。
- imports 或 test 调用混入候选路径，影响主链路判断。
- fanout 很大时，如果按 GitNexus 原始顺序裁剪，核心 calls 边可能被低价值关系挤掉。

### 根因

代码图谱是“事实邻域”，不是“业务阅读路径”。GitNexus 给的是关系证据，Code Intelligence 需要再做一层 Agent 任务建模：把图谱邻域组织成可消费的主链路、辅助关系、覆盖度和降级信息。

### 修正方案

V0.4 新增：

- `main_paths`：候选主链路，作为上游 Agent 默认入口。
- `side_relations`：imports、测试调用、工具细节等不进入主链路骨架，但保留为辅助证据。
- `coverage`：声明本次探索是否完整，避免把候选链路说成完整调用链。
- `budget_summary`：记录预算命中原因，便于复盘。
- relation priority：fanout 超限时优先保留 `calls`、`method_implements`、`implements` 等主链路相关边。
- folded steps：把校验、异常、锁、DTO 等细节折叠，不让流程图和排障主链路被细节淹没。

### 面试可讲述版本

可以这样讲：

> 我后来发现，对 Agent 来说“关系边完整返回”不等于“可用”。LLM 需要的是主次分明的任务模型。所以 v0.4 我没有继续堆更多边，而是把输出分层：`main_paths` 给 Agent 先判断主链路，`side_relations` 保留辅助证据，`coverage` 和 `budget_summary` 告诉 Agent 结果是不是预算内候选。这个设计让工具从代码图谱包装，进一步变成面向排障和业务理解的 Agent 证据契约。
