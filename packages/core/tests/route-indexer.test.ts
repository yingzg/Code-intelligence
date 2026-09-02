import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRouteIndex } from "../src/indexer/route-indexer.js";
import { readSnippet } from "../src/snippet.js";

describe("buildRouteIndex", () => {
  it("indexes Spring route mappings with class and method prefixes", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");
    const routes = await buildRouteIndex({ project: "trade-service", root });
    const routePaths = routes.map((route) => route.route);

    expect(routes).toContainEqual(
      expect.objectContaining({
        route: "/api/trade/order/detail",
        http_method: "GET",
        symbol: "OrderController.detail",
        location_type: "controller",
        file: "src/main/java/com/example/trade/web/OrderController.java"
      })
    );

    const detailRoute = routes.find((route) => route.route === "/api/trade/order/detail");
    expect(detailRoute?.snippet).toContain("detail(@RequestParam String orderId)");
    expect(detailRoute?.id).toContain(":detail:GET:/api/trade/order/detail");
    expect(routePaths).not.toContain("/api/trade/order");
  });

  it("indexes value and path mapping attributes", async () => {
    const root = await createJavaProject({
      "src/main/java/example/DemoController.java": `
        package example;

        import org.springframework.web.bind.annotation.PostMapping;
        import org.springframework.web.bind.annotation.RequestMapping;
        import org.springframework.web.bind.annotation.RestController;

        @RestController
        @RequestMapping(value = "/x")
        public class DemoController {
            @PostMapping(path = "/submit")
            public String submit() {
                return "ok";
            }
        }
      `
    });

    const routes = await buildRouteIndex({ project: "demo", root });

    expect(routes).toContainEqual(
      expect.objectContaining({
        route: "/x/submit",
        http_method: "POST",
        symbol: "DemoController.submit",
        file: "src/main/java/example/DemoController.java"
      })
    );
  });

  it("indexes mappings when annotations and method signatures are on separate lines", async () => {
    const root = await createJavaProject({
      "src/main/java/example/SplitController.java": `
        package example;

        import org.springframework.web.bind.annotation.GetMapping;
        import org.springframework.web.bind.annotation.RestController;

        @RestController
        public class SplitController {
            @GetMapping("/split")
            public String
            split() {
                return "ok";
            }
        }
      `
    });

    const routes = await buildRouteIndex({ project: "demo", root });

    expect(routes).toContainEqual(
      expect.objectContaining({
        route: "/split",
        http_method: "GET",
        symbol: "SplitController.split"
      })
    );
  });

  it("indexes multiline mapping annotations and RequestMapping HTTP methods", async () => {
    const root = await createJavaProject({
      "src/main/java/example/MultilineController.java": `
        package example;

        import org.springframework.web.bind.annotation.RequestMapping;
        import org.springframework.web.bind.annotation.RequestMethod;
        import org.springframework.web.bind.annotation.RestController;

        @RestController
        @RequestMapping(
            value = "/api/multi"
        )
        public class MultilineController {
            @RequestMapping(
                path = "/submit",
                method = RequestMethod.POST
            )
            public String submit() {
                return "ok";
            }
        }
      `
    });

    const routes = await buildRouteIndex({ project: "demo", root });

    expect(routes).toContainEqual(
      expect.objectContaining({
        route: "/api/multi/submit",
        http_method: "POST",
        symbol: "MultilineController.submit"
      })
    );
  });

  it("does not attach an unrecognized annotated method to a later method", async () => {
    const root = await createJavaProject({
      "src/main/java/example/AnnotatedReturnController.java": `
        package example;

        import javax.annotation.Nullable;
        import org.springframework.web.bind.annotation.GetMapping;
        import org.springframework.web.bind.annotation.RestController;

        @RestController
        public class AnnotatedReturnController {
            @GetMapping("/first")
            public @Nullable String first() {
                return "ok";
            }

            public String helper() {
                return "helper";
            }
        }
      `
    });

    const routes = await buildRouteIndex({ project: "demo", root });

    expect(routes).toContainEqual(
      expect.objectContaining({
        route: "/first",
        symbol: "AnnotatedReturnController.first"
      })
    );
    expect(routes).not.toContainEqual(
      expect.objectContaining({
        route: "/first",
        symbol: "AnnotatedReturnController.helper"
      })
    );
  });

  it("expands array mapping paths", async () => {
    const root = await createJavaProject({
      "src/main/java/example/ArrayController.java": `
        package example;

        import org.springframework.web.bind.annotation.GetMapping;
        import org.springframework.web.bind.annotation.RequestMapping;
        import org.springframework.web.bind.annotation.RequestMethod;
        import org.springframework.web.bind.annotation.RestController;

        @RestController
        @RequestMapping(path = {"/api/a", "/api/b"})
        public class ArrayController {
            @GetMapping({"/one", "/two"})
            public String list() {
                return "ok";
            }
        }
      `
    });

    const routes = await buildRouteIndex({ project: "demo", root });

    expect(routes.map((route) => route.route).sort()).toEqual([
      "/api/a/one",
      "/api/a/two",
      "/api/b/one",
      "/api/b/two"
    ]);
  });

  it("keeps Spring path variables inside array mapping paths", async () => {
    const root = await createJavaProject({
      "src/main/java/example/PathVariableController.java": `
        package example;

        import org.springframework.web.bind.annotation.GetMapping;
        import org.springframework.web.bind.annotation.RestController;

        @RestController
        public class PathVariableController {
            @GetMapping(path = {"/orders/{id}", "/orders/{orderId}/items/{itemId}"})
            public String detail() {
                return "ok";
            }
        }
      `
    });

    const routes = await buildRouteIndex({ project: "demo", root });

    expect(routes.map((route) => route.route).sort()).toEqual([
      "/orders/{id}",
      "/orders/{orderId}/items/{itemId}"
    ]);
  });

  it("does not treat produces or consumes strings as route paths", async () => {
    const root = await createJavaProject({
      "src/main/java/example/ProducesController.java": `
        package example;

        import org.springframework.web.bind.annotation.GetMapping;
        import org.springframework.web.bind.annotation.RequestMapping;
        import org.springframework.web.bind.annotation.RequestMethod;
        import org.springframework.web.bind.annotation.RestController;

        @RestController
        @RequestMapping("/api/report")
        public class ProducesController {
            @GetMapping(produces = "application/json")
            public String list() {
                return "ok";
            }

            @RequestMapping(method = RequestMethod.POST, consumes = "application/json")
            public String save() {
                return "ok";
            }
        }
      `
    });

    const routes = await buildRouteIndex({ project: "demo", root });

    expect(routes).toContainEqual(
      expect.objectContaining({
        route: "/api/report",
        http_method: "GET",
        symbol: "ProducesController.list"
      })
    );
    expect(routes).toContainEqual(
      expect.objectContaining({
        route: "/api/report",
        http_method: "POST",
        symbol: "ProducesController.save"
      })
    );
    expect(routes.map((route) => route.route)).not.toContain("/api/report/application/json");
  });

  it("expands RequestMapping HTTP method arrays", async () => {
    const root = await createJavaProject({
      "src/main/java/example/MethodArrayController.java": `
        package example;

        import org.springframework.web.bind.annotation.RequestMapping;
        import org.springframework.web.bind.annotation.RequestMethod;
        import org.springframework.web.bind.annotation.RestController;

        @RestController
        public class MethodArrayController {
            @RequestMapping(path = "/multi-method", method = {RequestMethod.GET, RequestMethod.POST})
            public String submit() {
                return "ok";
            }
        }
      `
    });

    const routes = await buildRouteIndex({ project: "demo", root });

    expect(routes).toContainEqual(
      expect.objectContaining({
        route: "/multi-method",
        http_method: "GET",
        symbol: "MethodArrayController.submit"
      })
    );
    expect(routes).toContainEqual(
      expect.objectContaining({
        route: "/multi-method",
        http_method: "POST",
        symbol: "MethodArrayController.submit"
      })
    );
  });

  it("ignores mapping annotations in comments and strings", async () => {
    const root = await createJavaProject({
      "src/main/java/example/CommentedController.java": `
        package example;

        import org.springframework.web.bind.annotation.GetMapping;
        import org.springframework.web.bind.annotation.RestController;

        @RestController
        public class CommentedController {
            /**
             * Example: @GetMapping("/doc-only")
             */
            public String helper() {
                String text = "@GetMapping(\\"/string-only\\")";
                return text;
            }

            // @GetMapping("/line-comment")
            @GetMapping("/real")
            public String real() {
                return "ok";
            }
        }
      `
    });

    const routes = await buildRouteIndex({ project: "demo", root });
    const routePaths = routes.map((route) => route.route);

    expect(routePaths).toEqual(["/real"]);
    expect(routePaths).not.toContain("/doc-only");
    expect(routePaths).not.toContain("/string-only");
    expect(routePaths).not.toContain("/line-comment");
  });

  it("ignores controller files under build output directories", async () => {
    const root = await createJavaProject({
      "src/main/java/example/VisibleController.java": `
        package example;
        import org.springframework.web.bind.annotation.GetMapping;
        public class VisibleController {
            @GetMapping("/visible")
            public String visible() { return "ok"; }
        }
      `,
      "src/main/java/target/example/NestedTargetController.java": `
        package example;
        import org.springframework.web.bind.annotation.GetMapping;
        public class NestedTargetController {
            @GetMapping("/nested-target")
            public String nestedTarget() { return "ok"; }
        }
      `,
      "src/main/java/build/example/NestedBuildController.java": `
        package example;
        import org.springframework.web.bind.annotation.GetMapping;
        public class NestedBuildController {
            @GetMapping("/nested-build")
            public String nestedBuild() { return "ok"; }
        }
      `,
      "target/src/main/java/example/HiddenController.java": `
        package example;
        import org.springframework.web.bind.annotation.GetMapping;
        public class HiddenController {
            @GetMapping("/hidden")
            public String hidden() { return "ok"; }
        }
      `,
      "build/src/main/java/example/BuiltController.java": `
        package example;
        import org.springframework.web.bind.annotation.GetMapping;
        public class BuiltController {
            @GetMapping("/built")
            public String built() { return "ok"; }
        }
      `
    });

    const routes = await buildRouteIndex({ project: "demo", root });

    expect(routes.map((route) => route.route)).toEqual(["/visible"]);
  });
});

describe("readSnippet", () => {
  it("clips snippets at the first line", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-snippet-"));
    const file = join(root, "Sample.java");
    await writeFile(file, "line1\nline2\nline3\nline4", "utf8");

    await expect(readSnippet(file, 1, 2)).resolves.toBe("line1\nline2\nline3");
  });

  it("clips snippets at the last line when the requested line is too large", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-snippet-"));
    const file = join(root, "Sample.java");
    await writeFile(file, "line1\nline2\nline3\nline4", "utf8");

    await expect(readSnippet(file, 99, 1)).resolves.toBe("line3\nline4");
  });
});

async function createJavaProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-intel-route-"));

  for (const [relativeFile, content] of Object.entries(files)) {
    const file = join(root, relativeFile);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, trimFixture(content), "utf8");
  }

  return root;
}

function trimFixture(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {8}/, ""))
    .join("\n")
    .trimStart();
}
