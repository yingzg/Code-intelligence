import { describe, expect, it } from "vitest";
import type { CodeLocation } from "../../src/schemas.js";
import { classifyNode } from "../../src/search/main-path/role-classifier.js";

function node(partial: Partial<CodeLocation> & Pick<CodeLocation, "id" | "file">): CodeLocation {
  return {
    project: "p",
    start_line: 1,
    end_line: 1,
    symbol: partial.id.split(":").at(-1)?.replace(/#\d+$/, ""),
    language: "java",
    location_type: "unknown",
    snippet: "",
    match_reason: "test",
    score: 0.8,
    confidence: "medium",
    source: "gitnexus",
    ...partial
  };
}

describe("classifyNode", () => {
  it("classifies common Java enterprise roles without project-specific package names", () => {
    expect(classifyNode(node({
      id: "Class:src/main/java/com/acme/web/SettlementTestController.java:SettlementTestController",
      file: "src/main/java/com/acme/web/SettlementTestController.java",
      snippet: "@RestController\n@RequestMapping(\"/settlement\")"
    })).role).toBe("controller");

    expect(classifyNode(node({
      id: "Class:src/main/java/com/acme/app/SettlementBillCommandProviderImpl.java:SettlementBillCommandProviderImpl",
      file: "src/main/java/com/acme/app/SettlementBillCommandProviderImpl.java"
    })).role).toBe("provider");

    expect(classifyNode(node({
      id: "Class:src/main/java/com/acme/domain/SettlementBillCommandServiceImpl.java:SettlementBillCommandServiceImpl",
      file: "src/main/java/com/acme/domain/SettlementBillCommandServiceImpl.java"
    })).role).toBe("application_service");

    expect(classifyNode(node({
      id: "Class:src/main/java/com/acme/infra/ActivitySettlementLineRebateRepositoryImpl.java:ActivitySettlementLineRebateRepositoryImpl",
      file: "src/main/java/com/acme/infra/ActivitySettlementLineRebateRepositoryImpl.java"
    })).role).toBe("repository");

    expect(classifyNode(node({
      id: "Interface:src/main/java/com/acme/mapper/OrderMapper.java:OrderMapper",
      file: "src/main/java/com/acme/mapper/OrderMapper.java"
    })).role).toBe("mapper");
  });

  it("classifies details that should usually be folded out of main paths", () => {
    expect(classifyNode(node({
      id: "Method:src/main/java/com/acme/service/OrderService.java:OrderService.checkParam#0",
      file: "src/main/java/com/acme/service/OrderService.java"
    })).role).toBe("validation");

    expect(classifyNode(node({
      id: "Constructor:src/main/java/com/acme/exception/BizException.java:BizException.BizException#1",
      file: "src/main/java/com/acme/exception/BizException.java"
    })).role).toBe("exception");

    expect(classifyNode(node({
      id: "Method:src/main/java/com/acme/common/RedissonLockUtil.java:RedissonLockUtil.executeWithHashLock#5",
      file: "src/main/java/com/acme/common/RedissonLockUtil.java"
    })).role).toBe("lock");

    expect(classifyNode(node({
      id: "Method:src/test/java/com/acme/service/OrderServiceTest.java:OrderServiceTest.detail_shouldReturn#0",
      file: "src/test/java/com/acme/service/OrderServiceTest.java"
    })).role).toBe("test");
  });

  it("returns explainable classification reasons", () => {
    const classified = classifyNode(node({
      id: "Class:src/main/java/com/acme/web/OrderController.java:OrderController",
      file: "src/main/java/com/acme/web/OrderController.java"
    }));

    expect(classified.reasons.length).toBeGreaterThan(0);
    expect(classified.score).toBeGreaterThan(0);
  });
});
