#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  createProjectRegistry,
  exploreSymbol,
  indexProject,
  resolveCodeIntelHome,
  searchCode,
  traceCallChain
} from "@code-intelligence/core";
import type { GitNexusIndexMode, QueryType } from "@code-intelligence/core";

export type TextToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type ToolEnv = {
  CODE_INTEL_MCP_ALLOW_INDEX?: string;
};

const QueryTypeInputSchema = z.enum([
  "route",
  "error",
  "sql",
  "table",
  "symbol",
  "keyword",
  "semantic",
  "call_chain"
]);
const GitNexusIndexModeInputSchema = z.enum(["auto", "none", "basic", "full"]);
const ExploreDirectionInputSchema = z.enum(["upstream", "downstream", "both"]);

export function allowIndexOperations(env: ToolEnv): boolean {
  return env.CODE_INTEL_MCP_ALLOW_INDEX === "true";
}

export async function handleCodeSearch(input: {
  home?: string;
  project: string;
  query: string;
  type?: QueryType;
  limit?: number;
  include_relations?: boolean;
}): Promise<TextToolResult> {
  const home = input.home ?? resolveCodeIntelHome();
  const registry = createProjectRegistry({ home });
  const project = await registry.get(input.project);
  if (!project) {
    return textResult({
      diagnostics: [
        {
          level: "error",
          code: "PROJECT_NOT_REGISTERED",
          message: "项目未注册"
        }
      ]
    });
  }

  return textResult(await searchCode({
    home,
    project: input.project,
    root: project.path,
    gitnexusRepo: project.gitnexus_repo,
    type: input.type,
    query: input.query,
    limit: input.limit,
    includeRelations: Boolean(input.include_relations)
  }));
}

export async function handleCodeLocateRoute(input: {
  home?: string;
  project: string;
  route: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  include_downstream?: boolean;
  downstream_depth?: number;
}): Promise<TextToolResult> {
  return handleCodeSearch({
    home: input.home,
    project: input.project,
    query: input.method ? `${input.method} ${input.route}` : input.route,
    type: "route",
    include_relations: input.include_downstream
  });
}

export async function handleCodeIndexProject(input: {
  home?: string;
  env?: ToolEnv;
  project: string;
  with_gitnexus?: boolean;
  gitnexus_mode?: GitNexusIndexMode;
}): Promise<TextToolResult> {
  const env = input.env ?? process.env;
  if (!allowIndexOperations(env)) {
    return textResult({
      diagnostics: [
        {
          level: "error",
          code: "INDEX_DISABLED",
          message: "MCP 默认不允许索引；请设置 CODE_INTEL_MCP_ALLOW_INDEX=true 后重试"
        }
      ]
    });
  }

  const home = input.home ?? resolveCodeIntelHome();
  const registry = createProjectRegistry({ home });
  const project = await registry.get(input.project);
  if (!project) {
    return textResult({
      diagnostics: [
        {
          level: "error",
          code: "PROJECT_NOT_REGISTERED",
          message: "项目未注册"
        }
      ]
    });
  }

  return textResult(await indexProject({
    home,
    name: project.name,
    path: project.path,
    withGitNexus: Boolean(input.with_gitnexus),
    gitnexusMode: input.gitnexus_mode ?? (input.with_gitnexus ? "basic" : "auto")
  }));
}

export async function handleCodeTraceCallChain(input: {
  home?: string;
  project: string;
  from: string;
  to: string;
  from_uid?: string;
  from_file?: string;
  to_uid?: string;
  to_file?: string;
  depth?: number;
}): Promise<TextToolResult> {
  const home = input.home ?? resolveCodeIntelHome();
  const registry = createProjectRegistry({ home });
  const project = await registry.get(input.project);
  if (!project) {
    return textResult({
      diagnostics: [
        {
          level: "error",
          code: "PROJECT_NOT_REGISTERED",
          message: "项目未注册"
        }
      ]
    });
  }

  return textResult(await traceCallChain({
    home,
    project: input.project,
    root: project.path,
    gitnexusRepo: project.gitnexus_repo,
    from: input.from,
    to: input.to,
    fromUid: input.from_uid,
    fromFile: input.from_file,
    toUid: input.to_uid,
    toFile: input.to_file,
    depth: input.depth
  }));
}

export async function handleCodeExploreSymbol(input: {
  home?: string;
  project: string;
  query: string;
  type?: QueryType;
  direction?: "upstream" | "downstream" | "both";
  depth?: number;
  limit?: number;
  relation_budget?: number;
  main_path_limit?: number;
  exclude_tests?: boolean;
}): Promise<TextToolResult> {
  const home = input.home ?? resolveCodeIntelHome();
  const registry = createProjectRegistry({ home });
  const project = await registry.get(input.project);
  if (!project) {
    return textResult({
      diagnostics: [
        {
          level: "error",
          code: "PROJECT_NOT_REGISTERED",
          message: "项目未注册"
        }
      ]
    });
  }

  return textResult(await exploreSymbol({
    home,
    project: input.project,
    root: project.path,
    gitnexusRepo: project.gitnexus_repo,
    type: input.type,
    query: input.query,
    direction: input.direction,
    depth: input.depth,
    limit: input.limit,
    relationBudget: input.relation_budget,
    mainPathLimit: input.main_path_limit,
    excludeTests: input.exclude_tests ?? true
  }));
}

export function parseTextResult(result: TextToolResult): unknown {
  return JSON.parse(result.content[0]?.text ?? "null") as unknown;
}

export function createCodeIntelligenceServer(): McpServer {
  const server = new McpServer({ name: "code-intelligence", version: "0.1.0" });

  server.registerTool(
    "code.search",
    {
      description: "通用代码检索入口",
      inputSchema: z.object({
        project: z.string(),
        query: z.string(),
        type: QueryTypeInputSchema.optional(),
        limit: z.number().int().positive().optional(),
        include_relations: z.boolean().optional()
      })
    },
    async (input) => handleCodeSearch(input)
  );

  server.registerTool(
    "code.locate_route",
    {
      description: "根据接口路径定位 Java 入口",
      inputSchema: z.object({
        project: z.string(),
        route: z.string(),
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
        include_downstream: z.boolean().optional(),
        downstream_depth: z.number().int().positive().max(3).optional()
      })
    },
    async (input) => handleCodeLocateRoute(input)
  );

  server.registerTool(
    "code.trace_call_chain",
    {
      description: "使用 GitNexus 查询两个符号之间的调用链",
      inputSchema: z.object({
        project: z.string(),
        from: z.string(),
        to: z.string(),
        from_uid: z.string().optional(),
        from_file: z.string().optional(),
        to_uid: z.string().optional(),
        to_file: z.string().optional(),
        depth: z.number().int().positive().optional()
      })
    },
    async (input) => handleCodeTraceCallChain(input)
  );

  server.registerTool(
    "code.explore_symbol",
    {
      description: "从一个代码线索出发探索上下游关系、候选路径和 V0.4 main_paths。上游 Agent 应优先消费 main_paths；relations 是预算内证据子集，不代表完整图谱；coverage.complete=false 时不得声明完整调用链。",
      inputSchema: z.object({
        project: z.string(),
        query: z.string(),
        type: QueryTypeInputSchema.optional(),
        direction: ExploreDirectionInputSchema.optional(),
        depth: z.number().int().positive().max(4).optional(),
        limit: z.number().int().positive().optional(),
        relation_budget: z.number().int().positive().optional(),
        main_path_limit: z.number().int().positive().optional(),
        exclude_tests: z.boolean().optional()
      })
    },
    async (input) => handleCodeExploreSymbol(input)
  );

  server.registerTool(
    "code.index_project",
    {
      description: "显式索引本地项目。默认禁用，需要 CODE_INTEL_MCP_ALLOW_INDEX=true。",
      inputSchema: z.object({
        project: z.string(),
        with_gitnexus: z.boolean().optional(),
        gitnexus_mode: GitNexusIndexModeInputSchema.optional()
      })
    },
    async (input) => handleCodeIndexProject(input)
  );

  return server;
}

if (isDirectExecution()) {
  serveStdio(() => createCodeIntelligenceServer());
}

function textResult(value: unknown): TextToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
}
