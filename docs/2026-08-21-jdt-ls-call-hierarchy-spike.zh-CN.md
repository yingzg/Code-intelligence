# JDT LS Call Hierarchy Spike 设计

## 1. 背景

Code Intelligence 当前的 `explore` 已经能基于 GitNexus 图谱，从一个代码线索展开上下游关系和候选路径。但真实项目试用暴露了一个问题：如果继续只靠自己组装关系边，很容易在调用链方向、重名方法、预算剪枝、完整性声明上反复踩坑。

因此 v0.4 前需要做一个 spike：评估是否引入 Eclipse JDT Language Server 的 Call Hierarchy 能力，作为 Java 常规调用链的更成熟底座。

这个文档不是功能完成说明。它只定义调研、验证和接入判断标准。

## 2. JDT LS 是什么

Eclipse JDT Language Server 是 Java 语言的 LSP Server，基于 Eclipse JDT、LSP4J、Maven/Gradle 项目导入能力构建。官方 README 明确列出它支持 Java 项目导入、代码导航、references/implementations、Call Hierarchy、Type Hierarchy 等能力。

关键资料：

- JDT LS 仓库：<https://github.com/eclipse-jdtls/eclipse.jdt.ls>
- JDT LS README：<https://github.com/eclipse-jdtls/eclipse.jdt.ls#readme>
- LSP Call Hierarchy 规范：<https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_prepareCallHierarchy>
- Eclipse JDT Call Hierarchy 视图说明：<https://help.eclipse.org/latest/topic/org.eclipse.jdt.doc.user/reference/views/ref-call-hierarchy.htm>

## 3. Call Hierarchy 的 LSP 协议

LSP 的 Call Hierarchy 是两阶段协议。

第一步是定位要分析的符号：

```text
textDocument/prepareCallHierarchy
```

输入是文件 URI 加光标位置。输出是一个或多个 `CallHierarchyItem`。这个步骤解决“当前位置到底对应哪个 Java 成员”的问题，例如类、方法、构造器。

第二步是基于选中的 `CallHierarchyItem` 查询调用关系：

```text
callHierarchy/incomingCalls
callHierarchy/outgoingCalls
```

`incomingCalls` 返回“谁调用了当前 item”。结果中的 `from` 是调用方，`fromRanges` 是调用发生的位置。

`outgoingCalls` 返回“当前 item 调用了谁”。结果中的 `to` 是被调用方，`fromRanges` 是当前 item 内部的调用位置。

这个协议有一个重要含义：JDT LS Call Hierarchy 不是直接输入一个字符串就返回完整链路。它要求先把字符串定位到具体文件和光标位置，然后再调用 LSP API 逐层展开。

## 4. JDT LS 源码确认

JDT LS 的 `JDTLanguageServer` 中已经实现了标准 Call Hierarchy 入口：

- `prepareCallHierarchy(CallHierarchyPrepareParams params)`
- `callHierarchyIncomingCalls(CallHierarchyIncomingCallsParams params)`
- `callHierarchyOutgoingCalls(CallHierarchyOutgoingCallsParams params)`

源码位置：

- <https://raw.githubusercontent.com/eclipse-jdtls/eclipse.jdt.ls/main/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/JDTLanguageServer.java>

JDT LS 内部委托给 `CallHierarchyHandler`：

- `prepareCallHierarchy` 会根据 URI、line、character 解析 Java 成员。
- `callHierarchyIncomingCalls` 会走 `CallHierarchyCore.getCallerRoots(...)`。
- `callHierarchyOutgoingCalls` 会走 `CallHierarchyCore.getCalleeRoots(...)`。
- 返回结构会转换成 LSP 的 `CallHierarchyIncomingCall` 和 `CallHierarchyOutgoingCall`。

源码位置：

- <https://raw.githubusercontent.com/eclipse-jdtls/eclipse.jdt.ls/main/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/CallHierarchyHandler.java>

这说明 JDT LS 不是单纯文本搜索，而是复用 Eclipse JDT 的 Java 模型和调用层级能力，理论上比我们自己从普通关系边拼路径更适合 Java 常规调用链。

## 5. 和 GitNexus 的关系

JDT LS 不应该替代 GitNexus。更合理的关系是分层共存。

GitNexus 继续负责：

- 跨仓库、跨文件的图谱检索入口。
- symbol/search/context/trace 等现有能力。
- embeddings、skills、PDG、wiki、影响分析等更宽的代码理解能力。
- 非严格 Java 调用链证据，例如 imports、implements、references、SQL/table、配置、业务文档等。

JDT LS 负责补强：

- Java 常规调用层级。
- 方法级 incoming/outgoing calls。
- 基于文件位置的精确重名方法 disambiguation。
- 调用点 range，即“调用发生在哪一行”。

Code Intelligence 的职责是统一输出：

- `anchors`
- `relations`
- `candidate_paths`
- `diagnostics`
- `source`
- `raw_relation_type`

也就是说，上层 Agent 不直接面对 JDT LS 或 GitNexus 的原始返回，而是面对一个稳定、可降级、可诊断的 Code Intelligence 契约。

## 6. 推荐接入形态

建议新增一个内部 provider 层，而不是把 JDT LS 逻辑塞进 `explore`：

```text
JavaCallHierarchyProvider
  - findItemByLocation(file, line, character)
  - incoming(item, limit)
  - outgoing(item, limit)
```

核心流程：

1. `searchCode()` 或 GitNexus definitions 先把用户 query 定位到 `CodeLocation`。
2. 如果 location 有 `file/start_line/symbol`，转换为 LSP 位置。
3. 调用 `textDocument/prepareCallHierarchy` 得到 `CallHierarchyItem`。
4. 按 `direction` 调 `incomingCalls` 或 `outgoingCalls`。
5. 把 LSP 返回转换成 `CodeRelation`：
   - incoming：`from -> current`，`relation_type=calls`
   - outgoing：`current -> to`，`relation_type=calls`
   - evidence 包含 `file`、`line`、`source=jdt_ls`、`extracted_by=lsp.callHierarchy`
6. Code Intelligence 再统一组装 path、diagnostics 和 summary。

## 7. Spike 验证对象

真实项目：

```text
/mnt/g/workSpace/mi-intl-scheme
```

优先验证方法：

```text
SettlementAndRebateServiceImpl.preCheckRebate(PreCheckSettlementParamValObj req)
```

重点观察：

- 是否能准确区分 `SettlementAndRebateServiceImpl.preCheckRebate(PreCheckSettlementParamValObj req)` 和 `SettlementBillCommandServiceImpl.preCheckRebate(String billId, boolean isBatch)`。
- incoming 是否能返回 `SettlementBillCommandServiceImpl.preCheckRebate -> SettlementAndRebateServiceImpl.preCheckRebate`。
- outgoing 是否能返回 `SettlementAndRebateServiceImpl.preCheckRebate -> checkPreCheckParam/getHashParamsOrThrow/executePreCheckRebate/...`。
- 是否能返回调用点 range，用于生成更可引用的 evidence。
- 初始化 `mi-intl-scheme` 的 Maven 多模块项目耗时是否可接受。

## 8. Spike 成功标准

可以进入 v0.4 实现的条件：

- 能在 WSL 环境启动 JDT LS。
- 能导入 `mi-intl-scheme` 多模块 Maven 项目。
- 能通过 LSP JSON-RPC 调通 `initialize`、`initialized`、`textDocument/didOpen`。
- 能对目标方法调通 `textDocument/prepareCallHierarchy`。
- incoming/outgoing 结果至少覆盖 GitNexus 当前已能看到的核心 calls。
- 同名方法、重载方法定位明显优于当前 GitNexus context 拼装方式。
- 单次查询耗时可接受，建议 warm 后 P95 小于 5 秒。
- 失败时能稳定输出 diagnostics，而不是让上层 Agent 误以为“没有调用链”。

## 9. Spike 失败标准

如果出现以下情况，暂不引入 JDT LS：

- WSL 下 JDT LS 启动、项目导入、Maven 解析不稳定。
- 多模块项目首次导入耗时过长，无法作为排障工具的一部分。
- 对目标方法的 incoming/outgoing 覆盖明显弱于 GitNexus。
- 需要大量特定 IDE 配置才能工作，不适合 CLI/MCP 工具。
- 结果缺少关键调用方/被调用方，且无法通过 diagnostics 清楚解释。

失败时仍保留当前 GitNexus-first 方案，并把 JDT LS 作为后续可选 provider。

## 10. 风险和边界

JDT LS Call Hierarchy 不是完整运行时链路。

它通常更擅长静态 Java 调用关系，但对以下场景仍可能不完整：

- 反射。
- Spring AOP。
- 动态代理。
- MQ/事件驱动。
- 配置驱动路由。
- 跨服务 RPC。
- MyBatis XML 到 Mapper 方法外的 SQL 业务语义。

因此即使接入 JDT LS，Code Intelligence 也不能直接宣称“完整线上调用链”。更合理的表述是：

```text
在静态 Java 语义范围内验证的调用层级证据。
```

对生产排障，仍然需要结合：

- 线上 trace/log。
- GitNexus 图谱和 PDG。
- Java 专项索引中的 route/sql/error map。
- 人工或上层 Agent 的业务判断。

## 11. v0.4 建议路线

v0.4 不建议一口气替换全部调用链能力。更稳妥的路线：

1. 新增只读 spike 脚本：启动 JDT LS，输入文件和行号，输出 incoming/outgoing JSON。
2. 在 `mi-intl-scheme` 上记录 eval case，对比 GitNexus 和 JDT LS。
3. 如果成功，再加内部 provider。
4. `explore` 增加 `providers` 字段，例如：

```json
{
  "providers": ["gitnexus", "jdt_ls"]
}
```

5. MCP/CLI 暂不暴露过多细节，只保留傻瓜式入口：

```bash
code-intel explore mi-intl-scheme --query "..." --direction both
```

6. diagnostics 中说明实际用了哪个 provider：

```text
JDT_LS_CALL_HIERARCHY_USED
JDT_LS_UNAVAILABLE_FALLBACK_TO_GITNEXUS
```

## 12. 结论

JDT LS Call Hierarchy 值得做 spike。原因不是“JDT LS 一定更强”，而是它提供了 Java 领域已经被 IDE 验证过的调用层级能力，可以减少 Code Intelligence 在常规 Java 调用链上继续造轮子的成本。

Code Intelligence 后续的正确方向不是把所有能力自己实现一遍，而是做一个 Agent 友好的代码证据编排层：能接入 GitNexus、JDT LS、Java 专项索引等多个 provider，同时统一输出证据、置信度、降级信息和下一步建议。
