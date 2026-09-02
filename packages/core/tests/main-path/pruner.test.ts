import { describe, expect, it } from "vitest";
import type { CodeRelation } from "../../src/schemas.js";
import { relationExpansionPriority, relationKey, splitSideRelations } from "../../src/search/main-path/pruner.js";

function relation(from: string, to: string, relation_type: CodeRelation["relation_type"], file = "src/main/java/com/acme/A.java"): CodeRelation {
  return {
    from,
    to,
    relation_type,
    raw_relation_type: relation_type,
    confidence: "medium",
    evidence: [
      {
        file,
        snippet: "",
        source: "gitnexus",
        extracted_by: "test",
        raw_relation_type: relation_type
      }
    ]
  };
}

describe("main path relation pruning", () => {
  it("prioritizes calls and implementation edges over imports and test noise", () => {
    expect(relationExpansionPriority(relation("A", "B", "calls"))).toBeGreaterThan(
      relationExpansionPriority(relation("A", "B", "imports"))
    );
    expect(relationExpansionPriority(relation("A", "B", "method_implements"))).toBeGreaterThan(
      relationExpansionPriority(relation("A", "B", "references"))
    );
    expect(relationExpansionPriority(relation("A", "B", "calls", "src/test/java/com/acme/ATest.java"))).toBeLessThan(
      relationExpansionPriority(relation("A", "B", "calls"))
    );
  });

  it("moves non-main relations to side relations with reasons", () => {
    const main = relation("A", "B", "calls");
    const imported = relation("File:src/main/java/com/acme/A.java", "B", "imports");
    const test = relation("Test", "B", "calls", "src/test/java/com/acme/BTest.java");

    const split = splitSideRelations({
      relations: [main, imported, test],
      mainPathRelationKeys: new Set([relationKey(main)])
    });

    expect(split.mainRelations).toEqual([main]);
    expect(split.sideRelations).toHaveLength(2);
    expect(split.sideRelations).toContainEqual(expect.objectContaining({
      side_type: "import_noise"
    }));
    expect(split.sideRelations).toContainEqual(expect.objectContaining({
      side_type: "test_noise"
    }));
  });
});
