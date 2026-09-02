import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildErrorIndex } from "../src/indexer/error-indexer.js";

describe("buildErrorIndex", () => {
  it("indexes fixture exceptions, error codes, and log statements", async () => {
    const root = join(process.cwd(), "fixtures/java-order-service");
    const entries = await buildErrorIndex({ project: "trade-service", root });

    expect(entries).toContainEqual(
      expect.objectContaining({
        token: "ClientAbortException",
        kind: "exception",
        file: "src/main/java/com/example/trade/service/ReportService.java"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        token: "ORDER_STATUS_INVALID",
        kind: "error_code",
        file: "src/main/java/com/example/trade/service/OrderDetailService.java"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "throw",
        token: "BusinessException",
        file: "src/main/java/com/example/trade/service/OrderDetailService.java"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "log_statement",
        file: "src/main/java/com/example/trade/service/ReportService.java"
      })
    );
  });

  it("indexes exception class declarations and catch clauses", async () => {
    const root = await createProject({
      "src/main/java/example/CustomException.java": `
        package example;

        public class PaymentTimeoutException extends RuntimeException {
        }
      `,
      "src/main/java/example/PaymentService.java": `
        package example;

        public class PaymentService {
            public void pay() {
                try {
                    throw new PaymentTimeoutException();
                } catch (PaymentTimeoutException ex) {
                    throw new IllegalStateException("PAYMENT_TIMEOUT", ex);
                }
            }
        }
      `
    });

    const entries = await buildErrorIndex({ project: "pay-service", root });

    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "exception",
        token: "PaymentTimeoutException",
        file: "src/main/java/example/CustomException.java"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "catch",
        token: "PaymentTimeoutException",
        file: "src/main/java/example/PaymentService.java"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "throw",
        token: "IllegalStateException",
        file: "src/main/java/example/PaymentService.java"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "error_code",
        token: "PAYMENT_TIMEOUT",
        file: "src/main/java/example/PaymentService.java"
      })
    );
  });

  it("ignores pseudo signals in comments, strings, and generated directories", async () => {
    const root = await createProject({
      "src/main/java/example/RealService.java": `
        package example;

        public class RealService {
            // throw new CommentedException("COMMENTED_CODE");
            private String message = "StringException IGNORED_CODE";

            public void run() {
                throw new RealBusinessException("REAL_ERROR_CODE");
            }
        }
      `,
      "target/generated-sources/example/GeneratedService.java": `
        package example;

        public class GeneratedService {
            public void run() {
                throw new GeneratedException("GENERATED_CODE");
            }
        }
      `
    });

    const entries = await buildErrorIndex({ project: "demo", root });
    const tokens = entries.map((entry) => entry.token);

    expect(tokens).toContain("RealBusinessException");
    expect(tokens).toContain("REAL_ERROR_CODE");
    expect(tokens).not.toContain("CommentedException");
    expect(tokens).not.toContain("COMMENTED_CODE");
    expect(tokens).not.toContain("StringException");
    expect(tokens).not.toContain("IGNORED_CODE");
    expect(tokens).not.toContain("GeneratedException");
    expect(tokens).not.toContain("GENERATED_CODE");
  });

  it("dedupes identical signals at the same location and returns snippets", async () => {
    const root = await createProject({
      "src/main/java/example/DedupeService.java": `
        package example;

        public class DedupeService {
            public void run() {
                throw new BusinessException("DUPLICATE_ERROR", "DUPLICATE_ERROR");
            }
        }
      `
    });

    const entries = await buildErrorIndex({ project: "demo", root });
    const duplicates = entries.filter(
      (entry) => entry.kind === "error_code" && entry.token === "DUPLICATE_ERROR"
    );

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.id).toContain(":DUPLICATE_ERROR");
    expect(duplicates[0]?.snippet).toContain("throw new BusinessException");
  });

  it("indexes error code declarations from enum constants and static final fields", async () => {
    const root = await createProject({
      "src/main/java/example/ErrorCode.java": `
        package example;

        public enum ErrorCode {
            ORDER_STATUS_INVALID("订单状态非法"),
            PAYMENT_TIMEOUT("支付超时");

            public static final String INVENTORY_LOCK_FAILED = "INVENTORY_LOCK_FAILED";
        }
      `
    });

    const entries = await buildErrorIndex({ project: "demo", root });

    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "error_code",
        token: "ORDER_STATUS_INVALID",
        file: "src/main/java/example/ErrorCode.java"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "error_code",
        token: "PAYMENT_TIMEOUT",
        file: "src/main/java/example/ErrorCode.java"
      })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "error_code",
        token: "INVENTORY_LOCK_FAILED",
        file: "src/main/java/example/ErrorCode.java"
      })
    );
  });

  it("indexes every exception type in Java multi-catch clauses", async () => {
    const root = await createProject({
      "src/main/java/example/MultiCatchService.java": `
        package example;

        public class MultiCatchService {
            public void run() {
                try {
                    remoteCall();
                } catch (RemoteTimeoutException | InventoryLockException ex) {
                    throw new BusinessException("REMOTE_CALL_FAILED", ex.getMessage());
                }
            }
        }
      `
    });

    const entries = await buildErrorIndex({ project: "demo", root });

    expect(entries).toContainEqual(expect.objectContaining({ kind: "catch", token: "RemoteTimeoutException" }));
    expect(entries).toContainEqual(expect.objectContaining({ kind: "catch", token: "InventoryLockException" }));
  });

  it("keeps correct line numbers and snippets for CRLF Java files", async () => {
    const root = await createProject({
      "src/main/java/example/CrlfService.java": [
        "package example;",
        "",
        "public class CrlfService {",
        "    public void run() {",
        "        throw new BusinessException(\"CRLF_ERROR_CODE\");",
        "    }",
        "",
        "    public void writeLog() {",
        "        log.error(\"gateway failed\", new RuntimeException(\"GatewayTimeoutException\"));",
        "    }",
        "}"
      ].join("\r\n")
    });

    const entries = await buildErrorIndex({ project: "demo", root });
    const throwEntry = entries.find((entry) => entry.kind === "throw" && entry.token === "BusinessException");
    const codeEntry = entries.find((entry) => entry.kind === "error_code" && entry.token === "CRLF_ERROR_CODE");
    const logEntry = entries.find((entry) => entry.kind === "log_statement");
    const exceptionEntry = entries.find((entry) => entry.kind === "exception" && entry.token === "GatewayTimeoutException");

    expect(throwEntry?.line).toBe(5);
    expect(codeEntry?.line).toBe(5);
    expect(logEntry?.line).toBe(9);
    expect(exceptionEntry?.line).toBe(9);
    expect(throwEntry?.snippet).toContain("throw new BusinessException");
    expect(logEntry?.snippet).toContain("log.error");
  });

  it("indexes error and warn logs but ignores lower-severity log levels", async () => {
    const root = await createProject({
      "src/main/java/example/LogLevelService.java": `
        package example;

        public class LogLevelService {
            public void run() {
                log.warn("warn failed", new RuntimeException("WarnException"));
                log.info("info only", new RuntimeException("InfoException"));
                logger.debug("debug only", new RuntimeException("DebugException"));
            }
        }
      `
    });

    const entries = await buildErrorIndex({ project: "demo", root });
    const tokens = entries.map((entry) => entry.token);

    expect(entries).toContainEqual(expect.objectContaining({ kind: "log_statement", token: expect.stringContaining("log.warn") }));
    expect(tokens).toContain("WarnException");
    expect(tokens).not.toContain("InfoException");
    expect(tokens).not.toContain("DebugException");
  });
});

async function createProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-intel-error-"));

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
