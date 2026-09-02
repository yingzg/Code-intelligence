import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = "packages/cli/dist/index.js";

describe("code-intel cli", () => {
  it("prints data directory with where command", async () => {
    const result = await runCli(["where"], {
      CODE_INTEL_HOME: "/tmp/code-intel-test-home"
    });

    expect(result.stdout).toContain("/tmp/code-intel-test-home");
  }, 30_000);

  it("registers, indexes, and searches a local project", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-cli-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const registered = await runCli(["register", "trade-service", root, "--stack", "java-spring-mybatis"], {
        CODE_INTEL_HOME: home
      });
      expect(JSON.parse(registered.stdout)).toMatchObject({
        name: "trade-service",
        stack: "java-spring-mybatis"
      });

      const index = await runCli(["index", "trade-service"], {
        CODE_INTEL_HOME: home
      });
      expect(JSON.parse(index.stdout)).toMatchObject({
        state: "partial"
      });

      const search = await runCli(
        ["search", "trade-service", "--type", "error", "--query", "ORDER_STATUS_INVALID", "--limit", "3"],
        {
          CODE_INTEL_HOME: home
        }
      );
      const response = JSON.parse(search.stdout) as {
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
  }, 60_000);

  it("registers optional GitNexus repo labels", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-cli-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const registered = await runCli([
        "register",
        "trade-service",
        root,
        "--stack",
        "java-spring-mybatis",
        "--gitnexus-repo",
        "java-spring-mybatis-demo"
      ], {
        CODE_INTEL_HOME: home
      });

      expect(JSON.parse(registered.stdout)).toMatchObject({
        name: "trade-service",
        gitnexus_repo: "java-spring-mybatis-demo"
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("explores a registered project from one query", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-cli-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await runCli(["register", "trade-service", root, "--stack", "java-spring-mybatis"], {
        CODE_INTEL_HOME: home
      });
      await runCli(["index", "trade-service", "--gitnexus-mode", "none"], {
        CODE_INTEL_HOME: home
      });
      const explore = await runCli([
        "explore",
        "trade-service",
        "--query",
        "OrderController.detail",
        "--direction",
        "both",
        "--depth",
        "2",
        "--limit",
        "5"
      ], {
        CODE_INTEL_HOME: home
      });
      const response = JSON.parse(explore.stdout) as {
        anchors: unknown[];
        relations: unknown[];
        candidate_paths: unknown[];
        main_paths: unknown[];
        coverage: { complete: boolean };
        budget_summary: { requested_limit: number; main_path_count: number };
        diagnostics: Array<{ code: string }>;
      };

      expect(Array.isArray(response.anchors)).toBe(true);
      expect(Array.isArray(response.relations)).toBe(true);
      expect(Array.isArray(response.candidate_paths)).toBe(true);
      expect(Array.isArray(response.main_paths)).toBe(true);
      expect(typeof response.coverage.complete).toBe("boolean");
      expect(response.budget_summary.requested_limit).toBe(5);
      expect(response.diagnostics.length).toBeGreaterThan(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  it("excludes test anchors by default for explore", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-cli-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-cli-gitnexus-"));

    try {
      await writeFakeGitNexusRunner(root);
      await runCli(["register", "trade-service", root, "--stack", "java-spring-mybatis"], {
        CODE_INTEL_HOME: home
      });

      const explore = await runCli([
        "explore",
        "trade-service",
        "--query",
        "AController",
        "--type",
        "symbol",
        "--direction",
        "downstream",
        "--depth",
        "1",
        "--limit",
        "5"
      ], {
        CODE_INTEL_HOME: home
      });
      const response = JSON.parse(explore.stdout) as {
        anchors: Array<{ file: string }>;
      };

      expect(response.anchors).toHaveLength(1);
      expect(response.anchors[0].file).toBe("src/main/java/com/example/AController.java");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("accepts relation budget for explore", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-cli-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-cli-gitnexus-"));

    try {
      await writeFakeGitNexusRunner(root);
      await runCli(["register", "trade-service", root, "--stack", "java-spring-mybatis"], {
        CODE_INTEL_HOME: home
      });

      const explore = await runCli([
        "explore",
        "trade-service",
        "--query",
        "AController",
        "--type",
        "symbol",
        "--direction",
        "downstream",
        "--depth",
        "1",
        "--limit",
        "1",
        "--relation-budget",
        "7",
        "--main-path-limit",
        "2"
      ], {
        CODE_INTEL_HOME: home
      });
      const response = JSON.parse(explore.stdout) as {
        summary: string;
        main_paths: unknown[];
        budget_summary: { main_path_count: number };
      };

      expect(response.summary).toContain("limit=1");
      expect(response.summary).toContain("relationBudget=7");
      expect(Array.isArray(response.main_paths)).toBe(true);
      expect(response.budget_summary.main_path_count).toBeLessThanOrEqual(2);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("can include test anchors for explore when explicitly requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-cli-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-cli-gitnexus-"));

    try {
      await writeFakeGitNexusRunner(root);
      await runCli(["register", "trade-service", root, "--stack", "java-spring-mybatis"], {
        CODE_INTEL_HOME: home
      });

      const explore = await runCli([
        "explore",
        "trade-service",
        "--query",
        "AController",
        "--type",
        "symbol",
        "--direction",
        "downstream",
        "--depth",
        "1",
        "--limit",
        "5",
        "--include-tests"
      ], {
        CODE_INTEL_HOME: home
      });
      const response = JSON.parse(explore.stdout) as {
        anchors: Array<{ file: string }>;
      };

      expect(response.anchors.map((anchor) => anchor.file)).toEqual([
        "src/main/java/com/example/AController.java",
        "src/test/java/com/example/AControllerTest.java"
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits non-zero for invalid limit values", async () => {
    await expect(runCli(["search", "trade-service", "--query", "x", "--limit", "abc"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("limit 必须是正整数")
    });
  }, 30_000);

  it("exits non-zero for invalid GitNexus index modes", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-cli-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      await runCli(["register", "trade-service", root, "--stack", "java-spring-mybatis"], {
        CODE_INTEL_HOME: home
      });
      await expect(runCli(["index", "trade-service", "--gitnexus-mode", "deep"], {
        CODE_INTEL_HOME: home
      })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("GitNexus 索引模式不支持")
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("exits non-zero for unregistered projects", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-cli-"));

    try {
      await expect(runCli(["search", "missing-service", "--query", "x"], {
        CODE_INTEL_HOME: home
      })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("项目未注册")
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync("node", [CLI, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env
    }
  });
}

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
