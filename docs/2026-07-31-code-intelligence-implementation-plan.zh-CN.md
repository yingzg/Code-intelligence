# 本地 Java 代码检索与代码理解底座实现计划

> **给 Agent 执行者：** 必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行。任务使用复选框语法跟踪进度。

**目标：** 从零实现一个本地 Java 代码检索与代码理解底座，提供 CLI 与 MCP 双入口，支持本地项目注册、索引、接口/异常/SQL/语义检索、基础调用链摘要和通用证据输出。

**架构：** 采用 TypeScript monorepo。`packages/core` 承载全部核心能力，`packages/cli` 和 `packages/mcp` 只做入口适配；第一版不要求 HTTP 服务。GitNexus 作为结构化代码图谱主索引，本工具维护 Java 专项索引、semantic-lite、项目注册与统一输出模型。

**技术栈：** Node.js 22+、TypeScript、Vitest、Zod、Commander、@modelcontextprotocol/server、fast-glob。

---

## 文件结构

```text
/mnt/g/my-Skill/Code-intelligence/
├── README.md
├── package.json
├── tsconfig.base.json
├── vitest.config.ts
├── docs/
│   ├── 2026-07-31-code-intelligence-design.zh-CN.md
│   ├── 2026-07-31-code-intelligence-implementation-plan.zh-CN.md
│   ├── user-guide.zh-CN.md
│   ├── features.zh-CN.md
│   └── integration-guide.zh-CN.md
├── fixtures/
│   └── java-order-service/
│       ├── pom.xml
│       └── src/main/
│           ├── java/com/example/trade/
│           │   ├── web/OrderController.java
│           │   ├── service/OrderDetailService.java
│           │   ├── service/ReportService.java
│           │   ├── mapper/OrderMapper.java
│           │   ├── enums/OrderStatusEnum.java
│           │   └── exception/BusinessException.java
│           └── resources/
│               ├── mapper/OrderMapper.xml
│               └── application.yml
└── packages/
    ├── core/
    │   ├── package.json
    │   ├── src/
    │   │   ├── index.ts
    │   │   ├── schemas.ts
    │   │   ├── paths.ts
    │   │   ├── fs-utils.ts
    │   │   ├── registry.ts
    │   │   ├── stack-detector.ts
    │   │   ├── git.ts
    │   │   ├── gitnexus.ts
    │   │   ├── snippet.ts
    │   │   ├── indexer/
    │   │   │   ├── index-project.ts
    │   │   │   ├── route-indexer.ts
    │   │   │   ├── sql-indexer.ts
    │   │   │   ├── error-indexer.ts
    │   │   │   └── semantic-lite-indexer.ts
    │   │   ├── search/
    │   │   │   ├── query-classifier.ts
    │   │   │   ├── grep-searcher.ts
    │   │   │   ├── search-router.ts
    │   │   │   ├── confidence.ts
    │   │   │   └── call-chain.ts
    │   │   └── diagnostics.ts
    │   └── tests/
    │       ├── registry.test.ts
    │       ├── stack-detector.test.ts
    │       ├── route-indexer.test.ts
    │       ├── sql-indexer.test.ts
    │       ├── error-indexer.test.ts
    │       ├── semantic-lite.test.ts
    │       ├── search-router.test.ts
    │       └── freshness.test.ts
    ├── cli/
    │   ├── package.json
    │   ├── src/index.ts
    │   └── tests/cli.test.ts
    └── mcp/
        ├── package.json
        ├── src/server.ts
        └── tests/mcp-tools.test.ts
```

## 任务 1：创建 TypeScript 工作区骨架

**文件：**

- 创建：`package.json`
- 创建：`tsconfig.base.json`
- 创建：`vitest.config.ts`
- 创建：`packages/core/package.json`
- 创建：`packages/cli/package.json`
- 创建：`packages/mcp/package.json`

- [ ] **步骤 1：写根 `package.json`**

```json
{
  "name": "code-intelligence",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "tsc -b packages/core packages/cli packages/mcp",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b packages/core packages/cli packages/mcp",
    "lint": "tsc -b packages/core packages/cli packages/mcp --pretty false"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **步骤 2：写 TypeScript 基础配置**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist"
  }
}
```

- [ ] **步骤 3：写 Vitest 配置**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    globals: false
  }
});
```

- [ ] **步骤 4：写三个 package 配置**

`packages/core/package.json`：

```json
{
  "name": "@code-intelligence/core",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b tsconfig.json"
  },
  "dependencies": {
    "fast-glob": "^3.3.2",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

`packages/cli/package.json`：

```json
{
  "name": "@code-intelligence/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "code-intel": "dist/index.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b tsconfig.json"
  },
  "dependencies": {
    "@code-intelligence/core": "workspace:*",
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

`packages/mcp/package.json`：

```json
{
  "name": "@code-intelligence/mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "code-intelligence-mcp": "dist/server.js"
  },
  "exports": {
    ".": {
      "types": "./dist/server.d.ts",
      "default": "./dist/server.js"
    }
  },
  "scripts": {
    "build": "tsc -b tsconfig.json"
  },
  "dependencies": {
    "@code-intelligence/core": "workspace:*",
    "@modelcontextprotocol/server": "^2.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

- [ ] **步骤 5：为每个 package 写 `tsconfig.json`**

`packages/core/tsconfig.json` 不需要项目引用：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true
  },
  "include": ["src/**/*.ts"]
}
```

`packages/cli/tsconfig.json` 和 `packages/mcp/tsconfig.json` 必须引用 `core`，用于配合根目录的 `tsc -b packages/core packages/cli packages/mcp` project references 构建：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }]
}
```

- [ ] **步骤 6：运行安装与类型检查**

运行：

```bash
npm install
npm run typecheck
```

预期：第一次 `npm install` 成功；Task 1 应创建最小 `src` 入口文件，确保 `typecheck` 不会因为没有输入文件而失败。

## 任务 2：定义通用 schema 与导出入口

**文件：**

- 创建：`packages/core/src/schemas.ts`
- 创建：`packages/core/src/index.ts`
- 测试：`packages/core/tests/schemas.test.ts`

- [ ] **步骤 1：写 schema 测试**

```ts
import { describe, expect, it } from "vitest";
import { SearchResponseSchema } from "../src/schemas.js";

describe("SearchResponseSchema", () => {
  it("accepts a valid generic code search response", () => {
    const parsed = SearchResponseSchema.parse({
      request_id: "req-1",
      project: {
        name: "trade-service",
        path: "/repo/trade-service",
        stack: "java-spring-mybatis",
        dirty: false
      },
      query: { type: "route", text: "/api/trade/order/detail" },
      index_status: { state: "ready" },
      summary: "命中订单详情接口入口。",
      locations: [
        {
          id: "loc-1",
          project: "trade-service",
          file: "src/main/java/com/example/trade/web/OrderController.java",
          start_line: 17,
          end_line: 20,
          symbol: "OrderController.detail",
          language: "java",
          location_type: "controller",
          snippet: "@GetMapping(\"/detail\")",
          match_reason: "接口路径精确匹配。",
          score: 0.98,
          confidence: "high",
          source: "java_index"
        }
      ],
      relations: [],
      diagnostics: []
    });

    expect(parsed.locations[0].confidence).toBe("high");
  });
});
```

- [ ] **步骤 2：运行失败测试**

运行：

```bash
npx vitest run packages/core/tests/schemas.test.ts
```

预期：失败，提示找不到 `../src/schemas.js`。

- [ ] **步骤 3：实现 `schemas.ts`**

```ts
import { z } from "zod";

export const StackSchema = z.enum([
  "java-spring-mybatis",
  "java-spring",
  "java-dubbo-mybatis",
  "java-generic"
]);

export const QueryTypeSchema = z.enum([
  "route",
  "error",
  "sql",
  "table",
  "symbol",
  "keyword",
  "semantic",
  "call_chain"
]);

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export const IndexStateSchema = z.enum(["ready", "missing", "stale", "partial", "failed"]);
export const SourceSchema = z.enum(["java_index", "gitnexus", "grep", "semantic_lite"]);

export const ProjectRefSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  stack: StackSchema,
  commit_hash: z.string().optional(),
  dirty: z.boolean()
});

export const QueryRefSchema = z.object({
  type: QueryTypeSchema,
  text: z.string().min(1),
  hints: z
    .object({
      class_name: z.string().optional(),
      method_name: z.string().optional(),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
      trace_source: z.string().optional()
    })
    .optional()
});

export const IndexStatusSchema = z.object({
  state: IndexStateSchema,
  indexed_at: z.string().optional(),
  indexed_commit: z.string().optional(),
  current_commit: z.string().optional(),
  message: z.string().optional(),
  suggested_command: z.string().optional()
});

export const CodeLocationSchema = z.object({
  id: z.string().min(1),
  project: z.string().min(1),
  file: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  symbol: z.string().optional(),
  language: z.enum(["java", "xml", "properties", "yaml", "sql", "unknown"]),
  location_type: z.enum([
    "route",
    "controller",
    "service",
    "dubbo_interface",
    "dubbo_provider",
    "mapper",
    "sql",
    "config",
    "constant",
    "enum",
    "exception",
    "log_statement",
    "test",
    "unknown"
  ]),
  snippet: z.string(),
  match_reason: z.string(),
  score: z.number().min(0).max(1),
  confidence: ConfidenceSchema,
  source: SourceSchema
});

export const EvidenceRefSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  snippet: z.string(),
  source: SourceSchema,
  extracted_by: z.string().min(1)
});

export const CodeRelationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relation_type: z.enum([
    "calls",
    "implements",
    "maps_to_sql",
    "handles_route",
    "throws",
    "logs",
    "reads_config",
    "uses_table"
  ]),
  confidence: ConfidenceSchema,
  evidence: z.array(EvidenceRefSchema)
});

export const DiagnosticSchema = z.object({
  level: z.enum(["info", "warning", "error"]),
  code: z.enum([
    "PROJECT_NOT_REGISTERED",
    "PROJECT_PATH_NOT_FOUND",
    "INDEX_MISSING",
    "INDEX_STALE",
    "GITNEXUS_UNAVAILABLE",
    "GITNEXUS_INDEX_MISSING",
    "SEMANTIC_INDEX_MISSING",
    "GREP_FALLBACK_USED",
    "LOW_CONFIDENCE"
  ]),
  message: z.string(),
  suggested_action: z.string().optional()
});

export const SearchResponseSchema = z.object({
  request_id: z.string().min(1),
  project: ProjectRefSchema,
  query: QueryRefSchema,
  index_status: IndexStatusSchema,
  summary: z.string(),
  locations: z.array(CodeLocationSchema),
  relations: z.array(CodeRelationSchema),
  diagnostics: z.array(DiagnosticSchema)
});

export type Stack = z.infer<typeof StackSchema>;
export type QueryType = z.infer<typeof QueryTypeSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type CodeLocation = z.infer<typeof CodeLocationSchema>;
export type CodeRelation = z.infer<typeof CodeRelationSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
```

- [ ] **步骤 4：实现导出入口**

```ts
export * from "./schemas.js";
```

- [ ] **步骤 5：运行测试**

运行：

```bash
npx vitest run packages/core/tests/schemas.test.ts
```

预期：通过。

## 任务 3：实现数据目录、文件工具和项目注册

**文件：**

- 创建：`packages/core/src/paths.ts`
- 创建：`packages/core/src/fs-utils.ts`
- 创建：`packages/core/src/registry.ts`
- 测试：`packages/core/tests/registry.test.ts`

- [ ] **步骤 1：写注册测试**

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectRegistry } from "../src/registry.js";

describe("project registry", () => {
  it("registers and reads a local Java project", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const repo = await mkdtemp(join(tmpdir(), "repo-"));

    try {
      const registry = createProjectRegistry({ home });
      const project = await registry.register({
        name: "trade-service",
        path: repo,
        stack: "java-generic"
      });

      expect(project.name).toBe("trade-service");
      expect(project.path).toBe(repo);
      await expect(registry.get("trade-service")).resolves.toMatchObject({
        name: "trade-service",
        path: repo
      });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行失败测试**

运行：

```bash
npx vitest run packages/core/tests/registry.test.ts
```

预期：失败，提示找不到 `registry.js`。

- [ ] **步骤 3：实现路径工具**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export type CodeIntelPaths = {
  home: string;
  registryFile: string;
  configFile: string;
  projectsDir: string;
  logsDir: string;
};

export function resolveCodeIntelHome(env = process.env): string {
  return env.CODE_INTEL_HOME && env.CODE_INTEL_HOME.trim().length > 0
    ? env.CODE_INTEL_HOME
    : join(homedir(), ".code-intelligence");
}

export function getCodeIntelPaths(home = resolveCodeIntelHome()): CodeIntelPaths {
  return {
    home,
    registryFile: join(home, "registry.json"),
    configFile: join(home, "config.json"),
    projectsDir: join(home, "projects"),
    logsDir: join(home, "logs")
  };
}

export function projectDataDir(home: string, projectName: string): string {
  return join(home, "projects", encodeURIComponent(projectName));
}
```

- [ ] **步骤 4：实现文件工具**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
```

- [ ] **步骤 5：实现 registry**

```ts
import { access, stat } from "node:fs/promises";
import { getCodeIntelPaths, projectDataDir } from "./paths.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs-utils.js";
import type { Stack } from "./schemas.js";

export type RegisteredProject = {
  name: string;
  path: string;
  stack: Stack;
  created_at: string;
  updated_at: string;
};

export type RegisterProjectInput = {
  name: string;
  path: string;
  stack: Stack;
};

type RegistryFile = {
  projects: RegisteredProject[];
};

export function createProjectRegistry(options: { home?: string } = {}) {
  const paths = getCodeIntelPaths(options.home);

  async function readRegistry(): Promise<RegistryFile> {
    return readJsonFile(paths.registryFile, { projects: [] });
  }

  async function writeRegistry(registry: RegistryFile): Promise<void> {
    await ensureDir(paths.home);
    await ensureDir(paths.projectsDir);
    await ensureDir(paths.logsDir);
    await writeJsonFile(paths.registryFile, registry);
  }

  return {
    async register(input: RegisterProjectInput): Promise<RegisteredProject> {
      if (!input.name.trim()) throw new Error("项目名不能为空");
      const statResult = await stat(input.path);
      if (!statResult.isDirectory()) throw new Error(`项目路径不是目录：${input.path}`);

      const registry = await readRegistry();
      const now = new Date().toISOString();
      const existing = registry.projects.find((project) => project.name === input.name);
      const project: RegisteredProject = {
        name: input.name,
        path: input.path,
        stack: input.stack,
        created_at: existing?.created_at ?? now,
        updated_at: now
      };
      registry.projects = registry.projects.filter((item) => item.name !== input.name).concat(project);
      await writeRegistry(registry);
      await ensureDir(projectDataDir(paths.home, input.name));
      return project;
    },

    async get(name: string): Promise<RegisteredProject | undefined> {
      const registry = await readRegistry();
      return registry.projects.find((project) => project.name === name);
    },

    async list(): Promise<RegisteredProject[]> {
      const registry = await readRegistry();
      return registry.projects;
    },

    async exists(name: string): Promise<boolean> {
      const project = await this.get(name);
      if (!project) return false;
      try {
        await access(project.path);
        return true;
      } catch {
        return false;
      }
    }
  };
}
```

- [ ] **步骤 6：补充导出并运行测试**

在 `packages/core/src/index.ts` 增加：

```ts
export * from "./paths.js";
export * from "./registry.js";
```

运行：

```bash
npx vitest run packages/core/tests/registry.test.ts
```

预期：通过。

## 任务 4：创建 Java fixture 项目

**文件：**

- 创建：`fixtures/java-order-service/pom.xml`
- 创建：`fixtures/java-order-service/src/main/java/com/example/trade/web/OrderController.java`
- 创建：`fixtures/java-order-service/src/main/java/com/example/trade/service/OrderDetailService.java`
- 创建：`fixtures/java-order-service/src/main/java/com/example/trade/service/ReportService.java`
- 创建：`fixtures/java-order-service/src/main/java/com/example/trade/mapper/OrderMapper.java`
- 创建：`fixtures/java-order-service/src/main/java/com/example/trade/enums/OrderStatusEnum.java`
- 创建：`fixtures/java-order-service/src/main/java/com/example/trade/exception/BusinessException.java`
- 创建：`fixtures/java-order-service/src/main/resources/mapper/OrderMapper.xml`
- 创建：`fixtures/java-order-service/src/main/resources/application.yml`

- [ ] **步骤 1：写 fixture 文件**

`OrderController.java`：

```java
package com.example.trade.web;

import com.example.trade.service.OrderDetailService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/trade/order")
public class OrderController {
    private final OrderDetailService orderDetailService;

    public OrderController(OrderDetailService orderDetailService) {
        this.orderDetailService = orderDetailService;
    }

    @GetMapping("/detail")
    public String detail(@RequestParam String orderId) {
        return orderDetailService.detail(orderId);
    }
}
```

`OrderDetailService.java`：

```java
package com.example.trade.service;

import com.example.trade.exception.BusinessException;
import com.example.trade.mapper.OrderMapper;
import org.springframework.stereotype.Service;

@Service
public class OrderDetailService {
    private final OrderMapper orderMapper;
    private final ReportService reportService;

    public OrderDetailService(OrderMapper orderMapper, ReportService reportService) {
        this.orderMapper = orderMapper;
        this.reportService = reportService;
    }

    public String detail(String orderId) {
        int itemCount = orderMapper.countSnapshotItems(orderId);
        if (itemCount < 0) {
            throw new BusinessException("ORDER_STATUS_INVALID", "订单状态非法");
        }
        return reportService.buildReportData(orderId);
    }
}
```

`ReportService.java`：

```java
package com.example.trade.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class ReportService {
    private static final Logger log = LoggerFactory.getLogger(ReportService.class);

    public String buildReportData(String orderId) {
        log.error("detail failed, orderId={}", orderId, new RuntimeException("ClientAbortException: Broken pipe"));
        return "report:" + orderId;
    }
}
```

`OrderMapper.java`：

```java
package com.example.trade.mapper;

import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface OrderMapper {
    int countSnapshotItems(String orderId);
}
```

`OrderStatusEnum.java`：

```java
package com.example.trade.enums;

public enum OrderStatusEnum {
    ORDER_STATUS_INVALID("ORDER_STATUS_INVALID", "订单状态非法");

    private final String code;
    private final String message;

    OrderStatusEnum(String code, String message) {
        this.code = code;
        this.message = message;
    }
}
```

`BusinessException.java`：

```java
package com.example.trade.exception;

public class BusinessException extends RuntimeException {
    private final String code;

    public BusinessException(String code, String message) {
        super(message);
        this.code = code;
    }
}
```

`OrderMapper.xml`：

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.trade.mapper.OrderMapper">
  <select id="countSnapshotItems" resultType="int">
    select count(*)
    from order_item_snapshot
    where order_id = #{orderId}
  </select>
</mapper>
```

`application.yml`：

```yaml
server:
  port: 8080
spring:
  application:
    name: trade-service
```

`pom.xml`：

```xml
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>java-order-service</artifactId>
  <version>1.0.0</version>
</project>
```

- [ ] **步骤 2：确认 fixture 文件存在**

运行：

```bash
find fixtures/java-order-service -type f | sort
```

预期：列出本任务创建的 9 个文件。

## 任务 5：实现技术栈探测

**文件：**

- 创建：`packages/core/src/stack-detector.ts`
- 测试：`packages/core/tests/stack-detector.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectStack } from "../src/stack-detector.js";

describe("detectStack", () => {
  it("detects java-spring-mybatis for the fixture project", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");
    await expect(detectStack(root)).resolves.toBe("java-spring-mybatis");
  });
});
```

- [ ] **步骤 2：实现探测器**

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
import type { Stack } from "./schemas.js";

async function containsAny(root: string, patterns: string[], tokens: string[]): Promise<boolean> {
  const files = await fg(patterns, { cwd: root, absolute: true, ignore: ["**/target/**", "**/build/**"] });
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (tokens.some((token) => text.includes(token))) return true;
  }
  return false;
}

export async function detectStack(root: string): Promise<Stack> {
  const files = await fg(["pom.xml", "build.gradle", "src/main/java/**/*.java", "src/main/resources/**/*.xml"], {
    cwd: root
  });
  const isJava = files.some((file) => file === "pom.xml" || file.endsWith(".java"));
  if (!isJava) return "java-generic";

  const hasSpring = await containsAny(root, ["src/main/java/**/*.java"], [
    "@RestController",
    "@Controller",
    "@RequestMapping",
    "@GetMapping",
    "@PostMapping"
  ]);
  const hasMyBatis = await containsAny(root, ["src/main/java/**/*.java", "src/main/resources/**/*.xml", "pom.xml"], [
    "@Mapper",
    "<mapper",
    "mybatis"
  ]);
  const hasDubbo = await containsAny(root, ["src/main/java/**/*.java", "src/main/resources/**/*.xml", "pom.xml"], [
    "org.apache.dubbo",
    "@DubboService",
    "@DubboReference",
    "<dubbo:"
  ]);

  if (hasDubbo && hasMyBatis) return "java-dubbo-mybatis";
  if (hasSpring && hasMyBatis) return "java-spring-mybatis";
  if (hasSpring) return "java-spring";
  return "java-generic";
}
```

- [ ] **步骤 3：导出并测试**

`packages/core/src/index.ts` 增加：

```ts
export * from "./stack-detector.js";
```

运行：

```bash
npx vitest run packages/core/tests/stack-detector.test.ts
```

预期：通过。

## 任务 6：实现 Java 路由索引器

**文件：**

- 创建：`packages/core/src/indexer/route-indexer.ts`
- 创建：`packages/core/src/snippet.ts`
- 测试：`packages/core/tests/route-indexer.test.ts`

- [ ] **步骤 1：写路由索引测试**

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRouteIndex } from "../src/indexer/route-indexer.js";

describe("buildRouteIndex", () => {
  it("indexes Spring route mappings with class and method prefixes", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");
    const routes = await buildRouteIndex({ project: "trade-service", root });

    expect(routes).toContainEqual(
      expect.objectContaining({
        route: "/api/trade/order/detail",
        http_method: "GET",
        symbol: "OrderController.detail",
        location_type: "controller"
      })
    );
  });
});
```

- [ ] **步骤 2：实现代码片段工具**

```ts
import { readFile } from "node:fs/promises";

export async function readSnippet(file: string, line: number, radius = 2): Promise<string> {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start - 1, end).join("\n");
}
```

- [ ] **步骤 3：实现路由索引器**

```ts
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import fg from "fast-glob";
import { readSnippet } from "../snippet.js";

export type RouteIndexEntry = {
  id: string;
  project: string;
  file: string;
  line: number;
  route: string;
  http_method?: string;
  symbol: string;
  location_type: "controller" | "route" | "dubbo_interface" | "dubbo_provider";
  snippet: string;
};

function extractAnnotationPath(annotation: string): string | undefined {
  const match = annotation.match(/\(\s*(?:value\s*=\s*)?"([^"]+)"/);
  return match?.[1];
}

function normalizeRoute(left: string, right: string): string {
  const joined = `${left.replace(/\/$/, "")}/${right.replace(/^\//, "")}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

export async function buildRouteIndex(input: { project: string; root: string }): Promise<RouteIndexEntry[]> {
  const files = await fg(["src/main/java/**/*.java"], { cwd: input.root, absolute: true });
  const entries: RouteIndexEntry[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (!text.includes("@RequestMapping") && !text.includes("@GetMapping") && !text.includes("@PostMapping")) continue;

    const className = text.match(/class\s+(\w+)/)?.[1] ?? "UnknownClass";
    const classMapping = text.match(/@RequestMapping\s*\([^\n]+\)/)?.[0];
    const classPath = classMapping ? extractAnnotationPath(classMapping) ?? "" : "";
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const mapping = line.match(/@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\([^\n]+\)/);
      if (!mapping) continue;
      const methodLine = lines.slice(i, i + 4).find((candidate) => /public\s+\w+[<>\w\s,]*\s+(\w+)\s*\(/.test(candidate));
      if (!methodLine) continue;
      const methodName = methodLine.match(/public\s+\w+[<>\w\s,]*\s+(\w+)\s*\(/)?.[1] ?? "unknown";
      const routePath = extractAnnotationPath(line) ?? "";
      const http_method = mapping[1].replace("Mapping", "").toUpperCase() || undefined;
      const relativeFile = relative(input.root, file);
      entries.push({
        id: `${input.project}:route:${relativeFile}:${i + 1}`,
        project: input.project,
        file: relativeFile,
        line: i + 1,
        route: normalizeRoute(classPath, routePath),
        http_method,
        symbol: `${className}.${methodName}`,
        location_type: "controller",
        snippet: await readSnippet(file, i + 1)
      });
    }
  }

  return entries;
}
```

- [ ] **步骤 4：运行测试**

运行：

```bash
npx vitest run packages/core/tests/route-indexer.test.ts
```

预期：通过。

## 任务 7：实现 SQL/表名索引器

**文件：**

- 创建：`packages/core/src/indexer/sql-indexer.ts`
- 测试：`packages/core/tests/sql-indexer.test.ts`

- [ ] **步骤 1：写 SQL 索引测试**

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSqlIndex } from "../src/indexer/sql-indexer.js";

describe("buildSqlIndex", () => {
  it("indexes MyBatis XML table names and mapper ids", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");
    const entries = await buildSqlIndex({ project: "trade-service", root });

    expect(entries).toContainEqual(
      expect.objectContaining({
        table: "order_item_snapshot",
        mapper_id: "countSnapshotItems",
        namespace: "com.example.trade.mapper.OrderMapper"
      })
    );
  });
});
```

- [ ] **步骤 2：实现 SQL 索引器**

```ts
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import fg from "fast-glob";

export type SqlIndexEntry = {
  id: string;
  project: string;
  file: string;
  line: number;
  namespace?: string;
  mapper_id?: string;
  table: string;
  sql_excerpt: string;
};

function findLine(text: string, token: string): number {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(token));
  return index >= 0 ? index + 1 : 1;
}

function extractTables(sql: string): string[] {
  const tables = new Set<string>();
  const regex = /\b(?:from|join|update|into)\s+([a-zA-Z_][\w.]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    tables.add(match[1].replace(/`/g, ""));
  }
  return [...tables];
}

export async function buildSqlIndex(input: { project: string; root: string }): Promise<SqlIndexEntry[]> {
  const files = await fg(["src/main/resources/**/*.xml", "src/main/java/**/*.java"], {
    cwd: input.root,
    absolute: true
  });
  const entries: SqlIndexEntry[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const namespace = text.match(/<mapper\s+namespace="([^"]+)"/)?.[1];
    const sqlBlocks = [...text.matchAll(/<(select|insert|update|delete)\s+[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)];
    for (const block of sqlBlocks) {
      const mapper_id = block[2];
      const sql = block[3].replace(/\s+/g, " ").trim();
      for (const table of extractTables(sql)) {
        const relativeFile = relative(input.root, file);
        entries.push({
          id: `${input.project}:sql:${relativeFile}:${mapper_id}:${table}`,
          project: input.project,
          file: relativeFile,
          line: findLine(text, table),
          namespace,
          mapper_id,
          table,
          sql_excerpt: sql
        });
      }
    }
  }

  return entries;
}
```

- [ ] **步骤 3：运行测试**

运行：

```bash
npx vitest run packages/core/tests/sql-indexer.test.ts
```

预期：通过。

## 任务 8：实现异常、错误码和日志索引器

**文件：**

- 创建：`packages/core/src/indexer/error-indexer.ts`
- 测试：`packages/core/tests/error-indexer.test.ts`

- [ ] **步骤 1：写错误索引测试**

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildErrorIndex } from "../src/indexer/error-indexer.js";

describe("buildErrorIndex", () => {
  it("indexes exceptions, error codes, and log statements", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");
    const entries = await buildErrorIndex({ project: "trade-service", root });

    expect(entries.some((entry) => entry.token === "ClientAbortException")).toBe(true);
    expect(entries.some((entry) => entry.token === "ORDER_STATUS_INVALID")).toBe(true);
    expect(entries.some((entry) => entry.kind === "log_statement")).toBe(true);
  });
});
```

- [ ] **步骤 2：实现错误索引器**

```ts
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import fg from "fast-glob";
import { readSnippet } from "../snippet.js";

export type ErrorIndexEntry = {
  id: string;
  project: string;
  file: string;
  line: number;
  token: string;
  kind: "exception" | "error_code" | "throw" | "catch" | "log_statement";
  snippet: string;
};

function lineNumber(lines: string[], index: number): number {
  return index + 1;
}

export async function buildErrorIndex(input: { project: string; root: string }): Promise<ErrorIndexEntry[]> {
  const files = await fg(["src/main/java/**/*.java"], { cwd: input.root, absolute: true });
  const entries: ErrorIndexEntry[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    const relativeFile = relative(input.root, file);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const tokens = [
        ...line.matchAll(/\b([A-Z][A-Za-z0-9]+Exception)\b/g),
        ...line.matchAll(/\b([A-Z][A-Z0-9_]{5,})\b/g)
      ].map((match) => match[1]);

      for (const token of tokens) {
        const kind = token.endsWith("Exception") ? "exception" : "error_code";
        entries.push({
          id: `${input.project}:error:${relativeFile}:${i + 1}:${token}`,
          project: input.project,
          file: relativeFile,
          line: lineNumber(lines, i),
          token,
          kind,
          snippet: await readSnippet(file, i + 1)
        });
      }

      if (/logger|log\.(error|warn)/.test(line)) {
        entries.push({
          id: `${input.project}:log:${relativeFile}:${i + 1}`,
          project: input.project,
          file: relativeFile,
          line: lineNumber(lines, i),
          token: line.trim(),
          kind: "log_statement",
          snippet: await readSnippet(file, i + 1)
        });
      }
    }
  }

  return entries;
}
```

- [ ] **步骤 3：运行测试**

运行：

```bash
npx vitest run packages/core/tests/error-indexer.test.ts
```

预期：通过。

## 任务 9：实现 semantic-lite 索引

**文件：**

- 创建：`packages/core/src/indexer/semantic-lite-indexer.ts`
- 测试：`packages/core/tests/semantic-lite.test.ts`

- [ ] **步骤 1：写轻量语义测试**

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSemanticLiteIndex, searchSemanticLite } from "../src/indexer/semantic-lite-indexer.js";

describe("semantic-lite", () => {
  it("recalls order detail code from a Chinese business description", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");
    const index = await buildSemanticLiteIndex({ project: "trade-service", root });
    const results = searchSemanticLite(index, "订单详情页打开超时", 5);

    expect(results.some((result) => result.file.includes("OrderController.java"))).toBe(true);
  });
});
```

- [ ] **步骤 2：实现 semantic-lite**

```ts
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import fg from "fast-glob";

export type SemanticLiteEntry = {
  id: string;
  project: string;
  file: string;
  text: string;
  tokens: string[];
};

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const words = normalized.match(/[a-z0-9_]+|[\u4e00-\u9fa5]{2,}/g) ?? [];
  const camelParts = normalized.split(/(?=[A-Z])|[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
  return [...new Set([...words, ...camelParts])];
}

function score(tokens: string[], queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const matches = queryTokens.filter((token) => tokens.some((candidate) => candidate.includes(token) || token.includes(candidate)));
  return matches.length / queryTokens.length;
}

export async function buildSemanticLiteIndex(input: { project: string; root: string }): Promise<SemanticLiteEntry[]> {
  const files = await fg(["src/main/java/**/*.java", "src/main/resources/**/*.xml", "src/main/resources/**/*.yml"], {
    cwd: input.root,
    absolute: true,
    ignore: ["**/target/**", "**/build/**"]
  });

  const entries: SemanticLiteEntry[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const compact = text
      .split(/\r?\n/)
      .filter((line) => /class |interface |public |@GetMapping|@PostMapping|<select|enum |订单|详情|状态/.test(line))
      .join(" ")
      .slice(0, 2000);
    const relativeFile = relative(input.root, file);
    entries.push({
      id: `${input.project}:semantic:${relativeFile}`,
      project: input.project,
      file: relativeFile,
      text: compact,
      tokens: tokenize(`${relativeFile} ${compact}`)
    });
  }
  return entries;
}

export function searchSemanticLite(index: SemanticLiteEntry[], query: string, limit: number): SemanticLiteEntry[] {
  const queryTokens = tokenize(query);
  return index
    .map((entry) => ({ entry, score: score(entry.tokens, queryTokens) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.entry);
}
```

- [ ] **步骤 3：运行测试**

运行：

```bash
npx vitest run packages/core/tests/semantic-lite.test.ts
```

预期：通过。

## 任务 10：实现索引编排和新鲜度判断

**文件：**

- 创建：`packages/core/src/git.ts`
- 创建：`packages/core/src/gitnexus.ts`
- 创建：`packages/core/src/indexer/index-project.ts`
- 测试：`packages/core/tests/freshness.test.ts`

- [ ] **步骤 1：写新鲜度测试**

```ts
import { describe, expect, it } from "vitest";
import { classifyFreshness } from "../src/indexer/index-project.js";

describe("classifyFreshness", () => {
  it("marks index stale when current commit differs", () => {
    expect(
      classifyFreshness({
        indexed_commit: "abc",
        current_commit: "def",
        indexed_dirty: false,
        current_dirty: false
      }).state
    ).toBe("stale");
  });

  it("marks index ready when commit and dirty flag match", () => {
    expect(
      classifyFreshness({
        indexed_commit: "abc",
        current_commit: "abc",
        indexed_dirty: false,
        current_dirty: false
      }).state
    ).toBe("ready");
  });
});
```

- [ ] **步骤 2：实现 Git 状态工具**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitState = {
  commit_hash?: string;
  dirty: boolean;
};

export async function readGitState(cwd: string): Promise<GitState> {
  try {
    const rev = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd });
    return {
      commit_hash: rev.stdout.trim() || undefined,
      dirty: status.stdout.trim().length > 0
    };
  } catch {
    return { dirty: false };
  }
}
```

- [ ] **步骤 3：实现 GitNexus 适配器**

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitNexusStatus = {
  installed: boolean;
  repo_index_exists: boolean;
  message?: string;
};

export async function inspectGitNexus(repoPath: string): Promise<GitNexusStatus> {
  let installed = false;
  try {
    await execFileAsync("gitnexus", ["--version"]);
    installed = true;
  } catch {
    installed = false;
  }

  let repo_index_exists = false;
  try {
    await access(join(repoPath, ".gitnexus"));
    repo_index_exists = true;
  } catch {
    repo_index_exists = false;
  }

  return {
    installed,
    repo_index_exists,
    message: installed ? undefined : "GitNexus 命令不可用"
  };
}

export async function runGitNexusAnalyze(repoPath: string): Promise<void> {
  await execFileAsync("gitnexus", ["analyze"], { cwd: repoPath });
}
```

- [ ] **步骤 4：实现索引编排**

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectDataDir } from "../paths.js";
import { ensureDir, writeJsonFile } from "../fs-utils.js";
import { readGitState } from "../git.js";
import { inspectGitNexus, runGitNexusAnalyze } from "../gitnexus.js";
import { buildRouteIndex } from "./route-indexer.js";
import { buildSqlIndex } from "./sql-indexer.js";
import { buildErrorIndex } from "./error-indexer.js";
import { buildSemanticLiteIndex } from "./semantic-lite-indexer.js";

export type FreshnessInput = {
  indexed_commit?: string;
  current_commit?: string;
  indexed_dirty: boolean;
  current_dirty: boolean;
};

export function classifyFreshness(input: FreshnessInput): { state: "ready" | "stale" } {
  if (input.indexed_commit && input.current_commit && input.indexed_commit !== input.current_commit) {
    return { state: "stale" };
  }
  if (input.indexed_dirty !== input.current_dirty) {
    return { state: "stale" };
  }
  return { state: "ready" };
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

export async function indexProject(input: {
  home: string;
  name: string;
  path: string;
  withGitNexus?: boolean;
}): Promise<{ state: "ready" | "partial"; warnings: string[] }> {
  const dir = projectDataDir(input.home, input.name);
  await ensureDir(dir);

  const warnings: string[] = [];
  const gitnexus = await inspectGitNexus(input.path);
  if (input.withGitNexus) {
    await runGitNexusAnalyze(input.path);
  } else if (!gitnexus.repo_index_exists) {
    warnings.push("GitNexus 索引不存在；调用链能力会降级。可执行 code-intel index " + input.name + " --with-gitnexus");
  }

  const git = await readGitState(input.path);
  const routes = await buildRouteIndex({ project: input.name, root: input.path });
  const sql = await buildSqlIndex({ project: input.name, root: input.path });
  const errors = await buildErrorIndex({ project: input.name, root: input.path });
  const semantic = await buildSemanticLiteIndex({ project: input.name, root: input.path });

  await writeJsonl(join(dir, "java-route-map.jsonl"), routes);
  await writeJsonl(join(dir, "java-sql-map.jsonl"), sql);
  await writeJsonl(join(dir, "error-map.jsonl"), errors);
  await writeJsonl(join(dir, "semantic-lite.jsonl"), semantic);
  await writeJsonFile(join(dir, "manifest.json"), {
    project: input.name,
    path: input.path,
    indexed_at: new Date().toISOString(),
    indexed_commit: git.commit_hash,
    dirty_flag: git.dirty,
    gitnexus_status: gitnexus,
    generated_files: ["java-route-map.jsonl", "java-sql-map.jsonl", "error-map.jsonl", "semantic-lite.jsonl"],
    warnings
  });

  return { state: warnings.length > 0 ? "partial" : "ready", warnings };
}
```

- [ ] **步骤 5：运行测试**

运行：

```bash
npx vitest run packages/core/tests/freshness.test.ts
```

预期：通过。

## 任务 11：实现检索路由、grep 兜底和置信度

**文件：**

- 创建：`packages/core/src/search/query-classifier.ts`
- 创建：`packages/core/src/search/confidence.ts`
- 创建：`packages/core/src/search/grep-searcher.ts`
- 创建：`packages/core/src/search/search-router.ts`
- 创建：`packages/core/src/search/call-chain.ts`
- 创建：`packages/core/src/diagnostics.ts`
- 测试：`packages/core/tests/search-router.test.ts`

- [ ] **步骤 1：写检索路由测试**

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexProject } from "../src/indexer/index-project.js";
import { searchCode } from "../src/search/search-router.js";

describe("searchCode", () => {
  it("locates route, table, error, and semantic candidates", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const root = join(process.cwd(), "fixtures/java-order-service");
    try {
      await indexProject({ home, name: "trade-service", path: root });

      const route = await searchCode({ home, project: "trade-service", root, type: "route", query: "/api/trade/order/detail" });
      expect(route.locations[0]).toMatchObject({ location_type: "controller", confidence: "high" });

      const table = await searchCode({ home, project: "trade-service", root, type: "table", query: "order_item_snapshot" });
      expect(table.locations.some((location) => location.location_type === "sql")).toBe(true);

      const error = await searchCode({ home, project: "trade-service", root, type: "error", query: "ORDER_STATUS_INVALID" });
      expect(error.locations.length).toBeGreaterThan(0);

      const semantic = await searchCode({ home, project: "trade-service", root, type: "semantic", query: "订单详情页打开超时" });
      expect(semantic.locations.length).toBeGreaterThan(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：实现 query classifier**

```ts
import type { QueryType } from "../schemas.js";

export function classifyQuery(query: string, explicitType?: QueryType): QueryType {
  if (explicitType) return explicitType;
  if (/^(GET|POST|PUT|DELETE|PATCH)\s+\//i.test(query) || query.startsWith("/")) return "route";
  if (/\bselect\b|\bfrom\b|\bwhere\b/i.test(query)) return "sql";
  if (/^[a-zA-Z_][\w]*(_[a-zA-Z0-9]+)+$/.test(query)) return "table";
  if (/Exception\b|ERROR|WARN|Broken pipe|[A-Z][A-Z0-9_]{5,}/.test(query)) return "error";
  if (/^[A-Z]\w+\.\w+$/.test(query)) return "symbol";
  return "semantic";
}
```

- [ ] **步骤 3：实现置信度工具**

```ts
import type { Confidence } from "../schemas.js";

export function confidenceFromScore(score: number): Confidence {
  if (score >= 0.85) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

export function downgradeForStale(confidence: Confidence, stale: boolean): Confidence {
  if (!stale) return confidence;
  if (confidence === "high") return "medium";
  if (confidence === "medium") return "low";
  return "low";
}
```

- [ ] **步骤 4：实现 grep 兜底**

```ts
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import fg from "fast-glob";
import type { CodeLocation } from "../schemas.js";

export async function grepSearch(input: {
  project: string;
  root: string;
  query: string;
  limit: number;
}): Promise<CodeLocation[]> {
  const files = await fg(["**/*.{java,xml,yml,yaml,properties,sql}"], {
    cwd: input.root,
    absolute: true,
    ignore: ["**/.git/**", "**/target/**", "**/build/**", "**/node_modules/**", "**/dist/**", "**/logs/**"]
  });
  const results: CodeLocation[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    const hitIndex = lines.findIndex((line) => line.includes(input.query));
    if (hitIndex < 0) continue;
    const relativeFile = relative(input.root, file);
    results.push({
      id: `${input.project}:grep:${relativeFile}:${hitIndex + 1}`,
      project: input.project,
      file: relativeFile,
      start_line: hitIndex + 1,
      end_line: hitIndex + 1,
      language: relativeFile.endsWith(".xml") ? "xml" : relativeFile.endsWith(".java") ? "java" : "unknown",
      location_type: "unknown",
      snippet: lines.slice(Math.max(0, hitIndex - 2), hitIndex + 3).join("\n"),
      match_reason: "增强 grep 命中原始查询文本。",
      score: 0.4,
      confidence: "low",
      source: "grep"
    });
    if (results.length >= input.limit) break;
  }
  return results;
}
```

- [ ] **步骤 5：实现 search router**

实现读取 `java-route-map.jsonl`、`java-sql-map.jsonl`、`error-map.jsonl`、`semantic-lite.jsonl`，按查询类型转换成 `SearchResponse`。核心转换规则：

```ts
// route 命中：location_type=controller, source=java_index, confidence=high
// table/sql 命中：location_type=sql, source=java_index, confidence=high
// error 命中：kind=log_statement -> location_type=log_statement；kind=exception -> location_type=exception
// semantic 命中：location_type=unknown, source=semantic_lite, confidence=medium
// 没有索引或没有命中：调用 grepSearch，diagnostics 加 GREP_FALLBACK_USED
```

`searchCode` 签名：

```ts
export async function searchCode(input: {
  home: string;
  project: string;
  root: string;
  type?: QueryType;
  query: string;
  limit?: number;
  includeRelations?: boolean;
}): Promise<SearchResponse>;
```

- [ ] **步骤 6：实现基础调用链摘要**

第一版 `traceCallChain` 可以先返回当前 location 的直接关系候选，不做跨项目深度图：

```ts
import type { SearchResponse } from "../schemas.js";

export async function traceCallChain(response: SearchResponse): Promise<SearchResponse> {
  return {
    ...response,
    summary: response.relations.length > 0 ? response.summary : `${response.summary} 未发现高置信调用链关系。`
  };
}
```

- [ ] **步骤 7：运行检索测试**

运行：

```bash
npx vitest run packages/core/tests/search-router.test.ts
```

预期：通过。

## 任务 12：实现 CLI

**文件：**

- 创建：`packages/cli/src/index.ts`
- 测试：`packages/cli/tests/cli.test.ts`

- [ ] **步骤 1：写 CLI 烟囱测试**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("code-intel cli", () => {
  it("prints data directory with where command", async () => {
    const result = await execFileAsync("node", ["packages/cli/dist/index.js", "where"], {
      env: { ...process.env, CODE_INTEL_HOME: "/tmp/code-intel-test-home" }
    });
    expect(result.stdout).toContain("/tmp/code-intel-test-home");
  });
});
```

- [ ] **步骤 2：实现 CLI**

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { resolveCodeIntelHome, createProjectRegistry, detectStack } from "@code-intelligence/core";
import { indexProject } from "@code-intelligence/core/indexer/index-project.js";
import { searchCode } from "@code-intelligence/core/search/search-router.js";

const program = new Command();
program.name("code-intel").version("0.1.0");

program.command("where").description("显示 Code Intelligence 数据目录").action(() => {
  console.log(resolveCodeIntelHome());
});

program.command("register")
  .argument("<name>")
  .argument("<path>")
  .option("--stack <stack>")
  .action(async (name, path, options) => {
    const stack = options.stack ?? await detectStack(path);
    const registry = createProjectRegistry();
    const project = await registry.register({ name, path, stack });
    console.log(JSON.stringify(project, null, 2));
  });

program.command("projects").action(async () => {
  const registry = createProjectRegistry();
  console.log(JSON.stringify(await registry.list(), null, 2));
});

program.command("index")
  .argument("<project>")
  .option("--with-gitnexus")
  .action(async (project, options) => {
    const registry = createProjectRegistry();
    const registered = await registry.get(project);
    if (!registered) throw new Error(`项目未注册：${project}`);
    const result = await indexProject({
      home: resolveCodeIntelHome(),
      name: registered.name,
      path: registered.path,
      withGitNexus: Boolean(options.withGitnexus)
    });
    console.log(JSON.stringify(result, null, 2));
  });

program.command("search")
  .argument("<project>")
  .requiredOption("--query <query>")
  .option("--type <type>")
  .option("--limit <limit>", "结果数量", "10")
  .option("--include-relations")
  .option("--json")
  .action(async (project, options) => {
    const registry = createProjectRegistry();
    const registered = await registry.get(project);
    if (!registered) throw new Error(`项目未注册：${project}`);
    const response = await searchCode({
      home: resolveCodeIntelHome(),
      project,
      root: registered.path,
      type: options.type,
      query: options.query,
      limit: Number(options.limit),
      includeRelations: Boolean(options.includeRelations)
    });
    console.log(JSON.stringify(response, null, 2));
  });

await program.parseAsync(process.argv);
```

- [ ] **步骤 3：构建并运行测试**

运行：

```bash
npm run build -w @code-intelligence/cli
npx vitest run packages/cli/tests/cli.test.ts
```

预期：通过。

## 任务 13：实现 MCP Server

**文件：**

- 创建：`packages/mcp/src/server.ts`
- 测试：`packages/mcp/tests/mcp-tools.test.ts`

- [ ] **步骤 1：写 MCP 工具处理器测试**

为了避免 stdio 集成测试脆弱，先把工具注册逻辑拆成可测试函数：

```ts
import { describe, expect, it } from "vitest";
import { allowIndexOperations } from "../src/server.js";

describe("mcp permissions", () => {
  it("disables index operations by default", () => {
    expect(allowIndexOperations({})).toBe(false);
  });

  it("enables index operations only with explicit env flag", () => {
    expect(allowIndexOperations({ CODE_INTEL_MCP_ALLOW_INDEX: "true" })).toBe(true);
  });
});
```

- [ ] **步骤 2：实现 MCP Server**

Context7 查询到当前 TypeScript MCP SDK 的 stdio 模式使用 `McpServer` 与 `serveStdio`，工具通过 `server.registerTool(name, { inputSchema }, handler)` 注册，输入 schema 可使用 Zod。

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createProjectRegistry, resolveCodeIntelHome } from "@code-intelligence/core";
import { indexProject } from "@code-intelligence/core/indexer/index-project.js";
import { searchCode } from "@code-intelligence/core/search/search-router.js";

export function allowIndexOperations(env: NodeJS.ProcessEnv): boolean {
  return env.CODE_INTEL_MCP_ALLOW_INDEX === "true";
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}

serveStdio(() => {
  const server = new McpServer({ name: "code-intelligence", version: "0.1.0" });

  server.registerTool(
    "code.search",
    {
      description: "通用代码检索入口",
      inputSchema: z.object({
        project: z.string(),
        query: z.string(),
        type: z.enum(["route", "error", "sql", "table", "symbol", "keyword", "semantic"]).optional(),
        limit: z.number().int().positive().optional(),
        include_relations: z.boolean().optional()
      })
    },
    async (input) => {
      const registry = createProjectRegistry();
      const project = await registry.get(input.project);
      if (!project) return textResult({ diagnostics: [{ level: "error", code: "PROJECT_NOT_REGISTERED", message: "项目未注册" }] });
      return textResult(await searchCode({
        home: resolveCodeIntelHome(),
        project: input.project,
        root: project.path,
        type: input.type,
        query: input.query,
        limit: input.limit,
        includeRelations: input.include_relations
      }));
    }
  );

  server.registerTool(
    "code.locate_route",
    {
      description: "根据接口路径定位 Java 入口",
      inputSchema: z.object({
        project: z.string(),
        route: z.string(),
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
        include_downstream: z.boolean().optional()
      })
    },
    async (input) => {
      const registry = createProjectRegistry();
      const project = await registry.get(input.project);
      if (!project) return textResult({ diagnostics: [{ level: "error", code: "PROJECT_NOT_REGISTERED", message: "项目未注册" }] });
      return textResult(await searchCode({
        home: resolveCodeIntelHome(),
        project: input.project,
        root: project.path,
        type: "route",
        query: input.route,
        includeRelations: input.include_downstream
      }));
    }
  );

  server.registerTool(
    "code.index_project",
    {
      description: "显式索引本地项目。默认禁用，需要 CODE_INTEL_MCP_ALLOW_INDEX=true。",
      inputSchema: z.object({
        project: z.string(),
        with_gitnexus: z.boolean().optional()
      })
    },
    async (input) => {
      if (!allowIndexOperations(process.env)) {
        return textResult({ diagnostics: [{ level: "error", code: "INDEX_MISSING", message: "MCP 默认不允许索引；请设置 CODE_INTEL_MCP_ALLOW_INDEX=true 后重试" }] });
      }
      const registry = createProjectRegistry();
      const project = await registry.get(input.project);
      if (!project) return textResult({ diagnostics: [{ level: "error", code: "PROJECT_NOT_REGISTERED", message: "项目未注册" }] });
      return textResult(await indexProject({
        home: resolveCodeIntelHome(),
        name: project.name,
        path: project.path,
        withGitNexus: input.with_gitnexus
      }));
    }
  );

  return server;
});
```

- [ ] **步骤 3：运行 MCP 测试**

运行：

```bash
npx vitest run packages/mcp/tests/mcp-tools.test.ts
```

预期：通过。

## 任务 14：补齐用户文档

**文件：**

- 创建：`README.md`
- 创建：`docs/user-guide.zh-CN.md`
- 创建：`docs/features.zh-CN.md`
- 创建：`docs/integration-guide.zh-CN.md`

- [ ] **步骤 1：写 README**

必须包含这些章节：

```markdown
# Code Intelligence

Code Intelligence 是一个本地 Java 代码检索与代码理解底座，用于被 Skill、MCP Server、Agent、CLI 和后续流程图工具调用。

## 快速开始

```bash
npm install
npm run build
node packages/cli/dist/index.js register trade-service /mnt/g/workSpace/trade-service
node packages/cli/dist/index.js index trade-service --with-gitnexus
node packages/cli/dist/index.js search trade-service --type route --query "/api/trade/order/detail" --json
```

## 与 GitNexus 的关系

GitNexus 负责结构化代码图谱。本工具负责项目注册、Java 专项索引、轻量语义召回、增强 grep 兜底和统一输出模型。

## 第一版限制

不支持 GitLab 远程仓库索引，不做跨项目调用链，不做完整 RAG 问答，不直接输出线上排障根因。
```

- [ ] **步骤 2：写用户指南**

`docs/user-guide.zh-CN.md` 必须覆盖：

```markdown
# 用户指南

## 查看数据目录

```bash
code-intel where
```

## 注册项目

```bash
code-intel register trade-service /mnt/g/workSpace/trade-service
```

## 建立索引

```bash
code-intel index trade-service --with-gitnexus
```

## 常见检索

```bash
code-intel search trade-service --type route --query "/api/trade/order/detail" --json
code-intel search trade-service --type error --query "ClientAbortException" --json
code-intel search trade-service --type table --query "order_item_snapshot" --json
code-intel search trade-service --type semantic --query "订单详情页打开超时" --json
```

## 处理索引状态

`missing` 表示索引不存在，执行 `code-intel index <project>`。
`stale` 表示代码已变化，建议重新索引。
`partial` 表示部分索引完成，工具会降级检索。
`failed` 表示索引不可用，需要查看 `code-intel doctor <project>`。
```

- [ ] **步骤 3：写功能介绍**

`docs/features.zh-CN.md` 必须覆盖：

```markdown
# 功能介绍

## 支持能力

- 接口和路由定位。
- 异常、错误码和日志文本定位。
- SQL 和表名定位。
- 轻量语义召回。
- 基础调用链摘要。
- 通用证据模型。

## 检索来源

- `java_index`：本工具 Java 专项索引。
- `gitnexus`：GitNexus 结构化代码图谱。
- `semantic_lite`：轻量语义召回。
- `grep`：增强 grep 兜底。
```

- [ ] **步骤 4：写接入指南**

`docs/integration-guide.zh-CN.md` 必须覆盖：

```markdown
# 接入指南

## MCP 工具

- `code.search`
- `code.locate_route`
- `code.search_error`
- `code.search_sql`
- `code.trace_call_chain`
- `code.diagnose`

## 输出模型

上层工具只依赖 `SearchResponse`、`CodeLocation`、`CodeRelation`、`EvidenceRef` 和 `Diagnostic`。

## 线上运维 Skill 适配

线上运维 Skill 应把 `SearchResponse.locations` 转换成自己的代码证据，把 `diagnostics` 转换成 `restricted_info` 或 warning。

## 流程图工具适配

流程图工具应把 `CodeLocation` 转换成节点，把 `CodeRelation` 转换成边，把 `EvidenceRef` 转换成节点证据。
```

- [ ] **步骤 5：检查文档存在**

运行：

```bash
test -f README.md
test -f docs/user-guide.zh-CN.md
test -f docs/features.zh-CN.md
test -f docs/integration-guide.zh-CN.md
```

预期：全部退出码为 0。

## 任务 15：端到端验收

**文件：**

- 修改：无新增业务文件；验证全项目。

- [ ] **步骤 1：安装依赖**

运行：

```bash
npm install
```

预期：安装成功。

- [ ] **步骤 2：运行类型检查**

运行：

```bash
npm run typecheck
```

预期：通过。

- [ ] **步骤 3：运行测试**

运行：

```bash
npm test
```

预期：所有 Vitest 用例通过。

- [ ] **步骤 4：构建**

运行：

```bash
npm run build
```

预期：`packages/core/dist`、`packages/cli/dist`、`packages/mcp/dist` 生成。

- [ ] **步骤 5：CLI 手工验收**

运行：

```bash
export CODE_INTEL_HOME=/tmp/code-intel-manual
node packages/cli/dist/index.js register trade-service fixtures/java-order-service
node packages/cli/dist/index.js index trade-service
node packages/cli/dist/index.js search trade-service --type route --query "/api/trade/order/detail" --json
node packages/cli/dist/index.js search trade-service --type table --query "order_item_snapshot" --json
node packages/cli/dist/index.js search trade-service --type error --query "ORDER_STATUS_INVALID" --json
node packages/cli/dist/index.js search trade-service --type semantic --query "订单详情页打开超时" --json
```

预期：

- route 查询返回 `OrderController.java`。
- table 查询返回 `OrderMapper.xml`。
- error 查询返回 `OrderStatusEnum.java` 或 `OrderDetailService.java`。
- semantic 查询返回 `OrderController.java`、`OrderDetailService.java` 或 `ReportService.java`。
- 所有响应符合 `SearchResponse`。

- [ ] **步骤 6：MCP 权限验收**

运行：

```bash
npx vitest run packages/mcp/tests/mcp-tools.test.ts
```

预期：默认不允许 MCP 索引；设置 `CODE_INTEL_MCP_ALLOW_INDEX=true` 后权限判断返回 true。

## 执行注意事项

- 本计划不要求 git 初始化，也不要求 commit。
- 如果执行者所在环境没有网络，`npm install` 可能失败；失败时需要用户授权网络访问后重试。
- 如果本地未安装 GitNexus，第一版必须仍可通过 Java 专项索引和 grep 完成基础检索。
- 如果 GitNexus 命令行为与计划中的 `gitnexus analyze` 不一致，先用 `gitnexus --help` 查实际命令，再只修改 `packages/core/src/gitnexus.ts` 的适配层。

## 自检结果

- 设计文档中的本地项目注册、Java 优先、MCP/CLI 双入口、GitNexus 边界、轻量语义召回、手动索引、stale 判断、权限控制和文档交付均有对应任务。
- 第一版没有加入 HTTP 服务实现任务，符合“HTTP 仅可选扩展”的设计边界。
- 计划没有要求提交代码，符合“暂时不做 git 初始化和 commit”的用户指令。
