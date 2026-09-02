# Explore v0.3.2 Usability Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the real `mi-intl-scheme` explore usability regressions: unreadable same-name summaries, overly broad anchors, relation/path budget coupling, and over-propagated truncation status.

**Architecture:** Keep `explore` as the GitNexus-backed evidence explorer, but make its output more usable and honest. This version does not build a full main-path engine; it stabilizes the current evidence contract and documents the JDT LS Call Hierarchy spike as the next wheel-evaluation step.

**Tech Stack:** TypeScript, Vitest, Commander CLI, GitNexus adapter, Markdown docs.

---

### Task 1: Summary Labels and Signature-Aware Anchors

**Files:**
- Modify: `packages/core/src/search/explore-symbol.ts`
- Modify: `packages/core/tests/explore-symbol.test.ts`

- [ ] **Step 1: Add failing tests**

Add tests that prove:
- A path containing two `preCheckRebate` methods renders class-qualified labels, not `preCheckRebate <--calls-- preCheckRebate`.
- A method-signature query prefers anchors whose method name and parameter type match the query.
- A signature query for `preCheckRebate(PreCheckSettlementParamValObj req)` does not include `buildPreCheckRebateParam` as an anchor when matching method anchors exist.

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "summary labels|signature query"
```

Expected before implementation: failing assertions for summary label and/or anchor filtering.

- [ ] **Step 2: Implement summary label extraction**

Implement a helper in `explore-symbol.ts` that derives a readable label from `CodeLocation.id`:

```text
Method:<file>:ClassName.methodName#N -> ClassName.methodName
Constructor:<file>:ClassName.ConstructorName#N -> ClassName.ConstructorName
Class:<file>:ClassName -> ClassName
Interface:<file>:InterfaceName -> InterfaceName
File:<path> -> filename
```

Use the derived label whenever a path contains duplicate plain symbols or the symbol does not already include an owner.

- [ ] **Step 3: Implement signature-aware anchor filtering/ranking**

Parse lightweight Java method signatures from query text:

```text
ReturnType methodName(TypeA argA, TypeB argB)
methodName(TypeA argA)
```

Use this to:
- Prefer exact method-name matches.
- Prefer snippets containing all query parameter type names.
- Filter non-matching method names when at least one method-name match exists.
- Downgrade overloads whose snippets do not include the requested parameter types.

- [ ] **Step 4: Verify**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts
```

Expected: all explore tests pass.

### Task 2: Split Path Display Limit from Relation Expansion Budget

**Files:**
- Modify: `packages/core/src/search/explore-symbol.ts`
- Modify: `packages/core/tests/explore-symbol.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/tests/cli.test.ts`
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Add failing tests**

Add tests that prove:
- `limit` controls returned `candidate_paths` count.
- relation expansion uses a separate `relationBudget`.
- default relation budget is larger than the default path output limit.
- CLI can accept `--relation-budget`.
- MCP can accept `relation_budget`.

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "relation budget"
npm run test -- packages/cli/tests/cli.test.ts -t "relation budget"
npm run test -- packages/mcp/tests/mcp-tools.test.ts -t "explore"
```

Expected before implementation: relation budget tests fail.

- [ ] **Step 2: Implement relation budget**

Add `relationBudget?: number` to `exploreSymbol` input. Use:

```text
DEFAULT_LIMIT = 20
DEFAULT_RELATION_BUDGET = 60
```

`limit` remains the max number of returned `candidate_paths`; `relationBudget` controls relation expansion and `RELATION_LIMIT_REACHED`.

- [ ] **Step 3: Add CLI/MCP options**

CLI:

```bash
code-intel explore <project> --limit 20 --relation-budget 60
```

MCP:

```json
{
  "limit": 20,
  "relation_budget": 60
}
```

- [ ] **Step 4: Verify**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts packages/cli/tests/cli.test.ts packages/mcp/tests/mcp-tools.test.ts
```

Expected: relevant tests pass.

### Task 3: Path-Level Truncation Instead of Global Over-Propagation

**Files:**
- Modify: `packages/core/src/search/explore-symbol.ts`
- Modify: `packages/core/tests/explore-symbol.test.ts`

- [ ] **Step 1: Add failing tests**

Add tests that prove:
- A global `RELATION_LIMIT_REACHED` does not automatically mark every candidate path as `truncated`.
- Paths at `maxDepth` with no known continuation can remain `candidate`.
- Paths that are known to stop because of depth/fanout/path output budget are marked `truncated`.

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts -t "path-level truncation"
```

Expected before implementation: tests fail against global truncation behavior.

- [ ] **Step 2: Implement local truncation metadata**

Track truncation at path construction time instead of using one global boolean for every path:
- Relation budget stays in top-level diagnostics.
- Path diagnostics are added only when the path itself is known to be affected.
- `PATH_VERIFICATION_SKIPPED` remains top-level when candidate paths are returned.

- [ ] **Step 3: Verify**

Run:

```bash
npm run test -- packages/core/tests/explore-symbol.test.ts
```

Expected: all explore tests pass with mixed `candidate` and `truncated` statuses where appropriate.

### Task 4: JDT LS Call Hierarchy Spike Design

**Files:**
- Create: `docs/2026-08-21-jdt-ls-call-hierarchy-spike.zh-CN.md`

- [ ] **Step 1: Write spike design**

Document:
- What JDT LS Call Hierarchy is.
- How LSP `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, and `callHierarchy/outgoingCalls` work.
- How to validate on `mi-intl-scheme`.
- Success/failure criteria.
- How it would coexist with GitNexus.

- [ ] **Step 2: Self-review**

Check the doc does not claim JDT LS is already integrated. It must describe a spike, not a delivered feature.

### Task 5: Final Verification on Tests and Real Eval

**Files:**
- Modify: `/root/.code-intelligence/projects/mi-intl-scheme/eval-cases/precheck-rebate-both-direction-20260820/*`
- Modify docs if CLI/MCP options changed.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run build
npm run typecheck
npm run test
```

- [ ] **Step 2: Run real project eval**

Run:

```bash
node packages/cli/dist/index.js explore mi-intl-scheme \
  --query "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);" \
  --type symbol \
  --direction both
```

Check:
- no `preCheckRebate <--calls-- preCheckRebate` summaries;
- `buildPreCheckRebateParam` is not an anchor for the exact `preCheckRebate(PreCheckSettlementParamValObj req)` signature query when matching anchors exist;
- default command does not hit `RELATION_LIMIT_REACHED` merely because path output limit defaults to 20;
- `candidate_paths` still exclude `imports`, `references`, `accesses`, and `src/test` by default;
- `method_implements` remains a first-class relation.

---

## Self-Review

- Scope is intentionally limited to v0.3.2 usability fixes plus a JDT LS spike design. It does not implement a full main-path planner.
- All behavior changes are covered by failing tests before implementation.
- Since this directory is not a git repository, commit steps are intentionally omitted.
