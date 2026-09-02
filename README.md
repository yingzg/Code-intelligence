# Code Intelligence

Code Intelligence 是一个本地 Java 代码检索与代码理解底座，用于被 Skill、MCP Server、Agent、CLI 和后续流程图工具调用。它面向已经克隆到本地的服务项目，提供项目注册、索引生成、结构化检索、轻量语义召回和增强 grep 兜底。

## 快速开始

```bash
bun install
npm run build
node packages/cli/dist/index.js register trade-service /mnt/g/workSpace/trade-service
node packages/cli/dist/index.js index trade-service --with-gitnexus
node packages/cli/dist/index.js search trade-service --type route --query "/api/trade/order/detail" --json
```

如果不需要 GitNexus 调用链增强，可以先执行：

```bash
node packages/cli/dist/index.js index trade-service
```

此时 Java 专项索引、错误索引、SQL 索引、semantic-lite 和 grep 兜底仍然可用。

## CLI

构建后可通过 Node 直接运行：

```bash
node packages/cli/dist/index.js where
node packages/cli/dist/index.js register trade-service /mnt/g/workSpace/trade-service --stack java-spring-mybatis
node packages/cli/dist/index.js index trade-service
node packages/cli/dist/index.js search trade-service --type error --query "ORDER_STATUS_INVALID" --json
```

数据默认写入：

```text
~/.code-intelligence
```

可以通过环境变量改写：

```bash
CODE_INTEL_HOME=/tmp/code-intel node packages/cli/dist/index.js where
```

## MCP Server

构建后可通过 stdio 启动：

```bash
node packages/mcp/dist/server.js
```

当前已实现的 MCP 工具：

- `code.search`：通用代码检索入口。
- `code.locate_route`：按接口路径和可选 HTTP method 定位 Java 入口。
- `code.index_project`：显式索引本地项目，默认禁用，需要 `CODE_INTEL_MCP_ALLOW_INDEX=true`。

## 与 GitNexus 的关系

GitNexus 负责结构化代码图谱和更强的调用链能力。本工具负责：

- 本地项目注册和数据目录管理。
- Java 专项索引，包括 Spring 路由、MyBatis SQL、异常、错误码和日志。
- `semantic-lite` 轻量语义召回。
- 增强 grep 兜底。
- 统一 `SearchResponse` 输出模型。

GitNexus 不可用时，本工具会降级运行，不会阻断本地 Java 索引生成。

## 第一版限制

- 不支持 GitLab 远程仓库索引，只索引本地已克隆目录。
- 不做跨项目调用链。
- 不做完整 RAG 问答。
- 不直接输出线上排障根因，只提供代码证据、诊断和候选位置。
- MCP 当前只实现 `code.search`、`code.locate_route`、`code.index_project`，其他工具属于规划能力。

## 验证

```bash
npm run typecheck
npm run test -- packages
```
