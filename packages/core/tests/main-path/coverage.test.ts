import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../src/schemas.js";
import { buildBudgetSummary, buildExploreCoverage } from "../../src/search/main-path/coverage.js";

describe("main path coverage", () => {
  it("marks coverage incomplete when relation budget, fanout, depth or anchor ambiguity diagnostics are present", () => {
    const diagnostics: Diagnostic[] = [
      { level: "info", code: "RELATION_LIMIT_REACHED", message: "关系数量超过预算。" },
      { level: "info", code: "FANOUT_LIMIT_REACHED", message: "fanout 超限。" },
      { level: "info", code: "DOWNSTREAM_DEPTH_LIMIT_REACHED", message: "下游深度超限。" },
      { level: "info", code: "ANCHOR_AMBIGUOUS", message: "多个 anchor。" },
      { level: "info", code: "GITNEXUS_RELATIONS_USED", message: "已使用 GitNexus。" }
    ];

    const coverage = buildExploreCoverage({
      diagnostics,
      usedSources: ["gitnexus"],
      anchorCount: 2,
      omittedRelationCount: 3
    });

    expect(coverage).toMatchObject({
      complete: false,
      relation_budget_reached: true,
      fanout_limit_reached: true,
      depth_limit_reached: true,
      anchor_ambiguous: true,
      used_sources: ["gitnexus"],
      omitted_relation_count: 3
    });
    expect(coverage.note).toContain("候选主链路");
  });

  it("summarizes budget hit reasons for upstream agents", () => {
    const summary = buildBudgetSummary({
      requestedDepth: 2,
      requestedLimit: 20,
      relationBudget: 80,
      exploredRelationCount: 80,
      returnedRelationCount: 60,
      mainPathCount: 2,
      sideRelationCount: 8,
      foldedStepCount: 3,
      diagnostics: [
        { level: "info", code: "RELATION_LIMIT_REACHED", message: "关系数量超过预算。" },
        { level: "info", code: "DOWNSTREAM_DEPTH_LIMIT_REACHED", message: "下游深度超限。" }
      ]
    });

    expect(summary.budget_hit).toBe(true);
    expect(summary.budget_hit_reasons).toEqual(["relation_budget", "depth"]);
    expect(summary.main_path_count).toBe(2);
  });
});
