#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import type {
  ExploreDirection,
  GitNexusIndexMode,
  IndexProjectProgressEvent,
  QueryType,
  Stack
} from "@code-intelligence/core";

const program = new Command();

program.name("code-intel").version("0.1.0");

program
  .command("where")
  .description("显示 Code Intelligence 数据目录")
  .action(() => {
    console.log(resolveCodeIntelHomeLocal());
  });

program
  .command("register")
  .description("注册本地项目")
  .argument("<name>")
  .argument("<path>")
  .option("--stack <stack>")
  .option("--gitnexus-repo <repo>")
  .action(async (name: string, path: string, options: { stack?: Stack; gitnexusRepo?: string }) => {
    const { createProjectRegistry, detectStack } = await import("@code-intelligence/core");
    const stack = options.stack ?? await detectStack(path);
    const registry = createProjectRegistry();
    const project = await registry.register({
      name,
      path,
      stack,
      gitnexus_repo: options.gitnexusRepo
    });

    printJson(project);
  });

program
  .command("projects")
  .description("列出已注册项目")
  .action(async () => {
    const { createProjectRegistry } = await import("@code-intelligence/core");
    const registry = createProjectRegistry();

    printJson(await registry.list());
  });

program
  .command("index")
  .description("生成本地代码索引")
  .argument("<project>")
  .option("--gitnexus-mode <mode>", "GitNexus 索引模式：auto|none|basic|full", "auto")
  .option("--with-gitnexus", "兼容旧用法，等价于 --gitnexus-mode basic")
  .action(async (project: string, options: { gitnexusMode: string; withGitnexus?: boolean }) => {
    const { createProjectRegistry, indexProject } = await import("@code-intelligence/core");
    const registry = createProjectRegistry();
    const registered = await registry.get(project);
    if (!registered) throw new Error(`项目未注册：${project}`);
    const gitnexusMode = parseGitNexusIndexMode(options.gitnexusMode, Boolean(options.withGitnexus));

    const result = await indexProject({
      home: resolveCodeIntelHomeLocal(),
      name: registered.name,
      path: registered.path,
      gitnexusMode,
      withGitNexus: Boolean(options.withGitnexus),
      onProgress: logIndexProgress
    });

    printJson(result);
  });

program
  .command("search")
  .description("检索项目代码")
  .argument("<project>")
  .requiredOption("--query <query>")
  .option("--type <type>")
  .option("--limit <limit>", "结果数量", "10")
  .option("--include-relations", "返回基础调用链关系")
  .option("--json", "以 JSON 输出，当前默认即为 JSON")
  .action(async (
    project: string,
    options: {
      query: string;
      type?: string;
      limit: string;
      includeRelations?: boolean;
    }
  ) => {
    const limit = parseLimit(options.limit);
    const type = parseQueryType(options.type);
    const { createProjectRegistry, searchCode } = await import("@code-intelligence/core");
    const registry = createProjectRegistry();
    const registered = await registry.get(project);
    if (!registered) throw new Error(`项目未注册：${project}`);

    const response = await searchCode({
      home: resolveCodeIntelHomeLocal(),
      project,
      root: registered.path,
      gitnexusRepo: registered.gitnexus_repo,
      type,
      query: options.query,
      limit,
      includeRelations: Boolean(options.includeRelations)
    });

    printJson(response);
  });

program
  .command("explore")
  .description("从一个接口、错误码、日志、SQL、方法或业务词出发探索代码上下文")
  .argument("<project>")
  .requiredOption("--query <query>")
  .option("--type <type>")
  .option("--direction <direction>", "探索方向：upstream|downstream|both", "both")
  .option("--depth <depth>", "最大探索深度，默认 2，最大 4", "2")
  .option("--limit <limit>", "最大返回候选路径数量", "20")
  .option("--relation-budget <relationBudget>", "最大关系扩展预算，默认 60")
  .option("--main-path-limit <mainPathLimit>", "最大返回候选主链路数量，默认 3")
  .option("--exclude-tests", "排除测试代码（默认行为）")
  .option("--include-tests", "包含测试代码")
  .option("--json", "以 JSON 输出，当前默认即为 JSON")
  .action(async (
    project: string,
    options: {
      query: string;
      type?: string;
      direction: string;
      depth: string;
      limit: string;
      relationBudget?: string;
      mainPathLimit?: string;
      excludeTests?: boolean;
      includeTests?: boolean;
    }
  ) => {
    const limit = parseLimit(options.limit);
    const relationBudget = options.relationBudget === undefined ? undefined : parseLimit(options.relationBudget);
    const mainPathLimit = options.mainPathLimit === undefined ? undefined : parseLimit(options.mainPathLimit);
    const depth = parseDepth(options.depth);
    const direction = parseExploreDirection(options.direction);
    const type = parseQueryType(options.type);
    const { createProjectRegistry, exploreSymbol } = await import("@code-intelligence/core");
    const registry = createProjectRegistry();
    const registered = await registry.get(project);
    if (!registered) throw new Error(`项目未注册：${project}`);

    const response = await exploreSymbol({
      home: resolveCodeIntelHomeLocal(),
      project,
      root: registered.path,
      gitnexusRepo: registered.gitnexus_repo,
      type,
      query: options.query,
      direction,
      depth,
      limit,
      relationBudget,
      mainPathLimit,
      excludeTests: options.includeTests ? false : true
    });

    printJson(response);
  });

program
  .command("trace")
  .description("使用 GitNexus 查询两个符号之间的调用链")
  .argument("<project>")
  .requiredOption("--from <symbol>")
  .requiredOption("--to <symbol>")
  .option("--from-uid <uid>", "GitNexus 源符号 UID，用于消除重名歧义")
  .option("--from-file <path>", "GitNexus 源符号文件路径，用于消除重名歧义")
  .option("--to-uid <uid>", "GitNexus 目标符号 UID，用于消除重名歧义")
  .option("--to-file <path>", "GitNexus 目标符号文件路径，用于消除重名歧义")
  .option("--depth <depth>", "最大跳数", "10")
  .option("--json", "以 JSON 输出，当前默认即为 JSON")
  .action(async (
    project: string,
    options: {
      from: string;
      to: string;
      fromUid?: string;
      fromFile?: string;
      toUid?: string;
      toFile?: string;
      depth: string;
    }
  ) => {
    const depth = parseLimit(options.depth);
    const { createProjectRegistry, traceCallChain } = await import("@code-intelligence/core");
    const registry = createProjectRegistry();
    const registered = await registry.get(project);
    if (!registered) throw new Error(`项目未注册：${project}`);

    const response = await traceCallChain({
      home: resolveCodeIntelHomeLocal(),
      project,
      root: registered.path,
      gitnexusRepo: registered.gitnexus_repo,
      from: options.from,
      to: options.to,
      fromUid: options.fromUid,
      fromFile: options.fromFile,
      toUid: options.toUid,
      toFile: options.toFile,
      depth
    });

    printJson(response);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parseQueryType(value: string | undefined): QueryType | undefined {
  if (value === undefined) return undefined;

  const validTypes = new Set<QueryType>([
    "route",
    "error",
    "sql",
    "table",
    "symbol",
    "keyword",
    "semantic",
    "call_chain"
  ]);
  if (validTypes.has(value as QueryType)) return value as QueryType;

  throw new Error(`查询类型不支持：${value}`);
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit 必须是正整数");
  }

  return limit;
}

function parseDepth(value: string): number {
  const depth = parseLimit(value);
  if (depth > 4) {
    throw new Error("depth 最大支持 4");
  }
  return depth;
}

function parseExploreDirection(value: string): ExploreDirection {
  if (value === "upstream" || value === "downstream" || value === "both") return value;
  throw new Error(`探索方向不支持：${value}，可选值：upstream|downstream|both`);
}

function parseGitNexusIndexMode(value: string, withGitNexus: boolean): GitNexusIndexMode {
  if (withGitNexus && value === "auto") return "basic";

  const modes = new Set<GitNexusIndexMode>(["auto", "none", "basic", "full"]);
  if (modes.has(value as GitNexusIndexMode)) return value as GitNexusIndexMode;

  throw new Error(`GitNexus 索引模式不支持：${value}，可选值：auto|none|basic|full`);
}

function logIndexProgress(event: IndexProjectProgressEvent): void {
  const elapsed = event.elapsed_ms === undefined ? "" : ` ${event.elapsed_ms}ms`;
  const stream = event.stream === undefined ? "" : `/${event.stream}`;
  console.error(`[code-intel] ${event.phase}${stream}: ${event.message}${elapsed}`);
}

function resolveCodeIntelHomeLocal(env = process.env): string {
  return env.CODE_INTEL_HOME && env.CODE_INTEL_HOME.trim().length > 0
    ? resolve(env.CODE_INTEL_HOME.trim())
    : join(homedir(), ".code-intelligence");
}
