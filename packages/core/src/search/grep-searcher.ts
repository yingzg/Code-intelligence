import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { CodeLocation } from "../schemas.js";

const execFileAsync = promisify(execFile);

const SEARCH_EXTENSIONS = ["java", "xml", "yml", "yaml", "properties", "sql"];
const IGNORED_DIRECTORIES = [".git", ".gradle", "build", "dist", "logs", "node_modules", "out", "target"];
const MAX_GREP_OUTPUT_BYTES = 20 * 1024 * 1024;

type GrepHit = {
  file: string;
  line: number;
};

export async function grepSearch(input: {
  project: string;
  root: string;
  query: string;
  limit: number;
}): Promise<CodeLocation[]> {
  const safeLimit = Math.max(0, Math.floor(input.limit));
  if (safeLimit === 0 || input.query.trim().length === 0) return [];

  const hits = await runGitGrep(input.root, input.query);
  const results: CodeLocation[] = [];
  const lineCache = new Map<string, string[] | undefined>();

  for (const hit of hits) {
    if (results.length >= safeLimit) break;

    const lines = await readCachedLines(input.root, hit.file, lineCache);
    if (lines === undefined) continue;

    results.push({
      id: `${input.project}:grep:${hit.file}:${hit.line}`,
      project: input.project,
      file: hit.file,
      start_line: hit.line,
      end_line: hit.line,
      language: languageFromFile(hit.file),
      location_type: "unknown",
      snippet: lines.slice(Math.max(0, hit.line - 3), hit.line + 2).join("\n"),
      match_reason: "grep 兜底命中原始查询文本。",
      score: 0.4,
      confidence: "low",
      source: "grep"
    });
  }

  return results;
}

async function runGitGrep(root: string, query: string): Promise<GrepHit[]> {
  const args = [
    "grep",
    "-n",
    "-I",
    "-F",
    "-e",
    query,
    "--",
    ...SEARCH_EXTENSIONS.map((extension) => `*.${extension}`)
  ];

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      maxBuffer: MAX_GREP_OUTPUT_BYTES
    });
    return parseGrepOutput(stdout);
  } catch (error) {
    const execError = error as { stdout?: string; code?: number };
    if (execError.stdout) return parseGrepOutput(execError.stdout);
    if (execError.code === 1) return [];
    return runSystemGrep(root, query);
  }
}

async function runSystemGrep(root: string, query: string): Promise<GrepHit[]> {
  const args = ["-r", "-n", "-I", "-F", "-e", query];
  for (const extension of SEARCH_EXTENSIONS) args.push(`--include=*.${extension}`);
  for (const directory of IGNORED_DIRECTORIES) args.push(`--exclude-dir=${directory}`);
  args.push(root);

  try {
    const { stdout } = await execFileAsync("grep", args, {
      maxBuffer: MAX_GREP_OUTPUT_BYTES
    });
    return parseGrepOutput(stdout).map((hit) => ({
      ...hit,
      file: toPosixPath(relative(root, hit.file))
    }));
  } catch (error) {
    const execError = error as { stdout?: string };
    if (execError.stdout) {
      return parseGrepOutput(execError.stdout).map((hit) => ({
        ...hit,
        file: toPosixPath(relative(root, hit.file))
      }));
    }
    return [];
  }
}

function parseGrepOutput(stdout: string): GrepHit[] {
  const hits: GrepHit[] = [];

  for (const rawLine of stdout.split("\n")) {
    if (rawLine.length === 0) continue;

    const firstColon = rawLine.indexOf(":");
    if (firstColon < 0) continue;
    const rest = rawLine.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    if (secondColon < 0) continue;

    const line = Number.parseInt(rest.slice(0, secondColon), 10);
    if (!Number.isFinite(line)) continue;

    hits.push({
      file: rawLine.slice(0, firstColon),
      line
    });
  }

  return hits;
}

async function readCachedLines(
  root: string,
  file: string,
  cache: Map<string, string[] | undefined>
): Promise<string[] | undefined> {
  if (cache.has(file)) return cache.get(file);

  let lines: string[] | undefined;
  try {
    const text = await readFile(join(root, file), "utf8");
    lines = text.split(/\r?\n/);
  } catch {
    lines = undefined;
  }

  cache.set(file, lines);
  return lines;
}

function languageFromFile(file: string): CodeLocation["language"] {
  if (file.endsWith(".java")) return "java";
  if (file.endsWith(".xml")) return "xml";
  if (file.endsWith(".yml") || file.endsWith(".yaml")) return "yaml";
  if (file.endsWith(".properties")) return "properties";
  if (file.endsWith(".sql")) return "sql";
  return "unknown";
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}
