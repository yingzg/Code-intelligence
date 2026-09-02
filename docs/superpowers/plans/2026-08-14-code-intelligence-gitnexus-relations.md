# Code Intelligence GitNexus Relations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Code Intelligence from code-location search to local GitNexus-backed code locations, relations, and trace evidence.

**Architecture:** Keep Java-specific indexes as high-precision entry anchors, then call local GitNexus CLI (`status`, `query`, `context`, `trace`) to enrich results with graph relations. Normalize every source into `SearchResponse.locations`, `SearchResponse.relations`, and `diagnostics`; no remote repository access is required.

**Tech Stack:** TypeScript, Node.js `execFile`, Commander, MCP stdio server, Vitest, local GitNexus CLI.

---

## File Structure

- Modify: `packages/core/src/schemas.ts`
  Add `gitnexus_repo` to `ProjectRef`, extend `RelationTypeSchema`, and add GitNexus diagnostics.
- Modify: `packages/core/src/registry.ts`
  Persist optional `gitnexus_repo` on registered projects.
- Modify: `packages/cli/src/index.ts`
  Add `--gitnexus-repo` to `register`; add `trace` command.
- Modify: `packages/mcp/src/server.ts`
  Add `downstream_depth` to route handling and add `code.trace_call_chain`.
- Modify: `packages/core/src/gitnexus.ts`
  Keep compatibility exports, but delegate richer behavior to new GitNexus adapter.
- Create: `packages/core/src/gitnexus/cli.ts`
  Execute local GitNexus CLI commands safely with JSON parsing.
- Create: `packages/core/src/gitnexus/adapter.ts`
  Stable TypeScript API: status, query, context, trace.
- Create: `packages/core/src/gitnexus/mapper.ts`
  Map GitNexus JSON output to `CodeLocation`, `CodeRelation`, and diagnostics.
- Modify: `packages/core/src/search/search-router.ts`
  Use GitNexus adapter when `includeRelations` is true.
- Modify: `packages/core/src/search/call-chain.ts`
  Implement trace support from `from` and `to` symbols.
- Modify: `packages/core/src/index.ts`
  Export new GitNexus adapter modules.
- Modify tests:
  `packages/core/tests/registry.test.ts`,
  `packages/core/tests/search-router.test.ts`,
  `packages/core/tests/gitnexus-adapter.test.ts` new,
  `packages/cli/tests/cli.test.ts`,
  `packages/mcp/tests/mcp-tools.test.ts`.
- Create: `docs/demo/mi-intl-scheme-gitnexus-relations.zh-CN.md`
  Local-only demo guide using `/mnt/g/workSpace/mi-intl-scheme`.

## Task 1: Extend Schemas and Registry

**Files:**
- Modify: `packages/core/src/schemas.ts`
- Modify: `packages/core/src/registry.ts`
- Modify: `packages/core/tests/registry.test.ts`

- [ ] **Step 1: Add failing registry test for `gitnexus_repo`**

Add this test to `packages/core/tests/registry.test.ts`:

```ts
  it("stores optional GitNexus repo label for registered projects", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const repo = await mkdtemp(join(tmpdir(), "repo-"));

    try {
      const registry = createProjectRegistry({ home });
      const project = await registry.register({
        name: "mi-intl-scheme",
        path: repo,
        stack: "java-spring-mybatis",
        gitnexus_repo: "mi-intl-scheme"
      });

      expect(project.gitnexus_repo).toBe("mi-intl-scheme");
      await expect(registry.get("mi-intl-scheme")).resolves.toMatchObject({
        gitnexus_repo: "mi-intl-scheme"
      });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run registry test and verify it fails**

Run:

```bash
npx vitest run packages/core/tests/registry.test.ts
```

Expected: TypeScript or test failure because `RegisterProjectInput` does not accept `gitnexus_repo`.

- [ ] **Step 3: Extend registry types and persistence**

Update `packages/core/src/registry.ts`:

```ts
export type RegisteredProject = {
  name: string;
  path: string;
  stack: Stack;
  gitnexus_repo?: string;
  created_at: string;
  updated_at: string;
};

export type RegisterProjectInput = {
  name: string;
  path: string;
  stack: Stack;
  gitnexus_repo?: string;
};
```

In `validateRegisteredProject`, read `gitnexus_repo` if present:

```ts
  const gitnexusRepo = project.gitnexus_repo;
  if (gitnexusRepo !== undefined && typeof gitnexusRepo !== "string") {
    throw new Error(`registry.json 格式无效：projects[${index}].gitnexus_repo 必须是字符串`);
  }
```

Return it only when present:

```ts
  return {
    name,
    path,
    stack: stack as Stack,
    ...(gitnexusRepo ? { gitnexus_repo: gitnexusRepo } : {}),
    created_at: assertRegistryStringField(project, index, "created_at"),
    updated_at: assertRegistryStringField(project, index, "updated_at")
  };
```

In `register`, persist it:

```ts
    const project: RegisteredProject = {
      name,
      path: input.path,
      stack: input.stack,
      ...(input.gitnexus_repo ? { gitnexus_repo: input.gitnexus_repo } : {}),
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
```

- [ ] **Step 4: Extend schema model**

Update `packages/core/src/schemas.ts`:

```ts
export const RelationTypeSchema = z.enum([
  "calls",
  "implements",
  "maps_to_sql",
  "handles_route",
  "throws",
  "logs",
  "reads_config",
  "uses_table",
  "contains",
  "has_method",
  "imports",
  "accesses",
  "typed_as",
  "references"
]);
```

Extend diagnostics:

```ts
export const DiagnosticCodeSchema = z.enum([
  "PROJECT_NOT_REGISTERED",
  "PROJECT_PATH_NOT_FOUND",
  "INDEX_MISSING",
  "INDEX_STALE",
  "GITNEXUS_UNAVAILABLE",
  "GITNEXUS_INDEX_MISSING",
  "GITNEXUS_REPO_AMBIGUOUS",
  "GITNEXUS_REPO_NOT_REGISTERED",
  "GITNEXUS_INDEX_STALE",
  "GITNEXUS_QUERY_FAILED",
  "GITNEXUS_RELATIONS_USED",
  "GITNEXUS_RELATIONS_UNAVAILABLE",
  "RELATION_LIMIT_REACHED",
  "DOWNSTREAM_DEPTH_LIMIT_REACHED",
  "SEMANTIC_INDEX_MISSING",
  "GREP_FALLBACK_USED",
  "LOW_CONFIDENCE"
]);
```

Extend `ProjectRefSchema`:

```ts
export const ProjectRefSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  stack: StackSchema,
  gitnexus_repo: z.string().optional(),
  commit_hash: z.string().optional(),
  dirty: z.boolean()
}).strict();
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run packages/core/tests/registry.test.ts packages/core/tests/schemas.test.ts
```

Expected: all tests pass.

## Task 2: Add GitNexus CLI Adapter

**Files:**
- Create: `packages/core/src/gitnexus/cli.ts`
- Create: `packages/core/src/gitnexus/adapter.ts`
- Create: `packages/core/src/gitnexus/mapper.ts`
- Create: `packages/core/tests/gitnexus-adapter.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write adapter tests using injected runner**

Create `packages/core/tests/gitnexus-adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createGitNexusAdapter } from "../src/gitnexus/adapter.js";
import { mapGitNexusContextToRelations, mapGitNexusDefinitionsToLocations } from "../src/gitnexus/mapper.js";

describe("GitNexus adapter", () => {
  it("passes explicit repo labels to context calls", async () => {
    const calls: string[][] = [];
    const adapter = createGitNexusAdapter({
      run: async (args) => {
        calls.push(args);
        return {
          status: "found",
          symbol: {
            uid: "Class:src/A.java:A",
            name: "A",
            kind: "Class",
            filePath: "src/A.java",
            startLine: 1,
            endLine: 10
          },
          incoming: {},
          outgoing: {},
          typed_properties: [],
          processes: []
        };
      }
    });

    await adapter.context({ repoPath: "/repo", repo: "mi-intl-scheme", symbol: "A", limit: 5 });

    expect(calls[0]).toEqual(["context", "A", "--repo", "mi-intl-scheme", "--limit", "5"]);
  });

  it("maps GitNexus definitions to gitnexus CodeLocation records", () => {
    const locations = mapGitNexusDefinitionsToLocations({
      project: "p",
      definitions: [
        {
          id: "Method:src/A.java:A.run#0",
          name: "run",
          filePath: "src/A.java",
          startLine: 12,
          endLine: 20
        }
      ]
    });

    expect(locations[0]).toMatchObject({
      id: "Method:src/A.java:A.run#0",
      project: "p",
      file: "src/A.java",
      start_line: 12,
      end_line: 20,
      symbol: "run",
      language: "java",
      source: "gitnexus"
    });
  });

  it("maps GitNexus context edges to CodeRelation records", () => {
    const relations = mapGitNexusContextToRelations({
      fromLocationId: "Class:src/A.java:A",
      context: {
        incoming: {
          implements: [
            { uid: "Class:src/AImpl.java:AImpl", name: "AImpl", filePath: "src/AImpl.java" }
          ]
        },
        outgoing: {
          calls: [
            { uid: "Method:src/B.java:B.call#0", name: "call", filePath: "src/B.java" }
          ]
        },
        typed_properties: [
          { uid: "Property:src/C.java:C.a", name: "a", filePath: "src/C.java", declaredType: "A" }
        ]
      }
    });

    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "Class:src/AImpl.java:AImpl", to: "Class:src/A.java:A", relation_type: "implements" }),
        expect.objectContaining({ from: "Class:src/A.java:A", to: "Method:src/B.java:B.call#0", relation_type: "calls" }),
        expect.objectContaining({ from: "Property:src/C.java:C.a", to: "Class:src/A.java:A", relation_type: "typed_as" })
      ])
    );
  });
});
```

- [ ] **Step 2: Run adapter tests and verify failure**

Run:

```bash
npx vitest run packages/core/tests/gitnexus-adapter.test.ts
```

Expected: fails because new modules do not exist.

- [ ] **Step 3: Implement `gitnexus/cli.ts`**

Create `packages/core/src/gitnexus/cli.ts`:

```ts
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitNexusRunner = (args: string[], options: { cwd: string }) => Promise<unknown>;

export async function runGitNexusJson(args: string[], options: { cwd: string }): Promise<unknown> {
  const runner = join(options.cwd, ".gitnexus", "run.cjs");
  const result = await execFileAsync("node", [runner, ...args], {
    cwd: options.cwd,
    maxBuffer: 20 * 1024 * 1024
  });

  return JSON.parse(result.stdout) as unknown;
}
```

- [ ] **Step 4: Implement `gitnexus/adapter.ts`**

Create `packages/core/src/gitnexus/adapter.ts`:

```ts
import { runGitNexusJson } from "./cli.js";

export type GitNexusAdapterOptions = {
  run?: (args: string[], options: { cwd: string }) => Promise<unknown>;
};

export type GitNexusContextInput = {
  repoPath: string;
  repo: string;
  symbol: string;
  limit?: number;
};

export type GitNexusQueryInput = {
  repoPath: string;
  repo: string;
  query: string;
  limit?: number;
};

export type GitNexusTraceInput = {
  repoPath: string;
  repo: string;
  from: string;
  to: string;
  depth?: number;
};

export function createGitNexusAdapter(options: GitNexusAdapterOptions = {}) {
  const run = options.run ?? ((args, runOptions) => runGitNexusJson(args, runOptions));

  return {
    status: (input: { repoPath: string }) => run(["status"], { cwd: input.repoPath }),
    query: (input: GitNexusQueryInput) => run([
      "query",
      input.query,
      "--repo",
      input.repo,
      "--limit",
      String(input.limit ?? 5)
    ], { cwd: input.repoPath }),
    context: (input: GitNexusContextInput) => run([
      "context",
      input.symbol,
      "--repo",
      input.repo,
      "--limit",
      String(input.limit ?? 10)
    ], { cwd: input.repoPath }),
    trace: (input: GitNexusTraceInput) => run([
      "trace",
      input.from,
      input.to,
      "--repo",
      input.repo,
      "--depth",
      String(input.depth ?? 10)
    ], { cwd: input.repoPath })
  };
}
```

- [ ] **Step 5: Implement `gitnexus/mapper.ts`**

Create `packages/core/src/gitnexus/mapper.ts` with:

```ts
import type { CodeLocation, CodeRelation, Diagnostic } from "../schemas.js";

type GitNexusDefinition = {
  id: string;
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
};

type GitNexusEdgeTarget = {
  uid: string;
  name: string;
  filePath: string;
};

type GitNexusTypedProperty = GitNexusEdgeTarget & {
  declaredType?: string;
};

export function mapGitNexusDefinitionsToLocations(input: {
  project: string;
  definitions: GitNexusDefinition[];
}): CodeLocation[] {
  return input.definitions.map((definition) => ({
    id: definition.id,
    project: input.project,
    file: definition.filePath,
    start_line: definition.startLine,
    end_line: definition.endLine,
    symbol: definition.name,
    language: languageFromFile(definition.filePath),
    location_type: locationTypeFromId(definition.id),
    snippet: "",
    match_reason: `GitNexus 图谱命中 ${definition.name}`,
    score: 0.8,
    confidence: "medium",
    source: "gitnexus"
  }));
}

export function mapGitNexusContextToRelations(input: {
  fromLocationId: string;
  context: {
    incoming?: Record<string, GitNexusEdgeTarget[]>;
    outgoing?: Record<string, GitNexusEdgeTarget[]>;
    typed_properties?: GitNexusTypedProperty[];
  };
}): CodeRelation[] {
  const relations: CodeRelation[] = [];

  for (const [kind, targets] of Object.entries(input.context.incoming ?? {})) {
    for (const target of targets) {
      relations.push(relation(target.uid, input.fromLocationId, relationType(kind), target));
    }
  }

  for (const [kind, targets] of Object.entries(input.context.outgoing ?? {})) {
    for (const target of targets) {
      relations.push(relation(input.fromLocationId, target.uid, relationType(kind), target));
    }
  }

  for (const property of input.context.typed_properties ?? []) {
    relations.push(relation(property.uid, input.fromLocationId, "typed_as", property));
  }

  return dedupeRelations(relations);
}

export function gitNexusRelationsUsedDiagnostic(count: number): Diagnostic {
  return {
    level: "info",
    code: "GITNEXUS_RELATIONS_USED",
    message: `已使用 GitNexus 生成 ${count} 条关系证据。`
  };
}

function relation(
  from: string,
  to: string,
  relation_type: CodeRelation["relation_type"],
  target: GitNexusEdgeTarget
): CodeRelation {
  return {
    from,
    to,
    relation_type,
    confidence: "medium",
    evidence: [
      {
        file: target.filePath,
        snippet: "",
        source: "gitnexus",
        extracted_by: "gitnexus.context"
      }
    ]
  };
}

function relationType(kind: string): CodeRelation["relation_type"] {
  if (kind === "calls") return "calls";
  if (kind === "implements") return "implements";
  if (kind === "imports") return "imports";
  if (kind === "accesses") return "accesses";
  if (kind === "has_method") return "has_method";
  if (kind === "contains") return "contains";
  return "references";
}

function locationTypeFromId(id: string): CodeLocation["location_type"] {
  if (id.startsWith("Method:")) return "service";
  if (id.startsWith("Class:") || id.startsWith("Interface:")) return "unknown";
  if (id.startsWith("Property:")) return "constant";
  return "unknown";
}

function languageFromFile(file: string): CodeLocation["language"] {
  if (file.endsWith(".java")) return "java";
  if (file.endsWith(".xml")) return "xml";
  if (file.endsWith(".yml") || file.endsWith(".yaml")) return "yaml";
  if (file.endsWith(".properties")) return "properties";
  if (file.endsWith(".sql")) return "sql";
  return "unknown";
}

function dedupeRelations(relations: CodeRelation[]): CodeRelation[] {
  const seen = new Set<string>();
  return relations.filter((item) => {
    const key = `${item.from}\u0000${item.to}\u0000${item.relation_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

- [ ] **Step 6: Export new modules**

Update `packages/core/src/index.ts`:

```ts
export * from "./gitnexus/cli.js";
export * from "./gitnexus/adapter.js";
export * from "./gitnexus/mapper.js";
```

- [ ] **Step 7: Run adapter tests**

Run:

```bash
npx vitest run packages/core/tests/gitnexus-adapter.test.ts
```

Expected: all tests pass.

## Task 3: Wire GitNexus Relations into Search

**Files:**
- Modify: `packages/core/src/search/search-router.ts`
- Modify: `packages/core/tests/search-router.test.ts`

- [ ] **Step 1: Add test for relations using injected GitNexus adapter**

Add a test to `packages/core/tests/search-router.test.ts` that calls `searchCode` with `includeRelations: true` and a fake adapter. If direct injection would require broad signature changes, create a helper function `enrichWithGitNexusRelations` and test it directly.

Expected assertion:

```ts
expect(response.relations).toContainEqual(
  expect.objectContaining({
    relation_type: "calls",
    source: undefined
  })
);
expect(response.diagnostics).toContainEqual(
  expect.objectContaining({ code: "GITNEXUS_RELATIONS_USED" })
);
```

- [ ] **Step 2: Implement relation enrichment helper**

In `search-router.ts`, add or import a helper with this behavior:

```ts
async function enrichRelations(input: {
  project: string;
  root: string;
  gitnexusRepo?: string;
  locations: CodeLocation[];
  limit: number;
  diagnostics: Diagnostic[];
}): Promise<CodeRelation[]> {
  const repo = input.gitnexusRepo ?? input.project;
  const adapter = createGitNexusAdapter();
  const relations: CodeRelation[] = [];

  for (const location of input.locations.filter((item) => item.symbol).slice(0, input.limit)) {
    try {
      const context = await adapter.context({
        repoPath: input.root,
        repo,
        symbol: location.symbol!,
        limit: input.limit
      });
      relations.push(...mapGitNexusContextToRelations({
        fromLocationId: location.id,
        context: context as Parameters<typeof mapGitNexusContextToRelations>[0]["context"]
      }));
    } catch (error) {
      input.diagnostics.push({
        level: "warning",
        code: "GITNEXUS_QUERY_FAILED",
        message: `GitNexus context 查询失败：${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  if (relations.length > 0) {
    input.diagnostics.push(gitNexusRelationsUsedDiagnostic(relations.length));
  } else {
    input.diagnostics.push({
      level: "info",
      code: "GITNEXUS_RELATIONS_UNAVAILABLE",
      message: "未生成 GitNexus 关系证据。"
    });
  }

  return relations;
}
```

- [ ] **Step 3: Pass registry `gitnexus_repo` into `searchCode`**

Update `searchCode` input type in `search-router.ts`:

```ts
gitnexusRepo?: string;
```

When constructing `response.project`, include:

```ts
gitnexus_repo: input.gitnexusRepo,
```

When `includeRelations` is true, call enrichment before building response or update response after creation.

- [ ] **Step 4: Update CLI and MCP callers to pass `gitnexus_repo`**

In CLI search action and MCP handler, pass:

```ts
gitnexusRepo: registered.gitnexus_repo
```

- [ ] **Step 5: Run search-router tests**

Run:

```bash
npx vitest run packages/core/tests/search-router.test.ts
```

Expected: all tests pass.

## Task 4: Add CLI Support for GitNexus Repo and Trace

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/tests/cli.test.ts`
- Modify: `packages/core/src/search/call-chain.ts`

- [ ] **Step 1: Add CLI test for `--gitnexus-repo`**

In `packages/cli/tests/cli.test.ts`, add:

```ts
  it("registers optional GitNexus repo labels", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-cli-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const registered = await runCli([
        "register",
        "trade-service",
        root,
        "--stack",
        "java-spring-mybatis",
        "--gitnexus-repo",
        "java-spring-mybatis-demo"
      ], { CODE_INTEL_HOME: home });

      expect(JSON.parse(registered.stdout)).toMatchObject({
        name: "trade-service",
        gitnexus_repo: "java-spring-mybatis-demo"
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
```

- [ ] **Step 2: Implement CLI register option**

In `packages/cli/src/index.ts`, update register:

```ts
.option("--gitnexus-repo <repo>")
```

Pass it:

```ts
const project = await registry.register({
  name,
  path,
  stack,
  gitnexus_repo: options.gitnexusRepo
});
```

- [ ] **Step 3: Add trace command**

In `packages/cli/src/index.ts`, add:

```ts
program
  .command("trace")
  .description("使用 GitNexus 查询两个符号之间的调用链")
  .argument("<project>")
  .requiredOption("--from <symbol>")
  .requiredOption("--to <symbol>")
  .option("--depth <depth>", "最大跳数", "10")
  .option("--json", "以 JSON 输出，当前默认即为 JSON")
  .action(async (project: string, options: { from: string; to: string; depth: string }) => {
    const depth = parseLimit(options.depth);
    const { createProjectRegistry, traceCallChain } = await import("@code-intelligence/core");
    const registry = createProjectRegistry();
    const registered = await registry.get(project);
    if (!registered) throw new Error(`项目未注册：${project}`);

    printJson(await traceCallChain({
      home: resolveCodeIntelHomeLocal(),
      project,
      root: registered.path,
      gitnexusRepo: registered.gitnexus_repo,
      from: options.from,
      to: options.to,
      depth
    }));
  });
```

- [ ] **Step 4: Implement traceCallChain input**

Replace `packages/core/src/search/call-chain.ts` with a real implementation that returns a `SearchResponse`. It should:

- Read git state.
- Resolve repo label as `gitnexusRepo ?? project`.
- Call `createGitNexusAdapter().trace`.
- Map path output conservatively to `relations` if GitNexus trace returns path-like records.
- If output shape is unknown, include raw trace JSON as diagnostic message only when concise; otherwise return `GITNEXUS_RELATIONS_USED` when relations were mapped or `GITNEXUS_RELATIONS_UNAVAILABLE`.

- [ ] **Step 5: Run CLI tests**

Run:

```bash
npm run build
npx vitest run packages/cli/tests/cli.test.ts
```

Expected: all tests pass.

## Task 5: Add MCP Trace and Downstream Parameters

**Files:**
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/mcp/tests/mcp-tools.test.ts`

- [ ] **Step 1: Add MCP tests**

Add tests for:

- `handleCodeSearch` passes registered `gitnexus_repo` into core search.
- `handleCodeLocateRoute` accepts `downstream_depth`.
- `handleCodeTraceCallChain` returns a text result.

- [ ] **Step 2: Implement `handleCodeTraceCallChain`**

In `packages/mcp/src/server.ts`, import `traceCallChain` and add:

```ts
export async function handleCodeTraceCallChain(input: {
  home?: string;
  project: string;
  from: string;
  to: string;
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
    depth: input.depth
  }));
}
```

- [ ] **Step 3: Register MCP tool**

Add:

```ts
server.registerTool(
  "code.trace_call_chain",
  {
    description: "使用 GitNexus 查询两个符号之间的调用链",
    inputSchema: z.object({
      project: z.string(),
      from: z.string(),
      to: z.string(),
      depth: z.number().int().positive().optional()
    })
  },
  async (input) => handleCodeTraceCallChain(input)
);
```

- [ ] **Step 4: Add downstream_depth schema**

Update `code.locate_route` schema:

```ts
downstream_depth: z.number().int().positive().max(3).optional()
```

Pass it through to search if `searchCode` accepts it; otherwise add diagnostics if requested depth is more than current implementation supports.

- [ ] **Step 5: Run MCP tests**

Run:

```bash
npm run build
npx vitest run packages/mcp/tests/mcp-tools.test.ts
```

Expected: all tests pass.

## Task 6: Local Integration Demo with mi-intl-scheme

**Files:**
- Create: `docs/demo/mi-intl-scheme-gitnexus-relations.zh-CN.md`

- [ ] **Step 1: Register local project**

Run:

```bash
CODE_INTEL_HOME=/tmp/code-intelligence-v02-demo \
node packages/cli/dist/index.js register mi-intl-scheme /mnt/g/workSpace/mi-intl-scheme \
  --stack java-spring-mybatis \
  --gitnexus-repo mi-intl-scheme
```

Expected: JSON contains `gitnexus_repo: "mi-intl-scheme"`.

- [ ] **Step 2: Build Code Intelligence index**

Run:

```bash
CODE_INTEL_HOME=/tmp/code-intelligence-v02-demo \
node packages/cli/dist/index.js index mi-intl-scheme
```

Expected: local Java indexes are generated. GitNexus status diagnostics should mention local index availability.

- [ ] **Step 3: Search with relations**

Run:

```bash
CODE_INTEL_HOME=/tmp/code-intelligence-v02-demo \
node packages/cli/dist/index.js search mi-intl-scheme \
  --type semantic \
  --query "store incentive" \
  --include-relations \
  --limit 5 \
  --json
```

Expected:

- `locations` contains Java index and/or GitNexus locations.
- `relations` is non-empty when GitNexus context resolves symbols.
- `diagnostics` contains `GITNEXUS_RELATIONS_USED` or a precise GitNexus failure diagnostic.

- [ ] **Step 4: Trace between known symbols**

Use symbols discovered from Step 3. Example shape:

```bash
CODE_INTEL_HOME=/tmp/code-intelligence-v02-demo \
node packages/cli/dist/index.js trace mi-intl-scheme \
  --from "StoreIncentiveCommandService" \
  --to "RmsdbDynamicQueryExecutor" \
  --depth 10 \
  --json
```

Expected: response returns a valid `SearchResponse`; if GitNexus cannot find a path, diagnostics explain that no trace relation was produced.

- [ ] **Step 5: Write demo doc**

Create `docs/demo/mi-intl-scheme-gitnexus-relations.zh-CN.md` containing:

- Environment assumptions.
- Commands run.
- Key output summaries.
- Known limitations: local-only, no remote GitLab, vector search unavailable, Chinese query should use semantic-lite first.

## Task 7: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript build succeeds.

- [ ] **Step 2: Run tests**

Run:

```bash
npm run test
```

Expected: all tests pass.

- [ ] **Step 3: Run local GitNexus status**

Run:

```bash
node .gitnexus/run.cjs status
```

from `/mnt/g/workSpace/mi-intl-scheme`.

Expected:

```text
Status: up-to-date
```

- [ ] **Step 4: Run mi-intl-scheme demo commands**

Run commands from Task 6. Expected: all commands complete without remote repository access.

## Self-Review

- Spec coverage: This plan covers v0.2 registry mapping, GitNexus adapter, relations enrichment, CLI trace, MCP trace, local demo, and verification.
- Placeholder scan: No placeholder markers are used.
- Scope check: This plan intentionally excludes remote GitLab indexing, business flowchart Skill, Web UI, complete RAG, cross-project call chain, and full Java AST graph implementation.
- Risk: GitNexus CLI output shape for `trace` may require a mapper adjustment after observing real output. The implementation must fail closed by returning diagnostics instead of fabricating relations.
