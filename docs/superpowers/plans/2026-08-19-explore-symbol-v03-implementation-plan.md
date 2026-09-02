# Explore Symbol v0.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Code Intelligence v0.3 `explore_symbol`, a production-oriented candidate path exploration MVP that starts from one clue and returns `anchors + relations + candidate_paths + diagnostics`.

**Architecture:** Add an independent `ExploreResponse` contract beside `SearchResponse`, reuse `searchCode()` to find anchors, reuse GitNexus `context` to expand relations, then assemble conservative `candidate_paths` with explicit `path_status`, `confidence`, evidence sources, and diagnostics. CLI and MCP call the same core `exploreSymbol()` API.

**Tech Stack:** TypeScript, Zod schemas, Vitest, Commander CLI, MCP stdio server, local GitNexus `.gitnexus/run.cjs`.

---

## Scope

This plan implements v0.3 only.

It does:

- Add `ExploreResponse` and `CodePath` schema/types.
- Add `exploreSymbol()` core API.
- Add bounded one-hop/two-hop GitNexus context expansion.
- Add conservative `candidate_paths` extraction.
- Add CLI command `code-intel explore`.
- Add MCP tool `code.explore_symbol`.
- Add tests for success, degraded, ambiguous, and limit/depth behavior.
- Update user-facing docs after implementation.

It does not:

- Promise complete call chains.
- Implement v0.4 shortcut commands such as `find-callers` or `find-entry-paths`.
- Implement cross-project tracing.
- Implement PDG/data-flow.
- Implement business flowchart Skill.
- Parallelize indexers.

## File Structure

Create:

- `packages/core/src/search/explore-symbol.ts`  
  Owns `exploreSymbol()`, context expansion, relation filtering, candidate path extraction, diagnostics, and summary creation.

- `packages/core/tests/explore-symbol.test.ts`  
  Core tests for anchor search, GitNexus context expansion, `candidate_paths`, diagnostics, and limits.

Modify:

- `packages/core/src/schemas.ts`  
  Add `CodePathSchema`, `ExploreResponseSchema`, `ExploreDirectionSchema`, `PathStatusSchema`, extra diagnostic codes.

- `packages/core/src/index.ts`  
  Export `explore-symbol.ts`.

- `packages/cli/src/index.ts`  
  Add `explore` command and input parsers.

- `packages/cli/tests/cli.test.ts`  
  Add CLI tests for `explore`.

- `packages/mcp/src/server.ts`  
  Add `code.explore_symbol` handler and registration.

- `packages/mcp/tests/mcp-tools.test.ts`  
  Add MCP handler tests.

- `docs/user-guide.zh-CN.md`  
  Add user guide for `explore`.

- `docs/current-tool-capabilities.zh-CN.md`  
  Update current tool capability conclusion after implementation.

- `docs/code-intelligence-pitfalls-and-evolution.zh-CN.md`  
  Add v0.3 lesson: candidate paths vs complete paths.

## Task 1: Extend Schemas

**Files:**

- Modify: `packages/core/src/schemas.ts`
- Test: `packages/core/tests/schemas.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add tests to `packages/core/tests/schemas.test.ts`:

```ts
import {
  CodePathSchema,
  ExploreResponseSchema
} from "../src/schemas.js";

it("validates candidate code paths with explicit status and evidence sources", () => {
  expect(CodePathSchema.parse({
    id: "path_1",
    path_type: "downstream",
    path_status: "candidate",
    nodes: [
      {
        id: "Method:src/A.java:A.run#0",
        project: "p",
        file: "src/A.java",
        start_line: 10,
        symbol: "A.run",
        language: "java",
        location_type: "service",
        snippet: "void run() {}",
        match_reason: "anchor",
        score: 0.8,
        confidence: "medium",
        source: "gitnexus"
      }
    ],
    relations: [],
    depth: 0,
    confidence: "medium",
    evidence_sources: ["gitnexus"],
    diagnostics: [],
    summary: "候选路径：A.run"
  })).toMatchObject({
    path_status: "candidate",
    evidence_sources: ["gitnexus"]
  });
});

it("validates explore responses separately from search responses", () => {
  expect(ExploreResponseSchema.parse({
    request_id: "req_1",
    project: {
      name: "p",
      path: "/repo",
      stack: "java-generic",
      dirty: false
    },
    query: {
      type: "symbol",
      text: "A.run"
    },
    index_status: {
      state: "ready"
    },
    anchors: [],
    relations: [],
    candidate_paths: [],
    diagnostics: [
      {
        level: "info",
        code: "PATH_VERIFICATION_SKIPPED",
        message: "v0.3 返回候选路径，不把候选路径标记为完整调用链。"
      }
    ],
    summary: "未找到候选路径。"
  })).toMatchObject({
    request_id: "req_1",
    candidate_paths: []
  });
});
```

- [ ] **Step 2: Run schema tests and confirm failure**

Run:

```bash
npm run test -- packages/core/tests/schemas.test.ts
```

Expected: fail because `CodePathSchema` and `ExploreResponseSchema` are not exported yet.

- [ ] **Step 3: Add schema definitions**

In `packages/core/src/schemas.ts`, add diagnostic codes:

```ts
"ANCHOR_NOT_FOUND",
"ANCHOR_AMBIGUOUS",
"FANOUT_LIMIT_REACHED",
"UPSTREAM_DEPTH_LIMIT_REACHED",
"PATH_EXTRACTION_PARTIAL",
"PATH_TRUNCATED",
"PATH_VERIFICATION_SKIPPED"
```

Add schemas:

```ts
export const ExploreDirectionSchema = z.enum(["upstream", "downstream", "both"]);
export const PathTypeSchema = z.enum(["upstream", "downstream", "entry_path", "data_path", "sql_path", "unknown"]);
export const PathStatusSchema = z.enum(["candidate", "verified", "partial", "truncated"]);

export const CodePathSchema = z.object({
  id: z.string().min(1),
  path_type: PathTypeSchema,
  path_status: PathStatusSchema,
  nodes: z.array(CodeLocationSchema),
  relations: z.array(CodeRelationSchema),
  depth: z.number().int().min(0),
  confidence: ConfidenceSchema,
  evidence_sources: z.array(SourceSchema),
  diagnostics: z.array(DiagnosticSchema),
  summary: z.string().min(1)
}).strict();

export const ExploreResponseSchema = z.object({
  request_id: z.string().min(1),
  project: ProjectRefSchema,
  query: QueryRefSchema,
  index_status: IndexStatusSchema,
  anchors: z.array(CodeLocationSchema),
  relations: z.array(CodeRelationSchema),
  candidate_paths: z.array(CodePathSchema),
  diagnostics: z.array(DiagnosticSchema),
  summary: z.string()
}).strict();

export type ExploreDirection = z.infer<typeof ExploreDirectionSchema>;
export type CodePath = z.infer<typeof CodePathSchema>;
export type ExploreResponse = z.infer<typeof ExploreResponseSchema>;
```

- [ ] **Step 4: Run schema tests and confirm pass**

Run:

```bash
npm run test -- packages/core/tests/schemas.test.ts
```

Expected: pass.

## Task 2: Add Core Explore API Skeleton

**Files:**

- Create: `packages/core/src/search/explore-symbol.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/explore-symbol.test.ts`

- [ ] **Step 1: Write failing test for no anchors**

Create `packages/core/tests/explore-symbol.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexProject } from "../src/indexer/index-project.js";
import { exploreSymbol } from "../src/search/explore-symbol.js";

describe("exploreSymbol", () => {
  it("returns ANCHOR_NOT_FOUND when search cannot locate a starting point", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "NoSuchBusinessSymbolXYZ",
        direction: "both",
        depth: 2,
        limit: 10
      });

      expect(response.anchors).toHaveLength(0);
      expect(response.relations).toHaveLength(0);
      expect(response.candidate_paths).toHaveLength(0);
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "ANCHOR_NOT_FOUND"
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts
```

Expected: fail because `explore-symbol.ts` does not exist.

- [ ] **Step 3: Add minimal `exploreSymbol()` implementation**

Create `packages/core/src/search/explore-symbol.ts`:

```ts
import { readGitState } from "../git.js";
import type {
  CodeLocation,
  CodeRelation,
  Diagnostic,
  ExploreDirection,
  ExploreResponse,
  QueryType,
  Stack
} from "../schemas.js";
import { ExploreResponseSchema } from "../schemas.js";
import { searchCode } from "./search-router.js";

const DEFAULT_DEPTH = 2;
const DEFAULT_LIMIT = 20;
const DEFAULT_ANCHOR_LIMIT = 3;

export async function exploreSymbol(input: {
  home: string;
  project: string;
  root: string;
  gitnexusRepo?: string;
  query: string;
  type?: QueryType;
  direction?: ExploreDirection;
  depth?: number;
  limit?: number;
  excludeTests?: boolean;
  anchorLimit?: number;
}): Promise<ExploreResponse> {
  const direction = input.direction ?? "both";
  const depth = normalizeDepth(input.depth);
  const limit = normalizeLimit(input.limit);
  const anchorLimit = normalizeAnchorLimit(input.anchorLimit);
  const currentGit = await readGitState(input.root);
  const diagnostics: Diagnostic[] = [];
  const search = await searchCode({
    home: input.home,
    project: input.project,
    root: input.root,
    gitnexusRepo: input.gitnexusRepo,
    type: input.type,
    query: input.query,
    limit: anchorLimit,
    includeRelations: false
  });
  diagnostics.push(...search.diagnostics);

  const anchors = filterAnchors(search.locations, Boolean(input.excludeTests)).slice(0, anchorLimit);
  if (anchors.length === 0) {
    diagnostics.push({
      level: "warning",
      code: "ANCHOR_NOT_FOUND",
      message: "未找到可作为 explore 起点的代码位置。"
    });
  }

  const response: ExploreResponse = {
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
      type: search.query.type,
      text: input.query
    },
    index_status: search.index_status,
    anchors,
    relations: [] satisfies CodeRelation[],
    candidate_paths: [],
    diagnostics,
    summary: summarize(anchors.length, 0, direction, depth, limit)
  };

  return ExploreResponseSchema.parse(response);
}

function filterAnchors(locations: CodeLocation[], excludeTests: boolean): CodeLocation[] {
  if (!excludeTests) return locations;
  return locations.filter((location) => !location.file.includes("/src/test/") && !location.file.includes("\\src\\test\\"));
}

function normalizeDepth(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DEPTH;
  if (!Number.isInteger(value) || value <= 0) throw new Error("depth 必须是正整数");
  return Math.min(value, 4);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value <= 0) throw new Error("limit 必须是正整数");
  return value;
}

function normalizeAnchorLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ANCHOR_LIMIT;
  if (!Number.isInteger(value) || value <= 0) throw new Error("anchorLimit 必须是正整数");
  return value;
}

function summarize(anchorCount: number, relationCount: number, direction: ExploreDirection, depth: number, limit: number): string {
  return `找到 ${anchorCount} 个探索起点，${relationCount} 条关系证据。direction=${direction}, depth=${depth}, limit=${limit}。`;
}

function createRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
```

- [ ] **Step 4: Export API**

Modify `packages/core/src/index.ts`:

```ts
export * from "./search/explore-symbol.js";
```

- [ ] **Step 5: Run test and confirm pass**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts
```

Expected: pass.

## Task 3: Add GitNexus Context Expansion

**Files:**

- Modify: `packages/core/src/search/explore-symbol.ts`
- Test: `packages/core/tests/explore-symbol.test.ts`

- [ ] **Step 1: Write failing test with fake GitNexus context**

Append test:

```ts
it("expands downstream relations from GitNexus context", async () => {
  const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
  const root = join(process.cwd(), "fixtures/java-order-service");

  try {
    await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
    const response = await exploreSymbol({
      home,
      project: "trade-service",
      root,
      gitnexusRepo: "java-spring-mybatis-demo",
      query: "OrderController.detail",
      direction: "downstream",
      depth: 1,
      limit: 10,
      adapter: {
        context: async () => ({
          incoming: {
            calls: [
              { uid: "Method:src/main/java/com/example/trade/web/AdminController.java:AdminController.detail#0", name: "AdminController.detail", filePath: "src/main/java/com/example/trade/web/AdminController.java" }
            ]
          },
          outgoing: {
            calls: [
              { uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0", name: "OrderService.detail", filePath: "src/main/java/com/example/trade/service/OrderService.java" }
            ]
          },
          typed_properties: []
        })
      }
    });

    expect(response.anchors.length).toBeGreaterThan(0);
    expect(response.relations).toContainEqual(expect.objectContaining({
      relation_type: "calls",
      to: expect.stringContaining("OrderService.detail")
    }));
    expect(response.relations).not.toContainEqual(expect.objectContaining({
      from: expect.stringContaining("AdminController.detail")
    }));
    expect(response.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "GITNEXUS_RELATIONS_USED"
      })
    ]));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
```

The test requires adding an optional injected adapter to `exploreSymbol()` for deterministic unit tests.

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts
```

Expected: fail because `adapter` input and relation expansion are not implemented.

- [ ] **Step 3: Add expansion types and adapter injection**

In `packages/core/src/search/explore-symbol.ts`, import:

```ts
import { inspectGitNexus } from "../gitnexus.js";
import { createGitNexusAdapter } from "../gitnexus/adapter.js";
import {
  findUnknownGitNexusRelationTypes,
  gitNexusRelationsUnavailableDiagnostic,
  gitNexusRelationsUsedDiagnostic,
  gitNexusUnknownRelationTypesDiagnostic,
  mapGitNexusContextToRelations
} from "../gitnexus/mapper.js";
```

Extend input:

```ts
adapter?: Pick<ReturnType<typeof createGitNexusAdapter>, "context">
fanout?: number
```

Add helpers:

```ts
const DEFAULT_FANOUT = 10;

function normalizeFanout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FANOUT;
  if (!Number.isInteger(value) || value <= 0) throw new Error("fanout 必须是正整数");
  return value;
}

function relationAllowed(direction: ExploreDirection, relation: CodeRelation, anchorId: string): boolean {
  if (direction === "both") return true;
  if (direction === "downstream") return relation.from === anchorId;
  return relation.to === anchorId;
}
```

- [ ] **Step 4: Call GitNexus context for anchors**

Inside `exploreSymbol()` after anchors are built:

```ts
const fanout = normalizeFanout(input.fanout);
const relations = await expandAnchorRelations({
  root: input.root,
  project: input.project,
  gitnexusRepo: input.gitnexusRepo,
  anchors,
  direction,
  limit,
  fanout,
  diagnostics,
  adapter: input.adapter
});
```

Add `expandAnchorRelations()`:

```ts
async function expandAnchorRelations(input: {
  root: string;
  project: string;
  gitnexusRepo?: string;
  anchors: CodeLocation[];
  direction: ExploreDirection;
  limit: number;
  fanout: number;
  diagnostics: Diagnostic[];
  adapter?: Pick<ReturnType<typeof createGitNexusAdapter>, "context">;
}): Promise<CodeRelation[]> {
  if (input.anchors.length === 0) return [];

  if (!input.adapter) {
    const gitnexus = await inspectGitNexus(input.root);
    if (!gitnexus.installed || !gitnexus.repo_index_exists) {
      input.diagnostics.push(gitNexusRelationsUnavailableDiagnostic());
      return [];
    }
  }

  const adapter = input.adapter ?? createGitNexusAdapter();
  const repo = input.gitnexusRepo ?? input.project;
  const relations: CodeRelation[] = [];

  for (const anchor of input.anchors) {
    if (!anchor.symbol) continue;
    try {
      const context = await adapter.context({
        repoPath: input.root,
        repo,
        symbol: anchor.symbol,
        limit: input.fanout
      });
      const mapped = mapGitNexusContextToRelations({
        fromLocationId: anchor.id,
        context: normalizeGitNexusContext(context)
      }).filter((relation) => relationAllowed(input.direction, relation, anchor.id));
      relations.push(...mapped.slice(0, input.fanout));
      if (mapped.length > input.fanout) {
        input.diagnostics.push({
          level: "info",
          code: "FANOUT_LIMIT_REACHED",
          message: `anchor ${anchor.symbol} 的关系数量超过 fanout=${input.fanout}，已截断。`
        });
      }
      if (relations.length >= input.limit) {
        input.diagnostics.push({
          level: "info",
          code: "RELATION_LIMIT_REACHED",
          message: `关系数量达到 limit=${input.limit}，已停止扩展。`
        });
        break;
      }
    } catch (error) {
      input.diagnostics.push({
        level: "warning",
        code: "GITNEXUS_QUERY_FAILED",
        message: `GitNexus context 查询失败：${errorMessage(error)}`
      });
    }
  }

  const deduped = dedupeRelations(relations).slice(0, input.limit);
  if (deduped.length > 0) {
    input.diagnostics.push(gitNexusRelationsUsedDiagnostic(deduped.length));
    const unknownTypes = findUnknownGitNexusRelationTypes(deduped);
    if (unknownTypes.length > 0) {
      input.diagnostics.push(gitNexusUnknownRelationTypesDiagnostic(unknownTypes));
    }
  } else if (!input.diagnostics.some((item) => item.code === "GITNEXUS_QUERY_FAILED")) {
    input.diagnostics.push(gitNexusRelationsUnavailableDiagnostic());
  }

  return deduped;
}
```

Reuse normalization helpers from `search-router.ts` by copying only the small `normalizeGitNexusContext`, `isRecord`, and array normalization helpers into `explore-symbol.ts` for v0.3. Do not refactor shared helpers in this task; extract later only if duplication becomes painful.

- [ ] **Step 5: Run test and confirm pass**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts
```

Expected: pass.

## Task 4: Add Candidate Path Extraction

**Files:**

- Modify: `packages/core/src/search/explore-symbol.ts`
- Test: `packages/core/tests/explore-symbol.test.ts`

- [ ] **Step 1: Write failing tests for candidate paths**

Add tests:

```ts
it("builds candidate paths from anchor relations without marking them verified", async () => {
  const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
  const root = join(process.cwd(), "fixtures/java-order-service");

  try {
    await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
    const response = await exploreSymbol({
      home,
      project: "trade-service",
      root,
      query: "OrderController.detail",
      direction: "downstream",
      depth: 1,
      limit: 10,
      adapter: {
        context: async () => ({
          outgoing: {
            calls: [
              { uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0", name: "OrderService.detail", filePath: "src/main/java/com/example/trade/service/OrderService.java" }
            ]
          }
        })
      }
    });

    expect(response.candidate_paths).toHaveLength(1);
    expect(response.candidate_paths[0]).toMatchObject({
      path_type: "downstream",
      path_status: "candidate",
      confidence: "medium",
      evidence_sources: ["gitnexus"]
    });
    expect(response.candidate_paths[0].path_status).not.toBe("verified");
    expect(response.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "PATH_VERIFICATION_SKIPPED"
      })
    ]));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("marks candidate paths truncated when relation expansion exceeds the configured limit", async () => {
  const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
  const root = join(process.cwd(), "fixtures/java-order-service");

  try {
    await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
    const response = await exploreSymbol({
      home,
      project: "trade-service",
      root,
      query: "OrderController.detail",
      direction: "downstream",
      depth: 2,
      limit: 1,
      adapter: {
        context: async () => ({
          outgoing: {
            calls: [
              { uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0", name: "OrderService.detail", filePath: "src/main/java/com/example/trade/service/OrderService.java" },
              { uid: "Method:src/main/java/com/example/trade/service/PriceService.java:PriceService.detail#0", name: "PriceService.detail", filePath: "src/main/java/com/example/trade/service/PriceService.java" }
            ]
          }
        })
      }
    });

    expect(response.candidate_paths).toHaveLength(1);
    expect(response.candidate_paths[0].path_status).toBe("truncated");
    expect(response.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "RELATION_LIMIT_REACHED"
      })
    ]));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts
```

Expected: fail because `candidate_paths` are not built yet.

- [ ] **Step 3: Implement one-edge candidate path extraction**

Add helper:

```ts
function buildCandidatePaths(input: {
  anchors: CodeLocation[];
  relations: CodeRelation[];
  direction: ExploreDirection;
  depth: number;
  diagnostics: Diagnostic[];
}): CodePath[] {
  const paths: CodePath[] = [];
  const anchorsById = new Map(input.anchors.map((anchor) => [anchor.id, anchor]));

  for (const relation of input.relations) {
    const anchor = anchorsById.get(relation.from) ?? anchorsById.get(relation.to);
    if (!anchor) continue;
    const hasGlobalTruncation = input.diagnostics.some((item) =>
      item.code === "RELATION_LIMIT_REACHED"
      || item.code === "FANOUT_LIMIT_REACHED"
      || item.code === "DOWNSTREAM_DEPTH_LIMIT_REACHED"
      || item.code === "UPSTREAM_DEPTH_LIMIT_REACHED"
    );
    const status = hasGlobalTruncation ? "truncated" : "candidate";
    const pathDiagnostics: Diagnostic[] = [];
    if (status === "truncated") {
      const diagnostic: Diagnostic = {
        level: "info",
        code: "PATH_TRUNCATED",
        message: "候选路径因为关系数量、fanout 或 depth 限制被截断。"
      };
      pathDiagnostics.push(diagnostic);
      input.diagnostics.push(diagnostic);
    }

    paths.push({
      id: `path_${paths.length + 1}`,
      path_type: input.direction === "upstream" ? "upstream" : input.direction === "downstream" ? "downstream" : "unknown",
      path_status: status,
      nodes: [anchor],
      relations: [relation],
      depth: 1,
      confidence: pathConfidence([relation], status),
      evidence_sources: relationEvidenceSources([relation]),
      diagnostics: pathDiagnostics,
      summary: `${anchor.symbol ?? anchor.id} ${relation.relation_type} ${relation.to}`
    });
  }

  if (paths.length > 0) {
    input.diagnostics.push({
      level: "info",
      code: "PATH_VERIFICATION_SKIPPED",
      message: "v0.3 返回候选路径；除 GitNexus trace 结果外，不把候选路径标记为完整调用链。"
    });
  } else if (input.relations.length > 0) {
    input.diagnostics.push({
      level: "info",
      code: "PATH_EXTRACTION_PARTIAL",
      message: "已生成关系边，但未能组装成候选路径。"
    });
  }

  return paths;
}

function pathConfidence(relations: CodeRelation[], status: "candidate" | "verified" | "partial" | "truncated"): "high" | "medium" | "low" {
  if (status === "verified") return "high";
  if (status === "truncated") return "low";
  if (relations.some((relation) => relation.relation_type === "references" || relation.confidence === "low")) return "low";
  return "medium";
}

function relationEvidenceSources(relations: CodeRelation[]): Array<"java_index" | "gitnexus" | "grep" | "semantic_lite"> {
  const sources = new Set<"java_index" | "gitnexus" | "grep" | "semantic_lite">();
  for (const relation of relations) {
    for (const evidence of relation.evidence) {
      sources.add(evidence.source);
    }
  }
  return [...sources];
}
```

Use the returned paths in response:

```ts
const candidatePaths = buildCandidatePaths({
  anchors,
  relations,
  direction,
  depth,
  diagnostics
});
```

- [ ] **Step 4: Run tests and confirm pass**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts
```

Expected: pass.

## Task 5: Add CLI Command

**Files:**

- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/tests/cli.test.ts`

- [ ] **Step 1: Write failing CLI test**

Add to `packages/cli/tests/cli.test.ts`:

```ts
it("explores a registered project from one query", async () => {
  const home = await mkdtemp(join(tmpdir(), "code-intel-cli-"));
  const root = join(process.cwd(), "fixtures/java-order-service");

  try {
    await runCli(["register", "trade-service", root, "--stack", "java-spring-mybatis"], {
      CODE_INTEL_HOME: home
    });
    await runCli(["index", "trade-service", "--gitnexus-mode", "none"], {
      CODE_INTEL_HOME: home
    });
    const explore = await runCli([
      "explore",
      "trade-service",
      "--query",
      "OrderController.detail",
      "--direction",
      "both",
      "--depth",
      "2",
      "--limit",
      "5"
    ], {
      CODE_INTEL_HOME: home
    });
    const response = JSON.parse(explore.stdout) as {
      anchors: unknown[];
      relations: unknown[];
      candidate_paths: unknown[];
      diagnostics: Array<{ code: string }>;
    };

    expect(Array.isArray(response.anchors)).toBe(true);
    expect(Array.isArray(response.relations)).toBe(true);
    expect(Array.isArray(response.candidate_paths)).toBe(true);
    expect(response.diagnostics.length).toBeGreaterThan(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
```

- [ ] **Step 2: Run CLI test and confirm failure**

Run:

```bash
npm run build
npm run test -- packages/cli/tests/cli.test.ts
```

Expected: fail because command `explore` does not exist.

- [ ] **Step 3: Add command implementation**

Modify `packages/cli/src/index.ts`, add before `trace` command:

```ts
program
  .command("explore")
  .description("从一个接口、错误码、日志、SQL、方法或业务词出发探索代码上下文")
  .argument("<project>")
  .requiredOption("--query <query>")
  .option("--type <type>")
  .option("--direction <direction>", "探索方向：upstream|downstream|both", "both")
  .option("--depth <depth>", "最大探索深度，默认 2，最大 4", "2")
  .option("--limit <limit>", "最大关系边或候选路径数量", "20")
  .option("--exclude-tests", "排除测试代码")
  .option("--json", "以 JSON 输出，当前默认即为 JSON")
  .action(async (
    project: string,
    options: {
      query: string;
      type?: string;
      direction: string;
      depth: string;
      limit: string;
      excludeTests?: boolean;
    }
  ) => {
    const limit = parseLimit(options.limit);
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
      excludeTests: Boolean(options.excludeTests)
    });

    printJson(response);
  });
```

Add parsers:

```ts
function parseExploreDirection(value: string): "upstream" | "downstream" | "both" {
  if (value === "upstream" || value === "downstream" || value === "both") return value;
  throw new Error(`探索方向不支持：${value}，可选值：upstream|downstream|both`);
}

function parseDepth(value: string): number {
  const depth = parseLimit(value);
  if (depth > 4) {
    throw new Error("depth 最大支持 4");
  }
  return depth;
}
```

- [ ] **Step 4: Build and run CLI tests**

Run:

```bash
npm run build
npm run test -- packages/cli/tests/cli.test.ts
```

Expected: pass.

## Task 6: Add MCP Tool

**Files:**

- Modify: `packages/mcp/src/server.ts`
- Test: `packages/mcp/tests/mcp-tools.test.ts`

- [ ] **Step 1: Write failing MCP handler test**

Add to `packages/mcp/tests/mcp-tools.test.ts`:

```ts
it("returns explore responses through the code.explore_symbol handler", async () => {
  const home = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));
  const root = join(process.cwd(), "fixtures/java-order-service");

  try {
    const registry = createProjectRegistry({ home });
    await registry.register({
      name: "trade-service",
      path: root,
      stack: "java-spring-mybatis"
    });
    await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });

    const result = await handleCodeExploreSymbol({
      home,
      project: "trade-service",
      query: "OrderController.detail",
      direction: "both",
      depth: 2,
      limit: 5
    });
    const response = parseTextResult(result) as {
      anchors: unknown[];
      relations: unknown[];
      candidate_paths: unknown[];
      diagnostics: unknown[];
    };

    expect(Array.isArray(response.anchors)).toBe(true);
    expect(Array.isArray(response.relations)).toBe(true);
    expect(Array.isArray(response.candidate_paths)).toBe(true);
    expect(Array.isArray(response.diagnostics)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run MCP tests and confirm failure**

Run:

```bash
npm run test -- packages/mcp/tests/mcp-tools.test.ts
```

Expected: fail because `handleCodeExploreSymbol` does not exist.

- [ ] **Step 3: Add handler**

Modify imports in `packages/mcp/src/server.ts`:

```ts
exploreSymbol,
```

Add input schema:

```ts
const ExploreDirectionInputSchema = z.enum(["upstream", "downstream", "both"]);
```

Add handler:

```ts
export async function handleCodeExploreSymbol(input: {
  home?: string;
  project: string;
  query: string;
  type?: QueryType;
  direction?: "upstream" | "downstream" | "both";
  depth?: number;
  limit?: number;
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
    excludeTests: Boolean(input.exclude_tests)
  }));
}
```

Register tool:

```ts
server.registerTool(
  "code.explore_symbol",
  {
    description: "从一个代码线索出发探索上下游关系和候选路径",
    inputSchema: z.object({
      project: z.string(),
      query: z.string(),
      type: QueryTypeInputSchema.optional(),
      direction: ExploreDirectionInputSchema.optional(),
      depth: z.number().int().positive().max(4).optional(),
      limit: z.number().int().positive().optional(),
      exclude_tests: z.boolean().optional()
    })
  },
  async (input) => handleCodeExploreSymbol(input)
);
```

- [ ] **Step 4: Run MCP tests and confirm pass**

Run:

```bash
npm run test -- packages/mcp/tests/mcp-tools.test.ts
```

Expected: pass.

## Task 7: Add Limit and Ambiguity Diagnostics

**Files:**

- Modify: `packages/core/src/search/explore-symbol.ts`
- Test: `packages/core/tests/explore-symbol.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests:

```ts
it("reports ANCHOR_AMBIGUOUS when multiple anchors are selected", async () => {
  const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
  const root = join(process.cwd(), "fixtures/java-order-service");

  try {
    await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
    const response = await exploreSymbol({
      home,
      project: "trade-service",
      root,
      query: "Order",
      direction: "both",
      depth: 2,
      limit: 10,
      anchorLimit: 3
    });

    if (response.anchors.length > 1) {
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "ANCHOR_AMBIGUOUS"
        })
      ]));
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("reports RELATION_LIMIT_REACHED when relations exceed limit", async () => {
  const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
  const root = join(process.cwd(), "fixtures/java-order-service");

  try {
    await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
    const response = await exploreSymbol({
      home,
      project: "trade-service",
      root,
      query: "OrderController.detail",
      direction: "downstream",
      depth: 2,
      limit: 1,
      fanout: 10,
      adapter: {
        context: async () => ({
          outgoing: {
            calls: [
              { uid: "Method:src/A.java:A.a#0", name: "A.a", filePath: "src/A.java" },
              { uid: "Method:src/B.java:B.b#0", name: "B.b", filePath: "src/B.java" }
            ]
          }
        })
      }
    });

    expect(response.relations).toHaveLength(1);
    expect(response.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "RELATION_LIMIT_REACHED"
      })
    ]));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and confirm failure if diagnostics are missing**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts
```

Expected: fail if diagnostics are not implemented.

- [ ] **Step 3: Implement ambiguity and truncation diagnostics**

After anchor selection:

```ts
if (anchors.length > 1) {
  diagnostics.push({
    level: "info",
    code: "ANCHOR_AMBIGUOUS",
    message: `找到 ${anchors.length} 个候选探索起点；结果会合并多个 anchor 的关系，必要时请使用更精确 query。`
  });
}
```

In `expandAnchorRelations()`, when raw mapped relations exceed limit before slicing:

```ts
const beforeLimit = dedupeRelations(relations);
if (beforeLimit.length > input.limit) {
  input.diagnostics.push({
    level: "info",
    code: "RELATION_LIMIT_REACHED",
    message: `关系数量超过 limit=${input.limit}，已截断。`
  });
}
const deduped = beforeLimit.slice(0, input.limit);
```

- [ ] **Step 4: Run explore tests**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts
```

Expected: pass.

## Task 8: Update Docs

**Files:**

- Modify: `docs/user-guide.zh-CN.md`
- Modify: `docs/current-tool-capabilities.zh-CN.md`
- Modify: `docs/code-intelligence-pitfalls-and-evolution.zh-CN.md`

- [ ] **Step 1: Update user guide**

Add a section after “常见检索”:

```md
## 单点探索：explore

`explore` 用于从一个真实线索出发探索代码上下文：

```bash
code-intel explore mi-intl-scheme --query "ORDER_STATUS_INVALID" --direction upstream --depth 3 --limit 20
code-intel explore mi-intl-scheme --query "/api/trade/order/detail" --direction downstream --depth 3 --limit 20
code-intel explore mi-intl-scheme --query "order_item_snapshot" --direction upstream --depth 3 --limit 20
```

输出重点字段：

- `anchors`：探索起点。
- `relations`：关系边集合，不等于完整调用链。
- `candidate_paths`：候选路径，必须结合 `path_status` 和 `confidence` 读取。
- `diagnostics`：索引、GitNexus、歧义、截断、低置信等诊断。

注意：`candidate_paths` 不是完整调用链承诺。`path_status=candidate|partial|truncated` 时，只能作为候选证据。
```

- [ ] **Step 2: Update current capabilities**

Add to `docs/current-tool-capabilities.zh-CN.md`:

```md
### code.explore_symbol

当前版本支持从单个线索探索上下游关系和候选路径。它返回独立 `ExploreResponse`，包含 `anchors`、`relations`、`candidate_paths` 和 `diagnostics`。

`candidate_paths` 是候选路径，不等于完整调用链证明。只有 `path_status=verified` 的路径才能视为底层 trace 已验证路径。
```

- [ ] **Step 3: Update pitfalls**

Add one lesson:

```md
## 踩坑七：candidate_paths 不能包装成完整调用链

v0.3 引入 explore 后，如果为了演示效果把所有关系边强行串成“完整调用链”，会误导排障结论。修正方式是引入 `path_status`、`confidence`、`evidence_sources` 和路径级 diagnostics。
```

- [ ] **Step 4: Run docs keyword check**

Run:

```bash
rg -n "explore|candidate_paths|path_status|code.explore_symbol" docs
```

Expected: user guide, capability doc, design spec, pitfalls all mention the new capability consistently.

## Task 9: Full Verification

**Files:**

- No new files.

- [ ] **Step 1: Run build**

Run:

```bash
npm run build
```

Expected: TypeScript build passes.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: typecheck passes.

- [ ] **Step 3: Run tests**

Run:

```bash
npm run test
```

Expected: all tests pass.

- [ ] **Step 4: Install wrapper syntax check**

Run:

```bash
bash -n scripts/install-local.sh
```

Expected: no output and exit code 0.

## Task 10: Real Project Trial on mi-intl-scheme

**Files:**

- No source files.
- Optional doc update after trial: `docs/2026-08-19-code-intelligence-next-phase-plan.zh-CN.md`

- [ ] **Step 1: Ensure local command is installed**

Run:

```bash
cd /mnt/g/my-Skill/Code-intelligence
bash scripts/install-local.sh
export PATH="$HOME/.local/bin:$PATH"
```

Expected: `code-intel where` prints the data directory.

- [ ] **Step 2: Register target project**

Run:

```bash
code-intel register mi-intl-scheme /mnt/g/workSpace/mi-intl-scheme \
  --stack java-spring-mybatis \
  --gitnexus-repo mi-intl-scheme
```

Expected: JSON contains `name=mi-intl-scheme` and `gitnexus_repo=mi-intl-scheme`.

- [ ] **Step 3: Refresh indexes**

For full demo preparation:

```bash
code-intel index mi-intl-scheme --gitnexus-mode full
```

For daily refresh after full index exists:

```bash
code-intel index mi-intl-scheme
```

Expected: final JSON contains `counts`, `timings_ms`, and `warnings` explain any degradation.

- [ ] **Step 4: Try route downstream exploration**

Run with a real route found from `search`:

```bash
code-intel search mi-intl-scheme --type route --query "<real-route>" --limit 5
code-intel explore mi-intl-scheme --query "<real-route>" --direction downstream --depth 3 --limit 20
```

Expected: `anchors` include Controller-like location; `relations` include downstream candidates; `candidate_paths` are `candidate` or `truncated`.

- [ ] **Step 5: Try error/log upstream exploration**

Run:

```bash
code-intel search mi-intl-scheme --type error --query "<real-error-code-or-log-token>" --limit 5
code-intel explore mi-intl-scheme --query "<real-error-code-or-log-token>" --direction upstream --depth 3 --limit 20
```

Expected: `anchors` include constant/exception/log location; diagnostics explain whether upstream relations were found.

- [ ] **Step 6: Try SQL/table upstream exploration**

Run:

```bash
code-intel search mi-intl-scheme --type table --query "<real-table-name>" --limit 5
code-intel explore mi-intl-scheme --query "<real-table-name>" --direction upstream --depth 3 --limit 20
```

Expected: `anchors` include Mapper/SQL location; candidate paths should expose Mapper/Service candidates if GitNexus can connect them.

- [ ] **Step 7: Record demo cases**

For each stable case, record:

```md
### Demo: <name>

- 输入线索：
- 命令：
- anchors：
- relations：
- candidate_paths：
- diagnostics：
- 证据来源：
- 面试讲法：
- 生产价值：
- 当前不足：
```

## Self-Review

Spec coverage:

- v0.3 independent `ExploreResponse`: Task 1.
- `exploreSymbol()` core API: Task 2.
- GitNexus context expansion: Task 3.
- `candidate_paths` with status/confidence/evidence/diagnostics: Task 4.
- CLI command: Task 5.
- MCP tool: Task 6.
- ambiguity, limit and depth diagnostics: Task 7.
- docs: Task 8.
- full verification: Task 9.
- real project trial: Task 10.

Placeholder scan:

- No `TODO`, `TBD`, or “implement later” placeholders are used as plan instructions.
- Code snippets are concrete enough for implementation but still allow minor type import adjustment if the current TypeScript compiler requires it.

Type consistency:

- Uses `candidate_paths`, not `paths`.
- Uses `path_status`, not `status`.
- Uses `ExploreDirection` values `upstream|downstream|both`.
- Uses existing `CodeRelation`, `CodeLocation`, `Diagnostic`, `SearchResponse` concepts.

Repository note:

- `/mnt/g/my-Skill/Code-intelligence` is currently not detected as a git repository in this environment, so task steps do not require `git commit`.
