import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectStack } from "../src/stack-detector.js";

async function writeProjectFile(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

describe("detectStack", () => {
  it("detects java-spring-mybatis for the fixture project", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");

    await expect(detectStack(root)).resolves.toBe("java-spring-mybatis");
  });

  it("detects java-spring when only Spring annotations are present", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-stack-"));

    try {
      await writeProjectFile(root, "src/main/java/com/example/UserController.java", `
        package com.example;

        import org.springframework.web.bind.annotation.GetMapping;
        import org.springframework.web.bind.annotation.RestController;

        @RestController
        class UserController {
          @GetMapping("/users")
          String list() {
            return "ok";
          }
        }
      `);

      await expect(detectStack(root)).resolves.toBe("java-spring");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects java-dubbo-mybatis when Dubbo and MyBatis clues are present", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-stack-"));

    try {
      await writeProjectFile(root, "src/main/java/com/example/OrderApi.java", `
        package com.example;

        import org.apache.dubbo.config.annotation.DubboService;
        import org.apache.ibatis.annotations.Mapper;

        @DubboService
        class OrderApi {
        }

        @Mapper
        interface OrderMapper {
        }
      `);

      await expect(detectStack(root)).resolves.toBe("java-dubbo-mybatis");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns java-generic when Java files have no framework clues", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-stack-"));

    try {
      await writeProjectFile(root, "src/main/java/com/example/Plain.java", `
        package com.example;

        class Plain {
        }
      `);

      await expect(detectStack(root)).resolves.toBe("java-generic");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores Spring and MyBatis clues inside target directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-stack-"));

    try {
      await writeProjectFile(root, "src/main/java/com/example/Plain.java", `
        package com.example;

        class Plain {
        }
      `);
      await writeProjectFile(root, "target/generated-sources/com/example/GeneratedController.java", `
        @RestController
        class GeneratedController {
        }
      `);
      await writeProjectFile(root, "target/classes/mapper/GeneratedMapper.xml", `
        <mapper namespace="GeneratedMapper">
        </mapper>
      `);

      await expect(detectStack(root)).resolves.toBe("java-generic");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns java-generic when the root path does not exist", async () => {
    const root = join(tmpdir(), `code-intel-missing-${process.pid}-${Date.now()}`);

    await expect(detectStack(root)).resolves.toBe("java-generic");
  });
});
