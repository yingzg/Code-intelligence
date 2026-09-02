import type { CodeRelation, SideRelation } from "../../schemas.js";

const PRIORITY: Partial<Record<CodeRelation["relation_type"], number>> = {
  calls: 100,
  method_implements: 85,
  implements: 80,
  method_overrides: 78,
  maps_to_sql: 72,
  uses_table: 70,
  has_method: 65,
  accesses: 35,
  references: 30,
  imports: 10
};

export function relationExpansionPriority(relation: CodeRelation): number {
  if (relation.from === relation.to) return 0;
  const base = PRIORITY[relation.relation_type] ?? 20;
  const testPenalty = relationTouchesTest(relation) ? 95 : 0;
  return Math.max(0, base - testPenalty);
}

export function splitSideRelations(input: {
  relations: CodeRelation[];
  mainPathRelationKeys: Set<string>;
}): {
  mainRelations: CodeRelation[];
  sideRelations: SideRelation[];
} {
  const mainRelations: CodeRelation[] = [];
  const sideRelations: SideRelation[] = [];

  for (const relation of input.relations) {
    if (input.mainPathRelationKeys.has(relationKey(relation))) {
      mainRelations.push(relation);
      continue;
    }

    sideRelations.push({
      id: `side_relation_${sideRelations.length + 1}`,
      side_type: sideRelationType(relation),
      reason: sideRelationReason(relation),
      ...relation
    });
  }

  return { mainRelations, sideRelations };
}

export function relationKey(relation: CodeRelation): string {
  return `${relation.from}\u0000${relation.to}\u0000${relation.relation_type}\u0000${relation.raw_relation_type ?? ""}`;
}

function sideRelationType(relation: CodeRelation): SideRelation["side_type"] {
  if (relationTouchesTest(relation)) return "test_noise";
  if (relation.relation_type === "imports") return "import_noise";
  if (relation.relation_type === "accesses") return "dto_detail";
  if (/(?:Util|Utils|Helper|Lock|Redisson)/i.test(`${relation.from}\n${relation.to}`)) return "utility_detail";
  if (relation.relation_type === "references") return "parallel_branch";
  return "low_score_relation";
}

function sideRelationReason(relation: CodeRelation): string {
  if (relationTouchesTest(relation)) return "测试代码关系不进入默认主链路。";
  if (relation.relation_type === "imports") return "imports 只能证明静态依赖，不适合作为调用主链路。";
  if (relation.relation_type === "accesses") return "字段访问作为细节证据保留。";
  return "该关系未进入当前主链路骨架，作为辅助证据保留。";
}

function relationTouchesTest(relation: CodeRelation): boolean {
  return isTestLike(relation.from)
    || isTestLike(relation.to)
    || relation.evidence.some((evidence) => isTestLike(evidence.file));
}

function isTestLike(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized.includes("/src/test/")
    || normalized.startsWith("src/test/")
    || /\b\w+Test\b/.test(normalized);
}
