import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectDataDir, resolveCodeIntelHome, validateProjectName } from "../src/paths.js";
import { createProjectRegistry } from "../src/registry.js";

describe("project registry", () => {
  it("registers and reads a local Java project", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const repo = await mkdtemp(join(tmpdir(), "repo-"));

    try {
      const registry = createProjectRegistry({ home });
      const project = await registry.register({
        name: "trade-service",
        path: repo,
        stack: "java-generic"
      });

      expect(project.name).toBe("trade-service");
      expect(project.path).toBe(repo);
      await expect(registry.get("trade-service")).resolves.toMatchObject({
        name: "trade-service",
        path: repo
      });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("stores optional GitNexus repo label for registered projects", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const repo = await mkdtemp(join(tmpdir(), "repo-"));

    try {
      const registry = createProjectRegistry({ home });
      const project = await registry.register({
        name: "mi-intl-scheme",
        path: repo,
        stack: "java-spring-mybatis",
        gitnexus_repo: "mi-intl-scheme"
      });

      expect(project.gitnexus_repo).toBe("mi-intl-scheme");
      await expect(registry.get("mi-intl-scheme")).resolves.toMatchObject({
        gitnexus_repo: "mi-intl-scheme"
      });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects dot project names for project data directories", () => {
    expect(() => projectDataDir("/tmp/code-intel", ".")).toThrow("项目名无效");
    expect(() => projectDataDir("/tmp/code-intel", "..")).toThrow("项目名无效");
  });

  it("validates project name edge cases", () => {
    const valid128Name = "a".repeat(128);
    const invalid129Name = "a".repeat(129);

    expect(() => validateProjectName("")).toThrow("项目名无效");
    expect(() => validateProjectName("   ")).toThrow("项目名无效");
    expect(() => validateProjectName("abc\n")).toThrow("项目名无效");
    expect(() => validateProjectName("abc\u0000")).toThrow("项目名无效");
    expect(() => validateProjectName("a/b")).toThrow("项目名无效");
    expect(() => validateProjectName("a\\b")).toThrow("项目名无效");
    expect(validateProjectName("trade.service_1")).toBe("trade.service_1");
    expect(validateProjectName(valid128Name)).toBe(valid128Name);
    expect(() => validateProjectName(invalid129Name)).toThrow("项目名无效");
  });

  it("rejects invalid project names when registering", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const repo = await mkdtemp(join(tmpdir(), "repo-"));

    try {
      const registry = createProjectRegistry({ home });
      await expect(registry.register({
        name: " ../trade-service ",
        path: repo,
        stack: "java-generic"
      })).rejects.toThrow("项目名无效");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps created_at and refreshes updated_at when registering the same project", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const repo = await mkdtemp(join(tmpdir(), "repo-"));
    const nextRepo = await mkdtemp(join(tmpdir(), "repo-"));

    try {
      const registry = createProjectRegistry({ home });
      const first = await registry.register({
        name: "trade-service",
        path: repo,
        stack: "java-generic"
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await registry.register({
        name: "trade-service",
        path: nextRepo,
        stack: "java-spring"
      });

      expect(second.created_at).toBe(first.created_at);
      expect(second.updated_at).not.toBe(first.updated_at);
      expect(second.path).toBe(nextRepo);
      expect(second.stack).toBe("java-spring");
      await expect(registry.list()).resolves.toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
      await rm(nextRepo, { recursive: true, force: true });
    }
  });

  it("supports destructured exists calls", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const repo = await mkdtemp(join(tmpdir(), "repo-"));

    try {
      const registry = createProjectRegistry({ home });
      await registry.register({
        name: "trade-service",
        path: repo,
        stack: "java-generic"
      });
      const { exists } = registry;

      await expect(exists("trade-service")).resolves.toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns false when a registered project directory was removed", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const repo = await mkdtemp(join(tmpdir(), "repo-"));

    try {
      const registry = createProjectRegistry({ home });
      await registry.register({
        name: "trade-service",
        path: repo,
        stack: "java-generic"
      });
      await rm(repo, { recursive: true, force: true });

      await expect(registry.exists("trade-service")).resolves.toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects regular file project paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const repo = await mkdtemp(join(tmpdir(), "repo-"));
    const repoFile = join(repo, "pom.xml");

    try {
      await writeFile(repoFile, "<project />", "utf8");
      const registry = createProjectRegistry({ home });

      await expect(registry.register({
        name: "trade-service",
        path: repoFile,
        stack: "java-generic"
      })).rejects.toThrow("项目路径不是目录");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("throws a clear error when registry projects is not an array", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));

    try {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "registry.json"), JSON.stringify({ projects: {} }), "utf8");
      const registry = createProjectRegistry({ home });

      await expect(registry.list()).rejects.toThrow("registry.json 格式无效：projects 必须是数组");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("lists all registered projects", async () => {
    const home = await mkdtemp(join(tmpdir(), "code-intel-"));
    const repo = await mkdtemp(join(tmpdir(), "repo-"));
    const nextRepo = await mkdtemp(join(tmpdir(), "repo-"));

    try {
      const registry = createProjectRegistry({ home });
      await registry.register({
        name: "trade-service",
        path: repo,
        stack: "java-generic"
      });
      await registry.register({
        name: "settlement-service",
        path: nextRepo,
        stack: "java-spring"
      });

      await expect(registry.list()).resolves.toHaveLength(2);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
      await rm(nextRepo, { recursive: true, force: true });
    }
  });

  it("resolves CODE_INTEL_HOME with trimming and absolute path normalization", () => {
    const home = resolveCodeIntelHome({ CODE_INTEL_HOME: " ./runtime " });

    expect(isAbsolute(home)).toBe(true);
    expect(home.endsWith("runtime")).toBe(true);
    expect(home).toBe(home.trim());
  });
});
