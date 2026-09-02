// `**/` 前缀能匹配任意层级（含 0 层），使单模块、多模块、任意嵌套的
// Maven/Gradle 项目都能被扫到；若改回 `src/main/` 会让多模块项目索引失效。
export const IGNORED_DIRECTORIES = [
  ".git",
  ".gradle",
  "build",
  "dist",
  "node_modules",
  "out",
  "target"
];

export function buildIgnorePatterns(): string[] {
  return IGNORED_DIRECTORIES.map((directory) => `**/${directory}/**`);
}

export const JAVA_SOURCE_PATTERNS = ["**/src/main/java/**/*.java"];

export const RESOURCE_SOURCE_PATTERNS = [
  "**/src/main/resources/**/*.xml",
  "**/src/main/resources/**/*.yml",
  "**/src/main/resources/**/*.yaml"
];

export const SOURCE_EXTENSIONS = new Set([".java", ".xml", ".yml", ".yaml"]);
