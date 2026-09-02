# 本地 Java 代码检索与代码理解底座设计文档

日期：2026-07-31

更新：2026-08-14，补充 v0.2 GitNexus relations 最小闭环实现结果。

## 0. 当前实现校准

截至 2026-08-14，当前代码已经完成 Code Intelligence v0.2 最小闭环。已实现项目注册、本地索引、Java 路由索引、SQL/表名索引、错误码/异常/日志索引、semantic-lite、受控 grep 兜底、CLI 入口、MCP 入口、统一 `SearchResponse` 输出模型，以及本地 GitNexus `query/context/trace` 接入。

当前已落地的 v0.2 能力：

- 项目注册支持 `gitnexus_repo`，用于绑定 Code Intelligence 项目名和 GitNexus repo label。
- GitNexus 探测支持项目内 `.gitnexus/run.cjs`，不依赖远程仓库权限。
- `include_relations=true` 会尝试调用 GitNexus `query/context`，生成 `source=gitnexus` 的 `CodeLocation` 和 `CodeRelation`。
- `CodeRelation` 会保留归一后的 `relation_type` 和 GitNexus 原始 `raw_relation_type`，避免封装时丢失底层语义。
- `traceCallChain()` 和 CLI `trace` 会调用 GitNexus `trace`，支持 `hops/edges` 输出结构，能生成有序调用链关系边。
- CLI `trace` 和 MCP `code.trace_call_chain` 支持 `from_uid/from_file/to_uid/to_file` 消除符号歧义。
- MCP 当前注册 `code.search`、`code.locate_route`、`code.trace_call_chain`、`code.index_project` 四个 tool。
- GitNexus 返回 `not_found`、`no_path`、`ambiguous` 时，会进入 `diagnostics`，不会把空 `relations` 解释成“确认没有调用关系”。
- GitNexus 返回未知关系类型时，会降级为 `references`，同时保留 `raw_relation_type` 并返回 `GITNEXUS_UNKNOWN_RELATION_TYPE` 诊断。
- 当前 grep 兜底仍是受控文本兜底：限定文件类型、忽略构建目录、限制扫描文件数和文件大小、结构化输出低置信结果；它不是语义增强 grep。

当前仍需明确的边界：

- v0.2 仍然只依赖本地源码和本地 GitNexus 索引，不访问远程 GitLab，不做远程仓库索引。
- `include_downstream` 已进入 MCP 参数契约，当前最小实现复用关系增强，还不是完整多跳下游展开。
- `relations=[]` 只能说明当前没有生成关系证据，不能说明“代码中不存在关系”。
- `search --include_relations` 返回的是邻域关系边集合，不是完整业务调用链；完整单点上下游探索需要后续 `explore_symbol` 能力。

## 1. 背景

当前已有一个线上运维排障 Skill，目录为 `/mnt/g/my-Skill/Skill/online-troubleshoot`。该 Skill 已经定义了稳定的排障流程：历史案例预检、上下文提取、代码定位、SQL 准备、数据库验证、根因分析、案例回写。其中第 3 步“代码定位”目前只定义了抽象契约，缺少一个真正可复用的本地代码检索能力。

用户还计划后续建设业务流程图、业务理解、新人问答、PRD 和详设辅助类工具。这些工具也需要一个共同底座：能够理解本地服务项目代码，定位接口、异常、SQL、表名、类、方法、调用链，并返回稳定的证据结构。

因此本设计的目标不是做一个线上运维专用工具，而是设计一个通用的本地 Java 代码检索与代码理解底座。线上运维 Skill 只是第一批消费者之一。

## 2. 目标

第一版建设一个本地代码检索工具，聚焦本地已克隆的 Java 后端服务项目。

第一版支持：

- 多个本地项目注册。
- 每次查询明确指定一个项目。
- Java 后端服务优先，重点支持 Spring、Dubbo、MyBatis、Mapper XML、配置文件、错误码、异常和日志语句。
- 接口和路由定位。
- 异常、错误码、日志文本定位。
- SQL 片段和表名定位。
- 符号、关键词、业务描述的轻量语义召回。
- 基础调用链摘要。
- 通用代码证据输出模型。
- MCP 和 CLI 双入口。
- GitNexus 结构化代码图谱复用。
- 增强 grep 降级能力。
- 使用指南、功能介绍和接入指南文档。

典型首次准备流程：

```bash
code-intel register trade-service /mnt/g/workSpace/trade-service
code-intel index trade-service --with-gitnexus
```

典型日常使用流程：

```text
用户向上层 Skill 或 Agent 提问
  -> 上层工具提取接口、异常、SQL、业务描述等线索
  -> 通过 MCP 调用本工具
  -> 本工具返回通用代码位置、关系、证据和诊断信息
  -> 上层工具适配成自己的领域输出
```

## 3. 非目标

第一版不做：

- 不支持 GitLab 远程仓库索引。
- 不做跨项目调用链分析。
- 不做完整 RAG 问答系统。
- 不直接输出线上排障根因结论。
- 不直接输出 P0/P1/P2 修复建议。
- 不绑定 `online-troubleshoot` 的专用 JSON schema。
- 不默认自动扫描大项目。
- 不重复建设完整 Java AST 图谱。
- 不替代 GitNexus 的结构化索引能力。
- 不默认把本工具索引写入业务项目目录。
- 不默认把运行时索引写入工具安装目录。

最重要的边界是：本工具只输出通用代码证据模型，具体业务工具负责适配和推理。

## 4. 已确认设计决策

| 决策项 | 结论 |
| --- | --- |
| 第一版代码来源 | 本地已克隆目录 |
| 第一版服务对象 | Java 后端服务项目 |
| 多项目支持 | 支持注册多个本地项目，每次查询指定一个项目 |
| 跨项目调用链 | 第一版不做 |
| 默认运行形态 | 本地核心库 + MCP 入口 + CLI 入口 |
| HTTP 服务 | 可选扩展，不是第一版必需运行组件 |
| 索引触发 | 默认手动索引 |
| 未索引时行为 | 返回明确提示，可降级增强 grep |
| GitNexus 调用 | 默认不自动执行重型分析，显式 `--with-gitnexus` 才代跑 |
| RAG 能力 | 第一版只做轻量语义召回，不做完整问答 |
| 技术栈参数 | 自动探测为主，`--stack` 作为可选覆盖 |
| 本工具数据目录 | 默认 `~/.code-intelligence/`，支持 `CODE_INTEL_HOME` 覆盖 |

## 5. 总体架构

第一版由五个模块组成。

```text
上层工具
  online-troubleshoot Skill
  未来流程图工具
  未来新人问答工具
        |
        | MCP 或 CLI
        v
入口层
  code-intelligence-mcp
  code-intelligence-cli
  code-intelligence-http 可选
        |
        v
核心层
  Code Intelligence Core
        |
        v
检索与索引层
  GitNexus 结构化索引
  Java 专项索引
  semantic-lite 轻量语义索引
  增强 grep 兜底
        |
        v
统一输出
  SearchResponse
  CodeLocation
  CodeRelation
  EvidenceRef
  Diagnostic
```

### 5.1 Code Intelligence Core

核心库不绑定 MCP、CLI 或 HTTP。它负责：

- 项目注册读取。
- 项目技术栈探测。
- 索引状态判断。
- 索引构建编排。
- 查询类型识别。
- 检索路由。
- GitNexus 查询封装。
- Java 专项索引读取。
- 增强 grep 兜底。
- 轻量语义召回。
- 结果去重与排序。
- 置信度计算。
- 通用模型归一化。
- 诊断信息输出。

核心库对外提供内部 API：

```text
registerProject()
indexProject()
searchCode()
locateRoute()
searchError()
searchSql()
traceCallChain()
diagnoseIndex()
```

### 5.2 CLI 入口

CLI 面向用户和脚本，负责注册、索引、诊断和调试。

CLI 直接调用 Core，不经过 HTTP 服务。

### 5.3 MCP 入口

MCP 是 Agent 和 Skill 的默认入口。MCP Server 只做协议适配：

```text
MCP Tool 请求
  -> 参数校验
  -> 调用 Core
  -> 返回 SearchResponse
```

MCP 默认只允许查询和诊断。注册和索引能力必须通过显式开关开启。

### 5.4 可选 HTTP 服务

HTTP 服务不是第一版必需组件。它只在未来需要 Web UI、多工具共享常驻进程、模型常驻内存、团队化部署时启用。

第一版可以保留 HTTP 接口设计，但用户日常使用不需要手动启动 HTTP 服务。

### 5.5 Index Store

本工具自己的数据目录默认放在：

```text
~/.code-intelligence/
```

支持通过环境变量覆盖：

```bash
export CODE_INTEL_HOME=/mnt/g/my-Skill/runtime/code-intelligence
```

数据目录结构：

```text
~/.code-intelligence/
├── README.md
├── registry.json
├── config.json
├── projects/
│   └── trade-service/
│       ├── manifest.json
│       ├── java-route-map.jsonl
│       ├── java-sql-map.jsonl
│       ├── error-map.jsonl
│       └── semantic-lite/
└── logs/
```

GitNexus 自己的索引继续由 GitNexus 管理：

```text
<repo>/.gitnexus/
~/.gitnexus/registry.json
```

本工具不复制 GitNexus 的完整索引，只记录 GitNexus 可用性、项目是否完成 GitNexus 分析、GitNexus 项目引用信息。

## 6. GitNexus 与本工具的职责边界

GitNexus 是结构化代码图谱主索引，负责：

- 类、方法、函数、文件结构。
- 符号定义和引用。
- 调用关系。
- 代码执行流。
- 影响面分析。

本工具负责：

- 项目注册。
- Java 后端专项索引。
- 检索意图识别。
- GitNexus、专项索引、语义召回、grep 的编排。
- 结果归一化。
- 置信度计算。
- 通用输出契约。
- 面向 MCP、CLI、未来 HTTP 的稳定入口。

设计原则：

```text
GitNexus 负责看懂代码结构。
本工具负责把代码结构变成稳定、通用、面向上层工具的代码检索能力。
```

### 6.1 v0.2 GitNexus 本地接入原则

v0.2 不复制 GitNexus 的完整索引，也不访问远程仓库。GitNexus 继续管理自己的本地图谱索引：

```text
<repo>/.gitnexus/
~/.gitnexus/registry.json
```

Code Intelligence 只做三件事：

- 记录 Code Intelligence 项目与 GitNexus repo label 的映射。
- 在查询时调用本地 GitNexus CLI 的 `status`、`query`、`context`、`trace` 等命令。
- 将 GitNexus 输出归一成 `CodeLocation`、`CodeRelation` 和 `Diagnostic`。

v0.2 的默认链路：

```text
用户线索
  -> Java 专项索引定位代码锚点
  -> GitNexus context/trace/query 扩展关系
  -> semantic-lite 补充业务词召回
  -> 受控 grep 兜底
  -> 统一 SearchResponse 输出
```

设计重点是分工清楚：

```text
Java 专项索引负责把接口、错误码、日志、SQL、表名等线上线索转换成代码锚点。
GitNexus 负责从代码锚点扩展上下游关系、调用链、实现关系和影响范围。
Code Intelligence 负责查询编排、可信度诊断、降级处理和统一协议。
```

### 6.2 本地验证项目

v0.2 使用本地项目 `/mnt/g/workSpace/mi-intl-scheme` 作为集成验收样例。该项目已有本地 GitNexus 索引，验证时不需要远程仓库权限。

截至 2026-08-14，本地 GitNexus 状态：

```text
Repository: /mnt/g/workSpace/mi-intl-scheme
Branch: fix-rebate-20260511
Indexed commit: d465a51
Current commit: d465a51
Status: up-to-date
```

本地索引能力：

```text
files: 5386
nodes: 74541
edges: 161711
processes: 300
graph: available
fts: available
vectorSearch: unavailable
```

注意：本地 GitNexus registry 中可能存在多个 repo，例如 `java-spring-mybatis-demo` 和 `mi-intl-scheme`。因此 v0.2 所有 GitNexus CLI 调用必须显式传 `--repo <gitnexus_repo>`，不能假设环境里只有一个索引。

## 7. 项目注册模型

第一版项目注册只保存必要信息，不引入负责人、业务域、数据库、环境等治理元数据。

注册信息包含：

```ts
type RegisteredProject = {
  name: string
  path: string
  stack: "java-spring-mybatis" | "java-spring" | "java-dubbo-mybatis" | "java-generic"
  gitnexus_repo?: string
  created_at: string
  updated_at: string
}
```

注册命令：

```bash
code-intel register trade-service /mnt/g/workSpace/trade-service
```

默认自动探测技术栈。可选覆盖：

```bash
code-intel register trade-service /mnt/g/workSpace/trade-service --stack java-spring-mybatis
```

v0.2 新增 GitNexus repo label 绑定：

```bash
code-intel register mi-intl-scheme /mnt/g/workSpace/mi-intl-scheme \
  --stack java-spring-mybatis \
  --gitnexus-repo mi-intl-scheme
```

如果不传 `--gitnexus-repo`，默认使用 Code Intelligence 项目名作为 GitNexus repo label。查询 GitNexus 时必须显式传入该 label，避免多个本地 GitNexus repo 并存时出现 repo 歧义。

技术栈探测规则：

- 存在 `pom.xml`、`build.gradle`、`src/main/java` 时，识别为 Java 项目。
- 存在 `@RestController`、`@Controller`、`@RequestMapping`、`@GetMapping`、`@PostMapping` 时，识别 Spring Web 能力。
- 存在 `@Mapper`、Mapper XML、MyBatis 依赖时，识别 MyBatis 能力。
- 存在 Dubbo 注解或 Dubbo 配置时，识别 Dubbo 能力。
- 无法细分时，落到 `java-generic`。

## 8. 索引策略

第一版使用四层能力：

```text
1. GitNexus 结构化索引
2. Java 专项索引
3. semantic-lite 轻量语义索引
4. 增强 grep 兜底
```

### 8.1 GitNexus 结构化索引

v0.1 当前实现只做 GitNexus 可用性检查，不读取 GitNexus 图谱内容：

- 检查 `gitnexus --version` 是否可用。
- 检查项目路径下是否存在 `.gitnexus` 目录。
- 显式传 `--with-gitnexus` 时尝试执行 `gitnexus analyze`。
- 将 GitNexus 状态写入 `manifest.json`。

v0.2 开始读取本地 GitNexus 图谱能力，但仍不复制完整索引。v0.2 通过本地 CLI 实时调用：

```bash
node .gitnexus/run.cjs status
node .gitnexus/run.cjs query "<query>" --repo <gitnexus_repo> --limit <n>
node .gitnexus/run.cjs context "<symbol>" --repo <gitnexus_repo> --limit <n>
node .gitnexus/run.cjs trace "<from>" "<to>" --repo <gitnexus_repo> --depth <n>
```

执行：

```bash
code-intel index trade-service
```

默认行为：

- 检查 GitNexus 是否安装。
- 检查 GitNexus 索引是否存在。
- 如果 GitNexus 索引不存在，只返回提示，不自动执行重型分析。
- 继续生成本工具自己的 Java 专项索引和 semantic-lite，条件是项目路径可读。

显式代跑 GitNexus：

```bash
code-intel index trade-service --with-gitnexus
```

行为：

- 执行 GitNexus 分析。
- 确认本地 GitNexus repo label 可用。
- 再生成 Java 专项索引和 semantic-lite。
- 记录健康状态。

v0.2 需要记录的 GitNexus 状态包括：

- repo label。
- indexed commit。
- current commit。
- 是否 up-to-date。
- nodes、edges、processes 统计。
- graph、fts、vectorSearch 能力状态。

如果 GitNexus 图谱不可用，Code Intelligence 必须继续返回 Java 专项索引、semantic-lite 或 grep 结果，并通过 `diagnostics` 标明关系能力降级。

### 8.2 Java 专项索引

Java 专项索引是面向 Java 后端排障的轻量倒排索引，不是完整 AST 图谱。

`java-route-map.jsonl` 记录：

- Spring 路由注解。
- Controller 类和方法。
- 类级路径和方法级路径拼接。
- HTTP 方法。
- Dubbo 接口、Provider、Consumer 候选。
- RPC 方法名。

`java-sql-map.jsonl` 记录：

- Mapper XML。
- Mapper 接口。
- 注解 SQL。
- SQL id。
- 表名。
- Mapper 方法。
- SQL 片段。

`error-map.jsonl` 记录：

- Exception 类。
- `throw new XxxException`。
- catch 块。
- 错误码枚举。
- 错误码常量。
- 日志模板。
- `logger.error` 和 `logger.warn` 语句。
- i18n message key。

### 8.3 semantic-lite 轻量语义索引

semantic-lite 只做业务描述到候选代码片段的补充召回，不做完整问答。

索引对象控制在：

- Controller 类名、方法名、注释、接口路径。
- Service 类名、方法名、注释。
- Mapper 方法名、SQL id、表名。
- 枚举、常量、错误码。
- 配置 key。
- README 或 docs 中的短业务说明。

semantic-lite 结果默认不作为高置信证据。只有被接口、错误码、SQL、符号关系等结构证据二次确认时，置信度才能提升。

### 8.4 增强 grep 兜底

增强 grep 用于索引缺失、索引过期、GitNexus 不可用、semantic-lite 缺失或低置信结果。

v0.1 当前 grep 更准确的定位是“受控 grep fallback”，增强点不是语义理解，而是：

- 限定扫描文件类型。
- 忽略构建产物、依赖目录、日志目录和临时目录。
- 限制最大扫描文件数和单文件大小。
- 命中结果达到 `limit` 后停止。
- 将命中结果包装成统一 `CodeLocation`。
- 明确标注 `source: "grep"`、`confidence: "low"` 和 grep fallback 诊断。

v0.1 当前实现不会保证 grep 结果完整召回，grep 只提供低置信兜底线索，不作为根因判断或流程图关系生成的核心依据。

增强 grep 策略：

- 搜索原始关键词。
- 搜索错误码、异常类、错误文本。
- 搜索接口路径片段。
- 搜索页面或模块名。
- 搜索候选表名和 SQL 片段。
- 对 Controller、Service、Mapper、DAO、Repository、XML、SQL、Enum、Constant、Config 文件加权。
- 排除 `.git`、`target`、`build`、`node_modules`、`dist`、日志目录和临时目录。
- 基于第一轮命中结果做二次上下文搜索。
- 返回结果必须标注 `source: "grep"`，置信度不得虚高。

v0.2 可以保留 grep 兜底，但必须在 diagnostics 中暴露扫描限制，例如是否达到文件扫描上限、是否达到结果 limit、是否只扫描了受支持文件类型。这样上层 Agent 不会把 grep 的不完整结果误判为“确认没有匹配代码”。

## 9. 索引新鲜度

索引时记录：

```text
indexed_at
indexed_commit
dirty_flag
tool_version
gitnexus_status
generated_files
warnings
errors
```

查询时判断：

- 当前 commit 与 `indexed_commit` 不一致，标记 `stale`。
- 当前工作区 dirty 状态与索引时不一致，标记 `stale`。
- 索引文件缺失，标记 `missing`。
- 部分索引生成失败，标记 `partial`。
- 索引可用且新鲜，标记 `ready`。

`stale` 不阻断查询，但必须出现在 `index_status` 和 `diagnostics` 中。非 grep 精确结果需要降低置信度，或在 `match_reason` 中说明可能过期。

## 10. 检索路由

统一查询入口接收：

```text
project
query_type
query_text
hints
limit
include_relations
```

### 10.1 route 查询

适用输入：

```text
/api/trade/order/detail
GET /api/trade/order/detail
```

路由：

```text
java-route-map 精确路径匹配
  -> java-route-map 路径片段匹配
  -> GitNexus 查询 Controller 方法下游调用
  -> java-sql-map 补 Mapper 和 SQL 候选
  -> grep 兜底
```

高置信条件：

- 路径完整匹配。
- 能定位 Controller 方法。
- 能找到下游 Service 或 Mapper 关系。

### 10.2 error 查询

适用输入：

```text
ClientAbortException
Broken pipe
ORDER_STATUS_INVALID
```

路由：

```text
error-map 查异常类、错误码、日志模板
  -> GitNexus 查符号定义和引用
  -> grep 搜原始错误文本
  -> semantic-lite 补业务候选
```

高置信条件：

- 异常类、错误码或日志模板精确命中。
- 命中 throw、catch、logger、错误枚举等明确代码位置。

### 10.3 sql 和 table 查询

适用输入：

```text
order_item_snapshot
select * from order_item_snapshot where order_id=?
```

路由：

```text
java-sql-map 查表名、SQL id、Mapper XML
  -> GitNexus 查 Mapper 方法上游调用
  -> grep 搜表名和 SQL 片段
```

高置信条件：

- 表名精确命中 SQL、XML 或注解。
- 能关联到 Mapper 方法。
- 最好能进一步关联到 Service。

### 10.4 semantic 查询

适用输入：

```text
订单详情页打开超时
支付完成后库存没有扣减
门店结算金额不对
```

路由：

```text
semantic-lite 召回候选 Controller、Service、Mapper、Enum、Config
  -> route-map、sql-map、error-map 交叉验证
  -> grep 搜业务关键词
```

高置信条件：

- 语义候选被接口、错误码、SQL 或符号关系二次确认。

### 10.5 call_chain 查询

v0.1 当前 `call_chain` 只是预留查询类型，尚未实现深度调用链检索。v0.2 必须让 `call_chain` 具备可演示能力，底层优先使用 GitNexus `trace` 或 `context`。

适用输入：

```text
文件加行号
类名加方法名
location_id
from symbol -> to symbol
```

路由：

```text
GitNexus 查询上下游调用关系
  -> Java 专项索引补 route -> service -> mapper -> sql
  -> grep 搜直接方法引用兜底
```

高置信条件：

- GitNexus 返回明确调用边。
- 或 Java 专项索引能从入口一路连接到 Mapper 和 SQL。

### 10.6 v0.2 relations 生成流程

v0.2 中 `include_relations` 必须真正生效。

通用流程：

```text
searchCode(project, query, include_relations=true)
  -> 使用 v0.1 检索逻辑得到 locations
  -> 从高置信 locations 提取 symbol、file、line
  -> 使用项目注册中的 gitnexus_repo 调用 GitNexus context
  -> 将 incoming、outgoing、typed_properties、processes 映射为 CodeRelation
  -> 将 GitNexus definitions 补充为 source=gitnexus 的 CodeLocation
  -> 返回 locations + relations + diagnostics
```

`include_downstream` 是 `code.locate_route` 的路由专用开关。v0.2 中它表示：

```text
先定位接口入口，再从 Controller 方法沿 GitNexus outgoing calls 扩展下游关系。
```

默认下游深度建议为 2，最大深度建议为 3。超过深度时必须返回诊断，说明链路被截断。

关系生成要遵守两个规则：

- 不编造关系。只有 GitNexus、Java 专项索引或明确源码证据支持的关系才能进入 `relations`。
- 空 `relations` 只代表“当前没有可用关系证据”，不能代表“确认没有调用关系”。

### 10.7 v0.2 GitNexus 查询策略

GitNexus 的中文全文查询可能受到 CJK 分词配置影响。v0.2 对中文业务词的策略是：

```text
中文业务词
  -> semantic-lite 优先召回候选代码位置
  -> 从候选位置提取英文 symbol、类名、方法名
  -> 使用 GitNexus context 扩展关系
```

英文 symbol、类名、方法名、模块名查询可以直接调用 GitNexus `query` 或 `context`。

查询 GitNexus 时必须显式传 `--repo <gitnexus_repo>`。如果没有配置 repo label，默认使用 Code Intelligence 项目名；如果仍然出现 repo 歧义，返回 `GITNEXUS_REPO_AMBIGUOUS` 诊断。

## 11. 通用输出模型

第一版核心返回对象为 `SearchResponse`。

```ts
type SearchResponse = {
  request_id: string
  project: ProjectRef
  query: QueryRef
  index_status: IndexStatus
  summary: string
  locations: CodeLocation[]
  relations: CodeRelation[]
  diagnostics: Diagnostic[]
}
```

### 11.1 ProjectRef

```ts
type ProjectRef = {
  name: string
  path: string
  stack: "java-spring-mybatis" | "java-spring" | "java-dubbo-mybatis" | "java-generic"
  gitnexus_repo?: string
  commit_hash?: string
  dirty: boolean
}
```

### 11.2 QueryRef

```ts
type QueryRef = {
  type:
    | "route"
    | "error"
    | "sql"
    | "table"
    | "symbol"
    | "keyword"
    | "semantic"
    | "call_chain"
  text: string
  hints?: {
    class_name?: string
    method_name?: string
    file?: string
    line?: number
    trace_source?: string
    from_uid?: string
    from_file?: string
    to_uid?: string
    to_file?: string
  }
}
```

### 11.3 IndexStatus

```ts
type IndexStatus = {
  state: "ready" | "missing" | "stale" | "partial" | "failed"
  indexed_at?: string
  indexed_commit?: string
  current_commit?: string
  message?: string
  suggested_command?: string
}
```

### 11.4 CodeLocation

```ts
type CodeLocation = {
  id: string
  project: string
  file: string
  start_line?: number
  end_line?: number
  symbol?: string
  language: "java" | "xml" | "properties" | "yaml" | "sql" | "unknown"
  location_type:
    | "route"
    | "controller"
    | "service"
    | "dubbo_interface"
    | "dubbo_provider"
    | "mapper"
    | "sql"
    | "config"
    | "constant"
    | "enum"
    | "exception"
    | "log_statement"
    | "test"
    | "unknown"
  snippet: string
  match_reason: string
  score: number
  confidence: "high" | "medium" | "low"
  source: "java_index" | "gitnexus" | "grep" | "semantic_lite"
}
```

### 11.5 CodeRelation

```ts
type CodeRelation = {
  from: string
  to: string
  relation_type:
    | "calls"
    | "implements"
    | "maps_to_sql"
    | "handles_route"
    | "throws"
    | "logs"
    | "reads_config"
    | "uses_table"
    | "contains"
    | "has_method"
    | "has_property"
    | "imports"
    | "accesses"
    | "extends"
    | "method_overrides"
    | "typed_as"
    | "references"
  raw_relation_type?: string
  confidence: "high" | "medium" | "low"
  evidence: EvidenceRef[]
}
```

`relation_type` 是 Code Intelligence 归一后的稳定类型。`raw_relation_type` 是 GitNexus 原始关系类型。未知 GitNexus 关系会降级为 `references`，但必须保留 `raw_relation_type`，并通过 diagnostics 暴露。

### 11.6 EvidenceRef

```ts
type EvidenceRef = {
  file: string
  line?: number
  snippet: string
  source: "java_index" | "gitnexus" | "grep" | "semantic_lite"
  extracted_by: string
  raw_relation_type?: string
}
```

### 11.7 Diagnostic

```ts
type Diagnostic = {
  level: "info" | "warning" | "error"
  code:
    | "PROJECT_NOT_REGISTERED"
    | "PROJECT_PATH_NOT_FOUND"
    | "INDEX_MISSING"
    | "INDEX_STALE"
    | "GITNEXUS_UNAVAILABLE"
    | "GITNEXUS_INDEX_MISSING"
    | "GITNEXUS_REPO_AMBIGUOUS"
    | "GITNEXUS_REPO_NOT_REGISTERED"
    | "GITNEXUS_INDEX_STALE"
    | "GITNEXUS_QUERY_FAILED"
    | "GITNEXUS_RELATIONS_USED"
    | "GITNEXUS_RELATIONS_UNAVAILABLE"
    | "GITNEXUS_UNKNOWN_RELATION_TYPE"
    | "RELATION_LIMIT_REACHED"
    | "DOWNSTREAM_DEPTH_LIMIT_REACHED"
    | "SEMANTIC_INDEX_MISSING"
    | "GREP_FALLBACK_USED"
    | "LOW_CONFIDENCE"
  message: string
  suggested_action?: string
}
```

## 12. CLI 命令

### 12.1 查看数据目录

```bash
code-intel where
```

### 12.2 全局诊断

```bash
code-intel doctor
```

输出：

```text
工具版本
数据目录
GitNexus 是否安装
GitNexus registry 是否存在
已注册项目数
全局诊断信息
```

### 12.3 注册项目

```bash
code-intel register trade-service /mnt/g/workSpace/trade-service
```

可选覆盖技术栈：

```bash
code-intel register trade-service /mnt/g/workSpace/trade-service --stack java-spring-mybatis
```

v0.2 可选绑定 GitNexus repo label：

```bash
code-intel register mi-intl-scheme /mnt/g/workSpace/mi-intl-scheme \
  --stack java-spring-mybatis \
  --gitnexus-repo mi-intl-scheme
```

### 12.4 查看项目列表

```bash
code-intel projects
```

### 12.5 建索引

默认不自动执行 GitNexus：

```bash
code-intel index trade-service
```

显式代跑 GitNexus：

```bash
code-intel index trade-service --with-gitnexus
```

### 12.6 检索

```bash
code-intel search trade-service --type route --query "/api/trade/order/detail"
code-intel search trade-service --type error --query "ClientAbortException"
code-intel search trade-service --type table --query "order_item_snapshot"
code-intel search trade-service --type semantic --query "订单详情页打开超时"
```

常用参数：

```text
--limit 10
--include-relations
--json
```

### 12.7 调用链

v0.2 已新增 `trace` 命令，底层调用本地 GitNexus `trace`。

```bash
code-intel trace mi-intl-scheme --from "AService.method" --to "BMapper.selectById" --depth 10 --json
```

如果符号重名或 GitNexus 建议使用 UID，可以传入消歧参数：

```bash
code-intel trace mi-intl-scheme \
  --from "SGPStoreIncentiveImeiConsumer" \
  --to "getStoreIncentiveCommandService" \
  --depth 3 \
  --from-uid "Class:intl-scheme-job/src/main/java/com/xiaomi/intl/scheme/job/consumer/SGPStoreIncentiveImeiConsumer.java:SGPStoreIncentiveImeiConsumer" \
  --to-uid "Method:intl-scheme-job/src/main/java/com/xiaomi/intl/scheme/job/consumer/AbstractStoreIncentiveImeiConsumer.java:AbstractStoreIncentiveImeiConsumer.getStoreIncentiveCommandService#0" \
  --json
```

### 12.8 项目诊断

```bash
code-intel doctor trade-service
```

## 13. MCP 工具

MCP 工具名保持通用，不带线上运维语义。

当前实际注册：

- `code.search`
- `code.locate_route`
- `code.trace_call_chain`
- `code.index_project`

后续目标新增或补全：

- `code.diagnose`：返回 Code Intelligence 与 GitNexus 本地索引健康状态。
- `code.search_error`：错误信号专用入口。
- `code.search_sql`：SQL/表名专用入口。
- `code.register_project`：MCP 侧项目注册，默认仍应禁用或要求显式授权。

### 13.1 code.search

参数：

```ts
{
  project: string
  query: string
  type?: "route" | "error" | "sql" | "table" | "symbol" | "keyword" | "semantic" | "call_chain"
  limit?: number
  include_relations?: boolean
}
```

返回 `SearchResponse`。当前 `include_relations=true` 时会尝试调用 GitNexus `query/context` 扩展定义和关系边。

### 13.2 code.locate_route

参数：

```ts
{
  project: string
  route: string
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  include_downstream?: boolean
  downstream_depth?: number
}
```

返回 `SearchResponse`。当前 `include_downstream=true` 会触发关系增强的最小闭环；完整多跳 downstream 仍是后续增强项。

### 13.3 code.search_error

参数：

```ts
{
  project: string
  error: string
  log_excerpt?: string
  include_references?: boolean
}
```

返回 `SearchResponse`。

### 13.4 code.search_sql

参数：

```ts
{
  project: string
  table?: string
  sql_excerpt?: string
  include_upstream?: boolean
}
```

返回 `SearchResponse`。

### 13.5 code.trace_call_chain

参数：

```ts
{
  project: string
  from: string
  to: string
  from_uid?: string
  from_file?: string
  to_uid?: string
  to_file?: string
  depth?: number
}
```

返回 `SearchResponse`。

当前实现支持 `from` + `to`，底层调用 GitNexus `trace <from> <to>`。当符号有歧义时，可以使用 `from_uid/from_file/to_uid/to_file` 消歧。返回关系来自 GitNexus `hops/edges`，并归一成 `CodeRelation`。

### 13.6 code.diagnose

参数：

```ts
{
  project?: string
}
```

返回：

```ts
{
  status: "ok" | "warning" | "failed"
  data_dir: string
  gitnexus: {
    installed: boolean
    registry_path?: string
    message?: string
  }
  projects: ProjectIndexHealth[]
  diagnostics: Diagnostic[]
}
```

### 13.7 code.register_project

默认禁用。只有 `CODE_INTEL_MCP_ALLOW_INDEX=true` 时允许调用。

参数：

```ts
{
  name: string
  path: string
  stack?: "java-spring-mybatis" | "java-spring" | "java-dubbo-mybatis" | "java-generic"
}
```

### 13.8 code.index_project

默认禁用。只有 `CODE_INTEL_MCP_ALLOW_INDEX=true` 时允许调用。

参数：

```ts
{
  project: string
  with_gitnexus?: boolean
}
```

## 14. 错误处理

工具必须 fail-closed：能返回证据就返回证据，不能返回证据就返回明确诊断，不编造文件、行号、调用链或业务事实。

错误场景：

| 代码 | 行为 |
| --- | --- |
| `PROJECT_NOT_REGISTERED` | 返回注册命令建议 |
| `PROJECT_PATH_NOT_FOUND` | 返回 registry 中的路径并提示重新注册 |
| `INDEX_MISSING` | 返回索引命令建议，可降级 grep |
| `INDEX_STALE` | 允许查询，标注 stale 并降低置信度 |
| `GITNEXUS_UNAVAILABLE` | 使用 Java 专项索引和 grep，调用链能力降级 |
| `GITNEXUS_INDEX_MISSING` | 默认不自动分析，提示 `--with-gitnexus` |
| `SEMANTIC_INDEX_MISSING` | route、error、sql 查询不受阻塞，semantic 查询降级 |
| `LOW_CONFIDENCE` | 返回候选，但说明未形成高置信定位 |

## 15. 权限与安全

默认策略：

- CLI 允许注册和索引。
- MCP 默认只读，只允许查询和诊断。
- MCP 注册和索引必须显式配置 `CODE_INTEL_MCP_ALLOW_INDEX=true`。

路径规则：

- 注册路径必须是本地存在目录。
- 排除 `.git`、`target`、`build`、`node_modules`、`dist`、日志目录和临时目录。
- 不把敏感文件内容写入 semantic-lite。
- 返回代码片段行数必须有限制。

敏感文件排除：

```text
.env
*.pem
*.key
*.crt
application-prod.*
bootstrap-prod.*
secret.*
credentials.*
```

可以识别这些文件存在，但不索引敏感内容，也不返回密钥值。

## 16. 日志与诊断

日志默认放在：

```text
~/.code-intelligence/logs/
```

索引日志记录：

- project。
- started_at。
- finished_at。
- duration。
- indexed_commit。
- dirty_flag。
- generated_files。
- warnings。
- errors。

查询日志记录：

- request_id。
- project。
- query_type。
- query_text 的截断值或哈希。
- index_status。
- sources_used。
- result_count。
- diagnostics。

日志不记录完整敏感代码片段。

## 17. 文档交付物

第一版必须交付以下文档。

### 17.1 README.md

面向第一次接触工具的用户，说明：

- 这个工具是什么。
- 解决什么问题。
- 不解决什么问题。
- 快速开始。
- 推荐使用流程。
- 与 GitNexus 的关系。

### 17.2 docs/user-guide.zh-CN.md

面向日常使用者，说明：

- 如何注册项目。
- 如何索引项目。
- 如何用 CLI 搜索代码。
- 如何让 Agent 通过 MCP 调用。
- 如何处理 missing、stale、partial、failed。
- 如何查看数据目录。
- 如何重建索引。

### 17.3 docs/features.zh-CN.md

面向能力理解和选型，说明：

- 支持的 Java 场景。
- 接口/路由定位能力。
- 异常/日志定位能力。
- SQL/表名定位能力。
- 调用链摘要能力。
- 轻量语义召回能力。
- GitNexus、Java 专项索引、semantic-lite、grep 的分工。
- 第一版限制。
- 后续路线。

### 17.4 docs/integration-guide.zh-CN.md

面向其他 Skill、MCP、Agent 工具开发者，说明：

- MCP 工具清单。
- CLI JSON 输出。
- `SearchResponse` schema。
- `CodeLocation`、`CodeRelation`、`EvidenceRef`、`Diagnostic` 的语义。
- 如何适配到线上运维 Skill。
- 如何适配到流程图工具。
- 错误和诊断字段处理建议。

## 18. 上层工具接入建议

### 18.1 online-troubleshoot Skill

线上运维 Skill 在第 3 步代码定位时调用：

```text
有接口路径：
  code.locate_route(project, route, include_downstream=true)

有异常或日志：
  code.search_error(project, error, log_excerpt)

有 SQL 或表名：
  code.search_sql(project, table/sql_excerpt, include_upstream=true)

只有业务描述：
  code.search(project, query, type=semantic, include_relations=true)
```

然后由线上运维 Skill 自己把 `SearchResponse` 适配成内部 `CodeMatch[]`、证据和 `restricted_info`。

### 18.2 未来流程图工具

流程图工具调用：

```text
code.locate_route
code.trace_call_chain
code.search_sql
code.search
```

映射关系：

```text
CodeLocation -> 流程图节点
CodeRelation -> 流程图边
EvidenceRef -> 节点证据引用
Diagnostic -> 图生成警告
```

底座不生成最终 PRD，也不替代流程图工具的业务表达层。

## 19. 测试与验收

第一版需要一个最小 Java fixture 项目，包含：

- `OrderController`
- `OrderDetailService`
- `ReportService.buildReportData`
- `OrderMapper.java`
- `OrderMapper.xml`
- `OrderStatusEnum`
- `BusinessException`
- `application.yml`

黄金查询：

```text
/api/trade/order/detail
ClientAbortException
Broken pipe
ORDER_STATUS_INVALID
order_item_snapshot
订单详情页打开超时
OrderDetailService.detail
```

测试分层：

- 单元测试：技术栈探测、路由注解解析、Mapper XML 表名解析、错误码提取、query_type 识别、置信度计算、stale 判断。
- 集成测试：注册 fixture、索引 fixture、route/error/table/semantic/call_chain 查询。
- MCP 测试：工具参数校验、返回模型、只读权限控制。
- CLI 测试：where、doctor、register、projects、index、search、trace。

验收标准：

- route 查询必须定位 Controller，且高置信。
- table 查询必须定位 Mapper XML 和 Mapper 方法。
- error 查询必须定位错误码、异常或日志语句候选。
- semantic 查询至少返回相关 Controller 或 Service；没有结构证据确认时，置信度不超过 medium。
- GitNexus 不可用时，工具不失败，返回 diagnostics 并降级 grep。
- 索引 stale 时，结果必须标注 stale。
- MCP 默认不可执行注册和索引。
- README、用户指南、功能介绍、接入指南四类文档齐备。

## 20. 后续演进

第一版完成后，可按需求演进：

- 跨项目调用链。
- 更完整 RAG 问答。
- 业务流程图生成工具。
- 新人项目问答工具。
- Web UI。
- 常驻 HTTP 服务。
- 增量索引。
- 团队共享配置。
- 更强 Java AST 解析。
- 与 trace 平台、日志平台、数据库工具的更紧密证据关联。

这些能力不进入第一版范围。
