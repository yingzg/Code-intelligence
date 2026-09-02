import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectRegistry, indexProject } from "@code-intelligence/core";
import {
  allowIndexOperations,
  handleCodeExploreSymbol,
  handleCodeLocateRoute,
  handleCodeIndexProject,
  handleCodeSearch,
  handleCodeTraceCallChain,
  parseTextResult
} from "../src/server.js";

describe("mcp permissions", () => {
  it("disables index operations by default", () => {
    expect(allowIndexOperations({})).toBe(false);
  });

  it("enables index operations only with explicit env flag", () => {
    expect(allowIndexOperations({ CODE_INTEL_MCP_ALLOW_INDEX: "true" })).toBe(true);
    expect(allowIndexOperations({ CODE_INTEL_MCP_ALLOW_INDEX: "1" })).toBe(false);
  });
});

describe("mcp tool handlers", () => {
  it("returns PROJECT_NOT_REGISTERED diagnostics for unknown projects", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));

    try {
      const result = await handleCodeSearch({
        home,
        project: "missing-service",
        query: "ORDER_STATUS_INVALID"
      });

      expect(parseTextResult(result)).toMatchObject({
        diagnostics: [
          {
            level: "error",
            code: "PROJECT_NOT_REGISTERED"
          }
        ]
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("searches registered projects through the generic code.search handler", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const registry = createProjectRegistry({ home });
      await registry.register({
        name: "trade-service",
        path: root,
        stack: "java-spring-mybatis"
      });
      await indexProject({ home, name: "trade-service", path: root });

      const result = await handleCodeSearch({
        home,
        project: "trade-service",
        query: "ORDER_STATUS_INVALID",
        type: "error",
        limit: 3
      });
      const response = parseTextResult(result) as {
        locations: Array<{ source: string; location_type: string }>;
        diagnostics: unknown[];
      };

      expect(response.locations).toContainEqual(
        expect.objectContaining({
          source: "java_index",
          location_type: "constant"
        })
      );
      expect(Array.isArray(response.diagnostics)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("locates routes through the code.locate_route handler", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const registry = createProjectRegistry({ home });
      await registry.register({
        name: "trade-service",
        path: root,
        stack: "java-spring-mybatis"
      });
      await indexProject({ home, name: "trade-service", path: root });

      const result = await handleCodeLocateRoute({
        home,
        project: "trade-service",
        route: "/api/trade/order/detail"
      });
      const response = parseTextResult(result) as {
        query: { type: string };
        locations: Array<{ location_type: string; source: string }>;
      };

      expect(response.query.type).toBe("route");
      expect(response.locations[0]).toMatchObject({
        location_type: "controller",
        source: "java_index"
      });

      const wrongMethod = await handleCodeLocateRoute({
        home,
        project: "trade-service",
        method: "POST",
        route: "/api/trade/order/detail"
      });
      const wrongMethodResponse = parseTextResult(wrongMethod) as {
        locations: unknown[];
        diagnostics: Array<{ code: string }>;
      };

      expect(wrongMethodResponse.locations).toHaveLength(0);
      expect(wrongMethodResponse.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "GREP_FALLBACK_USED"
        })
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("allows index operations when explicitly enabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const registry = createProjectRegistry({ home });
      await registry.register({
        name: "trade-service",
        path: root,
        stack: "java-spring-mybatis"
      });

      const result = await handleCodeIndexProject({
        home,
        env: { CODE_INTEL_MCP_ALLOW_INDEX: "true" },
        project: "trade-service",
        gitnexus_mode: "none"
      });

      expect(parseTextResult(result)).toMatchObject({
        state: "partial",
        gitnexus_mode: "none"
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns call_chain responses through the code.trace_call_chain handler", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const registry = createProjectRegistry({ home });
      await registry.register({
        name: "trade-service",
        path: root,
        stack: "java-spring-mybatis",
        gitnexus_repo: "java-spring-mybatis-demo"
      });

      const result = await handleCodeTraceCallChain({
        home,
        project: "trade-service",
        from: "OrderController.detail",
        to: "OrderMapper.countSnapshotItems",
        depth: 5
      });
      const response = parseTextResult(result) as {
        query: { type: string };
        relations: unknown[];
        diagnostics: Array<{ code: string }>;
      };

      expect(response.query.type).toBe("call_chain");
      expect(Array.isArray(response.relations)).toBe(true);
      expect(response.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "GITNEXUS_QUERY_FAILED"
          })
        ])
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns explore responses through the code.explore_symbol handler", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const registry = createProjectRegistry({ home });
      await registry.register({
        name: "trade-service",
        path: root,
        stack: "java-spring-mybatis"
      });
      await indexProject({ home, name: "trade-service", path: root, gitnexusMode: "none" });

      const result = await handleCodeExploreSymbol({
        home,
        project: "trade-service",
        query: "OrderController.detail",
        direction: "both",
        depth: 2,
        limit: 5
      });
      const response = parseTextResult(result) as {
        anchors: unknown[];
        relations: unknown[];
        candidate_paths: unknown[];
        main_paths: unknown[];
        coverage: { complete: boolean };
        budget_summary: { requested_limit: number };
        diagnostics: unknown[];
      };

      expect(Array.isArray(response.anchors)).toBe(true);
      expect(Array.isArray(response.relations)).toBe(true);
      expect(Array.isArray(response.candidate_paths)).toBe(true);
      expect(Array.isArray(response.main_paths)).toBe(true);
      expect(typeof response.coverage.complete).toBe("boolean");
      expect(response.budget_summary.requested_limit).toBe(5);
      expect(Array.isArray(response.diagnostics)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("excludes test anchors by default through the code.explore_symbol handler", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-mcp-gitnexus-"));

    try {
      await writeFakeGitNexusRunner(root);
      const registry = createProjectRegistry({ home });
      await registry.register({
        name: "trade-service",
        path: root,
        stack: "java-spring-mybatis"
      });

      const result = await handleCodeExploreSymbol({
        home,
        project: "trade-service",
        query: "AController",
        type: "symbol",
        direction: "downstream",
        depth: 1,
        limit: 5
      });
      const response = parseTextResult(result) as {
        anchors: Array<{ file: string }>;
      };

      expect(response.anchors).toHaveLength(1);
      expect(response.anchors[0].file).toBe("src/main/java/com/example/AController.java");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts relation_budget through the code.explore_symbol handler", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-mcp-gitnexus-"));

    try {
      await writeFakeGitNexusRunner(root);
      const registry = createProjectRegistry({ home });
      await registry.register({
        name: "trade-service",
        path: root,
        stack: "java-spring-mybatis"
      });

      const result = await handleCodeExploreSymbol({
        home,
        project: "trade-service",
        query: "AController",
        type: "symbol",
        direction: "downstream",
        depth: 1,
        limit: 1,
        relation_budget: 7
      });
      const response = parseTextResult(result) as {
        summary: string;
      };

      expect(response.summary).toContain("limit=1");
      expect(response.summary).toContain("relationBudget=7");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks index operations unless explicitly enabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));

    try {
      const result = await handleCodeIndexProject({
        home,
        env: {},
        project: "trade-service"
      });

      expect(parseTextResult(result)).toMatchObject({
        diagnostics: [
          {
            level: "error",
            code: "INDEX_DISABLED"
          }
        ]
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function writeFakeGitNexusRunner(root: string): Promise<void> {
  await mkdir(join(root, ".gitnexus"), { recursive: true });
  await mkdir(join(root, "src/main/java/com/example"), { recursive: true });
  await mkdir(join(root, "src/test/java/com/example"), { recursive: true });
  await writeFile(join(root, "src/main/java/com/example/AController.java"), "class AController {}\n", "utf8");
  await writeFile(join(root, "src/test/java/com/example/AControllerTest.java"), "class AControllerTest {}\n", "utf8");
  await writeFile(
    join(root, ".gitnexus", "run.cjs"),
    `const args = process.argv.slice(2);
if (args[0] === "status") {
  console.log(JSON.stringify({ status: "ok" }));
  process.exit(0);
}
if (args[0] === "query") {
  console.log(JSON.stringify({
    definitions: [
      {
        id: "Class:src/test/java/com/example/AControllerTest.java:AControllerTest",
        name: "AControllerTest",
        filePath: "src/test/java/com/example/AControllerTest.java",
        startLine: 1,
        endLine: 1
      },
      {
        id: "Class:src/main/java/com/example/AController.java:AController",
        name: "AController",
        filePath: "src/main/java/com/example/AController.java",
        startLine: 1,
        endLine: 1
      }
    ]
  }));
  process.exit(0);
}
if (args[0] === "context") {
  console.log(JSON.stringify({ outgoing: { calls: [] } }));
  process.exit(0);
}
console.log(JSON.stringify({}));
`,
    "utf8"
  );
}
