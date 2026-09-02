import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, writeJsonFile } from "../fs-utils.js";
import { readGitState } from "../git.js";
import {
  inspectGitNexus,
  runGitNexusAnalyze,
  type GitNexusIndexMode,
  type GitNexusProgressEvent
} from "../gitnexus.js";
import { projectDataDir } from "../paths.js";
import { buildErrorIndex } from "./error-indexer.js";
import { buildRouteIndex } from "./route-indexer.js";
import { buildSemanticLiteIndex } from "./semantic-lite-indexer.js";
import { buildSqlIndex } from "./sql-indexer.js";

const GENERATED_INDEX_FILES = [
  "java-route-map.jsonl",
  "java-sql-map.jsonl",
  "error-map.jsonl",
  "semantic-lite.jsonl"
];
const TOOL_VERSION = "0.1.0";

export type FreshnessInput = {
  indexed_commit?: string;
  current_commit?: string;
  indexed_dirty: boolean;
  current_dirty: boolean;
};

export type FreshnessResult = {
  state: "ready" | "stale";
};

export type IndexProjectResult = {
  state: "ready" | "partial";
  gitnexus_mode: GitNexusIndexMode;
  counts: IndexProjectCounts;
  timings_ms: IndexProjectTimings;
  warnings: string[];
  errors: string[];
};

export type IndexProjectCounts = {
  routes: number;
  sql: number;
  errors: number;
  semantic: number;
};

export type IndexProjectTimings = {
  gitnexus: number;
  git_state: number;
  route_index: number;
  sql_index: number;
  error_index: number;
  semantic_index: number;
  write_files: number;
  manifest: number;
  total: number;
};

export type IndexProjectProgressEvent = {
  phase:
    | "gitnexus"
    | "git_state"
    | "route_index"
    | "sql_index"
    | "error_index"
    | "semantic_index"
    | "write_files"
    | "manifest";
  message: string;
  elapsed_ms?: number;
  stream?: GitNexusProgressEvent["stream"];
};

export function classifyFreshness(input: FreshnessInput): FreshnessResult {
  if (Boolean(input.indexed_commit) !== Boolean(input.current_commit)) {
    return { state: "stale" };
  }
  if (input.indexed_commit && input.current_commit && input.indexed_commit !== input.current_commit) {
    return { state: "stale" };
  }
  if (input.indexed_dirty || input.current_dirty) {
    return { state: "stale" };
  }
  if (input.indexed_dirty !== input.current_dirty) {
    return { state: "stale" };
  }

  return { state: "ready" };
}

export async function indexProject(input: {
  home: string;
  name: string;
  path: string;
  withGitNexus?: boolean;
  gitnexusMode?: GitNexusIndexMode;
  onProgress?: (event: IndexProjectProgressEvent) => void;
}): Promise<IndexProjectResult> {
  const totalStartedAt = Date.now();
  const dir = projectDataDir(input.home, input.name);
  await ensureDir(dir);

  const warnings: string[] = [];
  const errors: string[] = [];
  const timings: Omit<IndexProjectTimings, "total"> = {
    gitnexus: 0,
    git_state: 0,
    route_index: 0,
    sql_index: 0,
    error_index: 0,
    semantic_index: 0,
    write_files: 0,
    manifest: 0
  };
  const gitnexusMode = resolveGitNexusMode(input);

  let gitnexus = await timeStage(timings, "gitnexus", input.onProgress, async () => {
    const status = await inspectGitNexus(input.path);
    return await maybeRunGitNexus({
      project: input.name,
      repoPath: input.path,
      mode: gitnexusMode,
      initialStatus: status,
      warnings,
      onProgress: input.onProgress
    });
  });

  const git = await timeStage(timings, "git_state", input.onProgress, () => readGitState(input.path));
  const routes = await timeStage(timings, "route_index", input.onProgress, () => buildRouteIndex({
    project: input.name,
    root: input.path
  }));
  const sql = await timeStage(timings, "sql_index", input.onProgress, () => buildSqlIndex({
    project: input.name,
    root: input.path
  }));
  const indexErrors = await timeStage(timings, "error_index", input.onProgress, () => buildErrorIndex({
    project: input.name,
    root: input.path
  }));
  const semantic = await timeStage(timings, "semantic_index", input.onProgress, () => buildSemanticLiteIndex({
    project: input.name,
    root: input.path
  }));
  const counts: IndexProjectCounts = {
    routes: routes.length,
    sql: sql.length,
    errors: indexErrors.length,
    semantic: semantic.length
  };

  await timeStage(timings, "write_files", input.onProgress, async () => {
    await writeJsonl(join(dir, "java-route-map.jsonl"), routes);
    await writeJsonl(join(dir, "java-sql-map.jsonl"), sql);
    await writeJsonl(join(dir, "error-map.jsonl"), indexErrors);
    await writeJsonl(join(dir, "semantic-lite.jsonl"), semantic);
  });

  const manifest = {
    tool_version: TOOL_VERSION,
    project: input.name,
    path: input.path,
    indexed_at: new Date().toISOString(),
    indexed_commit: git.commit_hash,
    dirty_flag: git.dirty,
    gitnexus_status: gitnexus,
    gitnexus_mode: gitnexusMode,
    generated_files: GENERATED_INDEX_FILES,
    counts,
    timings_ms: {
      ...timings,
      total: Date.now() - totalStartedAt
    },
    warnings,
    errors
  };
  await timeStage(timings, "manifest", input.onProgress, async () => {
    await writeJsonFile(join(dir, "manifest.json"), {
      ...manifest,
      timings_ms: {
        ...timings,
        total: Date.now() - totalStartedAt
      }
    });
  });

  const finalTimings = {
    ...timings,
    total: Date.now() - totalStartedAt
  };

  return {
    state: warnings.length > 0 ? "partial" : "ready",
    gitnexus_mode: gitnexusMode,
    counts,
    timings_ms: finalTimings,
    warnings,
    errors
  };
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  const content = rows.length > 0
    ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
    : "";

  await writeFile(path, content, "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveGitNexusMode(input: { gitnexusMode?: GitNexusIndexMode; withGitNexus?: boolean }): GitNexusIndexMode {
  if (input.gitnexusMode) return input.gitnexusMode;
  if (input.withGitNexus) return "basic";
  return "auto";
}

async function maybeRunGitNexus(input: {
  project: string;
  repoPath: string;
  mode: GitNexusIndexMode;
  initialStatus: Awaited<ReturnType<typeof inspectGitNexus>>;
  warnings: string[];
  onProgress?: (event: IndexProjectProgressEvent) => void;
}): Promise<Awaited<ReturnType<typeof inspectGitNexus>>> {
  let gitnexus = input.initialStatus;

  if (input.mode === "none") {
    input.onProgress?.({ phase: "gitnexus", message: "skipped by --gitnexus-mode none" });
    if (!gitnexus.repo_index_exists) {
      input.warnings.push(`GitNexus 索引不存在；调用链能力会降级。可执行 code-intel index ${input.project} --gitnexus-mode basic`);
    }
    return gitnexus;
  }

  if (!gitnexus.installed) {
    input.warnings.push("GitNexus 命令不可用；已跳过 GitNexus 分析，本地 Java 索引仍会生成。");
    return gitnexus;
  }

  const shouldAnalyze = input.mode === "basic"
    || input.mode === "full"
    || !gitnexus.repo_index_exists
    || gitnexus.freshness === "stale";
  if (!shouldAnalyze) {
    input.onProgress?.({
      phase: "gitnexus",
      message: `existing GitNexus index kept (${gitnexus.freshness})`
    });
    return gitnexus;
  }

  try {
    const profile = input.mode === "full" ? "full" : "basic";
    await runGitNexusAnalyze(input.repoPath, {
      profile,
      onProgress: (event) => input.onProgress?.(event)
    });
    gitnexus = await inspectGitNexus(input.repoPath);
    if (!gitnexus.repo_index_exists) {
      input.warnings.push("GitNexus 分析已执行，但未发现 .gitnexus 索引目录；调用链能力会降级。");
    }
  } catch (error) {
    input.warnings.push(`GitNexus 分析失败；调用链能力会降级：${errorMessage(error)}`);
    gitnexus = await inspectGitNexus(input.repoPath);
  }

  return gitnexus;
}

async function timeStage<T>(
  timings: Omit<IndexProjectTimings, "total">,
  phase: keyof Omit<IndexProjectTimings, "total">,
  onProgress: ((event: IndexProjectProgressEvent) => void) | undefined,
  work: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  onProgress?.({ phase, message: "started" });
  try {
    return await work();
  } finally {
    const elapsed = Date.now() - startedAt;
    timings[phase] = elapsed;
    onProgress?.({ phase, message: "completed", elapsed_ms: elapsed });
  }
}
