# Code Intelligence 下一阶段推进计划

日期：2026-08-19

## 1. 当前结论

下一阶段优先级已根据 2026-08-20 的真实试用反馈调整：

```text
1. 先测试并修正 v0.3 explore
2. 更新 v0.4 call-path 规格设计文档
3. 开发 v0.4，并补充自动化测试
4. 用户真实试用 v0.4
5. 再开启模拟面试
6. 最后设计并实现业务流程图 Skill
```

不建议现在直接进入模拟面试。原因是当前 Code Intelligence 已经具备“代码位置 + GitNexus 关系边 + trace 两点路径 + explore 单点探索”的基础能力，但 v0.3 真实试用暴露出方向展示、关系过滤、测试代码污染、`method_implements` 归一化和候选路径片段化等问题。

因此，面试前最值得先补齐的是 v0.3 的基础正确性：

```bash
code-intel explore mi-intl-scheme --query "<接口/错误码/日志/SQL/方法/业务词>" --direction both --depth 2
```

`explore` 可以继续作为“图谱邻域探索工具”，但不能输出方向错误或会被误读成完整调用链的候选路径。v0.3 修正完成后，再进入 v0.4 `call-path`，把“常规 Java 后端调用路径提取”做成面向生产和面试展示的主能力。

v0.3 回归修正规格：

```text
docs/2026-08-20-explore-v03-regression-fix-design.zh-CN.md
```

## 2. 推荐推进路线

### 2.1 v0.3 explore 回归修正

目标文档：

```text
docs/2026-08-20-explore-v03-regression-fix-design.zh-CN.md
```

需要重点完成：

- 修复 `both` 模式下反向遍历导致 summary 方向错误的问题。
- `candidate_paths` 默认过滤 `imports`、`accesses`、`references` 等低价值关系。
- 默认排除测试代码时，过滤 `candidate_paths` 中的 `src/test` endpoint。
- 将 `method_implements` 升级为一等关系类型，不再降级为 `references`。
- 增加 anchor ranking，优先实现类方法和更精确的方法命中。
- 优化 candidate path 的关系排序，减少 `limit` 截断对路径质量的破坏。
- 将 `preCheckRebate` 真实问题沉淀成首个手工 eval case，记录请求、响应、诊断和期望断言。
- 用 `mi-intl-scheme` 的 `preCheckRebate` case 做真实验收。

### 2.2 v0.4 call-path 规格设计

v0.3 修正完成后，再设计 v0.4。v0.4 的目标不是继续泛化 `explore`，而是新增更聚焦的调用路径能力：

```bash
code-intel call-path <project> --query "<symbol>"
```

或者等价 MCP tool：

```text
code.find_call_paths
```

v0.4 重点：

- `primary_path`
- `alternative_paths`
- `supporting_relations`
- `entry_paths`
- `downstream_paths`
- `sql_endpoints`
- Java 常规调用场景下的路径排序和主路径选择。
- 后续可补 `eval capture/list/run/diff` CLI，把真实试用问题转成可回放 eval case。

### 2.3 v0.4 开发和测试

开发前必须先补测试用例，至少覆盖：

- Controller / Scheduler / Consumer 到 Service 的路径。
- 接口方法到实现方法的桥接。
- Service 到 Repository / Mapper / SQL 的路径。
- 多候选 anchor 的消歧和排序。
- `limit/fanout/depth` 截断诊断。
- GitNexus 不可用或结果为空时的降级。

### 2.4 用户真实试用 v0.4

试用项目：

```text
/mnt/g/workSpace/mi-intl-scheme
```

试用重点：

- 输入接口路径，能否找到 Controller 入口和下游 Service/Mapper。
- 输入错误码或日志片段，能否找到定义、抛出点、调用方候选。
- 输入 SQL 表名，能否找到 Mapper SQL、Mapper 方法、上游 Service。
- 输入类名或方法名，能否找到更清晰的 upstream/downstream path。
- diagnostics 是否足够解释歧义、截断和降级。

### 2.5 沉淀稳定 demo case

建议至少沉淀 2 到 3 个稳定 demo case：

| demo case | 输入线索 | 期望展示点 |
| --- | --- | --- |
| 接口链路理解 | 一个 Controller route | 展示 Controller -> Service -> Mapper/SQL 的上下文展开 |
| 排障线索定位 | 一个错误码或日志关键字 | 展示从线上日志线索定位代码位置和调用方候选 |
| 数据链路理解 | 一个表名或 SQL 片段 | 展示 Mapper SQL -> Mapper 方法 -> 上游 Service 的探索 |

每个 demo case 要记录：

- 用户输入什么。
- CLI/MCP 返回什么。
- 哪些结果来自 Java 专项索引。
- 哪些结果来自 GitNexus。
- 是否发生降级。
- diagnostics 如何解释可信度。
- 面试时如何讲这个案例。

### 2.6 再开启模拟面试

模拟面试建议放在 v0.4 试用之后。

原因：

- 当前最容易被问到的短板就是“只知道一个线索时怎么查调用上下文”。
- 如果 v0.4 已经落地，可以把这个短板讲成真实演进过程。
- 面试回答会从“规划中”变成“我试用后发现问题，然后迭代了工具能力”。

面试重点问题：

- 为什么 Code Intelligence 不直接替代 GitNexus。
- 为什么不直接暴露 GitNexus 原始输出。
- 为什么需要统一 `CodeLocation`、`CodeRelation`、`Diagnostic`。
- 为什么 `relations` 不等于 `paths`。
- 为什么 `explore` 不等于完整调用链。
- 为什么需要独立的 `call-path`。
- 为什么 `depth` 不能无限大。
- 为什么空 `paths` 不能解释为没有调用链。
- 为什么 Agent 工具必须有可诊断、可降级、可引用的证据协议。

### 2.7 最后实现业务流程图 Skill

业务流程图 Skill 应该最后做，因为它是上层能力，不是底座能力。

它依赖 Code Intelligence 能稳定回答：

- 入口在哪里。
- 上游 caller 是谁。
- 下游 callee 是谁。
- 哪些节点是 Controller、Service、Mapper、SQL、MQ、定时任务、外部 RPC。
- 哪些边是调用、实现、继承、SQL 映射、配置引用。
- 哪些结果可靠，哪些是降级推断。

如果底座没有稳定的路径证据，流程图 Skill 只能基于零散 search/trace 拼图，容易画错。正确顺序是先让底座能稳定产出路径证据和 diagnostics，再让流程图 Skill 消费这些结构化证据。

## 2A. 已完成的 v0.3 explore MVP 记录

以下内容是 v0.3 MVP 已完成部分，保留作为历史记录和后续对照。

### 2A.1 实现 explore MVP

建议先实现一个可演示、可测试、可被上层 Agent 使用的最小闭环。

CLI 入口：

```bash
code-intel explore <project> \
  --query "<query>" \
  --direction upstream|downstream|both \
  --depth 2 \
  --limit 20 \
  --json
```

MCP 入口：

```text
code.explore_symbol
```

core API：

```ts
exploreSymbol(input): Promise<ExploreResponse>
```

MVP 最少要做到：

- 先复用 `searchCode()` 定位候选 anchors。
- 对每个 anchor 调用 GitNexus `context`。
- 根据 `direction` 选择 incoming、outgoing 或 both。
- 返回结构化 `anchors`、`relations`、`diagnostics`。
- 保留 `raw_relation_type`。
- 对 GitNexus 不可用、索引缺失、符号歧义、结果截断、低置信结果返回 diagnostics。

是否第一版就生成 `paths`，需要在设计修订时确认。建议保守处理：第一版可以返回 `paths: []` 和明确诊断，也可以只生成一跳或两跳的候选路径，避免过早承诺“完整调用链”。

### 2A.2 在 mi-intl-scheme 上完整试用

测试项目：

```text
/mnt/g/workSpace/mi-intl-scheme
```

注册命令：

```bash
code-intel register mi-intl-scheme /mnt/g/workSpace/mi-intl-scheme \
  --stack java-spring-mybatis \
  --gitnexus-repo mi-intl-scheme
```

首次准备完整演示环境：

```bash
code-intel index mi-intl-scheme --gitnexus-mode full
```

日常刷新：

```bash
code-intel index mi-intl-scheme
```

试用重点：

- 输入接口路径，能否找到 Controller 入口和下游 Service/Mapper。
- 输入错误码或日志片段，能否找到定义、抛出点、调用方候选。
- 输入 SQL 表名，能否找到 Mapper SQL、Mapper 方法、上游 Service。
- 输入类名或方法名，能否找到 incoming/outgoing 关系边。
- 当 GitNexus 找不到、返回空、返回歧义时，diagnostics 是否足够解释原因。
- 当结果被 `depth`、`limit`、`fanout` 截断时，是否明确提示。

## 3. 时间预估

| 阶段 | 预计耗时 |
| --- | --- |
| v0.3 explore 回归修正设计 | 0.5 天 |
| v0.3 explore 回归修正实现和测试 | 0.5 到 1.5 天 |
| v0.4 call-path 规格设计 | 0.5 到 1 天 |
| v0.4 call-path 实现和测试 | 2 到 4 天 |
| mi-intl-scheme 真实试用和 demo case 沉淀 | 0.5 到 1 天 |
| 模拟面试第一轮 | 0.5 天 |
| 业务流程图 Skill | 1 到 2 天 |

## 4. explore MVP 的关键取舍

### 4.1 默认先解决“单点探索”，不是完整自动根因分析

`explore` 的职责是从一个线索出发，展开代码上下文和候选关系证据。

它不直接承诺：

- 自动判断线上根因。
- 自动画完整业务流程图。
- 自动穿透所有动态代理、反射、AOP、RPC、MQ 和外部系统。

这些能力应该由上层排障 Skill 或流程图 Skill 基于 evidence 继续推理。

### 4.2 paths 要谨慎

`relations` 是边集合。

`paths` 是有序路径。

第一版如果无法可靠生成路径，不应该伪造路径。可以先返回 `anchors + relations`，并用 diagnostics 说明：

```text
PATH_EXTRACTION_NOT_IMPLEMENTED
```

或者只生成局部候选路径，并明确：

```text
path_type = candidate
confidence = low|medium
```

### 4.3 depth 默认 2，最大 4

真实项目图谱关系会快速扩散。一个 Service 可能被多个 Controller、Job、Listener 调用，也可能调用多个 Service、Mapper、Client。每一层 fanout 如果是 10，深度 4 理论上就可能扩展到 10000 个节点级别。

因此默认深度不宜太大：

- `depth=1`：只看直接邻居。
- `depth=2`：适合日常理解上下文。
- `depth=3`：适合找入口或下游 SQL。
- `depth=4`：适合明确需要更深探索的场景，应该作为上限。

这不是因为栈溢出，而是为了控制噪声、耗时、token 体积和 Agent 误判风险。

### 4.4 diagnostics 是上层 Agent 的安全边界

Agent 不能只看 `relations.length` 或 `paths.length`。

必须根据 diagnostics 判断：

- GitNexus 是否可用。
- 索引是否存在。
- 是否发生歧义。
- 是否达到 `depth/limit/fanout` 限制。
- 是否只返回了一跳关系。
- 是否发生 grep/semantic-lite 降级。

这决定了上层 Agent 能不能把结果当作强证据使用。

## 5. 后续执行检查清单

### 设计修订完成前

- [x] 明确 explore MVP 是否第一版生成 `candidate_paths`：v0.3 生成候选路径，不承诺完整调用链。
- [x] 明确 `depth/limit/fanout` 默认值。
- [x] 明确 `ExploreResponse` schema。
- [x] 明确 CLI/MCP 参数。
- [x] 明确 diagnostics 清单。
- [x] 明确 mi-intl-scheme 验收案例方向。

### 实现完成前

- [x] core 层有 `exploreSymbol()` 单元测试。
- [x] CLI 有 `code-intel explore` 测试。
- [x] MCP 有 `code.explore_symbol` handler 测试。
- [x] GitNexus 不可用时有降级测试。
- [x] 空 relations / 空 paths 有 diagnostics 测试。
- [x] limit/depth 截断有 diagnostics 测试。

### 试用完成前

- [x] 在 mi-intl-scheme 上完成一次 `explore_symbol` 真实试用，记录见 `docs/2026-08-19-explore-symbol-real-trial.zh-CN.md`。
- [ ] 在 mi-intl-scheme 上确认完整索引状态和稳定 demo 环境。
- [ ] 选出接口链路 demo。
- [ ] 选出错误码或日志 demo。
- [ ] 选出 SQL/表名 demo。
- [ ] 记录每个 demo 的输入、输出、证据来源、降级情况和面试讲法。

## 6. 当前建议

下一步进入 `explore_symbol` 设计修订。

修订时不要只补命令说明，而是要把它设计成上层 Agent 的代码证据探索协议。重点不是“能查到几条边”，而是让 Agent 明确知道：

- 查到了什么。
- 从哪里查到的。
- 可信度如何。
- 有没有降级。
- 有没有被截断。
- 下一步应该查什么。
