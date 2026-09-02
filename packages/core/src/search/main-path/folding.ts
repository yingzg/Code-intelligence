import type { CodeLocation, CodeRelation, FoldedStep } from "../../schemas.js";
import { classifyNode } from "./role-classifier.js";

export function classifyFoldedStep(input: {
  relation: CodeRelation;
  from?: CodeLocation;
  to?: CodeLocation;
}): FoldedStep | undefined {
  const target = input.to ?? input.from;
  if (!target) return undefined;

  const role = classifyNode(target).role;
  const foldType = foldTypeForRole(role);
  if (!foldType) return undefined;

  return {
    relation_id: relationKey(input.relation),
    fold_type: foldType,
    summary: `${summaryLabel(target)} 被折叠为${foldTypeLabel(foldType)}步骤`,
    evidence: input.relation.evidence
  };
}

export function foldPathDetails(input: {
  nodes: CodeLocation[];
  relations: CodeRelation[];
}): {
  nodes: CodeLocation[];
  relations: CodeRelation[];
  folded_steps: FoldedStep[];
} {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const folded_steps: FoldedStep[] = [];
  const keptRelations: CodeRelation[] = [];
  const foldedNodeIds = new Set<string>();

  for (const relation of input.relations) {
    const from = nodesById.get(relation.from);
    const to = nodesById.get(relation.to);
    const folded = classifyFoldedStep({ relation, from, to });
    if (folded) {
      folded_steps.push(folded);
      if (to) foldedNodeIds.add(to.id);
      continue;
    }
    keptRelations.push(relation);
  }

  return {
    nodes: input.nodes.filter((node, index) => index === 0 || !foldedNodeIds.has(node.id)),
    relations: keptRelations,
    folded_steps
  };
}

function foldTypeForRole(role: ReturnType<typeof classifyNode>["role"]): FoldedStep["fold_type"] | undefined {
  if (role === "validation") return "validation";
  if (role === "parameter_assembly") return "parameter_assembly";
  if (role === "exception") return "exception";
  if (role === "lock") return "lock";
  if (role === "dto") return "dto_accessor";
  if (role === "utility") return "utility";
  if (role === "test") return "test";
  return undefined;
}

function foldTypeLabel(type: FoldedStep["fold_type"]): string {
  if (type === "validation") return "参数校验";
  if (type === "parameter_assembly") return "参数组装";
  if (type === "exception") return "异常";
  if (type === "lock") return "锁";
  if (type === "dto_accessor") return "DTO 访问";
  if (type === "utility") return "工具";
  if (type === "test") return "测试";
  return "低优先级细节";
}

function relationKey(relation: CodeRelation): string {
  return `${relation.from}->${relation.to}:${relation.relation_type}:${relation.raw_relation_type ?? ""}`;
}

function summaryLabel(node: CodeLocation): string {
  return node.symbol ?? node.id.split(":").at(-1)?.replace(/#\d+$/, "") ?? node.id;
}
