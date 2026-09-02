# 功能介绍

Code Intelligence 的定位是本地代码检索与代码理解底座，不是单一线上排障工具。它面向 CLI、MCP、Skill、Agent 和未来流程图工具提供统一代码证据。

## 支持能力

- 接口和路由定位：索引 Spring `@RequestMapping`、`@GetMapping`、`@PostMapping` 等入口。
- 异常、错误码和日志文本定位：索引异常类、`throw`、`catch`、错误码声明、`log.error`、`log.warn`。
- SQL 和表名定位：索引 MyBatis XML 和注解 SQL，提取表名、mapper namespace、mapper id。
- 轻量语义召回：基于文件名、类名、方法名、中文注释、配置 key、SQL 和业务词做本地 token 检索。
- 增强 grep 兜底：结构化索引未命中或索引缺失时扫描源码和配置文件。
- 基础调用链摘要：第一版保留 `relations` 输出字段，但通常为空；深度调用链依赖后续 GitNexus 集成增强。
- 通用证据模型：统一输出 `SearchResponse`、`CodeLocation`、`CodeRelation`、`EvidenceRef` 和 `Diagnostic`。

## 检索来源

- `java_index`：本工具 Java 专项索引，包括路由、SQL、异常、错误码和日志。
- `gitnexus`：GitNexus 结构化代码图谱。当前第一版只检查/触发 GitNexus 分析，深度读取能力留给后续。
- `semantic_lite`：轻量语义召回，不依赖向量库，不需要 HTTP 服务。
- `grep`：增强 grep 兜底。

## 查询类型

当前支持：

- `route`
- `error`
- `sql`
- `table`
- `symbol`
- `keyword`
- `semantic`
- `call_chain`

`call_chain` 当前保留为规划类型，第一版不会生成深度调用链。

## 索引产物

每个项目的数据目录位于：

```text
<CODE_INTEL_HOME>/projects/<project-name>
```

主要文件：

- `manifest.json`
- `java-route-map.jsonl`
- `java-sql-map.jsonl`
- `error-map.jsonl`
- `semantic-lite.jsonl`

## 当前 MCP 工具

第一版实际可用：

- `code.search`
- `code.locate_route`
- `code.index_project`

以下属于规划能力，当前尚未注册为 MCP tool：

- `code.search_error`
- `code.search_sql`
- `code.trace_call_chain`
- `code.diagnose`
- `code.register_project`

需要这些能力时，请先通过 `code.search` 搭配 `type` 参数完成，例如：

```json
{
  "project": "trade-service",
  "type": "error",
  "query": "ORDER_STATUS_INVALID"
}
```

## 第一版边界

- 不索引远程 GitLab，只处理本地目录。
- 不直接给出线上故障根因。
- 不替代业务 Agent，只提供代码证据和诊断。
- 不启动常驻 HTTP 服务。
- 不依赖向量数据库。
