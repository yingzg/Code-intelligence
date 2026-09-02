import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { traceCallChain } from "../src/search/call-chain.js";

describe("traceCallChain", () => {
  it("preserves GitNexus not_found details as diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-trace-"));

    try {
      await mkdir(join(root, ".gitnexus"), { recursive: true });
      await writeFile(
        join(root, ".gitnexus", "run.cjs"),
        `
console.log(JSON.stringify({
  status: "not_found",
  error: "Source symbol 'A.run' not found.",
  suggestion: "Check the symbol name or use --from-uid for zero-ambiguity."
}));
`,
        "utf8"
      );

      const response = await traceCallChain({
        home: "/tmp/code-intel-home",
        project: "trade-service",
        root,
        gitnexusRepo: "java-spring-mybatis-demo",
        from: "A.run",
        to: "B.call",
        depth: 5
      });

      expect(response.relations).toHaveLength(0);
      expect(response.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "GITNEXUS_RELATIONS_UNAVAILABLE",
          message: expect.stringContaining("Source symbol 'A.run' not found."),
          suggested_action: expect.stringContaining("--from-uid")
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves GitNexus no_path details as diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-trace-"));

    try {
      await mkdir(join(root, ".gitnexus"), { recursive: true });
      await writeFile(
        join(root, ".gitnexus", "run.cjs"),
        `
console.log(JSON.stringify({
  status: "no_path",
  suggestion: "No directed path found. Try gitnexus context <symbol>."
}));
`,
        "utf8"
      );

      const response = await traceCallChain({
        home: "/tmp/code-intel-home",
        project: "trade-service",
        root,
        gitnexusRepo: "java-spring-mybatis-demo",
        from: "A.run",
        to: "B.call",
        depth: 5
      });

      expect(response.relations).toHaveLength(0);
      expect(response.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "GITNEXUS_RELATIONS_UNAVAILABLE",
          message: expect.stringContaining("GitNexus trace 未找到有向路径"),
          suggested_action: expect.stringContaining("gitnexus context")
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
