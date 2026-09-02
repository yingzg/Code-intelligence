import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGitState } from "../src/git.js";
import { indexProject, classifyFreshness } from "../src/indexer/index-project.js";
import { projectDataDir } from "../src/paths.js";

describe("classifyFreshness", () => {
  it("marks index stale when current commit differs", () => {
    expect(
      classifyFreshness({
        indexed_commit: "abc",
        current_commit: "def",
        indexed_dirty: false,
        current_dirty: false
      }).state
    ).toBe("stale");
  });

  it("marks index stale when dirty flag differs", () => {
    expect(
      classifyFreshness({
        indexed_commit: "abc",
        current_commit: "abc",
        indexed_dirty: false,
        current_dirty: true
      }).state
    ).toBe("stale");
  });

  it("marks index stale when only one commit is known", () => {
    expect(
      classifyFreshness({
        indexed_commit: "abc",
        indexed_dirty: false,
        current_dirty: false
      }).state
    ).toBe("stale");
    expect(
      classifyFreshness({
        current_commit: "abc",
        indexed_dirty: false,
        current_dirty: false
      }).state
    ).toBe("stale");
  });

  it("marks dirty indexes stale because dirty content cannot be fingerprinted yet", () => {
    expect(
      classifyFreshness({
        indexed_commit: "abc",
        current_commit: "abc",
        indexed_dirty: true,
        current_dirty: true
      }).state
    ).toBe("stale");
  });

  it("marks index ready when commit and dirty flag match", () => {
    expect(
      classifyFreshness({
        indexed_commit: "abc",
        current_commit: "abc",
        indexed_dirty: false,
        current_dirty: false
      }).state
    ).toBe("ready");
  });

  it("marks index ready for non-git projects when dirty flag matches", () => {
    expect(
      classifyFreshness({
        indexed_dirty: false,
        current_dirty: false
      }).state
    ).toBe("ready");
  });
});

describe("readGitState", () => {
  it("returns a non-dirty fallback for non-git directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-non-git-"));

    try {
      await expect(readGitState(root)).resolves.toEqual({ dirty: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("indexProject", () => {
  it("writes Java route, SQL, error, semantic indexes and a manifest", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-home-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const result = await indexProject({
        home,
        name: "trade-service",
        path: root
      });
      const dir = projectDataDir(home, "trade-service");
      const routeMap = await readJsonl(join(dir, "java-route-map.jsonl"));
      const sqlMap = await readJsonl(join(dir, "java-sql-map.jsonl"));
      const errorMap = await readJsonl(join(dir, "error-map.jsonl"));
      const semanticMap = await readJsonl(join(dir, "semantic-lite.jsonl"));
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
        project: string;
        path: string;
        dirty_flag: boolean;
        generated_files: string[];
        warnings: string[];
        counts: Record<string, number>;
        timings_ms: Record<string, number>;
        gitnexus_mode: string;
      };

      expect(result.state).toBe("partial");
      expect(result.warnings.some((warning) => warning.includes("GitNexus"))).toBe(true);
      expect(routeMap).toContainEqual(expect.objectContaining({ route: "/api/trade/order/detail" }));
      expect(sqlMap).toContainEqual(expect.objectContaining({ table: "order_item_snapshot" }));
      expect(errorMap).toContainEqual(expect.objectContaining({ token: "ORDER_STATUS_INVALID" }));
      expect(semanticMap).toContainEqual(expect.objectContaining({ file: "src/main/java/com/example/trade/web/OrderController.java" }));
      expect(manifest).toMatchObject({
        project: "trade-service",
        path: root,
        dirty_flag: false
      });
      expect(manifest.generated_files).toEqual([
        "java-route-map.jsonl",
        "java-sql-map.jsonl",
        "error-map.jsonl",
        "semantic-lite.jsonl"
      ]);
      expect(manifest.warnings).toEqual(result.warnings);
      expect(result.counts.routes).toBe(routeMap.length);
      expect(result.counts.sql).toBe(sqlMap.length);
      expect(result.counts.errors).toBe(errorMap.length);
      expect(result.counts.semantic).toBe(semanticMap.length);
      expect(result.timings_ms.total).toBeGreaterThanOrEqual(0);
      expect(manifest.counts).toEqual(result.counts);
      expect(manifest.timings_ms.total).toBeGreaterThanOrEqual(0);
      expect(manifest.gitnexus_mode).toBe("auto");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("continues writing local indexes when withGitNexus is requested but unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-home-"));
    const root = join(process.cwd(), "fixtures/java-order-service");

    try {
      const result = await indexProject({
        home,
        name: "trade-service",
        path: root,
        withGitNexus: true
      });
      const dir = projectDataDir(home, "trade-service");
      const routeMap = await readJsonl(join(dir, "java-route-map.jsonl"));
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
        warnings: string[];
        errors: string[];
        tool_version: string;
      };

      expect(result.state).toBe("partial");
      expect(result.warnings.some((warning) => warning.includes("GitNexus"))).toBe(true);
      expect(routeMap).toContainEqual(expect.objectContaining({ route: "/api/trade/order/detail" }));
      expect(manifest.tool_version).toBe("0.1.0");
      expect(manifest.errors).toEqual([]);
      expect(manifest.warnings).toEqual(result.warnings);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses --with-gitnexus as compatibility basic mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-home-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-basic-"));

    try {
      await writeFakeGitNexusRunner(root);
      const result = await indexProject({
        home,
        name: "trade-service",
        path: root,
        withGitNexus: true
      });
      const args = JSON.parse(await readFile(join(root, ".gitnexus", "last-analyze.json"), "utf8")) as string[];

      expect(args).toEqual(["analyze"]);
      expect(result.gitnexus_mode).toBe("basic");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs full GitNexus analysis with complete flags", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-home-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-full-"));
    const progress: string[] = [];

    try {
      await writeFakeGitNexusRunner(root);
      const result = await indexProject({
        home,
        name: "trade-service",
        path: root,
        gitnexusMode: "full",
        onProgress: (event) => progress.push(`${event.phase}:${event.message}`)
      });
      const args = JSON.parse(await readFile(join(root, ".gitnexus", "last-analyze.json"), "utf8")) as string[];

      expect(args).toEqual(["analyze", "--embeddings", "--skills", "--pdg", "--verbose"]);
      expect(result.gitnexus_mode).toBe("full");
      expect(result.timings_ms.gitnexus).toBeGreaterThanOrEqual(0);
      expect(progress.some((line) => line.includes("gitnexus:running"))).toBe(true);
      expect(progress.some((line) => line.includes("route_index"))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips GitNexus analysis in auto mode when the local index is up to date", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-home-"));
    const root = await mkdtemp(join(tmpdir(), "code-intel-gitnexus-auto-"));

    try {
      await writeFakeGitNexusRunner(root, "Status: up-to-date");
      const result = await indexProject({
        home,
        name: "trade-service",
        path: root,
        gitnexusMode: "auto"
      });

      await expect(readFile(join(root, ".gitnexus", "last-analyze.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect(result.gitnexus_mode).toBe("auto");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function writeFakeGitNexusRunner(root: string, statusText = "Status: stale"): Promise<void> {
  await mkdir(join(root, ".gitnexus"), { recursive: true });
  await writeFile(
    join(root, ".gitnexus", "run.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "status") {
  console.log(${JSON.stringify(statusText)});
  process.exit(0);
}
if (args[0] === "analyze") {
  fs.writeFileSync(path.join(process.cwd(), ".gitnexus", "last-analyze.json"), JSON.stringify(args));
  console.log("analyze started");
  console.error("analyze finished");
  process.exit(0);
}
process.exit(1);
`,
    "utf8"
  );
}
