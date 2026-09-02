# 接入指南

本文面向线上运维 Skill、流程图工具、其他 Agent 和 MCP 客户端，说明如何接入 Code Intelligence。

## CLI 接入

CLI 适合本地脚本、一次性调试和人工验证。

```bash
code-intel register trade-service /mnt/g/workSpace/trade-service --stack java-spring-mybatis
code-intel index trade-service
code-intel search trade-service --type error --query "ORDER_STATUS_INVALID" --json
```

CLI 输出完整 `SearchResponse` JSON。接入方应保留并解析 `diagnostics`，不要只读取 `locations`。

## MCP 工具

当前实际可用 MCP 工具：

- `code.search`
- `code.locate_route`
- `code.index_project`

### code.search

通用代码检索入口。

输入：

```json
{
  "project": "trade-service",
  "query": "ORDER_STATUS_INVALID",
  "type": "error",
  "limit": 10
}
```

`type` 可选。支持：

- `route`
- `error`
- `sql`
- `table`
- `symbol`
- `keyword`
- `semantic`
- `call_chain`

### code.locate_route

按接口路径定位 Java 入口。

输入：

```json
{
  "project": "trade-service",
  "method": "GET",
  "route": "/api/trade/order/detail"
}
```

如果传入 `method`，工具会按 HTTP method 过滤，避免 `POST` 误命中 `GET` handler。

### code.index_project

显式索引本地项目。

默认禁用，需要启动 MCP Server 时设置：

```bash
CODE_INTEL_MCP_ALLOW_INDEX=true node packages/mcp/dist/server.js
```

输入：

```json
{
  "project": "trade-service",
  "with_gitnexus": false
}
```

禁用时会返回错误诊断，message 会说明需要设置 `CODE_INTEL_MCP_ALLOW_INDEX=true`。

## 规划 MCP 工具

以下是设计文档中的规划工具，当前第一版尚未注册：

- `code.search_error`
- `code.search_sql`
- `code.trace_call_chain`
- `code.diagnose`
- `code.register_project`

接入方当前应统一使用 `code.search` 加 `type` 参数替代专用工具。

## 输出模型

上层工具只依赖以下模型：

- `SearchResponse`
- `CodeLocation`
- `CodeRelation`
- `EvidenceRef`
- `Diagnostic`

核心字段：

- `locations[].file`
- `locations[].start_line`
- `locations[].snippet`
- `locations[].confidence`
- `locations[].source`
- `diagnostics[].code`
- `diagnostics[].message`

## 线上运维 Skill 适配

线上运维 Skill 应把日志、错误码、异常名、接口路径、SQL 表名转换成 `code.search` 查询。

建议映射：

- 日志中的异常名：`type=error`
- 日志中的错误码：`type=error`
- 请求路径：`type=route`
- 慢 SQL 表名：`type=table`
- 模糊业务描述：`type=semantic`

线上运维 Skill 应把 `SearchResponse.locations` 转换成自己的代码证据，把 `diagnostics` 转换成 `restricted_info` 或 warning。

注意：Code Intelligence 不直接输出线上根因。它提供的是代码定位、证据和诊断，根因判断仍由上层排障工具结合日志、链路、指标和数据库状态完成。

## 流程图工具适配

流程图工具应把：

- `CodeLocation` 转换成节点。
- `CodeRelation` 转换成边。
- `EvidenceRef` 转换成节点证据。
- `Diagnostic` 转换成图生成备注或低置信提示。

第一版 `relations` 通常为空。流程图工具可以先基于 `locations`、文件路径、symbol 和 snippet 生成局部流程图，后续再接入 GitNexus 调用链。

## 索引状态处理

接入方必须处理 `index_status.state`：

- `ready`：可以正常消费。
- `missing`：提示用户先执行索引，或在 MCP 权限允许时调用 `code.index_project`。
- `stale`：结果可用但置信度会降低，建议重新索引。
- `partial`：部分索引缺失或 GitNexus 降级，应展示 warning。
- `failed`：当前第一版较少返回，预留给后续 per-indexer 容错。

## 关系能力说明

`include_relations` 和 `include_downstream` 是为后续调用链能力保留的参数。当前第一版通常返回：

```json
{
  "relations": []
}
```

接入方不能把空 `relations` 理解为“确认没有调用关系”，只能理解为“当前没有可用关系证据”。
