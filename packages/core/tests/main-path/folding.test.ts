import { describe, expect, it } from "vitest";
import type { CodeLocation, CodeRelation } from "../../src/schemas.js";
import { classifyFoldedStep, foldPathDetails } from "../../src/search/main-path/folding.js";

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

function relation(from: CodeLocation, to: CodeLocation): CodeRelation {
  return {
    from: from.id,
    to: to.id,
    relation_type: "calls",
    raw_relation_type: "calls",
    confidence: "medium",
    evidence: [
      {
        file: from.file,
        snippet: "",
        source: "gitnexus",
        extracted_by: "test",
        raw_relation_type: "calls"
      }
    ]
  };
}

describe("main path detail folding", () => {
  it("classifies validation, exception and lock calls as folded steps", () => {
    const source = node("Method:src/main/java/com/acme/service/OrderService.java:OrderService.preCheck#0", "src/main/java/com/acme/service/OrderService.java");
    const validation = node("Method:src/main/java/com/acme/service/OrderService.java:OrderService.checkPreCheckParam#0", "src/main/java/com/acme/service/OrderService.java");
    const exception = node("Constructor:src/main/java/com/acme/exception/BizException.java:BizException.BizException#1", "src/main/java/com/acme/exception/BizException.java");
    const lock = node("Method:src/main/java/com/acme/common/RedissonLockUtil.java:RedissonLockUtil.executeWithHashLock#5", "src/main/java/com/acme/common/RedissonLockUtil.java");

    expect(classifyFoldedStep({ relation: relation(source, validation), from: source, to: validation })).toMatchObject({
      fold_type: "validation"
    });
    expect(classifyFoldedStep({ relation: relation(source, exception), from: source, to: exception })).toMatchObject({
      fold_type: "exception"
    });
    expect(classifyFoldedStep({ relation: relation(source, lock), from: source, to: lock })).toMatchObject({
      fold_type: "lock"
    });
  });

  it("keeps repository calls in the main path while folding validation details", () => {
    const service = node("Method:src/main/java/com/acme/service/OrderService.java:OrderService.detail#0", "src/main/java/com/acme/service/OrderService.java");
    const validation = node("Method:src/main/java/com/acme/service/OrderService.java:OrderService.checkParam#0", "src/main/java/com/acme/service/OrderService.java");
    const repository = node("Method:src/main/java/com/acme/repository/OrderRepository.java:OrderRepository.query#0", "src/main/java/com/acme/repository/OrderRepository.java");
    const validationRelation = relation(service, validation);
    const repositoryRelation = relation(service, repository);

    const folded = foldPathDetails({
      nodes: [service, validation, repository],
      relations: [validationRelation, repositoryRelation]
    });

    expect(folded.folded_steps).toContainEqual(expect.objectContaining({
      fold_type: "validation"
    }));
    expect(folded.relations).toContainEqual(repositoryRelation);
    expect(folded.relations).not.toContainEqual(validationRelation);
  });
});
