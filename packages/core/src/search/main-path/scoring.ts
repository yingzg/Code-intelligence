import type { CodeLocation, CodeRelation, Confidence, ExploreDirection, ScoreFactor } from "../../schemas.js";
import { classifyNode } from "./role-classifier.js";

export function scoreRelationForMainPath(relation: CodeRelation): ScoreFactor[] {
  const weight = relationTypeWeight(relation.relation_type);
  return [
    {
      name: `RELATION_${relation.relation_type.toUpperCase()}`,
      weight,
      reason: `${relation.relation_type} 边的主链路基础权重为 ${weight}。`
    }
  ];
}

export function scorePathForMainPath(input: {
  nodes: CodeLocation[];
  relations: CodeRelation[];
  targetAnchorIds: Set<string>;
  direction: ExploreDirection;
}): {
  score: number;
  confidence: Confidence;
  score_breakdown: ScoreFactor[];
  confidence_reason: string;
} {
  const factors: ScoreFactor[] = [];
  for (const relation of input.relations) factors.push(...scoreRelationForMainPath(relation));

  for (const node of input.nodes) {
    const classified = classifyNode(node);
    const weight = roleWeight(classified.role);
    if (weight !== 0) {
      factors.push({
        name: `ROLE_${classified.role.toUpperCase()}`,
        weight,
        reason: classified.reasons[0] ?? `${classified.role} 角色权重。`
      });
    }
  }

  if (input.nodes.some((node) => isImplementationNode(node))) {
    factors.push({
      name: "IMPLEMENTATION_NODE_BONUS",
      weight: 0.15,
      reason: "实现类或 impl 路径通常比接口声明更适合作为排障主链路。"
    });
  }
  if (input.nodes.some((node) => input.targetAnchorIds.has(node.id) && isImplementationNode(node))) {
    factors.push({
      name: "IMPLEMENTATION_TARGET_BONUS",
      weight: 0.25,
      reason: "目标 anchor 命中实现类方法，通常比接口声明更接近实际执行逻辑。"
    });
  }

  if (input.relations.filter((relation) => relation.relation_type === "calls").length >= 1) {
    factors.push({
      name: "CALL_EDGE_CONTINUITY",
      weight: input.relations.length >= 2 ? 0.3 : 0.15,
      reason: "路径包含 calls 边，具备调用链连续性。"
    });
  }

  if (input.nodes.some((node) => input.targetAnchorIds.has(node.id))) {
    factors.push({
      name: "TARGET_ANCHOR_INCLUDED",
      weight: 0.3,
      reason: "路径包含用户查询命中的目标 anchor。"
    });
  }

  if (input.relations.some((relation) => relation.from === relation.to)) {
    factors.push({
      name: "SELF_LOOP_PENALTY",
      weight: -0.3,
      reason: "路径包含自环，不能作为稳定主链路。"
    });
  }

  const repeatedNodePenalty = repeatedNodeCount(input.nodes);
  if (repeatedNodePenalty > 0) {
    factors.push({
      name: "REPEATED_NODE_PENALTY",
      weight: -0.2 * repeatedNodePenalty,
      reason: "路径出现重复节点，降低主链路可信度。"
    });
  }

  const score = round(factors.reduce((sum, factor) => sum + factor.weight, 0));
  const confidence = confidenceFor(score);
  const confidence_reason = confidenceReason(confidence, input.relations);

  return {
    score,
    confidence,
    score_breakdown: factors,
    confidence_reason
  };
}

function relationTypeWeight(type: CodeRelation["relation_type"]): number {
  if (type === "calls") return 0.45;
  if (type === "method_implements") return 0.25;
  if (type === "implements") return 0.2;
  if (type === "has_method") return 0.1;
  if (type === "maps_to_sql" || type === "uses_table") return 0.35;
  if (type === "accesses") return -0.05;
  if (type === "references") return -0.1;
  if (type === "imports") return -0.3;
  return -0.15;
}

function roleWeight(role: ReturnType<typeof classifyNode>["role"]): number {
  if (["controller", "provider", "application_service", "domain_service", "repository", "mapper", "sql"].includes(role)) {
    return 0.2;
  }
  if (["validation", "parameter_assembly", "lock", "exception"].includes(role)) return -0.05;
  if (["utility", "dto", "test"].includes(role)) return -0.25;
  return 0;
}

function repeatedNodeCount(nodes: CodeLocation[]): number {
  const seen = new Set<string>();
  let repeated = 0;
  for (const node of nodes) {
    if (seen.has(node.id)) repeated += 1;
    seen.add(node.id);
  }
  return repeated;
}

function isImplementationNode(node: CodeLocation): boolean {
  const haystack = `${node.id}\n${node.file}\n${node.symbol ?? ""}`;
  return /(?:Impl|Implementation)\b/.test(haystack) || /\/impl\//i.test(haystack);
}

function confidenceFor(score: number): Confidence {
  if (score >= 0.75) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

function confidenceReason(confidence: Confidence, relations: CodeRelation[]): string {
  const callCount = relations.filter((relation) => relation.relation_type === "calls").length;
  if (confidence === "high") return `连续 calls 证据较强，包含 ${callCount} 条 calls 边。`;
  if (confidence === "medium") return `存在 calls 证据，可作为候选主链路优先验证。`;
  return "缺少稳定 calls 主链路证据，只能作为线索。";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
