import type { BudgetSummary, Diagnostic, ExploreCoverage } from "../../schemas.js";

type CoverageSource = ExploreCoverage["used_sources"][number];

export function buildExploreCoverage(input: {
  diagnostics: Diagnostic[];
  usedSources: CoverageSource[];
  anchorCount: number;
  omittedRelationCount?: number;
}): ExploreCoverage {
  const relation_budget_reached = hasDiagnostic(input.diagnostics, "RELATION_LIMIT_REACHED");
  const fanout_limit_reached = hasDiagnostic(input.diagnostics, "FANOUT_LIMIT_REACHED");
  const depth_limit_reached = hasDiagnostic(input.diagnostics, "DOWNSTREAM_DEPTH_LIMIT_REACHED")
    || hasDiagnostic(input.diagnostics, "UPSTREAM_DEPTH_LIMIT_REACHED")
    || hasDiagnostic(input.diagnostics, "PATH_TRUNCATED");
  const anchor_ambiguous = input.anchorCount > 1 || hasDiagnostic(input.diagnostics, "ANCHOR_AMBIGUOUS");
  const complete = !(relation_budget_reached || fanout_limit_reached || depth_limit_reached || anchor_ambiguous);
  const used_sources = unique(input.usedSources);

  return {
    complete,
    relation_budget_reached,
    fanout_limit_reached,
    depth_limit_reached,
    anchor_ambiguous,
    used_sources,
    omitted_relation_count: input.omittedRelationCount,
    note: complete
      ? "本次候选主链路未命中预算截断；仍需结合代码证据验证业务结论。"
      : "本次返回预算内候选主链路，relations 不是完整图谱。"
  };
}

export function buildBudgetSummary(input: {
  requestedDepth: number;
  requestedLimit: number;
  relationBudget: number;
  exploredRelationCount: number;
  returnedRelationCount: number;
  mainPathCount: number;
  sideRelationCount: number;
  foldedStepCount: number;
  diagnostics: Diagnostic[];
}): BudgetSummary {
  const budget_hit_reasons = budgetHitReasons(input.diagnostics);
  return {
    requested_depth: input.requestedDepth,
    requested_limit: input.requestedLimit,
    relation_budget: input.relationBudget,
    explored_relation_count: input.exploredRelationCount,
    returned_relation_count: input.returnedRelationCount,
    main_path_count: input.mainPathCount,
    side_relation_count: input.sideRelationCount,
    folded_step_count: input.foldedStepCount,
    budget_hit: budget_hit_reasons.length > 0,
    budget_hit_reasons
  };
}

function budgetHitReasons(diagnostics: Diagnostic[]): string[] {
  const reasons: string[] = [];
  if (hasDiagnostic(diagnostics, "RELATION_LIMIT_REACHED")) reasons.push("relation_budget");
  if (hasDiagnostic(diagnostics, "FANOUT_LIMIT_REACHED")) reasons.push("fanout");
  if (
    hasDiagnostic(diagnostics, "DOWNSTREAM_DEPTH_LIMIT_REACHED")
    || hasDiagnostic(diagnostics, "UPSTREAM_DEPTH_LIMIT_REACHED")
    || hasDiagnostic(diagnostics, "PATH_TRUNCATED")
  ) {
    reasons.push("depth");
  }
  return reasons;
}

function hasDiagnostic(diagnostics: Diagnostic[], code: Diagnostic["code"]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.code === code);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
