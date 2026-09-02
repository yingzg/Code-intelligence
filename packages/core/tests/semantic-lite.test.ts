import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSemanticLiteIndex, searchSemanticLite, tokenizeSemanticText } from "../src/indexer/semantic-lite-indexer.js";

describe("semantic-lite", () => {
  it("recalls order detail code from a Chinese business description", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");
    const index = await buildSemanticLiteIndex({ project: "trade-service", root });
    const results = searchSemanticLite(index, "订单详情页打开超时", 5);

    expect(results.some((result) => result.file.includes("OrderController.java"))).toBe(true);
    expect(results.some((result) => result.text.includes("查询订单详情"))).toBe(true);
  });

  it("recalls MyBatis XML from snake case table and SQL query terms", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");
    const index = await buildSemanticLiteIndex({ project: "trade-service", root });
    const results = searchSemanticLite(index, "count order item snapshot sql", 3);

    expect(results[0]?.file).toBe("src/main/resources/mapper/OrderMapper.xml");
    expect(results[0]?.tokens).toEqual(expect.arrayContaining(["order", "item", "snapshot", "count"]));
  });

  it("splits camel case symbols and file names into searchable terms", () => {
    const tokens = tokenizeSemanticText("OrderDetailService countSnapshotItems");

    expect(tokens).toEqual(expect.arrayContaining(["order", "detail", "service", "count", "snapshot", "items"]));
  });

  it("honors the result limit and ranks better token matches first", async () => {
    const root = await createProject({
      "src/main/java/example/OrderDetailService.java": `
        package example;

        public class OrderDetailService {
            public String detail(String orderId) {
                return "订单详情";
            }
        }
      `,
      "src/main/java/example/OrderListService.java": `
        package example;

        public class OrderListService {
            public String list() {
                return "订单列表";
            }
        }
      `
    });

    const index = await buildSemanticLiteIndex({ project: "demo", root });
    const results = searchSemanticLite(index, "order detail", 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.file).toBe("src/main/java/example/OrderDetailService.java");
  });

  it("ignores build output directories", async () => {
    const root = await createProject({
      "src/main/java/example/RealService.java": `
        package example;

        public class RealService {
            public String real() {
                return "真实订单查询";
            }
        }
      `,
      "target/generated-sources/example/GeneratedService.java": `
        package example;

        public class GeneratedService {
            public String generated() {
                return "generated only";
            }
        }
      `
    });

    const index = await buildSemanticLiteIndex({ project: "demo", root });
    const results = searchSemanticLite(index, "generated only", 5);

    expect(index.map((entry) => entry.file)).not.toContain("target/generated-sources/example/GeneratedService.java");
    expect(results).toHaveLength(0);
  });

  it("indexes YML resource files", async () => {
    const root = await createProject({
      "src/main/resources/application.yml": `
        trade:
          feature:
            order-timeout-message: 订单超时提醒
      `
    });

    const index = await buildSemanticLiteIndex({ project: "demo", root });
    const results = searchSemanticLite(index, "订单超时提醒", 3);

    expect(index).toContainEqual(
      expect.objectContaining({
        file: "src/main/resources/application.yml"
      })
    );
    expect(results[0]?.file).toBe("src/main/resources/application.yml");
  });

  it("indexes English YML configuration keys and numeric values", async () => {
    const root = await createProject({
      "src/main/resources/application.yml": `
        trade:
          order-timeout-ms: 3000
        spring:
          application.name: trade-service
      `
    });

    const index = await buildSemanticLiteIndex({ project: "demo", root });
    const results = searchSemanticLite(index, "order timeout 3000", 3);

    expect(results[0]?.file).toBe("src/main/resources/application.yml");
    expect(results[0]?.tokens).toEqual(expect.arrayContaining(["order", "timeout", "3000"]));
  });
});

async function createProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-intel-semantic-"));

  for (const [relativePath, content] of Object.entries(files)) {
    const file = join(root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, trimFixture(content));
  }

  return root;
}

function trimFixture(text: string): string {
  const lines = text.replace(/^\n/, "").replace(/\n\s*$/, "\n").split("\n");
  const indentation = Math.min(
    ...lines.filter((line) => line.trim().length > 0).map((line) => line.match(/^ */)?.[0].length ?? 0)
  );

  return lines.map((line) => line.slice(indentation)).join("\n");
}
