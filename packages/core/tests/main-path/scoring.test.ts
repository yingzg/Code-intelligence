import { describe, expect, it } from "vitest";
import type { CodeLocation, CodeRelation } from "../../src/schemas.js";
import { scorePathForMainPath, scoreRelationForMainPath } from "../../src/search/main-path/scoring.js";

function node(id: string, file: string): CodeLocation {
  return {
    id,
    project: "p",
    file,
    start_line: 1,
    end_line: 1,
    symbol: id.split(":").at(-1)?.replace(/#\d+$/, ""),
    language: "java",
    location_type: "service",
    snippet: "",
    match_reason: "test",
    score: 0.8,
    confidence: "medium",
    source: "gitnexus"
  };
}

function relation(from: string, to: string, relation_type: CodeRelation["relation_type"]): CodeRelation {
  return {
    from,
    to,
    relation_type,
    raw_relation_type: relation_type,
    confidence: "medium",
    evidence: [
      {
        file: "src/main/java/com/acme/service/OrderService.java",
        snippet: "",
        source: "gitnexus",
        extracted_by: "test",
        raw_relation_type: relation_type
      }
    ]
  };
}

describe("main path scoring", () => {
  it("scores calls relations higher than imports", () => {
    const calls = scoreRelationForMainPath(relation("A", "B", "calls"));
    const imports = scoreRelationForMainPath(relation("A", "B", "imports"));

    expect(calls.reduce((sum, factor) => sum + factor.weight, 0)).toBeGreaterThan(
      imports.reduce((sum, factor) => sum + factor.weight, 0)
    );
  });

  it("prefers a production calls chain over a test caller", () => {
    const target = node(
      "Method:src/main/java/com/acme/domain/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.preCheckRebate#1",
      "src/main/java/com/acme/domain/SettlementAndRebateServiceImpl.java"
    );
    const provider = node(
      "Method:src/main/java/com/acme/app/SettlementBillCommandProviderImpl.java:SettlementBillCommandProviderImpl.preCheckRebate#1",
      "src/main/java/com/acme/app/SettlementBillCommandProviderImpl.java"
    );
    const test = node(
      "Method:src/test/java/com/acme/domain/SettlementAndRebateServiceImplTest.java:SettlementAndRebateServiceImplTest.preCheckRebate_shouldThrow#0",
      "src/test/java/com/acme/domain/SettlementAndRebateServiceImplTest.java"
    );

    const productionPath = scorePathForMainPath({
      nodes: [provider, target],
      relations: [relation(provider.id, target.id, "calls")],
      targetAnchorIds: new Set([target.id]),
      direction: "upstream"
    });
    const testPath = scorePathForMainPath({
      nodes: [test, target],
      relations: [relation(test.id, target.id, "calls")],
      targetAnchorIds: new Set([target.id]),
      direction: "upstream"
    });

    expect(productionPath.score).toBeGreaterThan(testPath.score);
    expect(productionPath.confidence).not.toBe("low");
    expect(productionPath.score_breakdown.length).toBeGreaterThan(0);
    expect(productionPath.confidence_reason).toContain("calls");
  });

  it("penalizes self loops", () => {
    const target = node(
      "Method:src/main/java/com/acme/service/OrderService.java:OrderService.detail#0",
      "src/main/java/com/acme/service/OrderService.java"
    );
    const scored = scorePathForMainPath({
      nodes: [target, target],
      relations: [relation(target.id, target.id, "calls")],
      targetAnchorIds: new Set([target.id]),
      direction: "both"
    });

    expect(scored.score_breakdown).toContainEqual(expect.objectContaining({
      name: "SELF_LOOP_PENALTY"
    }));
  });

  it("prefers implementation method paths over interface-only paths when other evidence is equal", () => {
    const caller = node(
      "Method:src/main/java/com/acme/service/CommandServiceImpl.java:CommandServiceImpl.preCheck#0",
      "src/main/java/com/acme/service/CommandServiceImpl.java"
    );
    const interfaceTarget = node(
      "Method:src/main/java/com/acme/service/SettlementAndRebateService.java:SettlementAndRebateService.preCheckRebate#1",
      "src/main/java/com/acme/service/SettlementAndRebateService.java"
    );
    const implementationTarget = node(
      "Method:src/main/java/com/acme/service/impl/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.preCheckRebate#1",
      "src/main/java/com/acme/service/impl/SettlementAndRebateServiceImpl.java"
    );

    const interfacePath = scorePathForMainPath({
      nodes: [caller, interfaceTarget],
      relations: [relation(caller.id, interfaceTarget.id, "calls")],
      targetAnchorIds: new Set([interfaceTarget.id, implementationTarget.id]),
      direction: "upstream"
    });
    const implementationPath = scorePathForMainPath({
      nodes: [caller, implementationTarget],
      relations: [relation(caller.id, implementationTarget.id, "calls")],
      targetAnchorIds: new Set([interfaceTarget.id, implementationTarget.id]),
      direction: "upstream"
    });

    expect(implementationPath.score).toBeGreaterThan(interfacePath.score);
    expect(implementationPath.score_breakdown).toContainEqual(expect.objectContaining({
      name: "IMPLEMENTATION_NODE_BONUS"
    }));
    expect(implementationPath.score_breakdown).toContainEqual(expect.objectContaining({
      name: "IMPLEMENTATION_TARGET_BONUS"
    }));
  });
});
