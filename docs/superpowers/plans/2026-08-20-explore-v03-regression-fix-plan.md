# Explore v0.3 Regression Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix v0.3 `explore` so candidate paths are directionally correct, conservative, test-filtered by default, and backed by a saved real eval case.

**Architecture:** Keep `explore` as a graph-neighborhood evidence tool, not a full call-chain tool. Extend relation typing for `method_implements`, improve anchor ranking, build candidate paths only from path-eligible relations, render reverse traversal truthfully, and save the `mi-intl-scheme` `preCheckRebate` regression as an eval case under the project data directory.

**Tech Stack:** TypeScript, Zod, Vitest, Commander CLI output, local JSON eval assets under `CODE_INTEL_HOME`.

---

## Scope

This plan implements only v0.3 regression fixes described in:

```text
docs/2026-08-20-explore-v03-regression-fix-design.zh-CN.md
```

It does:

- Promote `method_implements` to a first-class relation type.
- Rank anchors before relation expansion.
- Keep default `excludeTests=true` semantics for anchors and candidate path endpoints.
- Exclude low-value relations from `candidate_paths`, while keeping them in `relations`.
- Sort path-eligible relations before path extraction.
- Fix summary rendering for reverse traversal in `upstream` / `both`.
- Add targeted unit tests and one fixture-style test matrix using fake GitNexus context.
- Save the first manual eval case for `mi-intl-scheme/preCheckRebate`.
- Update user-facing docs and capability notes.

It does not:

- Add `call-path`.
- Add `primary_path` / `alternative_paths`.
- Implement `code-intel eval` CLI.
- Implement trace verification.
- Implement AOP / reflection / MQ / RPC semantic bridging.
- Implement business flowchart Skill.

## File Structure

Modify:

- `packages/core/src/schemas.ts`
  - Add `method_implements` to `RelationTypeSchema`.

- `packages/core/src/gitnexus/mapper.ts`
  - Add `method_implements` to known GitNexus relation types.
  - Map `method_implements` to `relation_type="method_implements"`.

- `packages/core/src/search/explore-symbol.ts`
  - Add anchor ranking.
  - Pass `excludeTests` into candidate path building.
  - Filter path-eligible relations.
  - Sort relations by path value before candidate path extraction.
  - Track traversal direction per path edge.
  - Render summaries with reverse arrows when traversing against relation direction.
  - Keep `relations` output broad; only `candidate_paths` becomes conservative.

- `packages/core/tests/schemas.test.ts`
  - Add schema test for `method_implements`.

- `packages/core/tests/gitnexus-mapper.test.ts`
  - Isolate relation mapping and unknown-type diagnostics.

- `packages/core/tests/explore-symbol.test.ts`
  - Add tests for direction rendering, relation filtering, test endpoint filtering, anchor ranking, and path relation ordering.

- `docs/current-tool-capabilities.zh-CN.md`
  - Document v0.3 conservative candidate path semantics.

- `docs/user-guide.zh-CN.md`
  - Document `candidate_paths` filtering and diagnostics interpretation.

- `docs/code-intelligence-pitfalls-and-evolution.zh-CN.md`
  - Add the v0.3 regression lesson and eval case mechanism.

Create:

- `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/case.json`
- `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/request.json`
- `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/response.raw.json`
- `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/response.normalized.json`
- `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/expectations.json`
- `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/notes.md`

Note: `/mnt/g/my-Skill/Code-intelligence` is not a git repository. Skip commit steps and report changed files instead.

## Task 1: Promote `method_implements` Relation Type

**Files:**

- Modify: `packages/core/src/schemas.ts`
- Modify: `packages/core/src/gitnexus/mapper.ts`
- Test: `packages/core/tests/schemas.test.ts`
- Test: `packages/core/tests/gitnexus-mapper.test.ts`

- [ ] **Step 1: Add failing schema test**

Append this test to `packages/core/tests/schemas.test.ts`:

```ts
import { CodeRelationSchema } from "../src/schemas.js";

it("validates method_implements as a first-class relation type", () => {
  expect(CodeRelationSchema.parse({
    from: "Method:src/main/java/demo/Impl.java:Impl.preCheck#0",
    to: "Method:src/main/java/demo/Api.java:Api.preCheck#0",
    relation_type: "method_implements",
    raw_relation_type: "method_implements",
    confidence: "medium",
    evidence: [
      {
        file: "src/main/java/demo/Impl.java",
        snippet: "",
        source: "gitnexus",
        extracted_by: "gitnexus.context.incoming",
        raw_relation_type: "method_implements"
      }
    ]
  })).toMatchObject({
    relation_type: "method_implements",
    raw_relation_type: "method_implements"
  });
});
```

- [ ] **Step 2: Run schema test and verify RED**

Run:

```bash
npm run test -- packages/core/tests/schemas.test.ts -t "method_implements"
```

Expected: fail because `method_implements` is not in `RelationTypeSchema`.

- [ ] **Step 3: Add failing mapper test**

Create `packages/core/tests/gitnexus-mapper.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  findUnknownGitNexusRelationTypes,
  mapGitNexusContextToRelations
} from "../src/gitnexus/mapper.js";

describe("gitnexus mapper", () => {
  it("maps method_implements without downgrading it to references", () => {
    const relations = mapGitNexusContextToRelations({
      fromLocationId: "Method:src/main/java/demo/Api.java:Api.preCheck#0",
      context: {
        incoming: {
          method_implements: [
            {
              uid: "Method:src/main/java/demo/Impl.java:Impl.preCheck#0",
              name: "Impl.preCheck",
              filePath: "src/main/java/demo/Impl.java"
            }
          ]
        }
      }
    });

    expect(relations).toContainEqual(expect.objectContaining({
      from: "Method:src/main/java/demo/Impl.java:Impl.preCheck#0",
      to: "Method:src/main/java/demo/Api.java:Api.preCheck#0",
      relation_type: "method_implements",
      raw_relation_type: "method_implements"
    }));
    expect(findUnknownGitNexusRelationTypes(relations)).not.toContain("method_implements");
  });
});
```

- [ ] **Step 4: Run mapper test and verify RED**

Run:

```bash
npm run test -- packages/core/tests/gitnexus-mapper.test.ts
```

Expected: fail because mapper returns `relation_type="references"` and unknown relation types include `method_implements`.

- [ ] **Step 5: Implement schema and mapper change**

In `packages/core/src/schemas.ts`, add `"method_implements"` to `RelationTypeSchema` next to `"method_overrides"`:

```ts
  "method_implements",
  "method_overrides",
```

In `packages/core/src/gitnexus/mapper.ts`, add `"method_implements"` to `KNOWN_GITNEXUS_RELATION_TYPES`:

```ts
  "method_implements",
  "method_overrides",
```

In `relationType()`, add:

```ts
  if (normalized === "method_implements") return "method_implements";
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm run test -- packages/core/tests/schemas.test.ts -t "method_implements"
npm run test -- packages/core/tests/gitnexus-mapper.test.ts
```

Expected: both pass.

## Task 2: Anchor Ranking for Java Explore

**Files:**

- Modify: `packages/core/src/search/explore-symbol.ts`
- Test: `packages/core/tests/explore-symbol.test.ts`

- [ ] **Step 1: Add failing test for ranking implementation method first**

Append this test to `packages/core/tests/explore-symbol.test.ts`:

```ts
  it("ranks implementation methods before interface methods and classes for method queries", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-anchor-"));

    try {
      await writeFakeGitNexusRunner(root, [
        {
          id: "Interface:src/main/java/com/example/SettlementService.java:SettlementService",
          name: "SettlementService",
          filePath: "src/main/java/com/example/SettlementService.java",
          startLine: 1,
          endLine: 20
        },
        {
          id: "Method:src/main/java/com/example/SettlementService.java:SettlementService.preCheck#0",
          name: "preCheck",
          filePath: "src/main/java/com/example/SettlementService.java",
          startLine: 10,
          endLine: 10
        },
        {
          id: "Method:src/main/java/com/example/SettlementServiceImpl.java:SettlementServiceImpl.preCheck#0",
          name: "preCheck",
          filePath: "src/main/java/com/example/SettlementServiceImpl.java",
          startLine: 15,
          endLine: 18
        }
      ]);

      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "PreCheckResult preCheck(PreCheckParam req);",
        type: "symbol",
        direction: "downstream",
        depth: 1,
        limit: 5
      });

      expect(response.anchors[0]).toMatchObject({
        id: "Method:src/main/java/com/example/SettlementServiceImpl.java:SettlementServiceImpl.preCheck#0",
        file: "src/main/java/com/example/SettlementServiceImpl.java"
      });
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "ANCHOR_AMBIGUOUS" })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "ranks implementation methods"
```

Expected: fail because current anchors preserve GitNexus result order.

- [ ] **Step 3: Implement anchor ranking helper**

In `packages/core/src/search/explore-symbol.ts`, replace:

```ts
  const anchors = filterAnchors(search.locations, excludeTests).slice(0, anchorLimit);
```

with:

```ts
  const anchors = rankAnchors(
    filterAnchors(search.locations, excludeTests),
    input.query,
    direction
  ).slice(0, anchorLimit);
```

Add helpers near `filterAnchors()`:

```ts
function rankAnchors(
  locations: CodeLocation[],
  query: string,
  direction: ExploreDirection
): CodeLocation[] {
  return [...locations].sort((left, right) =>
    anchorRank(left, query, direction) - anchorRank(right, query, direction)
  );
}

function anchorRank(location: CodeLocation, query: string, direction: ExploreDirection): number {
  let score = 0;
  if (isTestFile(location.file)) score += 1000;
  if (location.id.startsWith("File:")) score += 500;
  if (location.id.startsWith("Class:") || location.id.startsWith("Interface:") || location.id.startsWith("Enum:")) score += 200;
  if (location.id.startsWith("Method:")) score -= 200;

  const symbol = location.symbol ?? "";
  const methodName = methodNameFromQuery(query);
  if (methodName && symbol === methodName) score -= 120;
  if (methodName && location.id.includes(`.${methodName}`)) score -= 80;

  if (location.id.includes("Impl.") || /Impl\.java$/.test(location.file)) {
    score += direction === "downstream" ? -80 : -40;
  }
  if (location.id.startsWith("Interface:") || /\/interface\//i.test(location.file)) {
    score += direction === "downstream" ? 120 : 40;
  }

  return score;
}

function methodNameFromQuery(query: string): string | undefined {
  const match = query.match(/([A-Za-z_$][\w$]*)\s*\(/);
  return match?.[1];
}
```

- [ ] **Step 4: Run focused test and verify GREEN**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "ranks implementation methods"
```

Expected: pass.

## Task 3: Conservative Candidate Path Filtering

**Files:**

- Modify: `packages/core/src/search/explore-symbol.ts`
- Test: `packages/core/tests/explore-symbol.test.ts`

- [ ] **Step 1: Add failing test that imports stay in relations but not paths**

Append:

```ts
  it("keeps imports in relations but excludes them from candidate paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "both",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            incoming: {
              imports: [
                {
                  uid: "File:src/main/java/com/example/trade/web/AdminController.java",
                  name: "AdminController.java",
                  filePath: "src/main/java/com/example/trade/web/AdminController.java"
                }
              ]
            },
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.relations).toContainEqual(expect.objectContaining({
        relation_type: "imports"
      }));
      expect(response.candidate_paths.some((path) =>
        path.relations.some((relation) => relation.relation_type === "imports")
      )).toBe(false);
      expect(response.candidate_paths).toContainEqual(expect.objectContaining({
        summary: expect.stringContaining("OrderService.detail")
      }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "keeps imports"
```

Expected: fail because current candidate path construction includes imports.

- [ ] **Step 3: Add failing test that test endpoints are excluded from paths by default**

Append:

```ts
  it("excludes src/test endpoints from candidate paths by default while keeping relations", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "both",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            incoming: {
              calls: [
                {
                  uid: "Method:src/test/java/com/example/trade/OrderControllerTest.java:OrderControllerTest.detail#0",
                  name: "OrderControllerTest.detail",
                  filePath: "src/test/java/com/example/trade/OrderControllerTest.java"
                }
              ]
            },
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.relations).toContainEqual(expect.objectContaining({
        from: expect.stringContaining("src/test/java")
      }));
      expect(response.candidate_paths.some((path) =>
        path.nodes.some((node) => node.file.includes("src/test/"))
      )).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 4: Run focused test and verify RED**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "excludes src/test endpoints"
```

Expected: fail because current path construction allows test endpoints.

- [ ] **Step 5: Pass excludeTests into candidate path builder**

In the `buildCandidatePaths()` call, add:

```ts
    excludeTests,
```

Change the function input type:

```ts
  excludeTests: boolean;
```

- [ ] **Step 6: Add path eligibility helpers**

In `packages/core/src/search/explore-symbol.ts`, add:

```ts
const PATH_RELATION_PRIORITY: Record<string, number> = {
  calls: 0,
  method_implements: 1,
  method_overrides: 2,
  maps_to_sql: 3,
  uses_table: 4,
  implements: 5,
  has_method: 6
};

function pathEligibleRelation(relation: CodeRelation): boolean {
  return Object.prototype.hasOwnProperty.call(PATH_RELATION_PRIORITY, relation.relation_type);
}

function relationPriority(relation: CodeRelation): number {
  return PATH_RELATION_PRIORITY[relation.relation_type] ?? 999;
}
```

Update `buildCandidatePaths()`:

```ts
  const pathRelations = input.relations
    .filter(pathEligibleRelation)
    .filter((relation) => !input.excludeTests || !relationTouchesTest(relation))
    .sort((left, right) => relationPriority(left) - relationPriority(right));
  const relationsByNode = indexRelations(pathRelations, input.direction);
```

Add:

```ts
function relationTouchesTest(relation: CodeRelation): boolean {
  return relation.evidence.some((evidence) => isTestFile(evidence.file))
    || relation.from.includes("/src/test/")
    || relation.to.includes("/src/test/")
    || relation.from.includes("src/test/")
    || relation.to.includes("src/test/");
}
```

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "keeps imports|excludes src/test endpoints"
```

Expected: both pass.

## Task 4: Correct Reverse Traversal Summary Rendering

**Files:**

- Modify: `packages/core/src/search/explore-symbol.ts`
- Test: `packages/core/tests/explore-symbol.test.ts`

- [ ] **Step 1: Add failing upstream summary direction test**

Append:

```ts
  it("renders reverse traversal without reversing the factual call direction", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "upstream",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            incoming: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/web/AdminController.java:AdminController.detail#0",
                  name: "AdminController.detail",
                  filePath: "src/main/java/com/example/trade/web/AdminController.java"
                }
              ]
            }
          })
        }
      });

      expect(response.candidate_paths[0]?.summary).toContain("OrderController.detail <--calls-- AdminController.detail");
      expect(response.candidate_paths[0]?.summary).not.toContain("OrderController.detail --calls--> AdminController.detail");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "renders reverse traversal"
```

Expected: fail because current summary always renders `--calls-->`.

- [ ] **Step 3: Add path edge traversal type**

In `packages/core/src/search/explore-symbol.ts`, add:

```ts
type PathStep = {
  relation: CodeRelation;
  reverse: boolean;
};
```

Change `walkPath()` input:

```ts
  currentSteps: PathStep[];
```

Change initial call:

```ts
      currentSteps: [],
```

In `walkPath()`, replace:

```ts
    const relations = [...input.currentRelations, relation];
```

with:

```ts
    const reverse = relation.to === input.currentId;
    const steps = [...input.currentSteps, { relation, reverse }];
    const relations = steps.map((step) => step.relation);
```

Update recursive call:

```ts
      currentSteps: steps,
```

- [ ] **Step 4: Change summarizePath to accept steps**

Change path creation summary:

```ts
      summary: summarizePath(nodes, steps)
```

Replace `summarizePath()` with:

```ts
function summarizePath(nodes: CodeLocation[], steps: PathStep[]): string {
  const labels: string[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    labels.push(nodes[index].symbol ?? nodes[index].id);
    const step = steps[index];
    if (step) {
      labels.push(step.reverse
        ? `<--${step.relation.relation_type}--`
        : `--${step.relation.relation_type}-->`);
    }
  }
  return labels.join(" ");
}
```

- [ ] **Step 5: Run focused test and verify GREEN**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "renders reverse traversal"
```

Expected: pass.

## Task 5: Fixture-Style Explore Matrix Test

**Files:**

- Modify: `packages/core/tests/explore-symbol.test.ts`

- [ ] **Step 1: Add a compact fake settlement graph helper**

Append helper near the bottom of `packages/core/tests/explore-symbol.test.ts`:

```ts
function settlementContextFor(symbol: string) {
  if (symbol.includes("SettlementAndRebateServiceImpl.preCheckRebate")) {
    return {
      incoming: {
        calls: [
          {
            uid: "Method:src/main/java/com/example/SettlementBillCommandService.java:SettlementBillCommandService.preCheckRebate#0",
            name: "SettlementBillCommandService.preCheckRebate",
            filePath: "src/main/java/com/example/SettlementBillCommandService.java"
          },
          {
            uid: "Method:src/test/java/com/example/SettlementAndRebateServiceImplTest.java:SettlementAndRebateServiceImplTest.preCheckRebate_shouldThrowWhenReqIsNull#0",
            name: "SettlementAndRebateServiceImplTest.preCheckRebate_shouldThrowWhenReqIsNull",
            filePath: "src/test/java/com/example/SettlementAndRebateServiceImplTest.java"
          }
        ],
        method_implements: [
          {
            uid: "Method:src/main/java/com/example/SettlementAndRebateService.java:SettlementAndRebateService.preCheckRebate#0",
            name: "SettlementAndRebateService.preCheckRebate",
            filePath: "src/main/java/com/example/SettlementAndRebateService.java"
          }
        ],
        imports: [
          {
            uid: "File:src/main/java/com/example/SettlementController.java",
            name: "SettlementController.java",
            filePath: "src/main/java/com/example/SettlementController.java"
          }
        ]
      },
      outgoing: {
        calls: [
          {
            uid: "Method:src/main/java/com/example/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.checkPreCheckParam#0",
            name: "SettlementAndRebateServiceImpl.checkPreCheckParam",
            filePath: "src/main/java/com/example/SettlementAndRebateServiceImpl.java"
          },
          {
            uid: "Method:src/main/java/com/example/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.executePreCheckRebate#0",
            name: "SettlementAndRebateServiceImpl.executePreCheckRebate",
            filePath: "src/main/java/com/example/SettlementAndRebateServiceImpl.java"
          }
        ]
      }
    };
  }
  return {};
}
```

- [ ] **Step 2: Add failing matrix test**

Append:

```ts
  it("handles upstream, downstream, both, method bridges, tests, and imports in a settlement fixture graph", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-anchor-"));

    try {
      await writeFakeGitNexusRunner(root, [
        {
          id: "Method:src/main/java/com/example/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.preCheckRebate#0",
          name: "preCheckRebate",
          filePath: "src/main/java/com/example/SettlementAndRebateServiceImpl.java",
          startLine: 10,
          endLine: 20
        }
      ]);

      const downstream = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "SettlementAndRebateServiceImpl.preCheckRebate",
        type: "symbol",
        direction: "downstream",
        depth: 1,
        limit: 10,
        adapter: { context: async (input) => settlementContextFor(input.symbol) }
      });
      expect(downstream.candidate_paths.map((path) => path.summary).join("\n")).toContain("SettlementAndRebateServiceImpl.checkPreCheckParam");

      const upstream = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "SettlementAndRebateServiceImpl.preCheckRebate",
        type: "symbol",
        direction: "upstream",
        depth: 1,
        limit: 10,
        adapter: { context: async (input) => settlementContextFor(input.symbol) }
      });
      const upstreamSummary = upstream.candidate_paths.map((path) => path.summary).join("\n");
      expect(upstreamSummary).toContain("preCheckRebate <--calls-- SettlementBillCommandService.preCheckRebate");
      expect(upstreamSummary).not.toContain("src/test");
      expect(upstream.candidate_paths.some((path) =>
        path.relations.some((relation) => relation.relation_type === "imports")
      )).toBe(false);

      const both = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "SettlementAndRebateServiceImpl.preCheckRebate",
        type: "symbol",
        direction: "both",
        depth: 1,
        limit: 10,
        adapter: { context: async (input) => settlementContextFor(input.symbol) }
      });
      expect(both.relations).toContainEqual(expect.objectContaining({
        relation_type: "method_implements",
        raw_relation_type: "method_implements"
      }));
      expect(both.candidate_paths.some((path) =>
        path.relations.some((relation) => relation.relation_type === "imports")
      )).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 3: Run matrix test and verify RED**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "settlement fixture graph"
```

Expected before Tasks 1-4 are complete: fail because `method_implements`, import filtering, test endpoint filtering, or reverse summary is not correct.

- [ ] **Step 4: Run matrix test after Tasks 1-4 and verify GREEN**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "settlement fixture graph"
```

Expected after prior tasks: pass.

## Task 6: Save Manual `mi-intl-scheme` Eval Case

**Files:**

- Create under: `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/`

- [ ] **Step 1: Create eval case directory**

Run:

```bash
mkdir -p /root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820
```

Expected: directory exists.

- [ ] **Step 2: Save case metadata**

Create `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/case.json`:

```json
{
  "case_id": "precheck-rebate-both-direction-20260820",
  "project": "mi-intl-scheme",
  "project_path": "/mnt/g/workSpace/mi-intl-scheme",
  "gitnexus_repo": "mi-intl-scheme",
  "commit_hash": "d465a5102d59942e49e73ae2353e750f29aad823",
  "dirty": true,
  "created_at": "2026-08-20",
  "created_reason": "真实试用发现 both 模式方向反转、imports/test 污染、method_implements 降级。"
}
```

- [ ] **Step 3: Save request**

Create `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/request.json`:

```json
{
  "tool": "explore",
  "project": "mi-intl-scheme",
  "query": "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);",
  "type": "symbol",
  "direction": "both",
  "depth": 3,
  "limit": 20,
  "exclude_tests": true
}
```

- [ ] **Step 4: Save expectations**

Create `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/expectations.json`:

```json
{
  "must_have": [
    {
      "type": "relation",
      "from_contains": "SettlementBillCommandServiceImpl.preCheckRebate",
      "to_contains": "SettlementAndRebateServiceImpl.preCheckRebate",
      "relation_type": "calls"
    },
    {
      "type": "relation_type",
      "relation_type": "method_implements"
    }
  ],
  "must_not_have": [
    {
      "type": "candidate_path_relation_type",
      "relation_type": "imports"
    },
    {
      "type": "candidate_path_file_contains",
      "pattern": "src/test"
    },
    {
      "type": "summary",
      "pattern": "SettlementAndRebateServiceImpl.preCheckRebate --calls--> SettlementBillCommandServiceImpl.preCheckRebate"
    },
    {
      "type": "diagnostic_code",
      "code": "GITNEXUS_UNKNOWN_RELATION_TYPE",
      "when_message_contains": "method_implements"
    }
  ],
  "allowed_diagnostics": [
    "INDEX_STALE",
    "ANCHOR_AMBIGUOUS",
    "RELATION_LIMIT_REACHED",
    "FANOUT_LIMIT_REACHED",
    "PATH_VERIFICATION_SKIPPED"
  ]
}
```

- [ ] **Step 5: Run fixed explore command and save raw response**

Run:

```bash
node packages/cli/dist/index.js explore mi-intl-scheme \
  --query "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);" \
  --type symbol \
  --direction both \
  --depth 3 \
  --limit 20 > /root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/response.raw.json
```

Expected: command exits 0 and `response.raw.json` contains valid JSON.

- [ ] **Step 6: Save normalized response**

Run this command from `/mnt/g/my-Skill/Code-intelligence`:

```bash
node --input-type=module -e '
import { readFile, writeFile } from "node:fs/promises";

const dir = "/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820";
const raw = JSON.parse(await readFile(`${dir}/response.raw.json`, "utf8"));
const normalized = {
  anchors: raw.anchors.map((anchor) => ({
    symbol: anchor.symbol,
    file: anchor.file,
    source: anchor.source
  })),
  relations: raw.relations
    .map((relation) => ({
      from: relation.from,
      to: relation.to,
      relation_type: relation.relation_type,
      raw_relation_type: relation.raw_relation_type
    }))
    .sort((left, right) =>
      `${left.from}\u0000${left.to}\u0000${left.relation_type}\u0000${left.raw_relation_type ?? ""}`
        .localeCompare(`${right.from}\u0000${right.to}\u0000${right.relation_type}\u0000${right.raw_relation_type ?? ""}`)
    ),
  candidate_paths: raw.candidate_paths.map((path) => ({
    summary: path.summary,
    path_status: path.path_status,
    relation_types: path.relations.map((relation) => relation.relation_type),
    node_files: path.nodes.map((node) => node.file)
  })),
  diagnostic_codes: raw.diagnostics.map((diagnostic) => diagnostic.code)
};

await writeFile(`${dir}/response.normalized.json`, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
'
```

Expected: `response.normalized.json` exists and contains stable fields only.

- [ ] **Step 7: Save notes**

Create `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/notes.md`:

```markdown
# precheck-rebate-both-direction-20260820

## 背景

真实试用 `explore` 查询 `preCheckRebate` 时发现 v0.3 候选路径存在方向反转、imports/test 污染、`method_implements` 降级为 `references` 的问题。

## 修复目标

- 保留原始 relations 证据。
- candidate_paths 不包含 imports。
- 默认 excludeTests=true 时 candidate_paths 不包含 src/test。
- `method_implements` 是一等 relation_type。
- upstream / both 的反向遍历 summary 不反转真实 calls 方向。

## 验收方式

运行 request.json 中的 explore 命令，检查 response.raw.json 和 expectations.json。
```

## Task 7: Documentation Updates

**Files:**

- Modify: `docs/current-tool-capabilities.zh-CN.md`
- Modify: `docs/user-guide.zh-CN.md`
- Modify: `docs/code-intelligence-pitfalls-and-evolution.zh-CN.md`

- [ ] **Step 1: Update current capabilities**

In `docs/current-tool-capabilities.zh-CN.md`, update the `code.explore_symbol` / `candidate_paths` section to include:

```markdown
v0.3 回归修正后，`relations` 和 `candidate_paths` 的语义边界更明确：

- `relations` 保留更完整的 GitNexus context 证据，包括 `imports`、`accesses`、测试关系等。
- `candidate_paths` 默认只使用更适合路径片段的关系，例如 `calls`、`method_implements`、`method_overrides`、`implements`、`has_method`、`maps_to_sql`、`uses_table`。
- 默认 `exclude_tests=true` 时，测试代码关系可以保留在 `relations`，但不会进入 `candidate_paths`。
- `both` / `upstream` 反向遍历时，summary 不会反转真实 `calls` 方向。
```

- [ ] **Step 2: Update user guide**

In `docs/user-guide.zh-CN.md`, update `explore` usage notes with:

```markdown
读取 `candidate_paths` 时要注意：

- 它是候选路径片段，不是完整调用链证明。
- 如果出现 `PATH_TRUNCATED`、`RELATION_LIMIT_REACHED`、`FANOUT_LIMIT_REACHED`，说明本次结果被预算限制截断。
- 默认不会把 `imports` 和 `src/test` 测试端点包装进 `candidate_paths`。
- 需要分析测试调用关系时使用 `--include-tests`。
```

- [ ] **Step 3: Update pitfalls document**

Append to `docs/code-intelligence-pitfalls-and-evolution.zh-CN.md`:

```markdown
## 14. 踩坑十：图谱邻域不等于候选调用路径

真实试用 `preCheckRebate` 时，`explore` 能返回大量 GitNexus 关系边，但早期 v0.3 把 `imports`、测试调用和反向遍历的 `calls` 都包装进 `candidate_paths`，导致结果像调用链但实际会误导上层 Agent。

修正后，`relations` 继续保留完整证据，`candidate_paths` 只保留更适合路径片段的关系，并且 summary 尊重真实边方向。重复出现的低置信或截断 diagnostics 会沉淀成 eval case，而不是只靠文字复盘。
```

## Task 8: Verification and Real Project Validation

**Files:**

- No source changes beyond previous tasks.

- [ ] **Step 1: Build**

Run:

```bash
npm run build
```

Expected: exit 0.

- [ ] **Step 2: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Full tests**

Run:

```bash
npm run test
```

Expected: all test files pass.

- [ ] **Step 4: Bash syntax check**

Run:

```bash
bash -n scripts/install-local.sh
```

Expected: exit 0.

- [ ] **Step 5: Real project validation**

Run:

```bash
node packages/cli/dist/index.js explore mi-intl-scheme \
  --query "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);" \
  --type symbol \
  --direction both \
  --depth 3 \
  --limit 20
```

Expected response properties:

- No summary contains `SettlementAndRebateServiceImpl.preCheckRebate --calls--> SettlementBillCommandServiceImpl.preCheckRebate`.
- No diagnostic says unknown relation type `method_implements`.
- `relations` contains at least one `relation_type="method_implements"` if GitNexus returns that raw type.
- Default `candidate_paths` do not include `src/test`.
- Default `candidate_paths` do not include `imports`.
- Diagnostics may still include `INDEX_STALE`, `ANCHOR_AMBIGUOUS`, `RELATION_LIMIT_REACHED`, `FANOUT_LIMIT_REACHED`, and `PATH_VERIFICATION_SKIPPED`.

- [ ] **Step 6: Confirm eval case files**

Run:

```bash
find /root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820 -maxdepth 1 -type f | sort
```

Expected files:

```text
/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/case.json
/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/expectations.json
/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/notes.md
/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/request.json
/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/response.normalized.json
/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/response.raw.json
```

## Execution Notes

- Follow TDD. Every production behavior change above has a failing test first.
- Do not implement `call-path` in this plan.
- Do not implement eval CLI in this plan.
- This workspace is not a git repository. Skip commit commands and report changed files instead.
- If real project validation differs because `/mnt/g/workSpace/mi-intl-scheme` changed, preserve `diagnostics`, report exact differences, and do not silently weaken expectations.
