import { cp, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexProject } from "../src/indexer/index-project.js";
import { classifyQuery } from "../src/search/query-classifier.js";
import { searchCode } from "../src/search/search-router.js";

describe("classifyQuery", () => {
  it("classifies common query shapes", () => {
    expect(classifyQuery("/api/trade/order/detail")).toBe("route");
    expect(classifyQuery("select * from order_item_snapshot")).toBe("sql");
    expect(classifyQuery("order_item_snapshot")).toBe("table");
    expect(classifyQuery("ORDER_STATUS_INVALID")).toBe("error");
    expect(classifyQuery("OrderController.detail")).toBe("symbol");
    expect(classifyQuery("订单详情页打开超时")).toBe("semantic");
  });
});

describe("searchCode", () => {
  it("locates route, table, error, and semantic candidates", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root });

      const route = await searchCode({
        home,
        project: "trade-service",
        root,
        type: "route",
        query: "/api/trade/order/detail"
      });
      expect(route.locations[0]).toMatchObject({
        location_type: "controller",
        confidence: "high",
        source: "java_index"
      });

      const table = await searchCode({
        home,
        project: "trade-service",
        root,
        type: "table",
        query: "order_item_snapshot"
      });
      expect(table.locations.some((location) => location.location_type === "sql")).toBe(true);

      const error = await searchCode({
        home,
        project: "trade-service",
        root,
        type: "error",
        query: "ORDER_STATUS_INVALID"
      });
      expect(error.locations).toContainEqual(
        expect.objectContaining({
          location_type: "constant",
          confidence: "high",
          source: "java_index"
        })
      );

      const semantic = await searchCode({
        home,
        project: "trade-service",
        root,
        type: "semantic",
        query: "订单详情页打开超时"
      });
      expect(semantic.locations).toContainEqual(
        expect.objectContaining({
          file: "src/main/java/com/example/trade/web/OrderController.java",
          location_type: "unknown",
          confidence: "medium",
          source: "semantic_lite"
        })
      );

      const symbol = await searchCode({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail"
      });
      expect(symbol.query.type).toBe("symbol");
      expect(symbol.locations[0]).toMatchObject({
        symbol: "OrderController.detail",
        location_type: "controller",
        source: "java_index"
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("falls back to grep when indexes have no structured hit", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root });
      const response = await searchCode({
        home,
        project: "trade-service",
        root,
        type: "keyword",
        query: "buildReportData"
      });

      expect(response.locations[0]).toMatchObject({
        source: "grep",
        confidence: "low"
      });
      expect(response.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "GREP_FALLBACK_USED"
        })
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("merges GitNexus query definitions before relation enrichment", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-project-"));
    const fixtureRoot = join(process.cwd(), "fixtures/java-order-service");

    try {
      await cp(fixtureRoot, root, { recursive: true });
      await mkdir(join(root, ".gitnexus"), { recursive: true });
      await writeFile(
        join(root, ".gitnexus", "run.cjs"),
        `
const command = process.argv[2];
if (command === "query") {
  console.log(JSON.stringify({
    definitions: [
      {
        id: "Class:RemoteSymbol",
        name: "RemoteSymbol",
        filePath: "src/main/java/com/example/trade/service/RemoteSymbol.java",
        startLine: 10,
        endLine: 20
      }
    ]
  }));
} else if (command === "context") {
  console.log(JSON.stringify({
    outgoing: {
      calls: [
        {
          uid: "Method:RemoteDependency.call",
          name: "RemoteDependency.call",
          filePath: "src/main/java/com/example/trade/service/RemoteDependency.java"
        }
      ],
      annotated_by: [
        {
          uid: "Class:RemoteAnnotation",
          name: "RemoteAnnotation",
          filePath: "src/main/java/com/example/trade/service/RemoteAnnotation.java"
        }
      ]
    }
  }));
} else {
  console.log(JSON.stringify({ ok: true }));
}
`,
        "utf8"
      );
      await indexProject({ home, name: "trade-service", path: root });

      const response = await searchCode({
        home,
        project: "trade-service",
        root,
        gitnexusRepo: "java-spring-mybatis-demo",
        type: "semantic",
        query: "RemoteSymbol",
        includeRelations: true,
        limit: 5
      });

      expect(response.locations).toContainEqual(
        expect.objectContaining({
          id: "Class:RemoteSymbol",
          symbol: "RemoteSymbol",
          source: "gitnexus"
        })
      );
      expect(response.relations).toContainEqual(
        expect.objectContaining({
          from: "Class:RemoteSymbol",
          to: "Method:RemoteDependency.call",
          relation_type: "calls",
          raw_relation_type: "calls"
        })
      );
      expect(response.relations).toContainEqual(
        expect.objectContaining({
          from: "Class:RemoteSymbol",
          to: "Class:RemoteAnnotation",
          relation_type: "references",
          raw_relation_type: "annotated_by"
        })
      );
      expect(response.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "GITNEXUS_RELATIONS_USED"
        })
      );
      expect(response.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "GITNEXUS_UNKNOWN_RELATION_TYPE",
          message: expect.stringContaining("annotated_by")
        })
      );
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing indexes and still attempts grep", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const response = await searchCode({
        home,
        project: "trade-service",
        root,
        query: "ORDER_STATUS_INVALID"
      });

      expect(response.index_status.state).toBe("missing");
      expect(response.diagnostics).toContainEqual(expect.objectContaining({ code: "INDEX_MISSING" }));
      expect(response.locations).toContainEqual(expect.objectContaining({ source: "grep" }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("records grep fallback diagnostics even when grep has no hit", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root });
      const response = await searchCode({
        home,
        project: "trade-service",
        root,
        type: "keyword",
        query: "NO_SUCH_TOKEN_FOR_GREP_FALLBACK"
      });

      expect(response.locations).toHaveLength(0);
      expect(response.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "GREP_FALLBACK_USED"
        })
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports missing semantic index files as partial index state", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root });
      await unlink(join(home, "projects", "trade-service", "semantic-lite.jsonl"));

      const response = await searchCode({
        home,
        project: "trade-service",
        root,
        type: "semantic",
        query: "订单详情页打开超时"
      });

      expect(response.index_status.state).toBe("partial");
      expect(response.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "SEMANTIC_INDEX_MISSING"
        })
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("marks index stale when manifest project path does not match current root", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root });
      await writeFile(
        join(home, "projects", "trade-service", "manifest.json"),
        JSON.stringify({
          project: "trade-service",
          path: "/tmp/old-trade-service",
          indexed_at: new Date().toISOString(),
          dirty_flag: false,
          generated_files: [
            "java-route-map.jsonl",
            "java-sql-map.jsonl",
            "error-map.jsonl",
            "semantic-lite.jsonl"
          ],
          warnings: [],
          errors: []
        }),
        "utf8"
      );

      const response = await searchCode({
        home,
        project: "trade-service",
        root,
        type: "route",
        query: "/api/trade/order/detail"
      });

      expect(response.index_status.state).toBe("stale");
      expect(response.diagnostics).toContainEqual(expect.objectContaining({ code: "INDEX_STALE" }));
      expect(response.locations[0]?.confidence).toBe("medium");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps stale diagnostics and downgraded confidence when a mismatched manifest is also partial", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await indexProject({ home, name: "trade-service", path: root });
      await unlink(join(home, "projects", "trade-service", "java-sql-map.jsonl"));
      await writeFile(
        join(home, "projects", "trade-service", "manifest.json"),
        JSON.stringify({
          project: "trade-service",
          path: "/tmp/old-trade-service",
          indexed_at: new Date().toISOString(),
          dirty_flag: false,
          generated_files: [
            "java-route-map.jsonl",
            "java-sql-map.jsonl",
            "error-map.jsonl",
            "semantic-lite.jsonl"
          ],
          warnings: [],
          errors: []
        }),
        "utf8"
      );

      const response = await searchCode({
        home,
        project: "trade-service",
        root,
        query: "OrderController.detail"
      });

      expect(response.index_status.state).toBe("partial");
      expect(response.diagnostics).toContainEqual(expect.objectContaining({ code: "INDEX_STALE" }));
      expect(response.diagnostics).toContainEqual(expect.objectContaining({ code: "INDEX_MISSING" }));
      expect(response.locations[0]?.confidence).toBe("medium");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("searches oversized files during grep fallback", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-grep-"));

    try {
      await mkdir(join(root, "src/main/java/example"), { recursive: true });
      await writeFile(
        join(root, "src/main/java/example/LargeService.java"),
        `${"x".repeat(1_100_000)}UNIQUE_TOKEN_IN_OVERSIZED_FILE`,
        "utf8"
      );

      const response = await searchCode({
        home,
        project: "large-service",
        root,
        type: "keyword",
        query: "UNIQUE_TOKEN_IN_OVERSIZED_FILE"
      });

      expect(response.locations).toContainEqual(
        expect.objectContaining({
          file: expect.stringContaining("LargeService.java"),
          source: "grep"
        })
      );
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
