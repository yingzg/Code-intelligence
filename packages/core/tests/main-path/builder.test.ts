import { describe, expect, it } from "vitest";
import type { CodeLocation, CodeRelation } from "../../src/schemas.js";
import { buildMainPaths } from "../../src/search/main-path/builder.js";

function node(id: string, file: string): CodeLocation {
  return {
    id,
    project: "p",
    file,
    start_line: 1,
    end_line: 1,
    symbol: id.split(":").at(-1)?.replace(/#\d+$/, ""),
    language: "java",
    location_type: file.includes("/mapper/") ? "mapper" : "service",
    snippet: "",
    match_reason: "test",
    score: 0.8,
    confidence: "medium",
    source: "gitnexus"
  };
}

function relation(from: CodeLocation, to: CodeLocation, relation_type: CodeRelation["relation_type"] = "calls"): CodeRelation {
  return {
    from: from.id,
    to: to.id,
    relation_type,
    raw_relation_type: relation_type,
    confidence: "medium",
    evidence: [
      {
        file: from.file,
        snippet: "",
        source: "gitnexus",
        extracted_by: "test",
        raw_relation_type: relation_type
      }
    ]
  };
}

describe("buildMainPaths", () => {
  it("builds a production main path around the target and folds low-value details", () => {
    const provider = node(
      "Method:src/main/java/com/acme/app/SettlementBillCommandProviderImpl.java:SettlementBillCommandProviderImpl.preCheckRebate#1",
      "src/main/java/com/acme/app/SettlementBillCommandProviderImpl.java"
    );
    const command = node(
      "Method:src/main/java/com/acme/domain/SettlementBillCommandServiceImpl.java:SettlementBillCommandServiceImpl.preCheckRebate#2",
      "src/main/java/com/acme/domain/SettlementBillCommandServiceImpl.java"
    );
    const target = node(
      "Method:src/main/java/com/acme/domain/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.preCheckRebate#1",
      "src/main/java/com/acme/domain/SettlementAndRebateServiceImpl.java"
    );
    const repository = node(
      "Method:src/main/java/com/acme/repository/ActivitySettlementLineRebateRepositoryImpl.java:ActivitySettlementLineRebateRepositoryImpl.query#1",
      "src/main/java/com/acme/repository/ActivitySettlementLineRebateRepositoryImpl.java"
    );
    const validation = node(
      "Method:src/main/java/com/acme/domain/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.checkPreCheckParam#1",
      "src/main/java/com/acme/domain/SettlementAndRebateServiceImpl.java"
    );
    const test = node(
      "Method:src/test/java/com/acme/domain/SettlementAndRebateServiceImplTest.java:SettlementAndRebateServiceImplTest.preCheckRebate_shouldThrow#0",
      "src/test/java/com/acme/domain/SettlementAndRebateServiceImplTest.java"
    );

    const result = buildMainPaths({
      anchors: [target],
      relations: [
        relation(provider, command),
        relation(command, target),
        relation(target, repository),
        relation(target, validation),
        relation(test, target)
      ],
      candidatePaths: [],
      direction: "both",
      depth: 3,
      mainPathLimit: 3,
      diagnostics: []
    });

    expect(result.main_paths.length).toBeGreaterThanOrEqual(1);
    expect(result.main_paths[0]).toMatchObject({
      confidence: expect.stringMatching(/medium|high/),
      path_type: "mixed"
    });
    expect(result.main_paths[0].summary).toContain("SettlementBillCommandProviderImpl.preCheckRebate");
    expect(result.main_paths[0].summary).toContain("SettlementBillCommandServiceImpl.preCheckRebate");
    expect(result.main_paths[0].summary).toContain("SettlementAndRebateServiceImpl.preCheckRebate");
    expect(result.main_paths[0].summary).toContain("ActivitySettlementLineRebateRepositoryImpl.query");
    expect(result.main_paths[0].summary).not.toBe("preCheckRebate --calls--> preCheckRebate");
    expect(result.main_paths[0].folded_steps).toContainEqual(expect.objectContaining({
      fold_type: "validation"
    }));
    expect(result.side_relations).toContainEqual(expect.objectContaining({
      side_type: "test_noise"
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "MAIN_PATHS_BUILT"
    }));
  });

  it("reports no strong relation chain when only import evidence exists", () => {
    const target = node(
      "Method:src/main/java/com/acme/service/OrderService.java:OrderService.detail#0",
      "src/main/java/com/acme/service/OrderService.java"
    );
    const file = node("File:src/main/java/com/acme/web/OrderController.java", "src/main/java/com/acme/web/OrderController.java");

    const result = buildMainPaths({
      anchors: [target],
      relations: [relation(file, target, "imports")],
      candidatePaths: [],
      direction: "upstream",
      depth: 2,
      mainPathLimit: 3,
      diagnostics: []
    });

    expect(result.main_paths).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "MAIN_PATH_NO_STRONG_RELATION_CHAIN"
    }));
  });

  it("deduplicates equivalent main paths before applying main path limit", () => {
    const provider = node(
      "Method:src/main/java/com/acme/app/ProviderImpl.java:ProviderImpl.run#1",
      "src/main/java/com/acme/app/ProviderImpl.java"
    );
    const target = node(
      "Method:src/main/java/com/acme/service/impl/TargetServiceImpl.java:TargetServiceImpl.run#1",
      "src/main/java/com/acme/service/impl/TargetServiceImpl.java"
    );
    const call = relation(provider, target);

    const result = buildMainPaths({
      anchors: [target, target],
      relations: [call],
      candidatePaths: [],
      direction: "both",
      depth: 2,
      mainPathLimit: 3,
      diagnostics: []
    });

    expect(result.main_paths.map((path) => path.summary)).toEqual([
      "ProviderImpl.run --calls--> TargetServiceImpl.run"
    ]);
  });
});
