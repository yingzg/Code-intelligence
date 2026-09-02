import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexProject } from "../src/indexer/index-project.js";
import { exploreSymbol } from "../src/search/explore-symbol.js";

describe("exploreSymbol", () => {
  it("returns ANCHOR_NOT_FOUND when search cannot locate a starting point", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "/no/such/route/for/explore-symbol",
        type: "route",
        direction: "both",
        depth: 2,
        limit: 10
      });

      expect(response.anchors).toHaveLength(0);
      expect(response.relations).toHaveLength(0);
      expect(response.candidate_paths).toHaveLength(0);
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "ANCHOR_NOT_FOUND"
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("expands downstream relations from GitNexus context", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        gitnexusRepo: "java-spring-mybatis-demo",
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            incoming: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/web/AdminController.java:AdminController.detail#0",
                  name: "AdminController.detail",
                  filePath: "src/main/java/com/example/trade/web/AdminController.java"
                }
              ]
            },
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                }
              ]
            },
            typed_properties: []
          })
        }
      });

      expect(response.anchors.length).toBeGreaterThan(0);
      expect(response.relations).toContainEqual(expect.objectContaining({
        relation_type: "calls",
        to: expect.stringContaining("OrderService.detail")
      }));
      expect(response.relations).not.toContainEqual(expect.objectContaining({
        from: expect.stringContaining("AdminController.detail")
      }));
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "GITNEXUS_RELATIONS_USED"
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns v0.4 main paths, coverage and budget summary for explore responses", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderDetailService.java:OrderDetailService.detail#0",
                  name: "OrderDetailService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderDetailService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.main_paths).toHaveLength(1);
      expect(response.main_paths[0]).toMatchObject({
        path_type: "downstream",
        confidence: expect.stringMatching(/medium|high/)
      });
      expect(response.main_paths[0].summary).toContain("OrderController.detail");
      expect(response.main_paths[0].summary).toContain("OrderDetailService.detail");
      expect(response.coverage).toMatchObject({
        used_sources: ["gitnexus"]
      });
      expect(response.budget_summary).toMatchObject({
        requested_depth: 1,
        requested_limit: 10,
        main_path_count: 1
      });
      expect(response.summary).toContain("候选主链路");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("prioritizes calls over import noise before applying fanout", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 10,
        fanout: 1,
        adapter: {
          context: async () => ({
            outgoing: {
              imports: [
                {
                  uid: "File:src/main/java/com/example/trade/dto/OrderDetailRequest.java",
                  name: "OrderDetailRequest",
                  filePath: "src/main/java/com/example/trade/dto/OrderDetailRequest.java"
                }
              ],
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderDetailService.java:OrderDetailService.detail#0",
                  name: "OrderDetailService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderDetailService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.relations).toHaveLength(1);
      expect(response.relations[0]).toMatchObject({
        relation_type: "calls",
        to: expect.stringContaining("OrderDetailService.detail")
      });
      expect(response.main_paths[0].summary).toContain("OrderDetailService.detail");
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "FANOUT_LIMIT_REACHED"
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("builds candidate paths from anchor relations without marking them verified", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.candidate_paths).toHaveLength(1);
      expect(response.candidate_paths[0]).toMatchObject({
        path_type: "downstream",
        path_status: "candidate",
        confidence: "medium",
        evidence_sources: ["gitnexus"]
      });
      expect(response.candidate_paths[0].path_status).not.toBe("verified");
      expect(response.candidate_paths[0].diagnostics).toEqual([]);
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "DOWNSTREAM_DEPTH_LIMIT_REACHED"
        }),
        expect.objectContaining({
          code: "PATH_VERIFICATION_SKIPPED"
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports relation budget diagnostics without using path limit as relation limit", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 2,
        limit: 1,
        relationBudget: 1,
        adapter: {
          context: async () => ({
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                },
                {
                  uid: "Method:src/main/java/com/example/trade/service/PriceService.java:PriceService.detail#0",
                  name: "PriceService.detail",
                  filePath: "src/main/java/com/example/trade/service/PriceService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.relations).toHaveLength(1);
      expect(response.candidate_paths).toHaveLength(1);
      expect(response.candidate_paths[0].path_status).toBe("candidate");
      expect(response.candidate_paths[0].diagnostics).toEqual([]);
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "RELATION_LIMIT_REACHED"
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses relationBudget for relation expansion while limit only controls returned paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 1,
        relationBudget: 3,
        adapter: {
          context: async () => ({
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                },
                {
                  uid: "Method:src/main/java/com/example/trade/service/PriceService.java:PriceService.detail#0",
                  name: "PriceService.detail",
                  filePath: "src/main/java/com/example/trade/service/PriceService.java"
                },
                {
                  uid: "Method:src/main/java/com/example/trade/service/StockService.java:StockService.detail#0",
                  name: "StockService.detail",
                  filePath: "src/main/java/com/example/trade/service/StockService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.relations).toHaveLength(3);
      expect(response.candidate_paths).toHaveLength(1);
      expect(response.diagnostics).not.toContainEqual(expect.objectContaining({
        code: "RELATION_LIMIT_REACHED"
      }));
      expect(response.summary).toContain("limit=1");
      expect(response.summary).toContain("relationBudget=3");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses a default relation budget larger than the default path limit", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        adapter: {
          context: async () => ({
            outgoing: {
              calls: Array.from({ length: 25 }, (_, index) => ({
                uid: `Method:src/main/java/com/example/trade/service/Service${index}.java:Service${index}.detail#0`,
                name: `Service${index}.detail`,
                filePath: `src/main/java/com/example/trade/service/Service${index}.java`
              }))
            }
          })
        }
      });

      expect(response.relations.length).toBeGreaterThan(20);
      expect(response.candidate_paths).toHaveLength(20);
      expect(response.diagnostics).not.toContainEqual(expect.objectContaining({
        code: "RELATION_LIMIT_REACHED"
      }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not mark every candidate path truncated only because the relation budget is reached", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 5,
        relationBudget: 1,
        adapter: {
          context: async () => ({
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                },
                {
                  uid: "Method:src/main/java/com/example/trade/service/PriceService.java:PriceService.detail#0",
                  name: "PriceService.detail",
                  filePath: "src/main/java/com/example/trade/service/PriceService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "RELATION_LIMIT_REACHED"
        })
      ]));
      expect(response.candidate_paths).toContainEqual(expect.objectContaining({
        path_status: "candidate",
        confidence: "medium",
        diagnostics: []
      }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps max-depth path fragments candidate when no continuation edge is known", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 5,
        adapter: {
          context: async () => ({
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "DOWNSTREAM_DEPTH_LIMIT_REACHED"
        })
      ]));
      expect(response.candidate_paths).toContainEqual(expect.objectContaining({
        path_status: "candidate",
        confidence: "medium",
        diagnostics: []
      }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("detects fanout truncation by requesting one extra relation", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");
    const requestedLimits: number[] = [];

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 10,
        fanout: 1,
        adapter: {
          context: async (input) => {
            requestedLimits.push(input.limit);
            return {
              outgoing: {
                calls: [
                  {
                    uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                    name: "OrderService.detail",
                    filePath: "src/main/java/com/example/trade/service/OrderService.java"
                  },
                  {
                    uid: "Method:src/main/java/com/example/trade/service/PriceService.java:PriceService.detail#0",
                    name: "PriceService.detail",
                    filePath: "src/main/java/com/example/trade/service/PriceService.java"
                  }
                ]
              }
            };
          }
        }
      });

      expect(requestedLimits).toEqual([2]);
      expect(response.relations).toHaveLength(1);
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "FANOUT_LIMIT_REACHED"
        })
      ]));
      expect(response.candidate_paths[0].path_status).toBe("candidate");
      expect(response.candidate_paths[0].diagnostics).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("marks candidate paths truncated when depth stops before the next frontier", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "DOWNSTREAM_DEPTH_LIMIT_REACHED"
        })
      ]));
      expect(response.candidate_paths[0].path_status).toBe("candidate");
      expect(response.candidate_paths[0].diagnostics).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports ANCHOR_AMBIGUOUS when multiple anchors are selected", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "Order",
        type: "symbol",
        direction: "both",
        depth: 2,
        limit: 10,
        anchorLimit: 3
      });

      expect(response.anchors.length).toBeGreaterThan(1);
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "ANCHOR_AMBIGUOUS"
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("ranks implementation methods before interface anchors for downstream Java method explore", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-anchor-"));

    try {
      await writeFakeGitNexusRunner(root, [
        {
          id: "Interface:src/main/java/com/example/OrderService.java:OrderService",
          name: "OrderService",
          filePath: "src/main/java/com/example/OrderService.java",
          startLine: 1,
          endLine: 3
        },
        {
          id: "Method:src/main/java/com/example/OrderService.java:OrderService.create#0",
          name: "OrderService.create",
          filePath: "src/main/java/com/example/OrderService.java",
          startLine: 2,
          endLine: 2
        },
        {
          id: "Method:src/main/java/com/example/OrderServiceImpl.java:OrderServiceImpl.create#0",
          name: "OrderServiceImpl.create",
          filePath: "src/main/java/com/example/OrderServiceImpl.java",
          startLine: 2,
          endLine: 2
        }
      ]);
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderService.create(String request)",
        type: "symbol",
        direction: "downstream",
        depth: 1,
        limit: 5
      });

      expect(response.anchors).toHaveLength(2);
      expect(response.anchors[0]).toMatchObject({
        id: "Method:src/main/java/com/example/OrderServiceImpl.java:OrderServiceImpl.create#0",
        symbol: "OrderServiceImpl.create"
      });
      expect(response.anchors.map((anchor) => anchor.id)).not.toContain("Interface:src/main/java/com/example/OrderService.java:OrderService");
      expect(response.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "ANCHOR_AMBIGUOUS"
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps exact method matches ahead of implementation methods with different names", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-anchor-"));

    try {
      await writeFakeGitNexusRunner(root, [
        {
          id: "Interface:src/main/java/com/example/OrderService.java:OrderService",
          name: "OrderService",
          filePath: "src/main/java/com/example/OrderService.java",
          startLine: 1,
          endLine: 3
        },
        {
          id: "Method:src/main/java/com/example/OrderService.java:OrderService.create#0",
          name: "OrderService.create",
          filePath: "src/main/java/com/example/OrderService.java",
          startLine: 2,
          endLine: 2
        },
        {
          id: "Method:src/main/java/com/example/OrderServiceImpl.java:OrderServiceImpl.cancel#0",
          name: "OrderServiceImpl.cancel",
          filePath: "src/main/java/com/example/OrderServiceImpl.java",
          startLine: 2,
          endLine: 2
        }
      ]);
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderService.create(String request)",
        type: "symbol",
        direction: "downstream",
        depth: 1,
        limit: 5
      });

      expect(response.anchors[0]).toMatchObject({
        id: "Method:src/main/java/com/example/OrderService.java:OrderService.create#0",
        symbol: "OrderService.create"
      });
      expect(response.anchors[0].symbol).not.toBe("OrderServiceImpl.cancel");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters signature queries to exact method anchors instead of similar helper names", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-anchor-"));

    try {
      await writeFakeGitNexusRunner(root, [
        {
          id: "Method:src/main/java/com/example/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.preCheckRebate#0",
          name: "preCheckRebate",
          filePath: "src/main/java/com/example/SettlementAndRebateServiceImpl.java",
          startLine: 3,
          endLine: 5
        },
        {
          id: "Method:src/main/java/com/example/SettlementBillCommandServiceImpl.java:SettlementBillCommandServiceImpl.preCheckRebate#0",
          name: "preCheckRebate",
          filePath: "src/main/java/com/example/SettlementBillCommandServiceImpl.java",
          startLine: 3,
          endLine: 5
        },
        {
          id: "Method:src/main/java/com/example/SettlementBillCommandServiceImpl.java:SettlementBillCommandServiceImpl.buildPreCheckRebateParam#0",
          name: "buildPreCheckRebateParam",
          filePath: "src/main/java/com/example/SettlementBillCommandServiceImpl.java",
          startLine: 7,
          endLine: 9
        }
      ]);
      await writeFile(
        join(root, "src/main/java/com/example/SettlementAndRebateServiceImpl.java"),
        [
          "class SettlementAndRebateServiceImpl {",
          "  void before() {}",
          "  PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req) {",
          "    return null;",
          "  }",
          "}"
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        join(root, "src/main/java/com/example/SettlementBillCommandServiceImpl.java"),
        [
          "class SettlementBillCommandServiceImpl {",
          "  void before() {}",
          "  PreCheckResultValObj preCheckRebate(String billId, boolean isBatch) {",
          "    return null;",
          "  }",
          "  void gap() {}",
          "  PreCheckSettlementParamItemValObj buildPreCheckRebateParam(SettlementBillValObj settlementBill) {",
          "    return null;",
          "  }",
          "}"
        ].join("\n"),
        "utf8"
      );

      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req);",
        type: "symbol",
        direction: "both",
        depth: 1,
        limit: 5
      });

      expect(response.anchors.map((anchor) => anchor.id)).toEqual([
        "Method:src/main/java/com/example/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.preCheckRebate#0"
      ]);
      expect(response.anchors.map((anchor) => anchor.symbol)).not.toContain("buildPreCheckRebateParam");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("oversamples anchors before ranking so later implementation methods can win", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-anchor-"));

    try {
      await writeFakeGitNexusRunner(root, [
        {
          id: "Interface:src/main/java/com/example/OrderService.java:OrderService",
          name: "OrderService",
          filePath: "src/main/java/com/example/OrderService.java",
          startLine: 1,
          endLine: 3
        },
        {
          id: "Class:src/main/java/com/example/OrderRequest.java:OrderRequest",
          name: "OrderRequest",
          filePath: "src/main/java/com/example/OrderRequest.java",
          startLine: 1,
          endLine: 3
        },
        {
          id: "Method:src/main/java/com/example/OrderService.java:OrderService.create#0",
          name: "OrderService.create",
          filePath: "src/main/java/com/example/OrderService.java",
          startLine: 2,
          endLine: 2
        },
        {
          id: "Method:src/main/java/com/example/OrderServiceImpl.java:OrderServiceImpl.create#0",
          name: "OrderServiceImpl.create",
          filePath: "src/main/java/com/example/OrderServiceImpl.java",
          startLine: 2,
          endLine: 2
        }
      ]);
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderService.create(String request)",
        type: "symbol",
        direction: "downstream",
        depth: 1,
        limit: 5
      });

      expect(response.anchors).toHaveLength(2);
      expect(response.anchors[0]).toMatchObject({
        id: "Method:src/main/java/com/example/OrderServiceImpl.java:OrderServiceImpl.create#0",
        symbol: "OrderServiceImpl.create"
      });
      expect(response.anchors.map((anchor) => anchor.id)).not.toContain("Interface:src/main/java/com/example/OrderService.java:OrderService");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues expanding from next-hop relation targets up to depth", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");
    const symbols: string[] = [];

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 2,
        limit: 10,
        adapter: {
          context: async (input) => {
            symbols.push(input.symbol);
            if (input.symbol === "OrderController.detail") {
              return {
                outgoing: {
                  calls: [
                    {
                      uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                      name: "OrderService.detail",
                      filePath: "src/main/java/com/example/trade/service/OrderService.java"
                    }
                  ]
                }
              };
            }
            if (input.symbol.includes("OrderService.detail")) {
              return {
                outgoing: {
                  calls: [
                    {
                      uid: "Method:src/main/java/com/example/trade/mapper/OrderMapper.java:OrderMapper.countSnapshotItems#0",
                      name: "OrderMapper.countSnapshotItems",
                      filePath: "src/main/java/com/example/trade/mapper/OrderMapper.java"
                    }
                  ]
                }
              };
            }
            return {};
          }
        }
      });

      expect(symbols).toEqual(expect.arrayContaining([
        "OrderController.detail",
        "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0"
      ]));
      expect(response.relations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: expect.stringContaining("OrderController"),
          to: expect.stringContaining("OrderService.detail")
        }),
        expect.objectContaining({
          from: expect.stringContaining("OrderService.detail"),
          to: expect.stringContaining("OrderMapper.countSnapshotItems")
        })
      ]));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("builds multi-hop candidate paths from expanded relations", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 2,
        limit: 10,
        adapter: {
          context: async (input) => {
            if (input.symbol === "OrderController.detail") {
              return {
                outgoing: {
                  calls: [
                    {
                      uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                      name: "OrderService.detail",
                      filePath: "src/main/java/com/example/trade/service/OrderService.java"
                    }
                  ]
                }
              };
            }
            if (input.symbol.includes("OrderService.detail")) {
              return {
                outgoing: {
                  calls: [
                    {
                      uid: "Method:src/main/java/com/example/trade/mapper/OrderMapper.java:OrderMapper.countSnapshotItems#0",
                      name: "OrderMapper.countSnapshotItems",
                      filePath: "src/main/java/com/example/trade/mapper/OrderMapper.java"
                    }
                  ]
                }
              };
            }
            return {};
          }
        }
      });

      expect(response.candidate_paths).toContainEqual(expect.objectContaining({
        path_type: "downstream",
        path_status: "candidate",
        depth: 2,
        summary: expect.stringContaining("OrderMapper.countSnapshotItems")
      }));
      const twoHopPath = response.candidate_paths.find((path) => path.depth === 2);
      expect(twoHopPath?.relations).toHaveLength(2);
      expect(twoHopPath?.nodes.map((node) => node.symbol)).toEqual([
        "OrderController.detail",
        "OrderService.detail",
        "OrderMapper.countSnapshotItems"
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses GitNexus UIDs instead of short symbols when exploring GitNexus anchors", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-anchor-"));

    try {
      await writeFakeGitNexusRunner(root, [
        {
          id: "Method:src/main/java/com/example/A.java:A.run#0",
          name: "run",
          filePath: "src/main/java/com/example/A.java",
          startLine: 1,
          endLine: 3
        }
      ]);
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "A.run",
        type: "symbol",
        direction: "downstream",
        depth: 1,
        limit: 5
      });
      const contextSymbol = await readFile(join(root, ".gitnexus", "last-context.txt"), "utf8");

      expect(response.anchors[0]).toMatchObject({
        id: "Method:src/main/java/com/example/A.java:A.run#0",
        source: "gitnexus"
      });
      expect(contextSymbol).toBe("Method:src/main/java/com/example/A.java:A.run#0");
      expect(response.relations).toContainEqual(expect.objectContaining({
        to: "Method:src/main/java/com/example/B.java:B.call#0"
      }));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes test anchors by default", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-anchor-"));

    try {
      await writeFakeGitNexusRunner(root, [
        {
          id: "Class:src/test/java/com/example/AControllerTest.java:AControllerTest",
          name: "AControllerTest",
          filePath: "src/test/java/com/example/AControllerTest.java",
          startLine: 1,
          endLine: 5
        },
        {
          id: "Class:src/main/java/com/example/AController.java:AController",
          name: "AController",
          filePath: "src/main/java/com/example/AController.java",
          startLine: 1,
          endLine: 5
        }
      ]);
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "AController",
        type: "symbol",
        direction: "downstream",
        depth: 1,
        limit: 5
      });

      expect(response.anchors).toHaveLength(1);
      expect(response.anchors[0].file).toBe("src/main/java/com/example/AController.java");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Task 3 keeps imports and references in relations while excluding them from candidate paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            outgoing: {
              imports: [
                {
                  uid: "Class:src/main/java/com/example/trade/service/ImportedHelper.java:ImportedHelper",
                  name: "ImportedHelper",
                  filePath: "src/main/java/com/example/trade/service/ImportedHelper.java"
                }
              ],
              references: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/ReferencedHelper.java:ReferencedHelper.detail#0",
                  name: "ReferencedHelper.detail",
                  filePath: "src/main/java/com/example/trade/service/ReferencedHelper.java"
                }
              ],
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.relations).toEqual(expect.arrayContaining([
        expect.objectContaining({ relation_type: "imports" }),
        expect.objectContaining({ relation_type: "references" }),
        expect.objectContaining({ relation_type: "calls" })
      ]));
      expect(response.candidate_paths).toHaveLength(1);
      expect(response.candidate_paths[0].relations.map((relation) => relation.relation_type)).toEqual(["calls"]);
      expect(response.candidate_paths[0].summary).toContain("--calls-->");
      expect(response.candidate_paths[0].summary).not.toContain("--imports-->");
      expect(response.candidate_paths[0].summary).not.toContain("--references-->");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("Task 3 keeps test call relations but excludes test endpoint candidate paths by default", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");
    const testEndpoint = "Method:src/test/java/com/example/trade/web/OrderControllerTest.java:OrderControllerTest.detail#0";

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const adapter = {
        context: async () => ({
          outgoing: {
            calls: [
              {
                uid: testEndpoint,
                name: "OrderControllerTest.detail",
                filePath: "src/test/java/com/example/trade/web/OrderControllerTest.java"
              },
              {
                uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                name: "OrderService.detail",
                filePath: "src/main/java/com/example/trade/service/OrderService.java"
              }
            ]
          }
        })
      };

      const defaultResponse = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 10,
        adapter
      });

      expect(defaultResponse.relations).toContainEqual(expect.objectContaining({
        relation_type: "calls",
        to: testEndpoint
      }));
      expect(defaultResponse.candidate_paths.some((path) =>
        path.nodes.some((node) => node.file.includes("src/test/"))
        || path.relations.some((relation) => relation.from.includes("src/test/") || relation.to.includes("src/test/"))
      )).toBe(false);

      const includeTestsResponse = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 10,
        excludeTests: false,
        adapter
      });

      expect(includeTestsResponse.candidate_paths).toContainEqual(expect.objectContaining({
        relations: [expect.objectContaining({ to: testEndpoint })]
      }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("Task 3 prioritizes calls over has_method when building candidate paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 2,
        adapter: {
          context: async () => ({
            outgoing: {
              has_method: [
                {
                  uid: "Method:src/main/java/com/example/trade/web/OrderController.java:OrderController.helper#0",
                  name: "OrderController.helper",
                  filePath: "src/main/java/com/example/trade/web/OrderController.java"
                }
              ],
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                }
              ]
            }
          })
        }
      });

      expect(response.relations.map((relation) => relation.relation_type)).toEqual(["has_method", "calls"]);
      expect(response.candidate_paths[0].relations[0]).toMatchObject({
        relation_type: "calls",
        to: expect.stringContaining("OrderService.detail")
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("renders class-qualified summary labels when a path contains same-name methods", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-summary-"));
    const implId = "Method:src/main/java/com/example/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.preCheckRebate#0";
    const callerId = "Method:src/main/java/com/example/SettlementBillCommandServiceImpl.java:SettlementBillCommandServiceImpl.preCheckRebate#0";

    try {
      await writeFakeGitNexusRunner(root, [
        {
          id: implId,
          name: "preCheckRebate",
          filePath: "src/main/java/com/example/SettlementAndRebateServiceImpl.java",
          startLine: 3,
          endLine: 5
        },
        {
          id: callerId,
          name: "preCheckRebate",
          filePath: "src/main/java/com/example/SettlementBillCommandServiceImpl.java",
          startLine: 3,
          endLine: 5
        }
      ]);
      await writeFile(
        join(root, "src/main/java/com/example/SettlementAndRebateServiceImpl.java"),
        "class SettlementAndRebateServiceImpl {\n  void x() {}\n  PreCheckResultValObj preCheckRebate(PreCheckSettlementParamValObj req) { return null; }\n}\n",
        "utf8"
      );
      await writeFile(
        join(root, "src/main/java/com/example/SettlementBillCommandServiceImpl.java"),
        "class SettlementBillCommandServiceImpl {\n  void x() {}\n  PreCheckResultValObj preCheckRebate(String billId, boolean isBatch) { return null; }\n}\n",
        "utf8"
      );

      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "preCheckRebate",
        type: "symbol",
        direction: "upstream",
        depth: 1,
        limit: 5,
        adapter: {
          context: async (input) => {
            if (input.symbol.includes("SettlementAndRebateServiceImpl.preCheckRebate")) {
              return {
                incoming: {
                  calls: [
                    {
                      uid: callerId,
                      name: "preCheckRebate",
                      filePath: "src/main/java/com/example/SettlementBillCommandServiceImpl.java"
                    }
                  ]
                }
              };
            }
            return {};
          }
        }
      });

      expect(response.candidate_paths[0].summary).toBe(
        "SettlementAndRebateServiceImpl.preCheckRebate <--calls-- SettlementBillCommandServiceImpl.preCheckRebate"
      );
      expect(response.candidate_paths[0].summary).not.toBe("preCheckRebate <--calls-- preCheckRebate");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders upstream reverse traversal without reversing the factual call direction", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "upstream",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            incoming: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/web/AdminController.java:AdminController.detail#0",
                  name: "AdminController.detail",
                  filePath: "src/main/java/com/example/trade/web/AdminController.java"
                }
              ]
            }
          })
        }
      });

      const summary = response.candidate_paths[0]?.summary ?? "";
      expect(summary).toContain("OrderController.detail <--calls-- AdminController.detail");
      expect(summary).toContain("<--calls--");
      expect(summary).not.toContain("OrderController.detail --calls--> AdminController.detail");
      expect(response.candidate_paths[0]?.relations[0]).toMatchObject({
        from: expect.stringContaining("AdminController.detail"),
        to: expect.stringContaining("OrderController.java"),
        relation_type: "calls"
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("renders both-direction reverse traversal without reversing the factual call direction", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "both",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            incoming: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/web/AdminController.java:AdminController.detail#0",
                  name: "AdminController.detail",
                  filePath: "src/main/java/com/example/trade/web/AdminController.java"
                }
              ]
            }
          })
        }
      });

      const summary = response.candidate_paths[0]?.summary ?? "";
      expect(summary).toContain("OrderController.detail <--calls-- AdminController.detail");
      expect(summary).toContain("<--calls--");
      expect(summary).not.toContain("OrderController.detail --calls--> AdminController.detail");
      expect(response.candidate_paths[0]?.relations[0]).toMatchObject({
        from: expect.stringContaining("AdminController.detail"),
        to: expect.stringContaining("OrderController.java"),
        relation_type: "calls"
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps downstream traversal summaries pointing along factual call direction", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });
      const response = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail",
        direction: "downstream",
        depth: 1,
        limit: 10,
        adapter: {
          context: async () => ({
            outgoing: {
              calls: [
                {
                  uid: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
                  name: "OrderService.detail",
                  filePath: "src/main/java/com/example/trade/service/OrderService.java"
                }
              ]
            }
          })
        }
      });

      const summary = response.candidate_paths[0]?.summary ?? "";
      expect(summary).toContain("OrderController.detail --calls--> OrderService.detail");
      expect(summary).not.toContain("<--calls--");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("handles upstream, downstream, both, method bridges, tests, and imports in a settlement fixture graph", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-explore-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-anchor-"));
    const anchorId = "Method:src/main/java/com/example/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.preCheckRebate#0";
    const testEndpoint = "Method:src/test/java/com/example/SettlementAndRebateServiceImplTest.java:SettlementAndRebateServiceImplTest.preCheckRebate_shouldThrowWhenReqIsNull#0";
    const adapter = {
      context: async (input: { symbol: string }) => settlementContextFor(input.symbol)
    };

    try {
      await writeFakeGitNexusRunner(root, [
        {
          id: anchorId,
          name: "SettlementAndRebateServiceImpl.preCheckRebate",
          filePath: "src/main/java/com/example/SettlementAndRebateServiceImpl.java",
          startLine: 10,
          endLine: 20
        }
      ]);

      const downstream = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "SettlementAndRebateServiceImpl.preCheckRebate",
        type: "symbol",
        direction: "downstream",
        depth: 1,
        limit: 10,
        adapter
      });
      const downstreamSummary = downstream.candidate_paths.map((path) => path.summary).join("\n");
      expect(downstreamSummary).toContain("SettlementAndRebateServiceImpl.preCheckRebate --calls--> SettlementAndRebateServiceImpl.checkPreCheckParam");
      expect(downstreamSummary).toContain("SettlementAndRebateServiceImpl.preCheckRebate --calls--> SettlementAndRebateServiceImpl.executePreCheckRebate");
      expect(downstream.candidate_paths).not.toContainEqual(expect.objectContaining({
        path_status: "verified"
      }));
      expect(downstream.candidate_paths).toContainEqual(expect.objectContaining({
        path_status: "candidate",
        diagnostics: []
      }));

      const upstream = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "SettlementAndRebateServiceImpl.preCheckRebate",
        type: "symbol",
        direction: "upstream",
        depth: 1,
        limit: 10,
        adapter
      });
      const upstreamSummary = upstream.candidate_paths.map((path) => path.summary).join("\n");
      expect(upstreamSummary).toContain("SettlementAndRebateServiceImpl.preCheckRebate <--calls-- SettlementBillCommandService.preCheckRebate");
      expect(upstreamSummary).not.toContain("SettlementAndRebateServiceImpl.preCheckRebate --calls--> SettlementBillCommandService.preCheckRebate");
      expect(upstream.relations).toEqual(expect.arrayContaining([
        expect.objectContaining({ relation_type: "imports" })
      ]));
      expect(upstream.candidate_paths.some((path) =>
        path.nodes.some((node) => node.file.includes("src/test/"))
        || path.relations.some((relation) => relation.from.includes("src/test/") || relation.to.includes("src/test/"))
      )).toBe(false);
      expect(upstream.candidate_paths.some((path) =>
        path.relations.some((relation) => relation.relation_type === "imports")
      )).toBe(false);

      const both = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "SettlementAndRebateServiceImpl.preCheckRebate",
        type: "symbol",
        direction: "both",
        depth: 1,
        limit: 10,
        adapter
      });
      const bothSummary = both.candidate_paths.map((path) => path.summary).join("\n");
      expect(bothSummary).toContain("SettlementAndRebateServiceImpl.preCheckRebate <--calls-- SettlementBillCommandService.preCheckRebate");
      expect(bothSummary).toContain("SettlementAndRebateServiceImpl.preCheckRebate --calls--> SettlementAndRebateServiceImpl.checkPreCheckParam");
      expect(bothSummary).toContain("SettlementAndRebateServiceImpl.preCheckRebate --calls--> SettlementAndRebateServiceImpl.executePreCheckRebate");
      expect(bothSummary).not.toContain("SettlementAndRebateServiceImpl.preCheckRebate --calls--> SettlementBillCommandService.preCheckRebate");
      expect(both.relations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          relation_type: "method_implements",
          raw_relation_type: "method_implements"
        }),
        expect.objectContaining({
          relation_type: "imports",
          raw_relation_type: "imports"
        })
      ]));
      expect(both.candidate_paths).toContainEqual(expect.objectContaining({
        path_status: "candidate",
        relations: [expect.objectContaining({ relation_type: "method_implements" })]
      }));
      expect(both.candidate_paths.some((path) =>
        path.relations.some((relation) => relation.relation_type === "imports")
      )).toBe(false);
      expect(both.candidate_paths).not.toContainEqual(expect.objectContaining({
        path_status: "verified"
      }));
      expect(both.candidate_paths).toContainEqual(expect.objectContaining({
        diagnostics: []
      }));

      const includeTests = await exploreSymbol({
        home,
        project: "trade-service",
        root,
        query: "SettlementAndRebateServiceImpl.preCheckRebate",
        type: "symbol",
        direction: "upstream",
        depth: 1,
        limit: 10,
        excludeTests: false,
        adapter
      });
      expect(includeTests.candidate_paths).toContainEqual(expect.objectContaining({
        path_status: "candidate",
        relations: [expect.objectContaining({ from: testEndpoint, relation_type: "calls" })]
      }));
      expect(includeTests.candidate_paths).not.toContainEqual(expect.objectContaining({
        path_status: "verified"
      }));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

function settlementContextFor(symbol: string) {
  if (symbol.includes("SettlementAndRebateServiceImpl.preCheckRebate")) {
    return {
      incoming: {
        calls: [
          {
            uid: "Method:src/main/java/com/example/SettlementBillCommandService.java:SettlementBillCommandService.preCheckRebate#0",
            name: "SettlementBillCommandService.preCheckRebate",
            filePath: "src/main/java/com/example/SettlementBillCommandService.java"
          },
          {
            uid: "Method:src/test/java/com/example/SettlementAndRebateServiceImplTest.java:SettlementAndRebateServiceImplTest.preCheckRebate_shouldThrowWhenReqIsNull#0",
            name: "SettlementAndRebateServiceImplTest.preCheckRebate_shouldThrowWhenReqIsNull",
            filePath: "src/test/java/com/example/SettlementAndRebateServiceImplTest.java"
          }
        ],
        method_implements: [
          {
            uid: "Method:src/main/java/com/example/SettlementAndRebateService.java:SettlementAndRebateService.preCheckRebate#0",
            name: "SettlementAndRebateService.preCheckRebate",
            filePath: "src/main/java/com/example/SettlementAndRebateService.java"
          }
        ],
        imports: [
          {
            uid: "File:src/main/java/com/example/SettlementController.java",
            name: "SettlementController.java",
            filePath: "src/main/java/com/example/SettlementController.java"
          }
        ]
      },
      outgoing: {
        calls: [
          {
            uid: "Method:src/main/java/com/example/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.checkPreCheckParam#0",
            name: "SettlementAndRebateServiceImpl.checkPreCheckParam",
            filePath: "src/main/java/com/example/SettlementAndRebateServiceImpl.java"
          },
          {
            uid: "Method:src/main/java/com/example/SettlementAndRebateServiceImpl.java:SettlementAndRebateServiceImpl.executePreCheckRebate#0",
            name: "SettlementAndRebateServiceImpl.executePreCheckRebate",
            filePath: "src/main/java/com/example/SettlementAndRebateServiceImpl.java"
          }
        ]
      }
    };
  }

  return {};
}

async function writeFakeGitNexusRunner(
  root: string,
  definitions: Array<{ id: string; name: string; filePath: string; startLine: number; endLine: number }>
): Promise<void> {
  await mkdir(join(root, ".gitnexus"), { recursive: true });
  await mkdir(join(root, "src/main/java/com/example"), { recursive: true });
  await mkdir(join(root, "src/test/java/com/example"), { recursive: true });
  await writeFile(join(root, "src/main/java/com/example/A.java"), "class A { void run() {} }\n", "utf8");
  await writeFile(join(root, "src/main/java/com/example/AController.java"), "class AController {}\n", "utf8");
  await writeFile(join(root, "src/test/java/com/example/AControllerTest.java"), "class AControllerTest {}\n", "utf8");
  await writeFile(
    join(root, ".gitnexus", "run.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "status") {
  console.log(JSON.stringify({ status: "ok" }));
  process.exit(0);
}
if (args[0] === "query") {
  console.log(JSON.stringify({ definitions: ${JSON.stringify(definitions)} }));
  process.exit(0);
}
if (args[0] === "context") {
  fs.writeFileSync(path.join(process.cwd(), ".gitnexus", "last-context.txt"), args[1]);
  console.log(JSON.stringify({
    outgoing: {
      calls: [
        {
          uid: "Method:src/main/java/com/example/B.java:B.call#0",
          name: "B.call",
          filePath: "src/main/java/com/example/B.java"
        }
      ]
    }
  }));
  process.exit(0);
}
console.log(JSON.stringify({}));
`,
    "utf8"
  );
}
