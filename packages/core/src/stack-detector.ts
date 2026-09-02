import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
import type { Stack } from "./schemas.js";
import { buildIgnorePatterns, JAVA_SOURCE_PATTERNS, RESOURCE_SOURCE_PATTERNS } from "./source-roots.js";

const SPRING_CLUES = [
  "@RestController",
  "@Controller",
  "@RequestMapping",
  "@GetMapping",
  "@PostMapping",
  "spring-boot-starter-web"
];

const MYBATIS_CLUES = [
  "@Mapper",
  "<mapper",
  "mybatis",
  "mybatis-spring-boot-starter"
];

const DUBBO_CLUES = [
  "org.apache.dubbo",
  "@DubboService",
  "@DubboReference",
  "<dubbo:"
];

const SAMPLE_LIMIT = 200;

type StackClues = {
  hasJava: boolean;
  hasSpring: boolean;
  hasMyBatis: boolean;
  hasDubbo: boolean;
};

export async function detectStack(root: string): Promise<Stack> {
  const rootExists = await isDirectory(root);
  if (!rootExists) return "java-generic";

  const clues: StackClues = {
    hasJava: false,
    hasSpring: false,
    hasMyBatis: false,
    hasDubbo: false
  };

  await inspectRootBuildFile(root, "pom.xml", clues);
  await inspectRootBuildFile(root, "build.gradle", clues);

  const javaFiles = await fg(JAVA_SOURCE_PATTERNS, {
    cwd: root,
    onlyFiles: true,
    ignore: buildIgnorePatterns()
  });
  const resourceFiles = await fg(RESOURCE_SOURCE_PATTERNS, {
    cwd: root,
    onlyFiles: true,
    ignore: buildIgnorePatterns()
  });

  if (javaFiles.length > 0) clues.hasJava = true;

  const samples = [
    ...sampleEvenly(javaFiles, SAMPLE_LIMIT),
    ...sampleEvenly(resourceFiles, SAMPLE_LIMIT)
  ];
  for (const file of samples) {
    await inspectFile(join(root, file), clues);
    if (clues.hasSpring && clues.hasMyBatis && clues.hasDubbo) break;
  }

  if (!clues.hasJava) return "java-generic";
  if (clues.hasDubbo && clues.hasMyBatis) return "java-dubbo-mybatis";
  if (clues.hasSpring && clues.hasMyBatis) return "java-spring-mybatis";
  if (clues.hasSpring) return "java-spring";

  return "java-generic";
}

function sampleEvenly<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount) return items;

  const result: T[] = [];
  for (let index = 0; index < maxCount; index += 1) {
    result.push(items[Math.floor((index * items.length) / maxCount)]);
  }

  return result;
}

async function inspectRootBuildFile(root: string, filename: string, clues: StackClues): Promise<void> {
  const filePath = join(root, filename);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    return;
  }

  clues.hasJava = true;
  await inspectFile(filePath, clues);
}

async function inspectFile(filePath: string, clues: StackClues): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return;
  }

  clues.hasSpring ||= containsAny(content, SPRING_CLUES);
  clues.hasMyBatis ||= containsAny(content, MYBATIS_CLUES);
  clues.hasDubbo ||= containsAny(content, DUBBO_CLUES);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function containsAny(content: string, clues: string[]): boolean {
  return clues.some((clue) => content.includes(clue));
}
