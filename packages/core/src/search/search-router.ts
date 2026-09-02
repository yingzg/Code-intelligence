import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { projectDataDir } from "../paths.js";
import type { CodeLocation, Diagnostic, QueryType, SearchResponse, Stack } from "../schemas.js";
import { SearchResponseSchema } from "../schemas.js";
import type { ErrorIndexEntry } from "../indexer/error-indexer.js";
import type { RouteIndexEntry } from "../indexer/route-indexer.js";
import type { SemanticLiteEntry } from "../indexer/semantic-lite-indexer.js";
import { searchSemanticLite } from "../indexer/semantic-lite-indexer.js";
import type { SqlIndexEntry } from "../indexer/sql-indexer.js";
import { readGitState } from "../git.js";
import { inspectGitNexus } from "../gitnexus.js";
import { createGitNexusAdapter } from "../gitnexus/adapter.js";
import {
  type GitNexusDefinition,
  findUnknownGitNexusRelationTypes,
  gitNexusRelationsUnavailableDiagnostic,
  gitNexusRelationsUsedDiagnostic,
  gitNexusUnknownRelationTypesDiagnostic,
  mapGitNexusDefinitionsToLocations,
  mapGitNexusContextToRelations
} from "../gitnexus/mapper.js";
import { grepSearch } from "./grep-searcher.js";
import { classifyFreshness } from "../indexer/index-project.js";
import { classifyQuery } from "./query-classifier.js";
import { downgradeForStale } from "./confidence.js";
import type { CodeRelation } from "../schemas.js";

const DEFAULT_LIMIT = 10;

type Manifest = {
  project: string;
  path: string;
  indexed_at?: string;
  indexed_commit?: string;
  dirty_flag?: boolean;
  gitnexus_status?: {
    installed: boolean;
    repo_index_exists: boolean;
    message?: string;
  };
  generated_files?: string[];
  warnings?: string[];
  errors?: string[];
};

type IndexState = "ready" | "missing" | "stale" | "partial";

export async function searchCode(input: {
  home: string;
  project: string;
  root: string;
  gitnexusRepo?: string;
  type?: QueryType;
  query: string;
  limit?: number;
  includeRelations?: boolean;
}): Promise<SearchResponse> {
  const queryType = classifyQuery(input.query, input.type);
  const limit = normalizeLimit(input.limit);
  const diagnostics: Diagnostic[] = [];
  const manifest = await readManifest(input.home, input.project);
  const currentGit = await readGitState(input.root);
  const requiredFiles = requiredIndexFiles(queryType);
  const missingFiles = manifest
    ? await findMissingIndexFiles(input.home, input.project, requiredFiles)
    : requiredFiles;
  const manifestMismatch = manifest !== undefined && !manifestMatchesInput(manifest, input.project, input.root);
  const freshness = manifest
    ? classifyFreshness({
        indexed_commit: manifest.indexed_commit,
        current_commit: currentGit.commit_hash,
        indexed_dirty: Boolean(manifest.dirty_flag),
        current_dirty: currentGit.dirty
      }).state
    : "missing";
  const stale = manifestMismatch || freshness === "stale";
  let indexState: IndexState = manifest
    ? (freshness as IndexState)
    : "missing";

  if (stale) indexState = "stale";
  if (manifest && missingFiles.length > 0) indexState = "partial";

  if (!manifest) {
    diagnostics.push({
      level: "warning",
      code: "INDEX_MISSING",
      message: "未找到项目索引，已尝试使用 grep 兜底。",
      suggested_action: `code-intel index ${input.project}`
    });
  } else if (stale) {
    diagnostics.push({
      level: "warning",
      code: "INDEX_STALE",
      message: manifestMismatch ? "索引所属项目或路径与当前查询不一致，结果置信度会降低。" : "索引可能已过期，结果置信度会降低。",
      suggested_action: `code-intel index ${input.project}`
    });
  }
  if (manifest && missingFiles.length > 0) {
    for (const file of missingFiles) {
      diagnostics.push({
        level: "warning",
        code: file === "semantic-lite.jsonl" ? "SEMANTIC_INDEX_MISSING" : "INDEX_MISSING",
        message: `索引文件缺失：${file}`,
        suggested_action: `code-intel index ${input.project}`
      });
    }
  }

  let locations = manifest
    ? await searchIndexedLocations({
        home: input.home,
        project: input.project,
        query: input.query,
        type: queryType,
        limit,
        stale
      })
    : [];

  if (shouldUseGitNexusQuery(queryType, input.includeRelations)) {
    const gitnexusLocations = await searchGitNexusLocations({
      project: input.project,
      root: input.root,
      gitnexusRepo: input.gitnexusRepo,
      query: input.query,
      limit,
      diagnostics
    });
    locations = dedupeLocations(locations.concat(gitnexusLocations)).slice(0, limit);
  }

  if (locations.length === 0) {
    const grepLocations = await grepSearch({
      project: input.project,
      root: input.root,
      query: input.query,
      limit
    });

    diagnostics.push({
      level: "info",
      code: "GREP_FALLBACK_USED",
      message: "结构化索引未命中，已使用 grep 兜底。"
    });

    if (grepLocations.length > 0) {
      locations.push(...grepLocations);
    }
  }
  if (locations.length === 0 && !diagnostics.some((item) => item.code === "LOW_CONFIDENCE")) {
    diagnostics.push({
      level: "warning",
      code: "LOW_CONFIDENCE",
      message: "未找到可用代码证据，当前结果置信度较低。"
    });
  }
  const relations = input.includeRelations
    ? await enrichRelations({
        project: input.project,
        root: input.root,
        gitnexusRepo: input.gitnexusRepo,
        locations,
        limit,
        diagnostics
      })
    : [];

  const response: SearchResponse = {
    request_id: createRequestId(),
    project: {
      name: input.project,
      path: input.root,
      stack: "java-generic" satisfies Stack,
      gitnexus_repo: input.gitnexusRepo,
      commit_hash: currentGit.commit_hash,
      dirty: currentGit.dirty
    },
    query: {
      type: queryType,
      text: input.query
    },
    index_status: {
      state: indexState,
      indexed_at: manifest?.indexed_at,
      indexed_commit: manifest?.indexed_commit,
      current_commit: currentGit.commit_hash,
      message: manifest ? undefined : "索引不存在",
      suggested_command: manifest ? undefined : `code-intel index ${input.project}`
    },
    summary: summarize(queryType, locations.length),
    locations: locations.slice(0, limit),
    relations,
    diagnostics
  };

  return SearchResponseSchema.parse(response);
}

async function searchGitNexusLocations(input: {
  project: string;
  root: string;
  gitnexusRepo?: string;
  query: string;
  limit: number;
  diagnostics: Diagnostic[];
}): Promise<CodeLocation[]> {
  const gitnexus = await inspectGitNexus(input.root);
  if (!gitnexus.installed || !gitnexus.repo_index_exists) {
    return [];
  }

  try {
    const adapter = createGitNexusAdapter();
    const repo = input.gitnexusRepo ?? input.project;
    const result = await adapter.query({
      repoPath: input.root,
      repo,
      query: input.query,
      limit: input.limit
    });
    const definitions = normalizeGitNexusDefinitions(result);
    return await mapGitNexusDefinitionsToLocations({
      project: input.project,
      root: input.root,
      definitions
    });
  } catch (error) {
    input.diagnostics.push({
      level: "warning",
      code: "GITNEXUS_QUERY_FAILED",
      message: `GitNexus query 查询失败：${errorMessage(error)}`
    });
    return [];
  }
}

async function enrichRelations(input: {
  project: string;
  root: string;
  gitnexusRepo?: string;
  locations: CodeLocation[];
  limit: number;
  diagnostics: Diagnostic[];
}): Promise<CodeRelation[]> {
  const gitnexus = await inspectGitNexus(input.root);
  if (!gitnexus.installed || !gitnexus.repo_index_exists) {
    input.diagnostics.push(gitNexusRelationsUnavailableDiagnostic());
    return [];
  }

  const adapter = createGitNexusAdapter();
  const repo = input.gitnexusRepo ?? input.project;
  const symbolLocations = input.locations
    .filter((location) => location.symbol !== undefined && location.symbol.trim().length > 0)
    .slice(0, input.limit);

  const relationGroups = await Promise.all(
    symbolLocations.map(async (location) => {
      try {
        const context = await adapter.context({
          repoPath: input.root,
          repo,
          symbol: location.symbol!,
          limit: input.limit
        });
        return mapGitNexusContextToRelations({
          fromLocationId: location.id,
          context: normalizeGitNexusContext(context)
        });
      } catch (error) {
        input.diagnostics.push({
          level: "warning",
          code: "GITNEXUS_QUERY_FAILED",
          message: `GitNexus context 查询失败：${errorMessage(error)}`
        });
        return [];
      }
    })
  );

  const relations: CodeRelation[] = relationGroups.flat();

  const dedupedRelations = dedupeRelations(relations).slice(0, input.limit);
  const unknownRelationTypes = findUnknownGitNexusRelationTypes(dedupedRelations);

  if (dedupedRelations.length > 0) {
    input.diagnostics.push(gitNexusRelationsUsedDiagnostic(dedupedRelations.length));
    if (unknownRelationTypes.length > 0) {
      input.diagnostics.push(gitNexusUnknownRelationTypesDiagnostic(unknownRelationTypes));
    }
  } else {
    input.diagnostics.push(gitNexusRelationsUnavailableDiagnostic());
  }

  return dedupedRelations;
}

function normalizeGitNexusDefinitions(value: unknown): GitNexusDefinition[] {
  if (Array.isArray(value)) {
    return value.map(normalizeGitNexusDefinition).filter((item): item is GitNexusDefinition => item !== undefined);
  }
  if (!isRecord(value)) return [];

  const candidates = [
    value.definitions,
    value.results,
    value.items,
    value.nodes
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate
      .map(normalizeGitNexusDefinition)
      .filter((item): item is GitNexusDefinition => item !== undefined);
  }

  return [];
}

function normalizeGitNexusDefinition(value: unknown): GitNexusDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringField(value, "id") ?? stringField(value, "uid");
  const name = stringField(value, "name") ?? stringField(value, "symbol") ?? id;
  const filePath = stringField(value, "filePath") ?? stringField(value, "file") ?? stringField(value, "path");
  if (!id || !name || !filePath) return undefined;

  return {
    id,
    name,
    filePath,
    startLine: numberField(value, "startLine") ?? numberField(value, "start_line") ?? numberField(value, "line"),
    endLine: numberField(value, "endLine") ?? numberField(value, "end_line")
  };
}

function normalizeGitNexusContext(value: unknown): Parameters<typeof mapGitNexusContextToRelations>[0]["context"] {
  if (!isRecord(value)) return {};
  return {
    incoming: isRecord(value.incoming) ? normalizeEdgeMap(value.incoming) : undefined,
    outgoing: isRecord(value.outgoing) ? normalizeEdgeMap(value.outgoing) : undefined,
    typed_properties: Array.isArray(value.typed_properties)
      ? value.typed_properties.filter(isGitNexusTarget)
      : undefined
  };
}

function normalizeEdgeMap(value: Record<string, unknown>): Record<string, Array<{ uid: string; name: string; filePath: string }>> {
  const result: Record<string, Array<{ uid: string; name: string; filePath: string }>> = {};
  for (const [key, items] of Object.entries(value)) {
    if (!Array.isArray(items)) continue;
    result[key] = items.filter(isGitNexusTarget);
  }
  return result;
}

function isGitNexusTarget(value: unknown): value is { uid: string; name: string; filePath: string } {
  return isRecord(value) &&
    typeof value.uid === "string" &&
    typeof value.name === "string" &&
    typeof value.filePath === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function dedupeLocations(locations: CodeLocation[]): CodeLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = location.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeRelations(relations: CodeRelation[]): CodeRelation[] {
  const seen = new Set<string>();
  return relations.filter((relation) => {
    const key = `${relation.from}\u0000${relation.to}\u0000${relation.relation_type}\u0000${relation.raw_relation_type ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shouldUseGitNexusQuery(type: QueryType, includeRelations: boolean | undefined): boolean {
  return includeRelations === true || type === "semantic" || type === "symbol" || type === "keyword";
}

async function searchIndexedLocations(input: {
  home: string;
  project: string;
  query: string;
  type: QueryType;
  limit: number;
  stale: boolean;
}): Promise<CodeLocation[]> {
  if (input.type === "route") {
    const routes = await readJsonl<RouteIndexEntry>(indexFile(input.home, input.project, "java-route-map.jsonl"));
    const routeQuery = parseRouteQuery(input.query);
    return routes
      .filter((route) =>
        (routeQuery.method === undefined || route.http_method === routeQuery.method) &&
        (route.route.includes(routeQuery.route) || routeQuery.route.includes(route.route))
      )
      .slice(0, input.limit)
      .map((route) => routeToLocation(route, input.stale));
  }

  if (input.type === "table" || input.type === "sql") {
    const sql = await readJsonl<SqlIndexEntry>(indexFile(input.home, input.project, "java-sql-map.jsonl"));
    const query = input.query.toLowerCase();
    return sql
      .filter((entry) => entry.table.toLowerCase().includes(query) || entry.sql_excerpt.toLowerCase().includes(query))
      .slice(0, input.limit)
      .map((entry) => sqlToLocation(entry, input.stale));
  }

  if (input.type === "error") {
    const errors = await readJsonl<ErrorIndexEntry>(indexFile(input.home, input.project, "error-map.jsonl"));
    return errors
      .filter((entry) => entry.token.includes(input.query) || input.query.includes(entry.token))
      .slice(0, input.limit)
      .map((entry) => errorToLocation(entry, input.stale));
  }

  if (input.type === "symbol") {
    const query = input.query.toLowerCase();
    const routes = await readJsonl<RouteIndexEntry>(indexFile(input.home, input.project, "java-route-map.jsonl"));
    const routeLocations = routes
      .filter((route) => route.symbol.toLowerCase().includes(query))
      .map((route) => routeToLocation(route, input.stale));
    const sql = await readJsonl<SqlIndexEntry>(indexFile(input.home, input.project, "java-sql-map.jsonl"));
    const sqlLocations = sql
      .filter((entry) =>
        (entry.mapper_id?.toLowerCase().includes(query) ?? false) ||
        (entry.namespace?.toLowerCase().includes(query) ?? false)
      )
      .map((entry) => sqlToLocation(entry, input.stale));

    return routeLocations.concat(sqlLocations).slice(0, input.limit);
  }

  if (input.type === "semantic") {
    const semantic = await readJsonl<SemanticLiteEntry>(indexFile(input.home, input.project, "semantic-lite.jsonl"));
    return searchSemanticLite(semantic, input.query, input.limit).map((entry) => semanticToLocation(entry, input.stale));
  }

  return [];
}

function routeToLocation(entry: RouteIndexEntry, stale: boolean): CodeLocation {
  return {
    id: entry.id,
    project: entry.project,
    file: entry.file,
    start_line: entry.line,
    end_line: entry.line,
    symbol: entry.symbol,
    language: "java",
    location_type: entry.location_type,
    snippet: entry.snippet,
    match_reason: `Spring 路由索引命中 ${entry.http_method ? `${entry.http_method} ` : ""}${entry.route}`,
    score: stale ? 0.8 : 1,
    confidence: downgradeForStale("high", stale),
    source: "java_index"
  };
}

function sqlToLocation(entry: SqlIndexEntry, stale: boolean): CodeLocation {
  return {
    id: entry.id,
    project: entry.project,
    file: entry.file,
    start_line: entry.line,
    end_line: entry.line,
    symbol: entry.mapper_id,
    language: entry.file.endsWith(".xml") ? "xml" : "java",
    location_type: "sql",
    snippet: entry.sql_excerpt,
    match_reason: `SQL 索引命中表 ${entry.table}`,
    score: stale ? 0.8 : 1,
    confidence: downgradeForStale("high", stale),
    source: "java_index"
  };
}

function errorToLocation(entry: ErrorIndexEntry, stale: boolean): CodeLocation {
  return {
    id: entry.id,
    project: entry.project,
    file: entry.file,
    start_line: entry.line,
    end_line: entry.line,
    language: "java",
    location_type: errorLocationType(entry.kind),
    snippet: entry.snippet,
    match_reason: `错误信号索引命中 ${entry.kind}: ${entry.token}`,
    score: stale ? 0.8 : 1,
    confidence: downgradeForStale("high", stale),
    source: "java_index"
  };
}

function semanticToLocation(entry: SemanticLiteEntry, stale: boolean): CodeLocation {
  return {
    id: entry.id,
    project: entry.project,
    file: entry.file,
    language: languageFromFile(entry.file),
    location_type: "unknown",
    snippet: entry.text,
    match_reason: stale ? "semantic-lite 轻量语义索引命中，但索引可能过期。" : "semantic-lite 轻量语义索引命中。",
    score: stale ? 0.4 : 0.6,
    confidence: downgradeForStale("medium", stale),
    source: "semantic_lite"
  };
}

function errorLocationType(kind: ErrorIndexEntry["kind"]): CodeLocation["location_type"] {
  if (kind === "log_statement") return "log_statement";
  if (kind === "error_code") return "constant";
  return "exception";
}

function languageFromFile(file: string): CodeLocation["language"] {
  if (file.endsWith(".java")) return "java";
  if (file.endsWith(".xml")) return "xml";
  if (file.endsWith(".yml") || file.endsWith(".yaml")) return "yaml";
  if (file.endsWith(".properties")) return "properties";
  if (file.endsWith(".sql")) return "sql";
  return "unknown";
}

async function readManifest(home: string, project: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(indexFile(home, project, "manifest.json"), "utf8")) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function indexFile(home: string, project: string, file: string): string {
  return join(projectDataDir(home, project), file);
}

function requiredIndexFiles(type: QueryType): string[] {
  if (type === "route") return ["java-route-map.jsonl"];
  if (type === "symbol") return ["java-route-map.jsonl", "java-sql-map.jsonl"];
  if (type === "table" || type === "sql") return ["java-sql-map.jsonl"];
  if (type === "error") return ["error-map.jsonl"];
  if (type === "semantic") return ["semantic-lite.jsonl"];
  return [];
}

function parseRouteQuery(query: string): { method?: string; route: string } {
  const match = query.trim().match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/i);
  if (!match) return { route: query.trim() };

  return {
    method: match[1].toUpperCase(),
    route: match[2].trim()
  };
}

async function findMissingIndexFiles(home: string, project: string, files: string[]): Promise<string[]> {
  const missing: string[] = [];

  for (const file of files) {
    try {
      await access(indexFile(home, project, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(file);
      } else {
        throw error;
      }
    }
  }

  return missing;
}

function manifestMatchesInput(manifest: Manifest, project: string, root: string): boolean {
  return manifest.project === project && resolve(manifest.path) === resolve(root);
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.floor(limit));
}

function summarize(type: QueryType, count: number): string {
  if (count === 0) return `未找到 ${type} 类型的高置信代码位置。`;
  return `找到 ${count} 个 ${type} 类型候选位置。`;
}

function createRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
