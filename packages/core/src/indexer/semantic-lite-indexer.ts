import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import fg from "fast-glob";
import { buildIgnorePatterns, JAVA_SOURCE_PATTERNS, RESOURCE_SOURCE_PATTERNS } from "../source-roots.js";

const COMPACT_TEXT_LIMIT = 4000;

export type SemanticLiteEntry = {
  id: string;
  project: string;
  file: string;
  text: string;
  tokens: string[];
};

type ScoredEntry = {
  entry: SemanticLiteEntry;
  score: number;
};

export async function buildSemanticLiteIndex(input: { project: string; root: string }): Promise<SemanticLiteEntry[]> {
  const files = await fg([...JAVA_SOURCE_PATTERNS, ...RESOURCE_SOURCE_PATTERNS], {
    cwd: input.root,
    absolute: true,
    onlyFiles: true,
    ignore: buildIgnorePatterns()
  });

  const entries: SemanticLiteEntry[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const relativeFile = toPosixPath(relative(input.root, file));
    const compactText = compactSemanticText(text);

    entries.push({
      id: `${input.project}:semantic:${relativeFile}`,
      project: input.project,
      file: relativeFile,
      text: compactText,
      tokens: tokenizeSemanticText(`${relativeFile} ${compactText}`)
    });
  }

  return entries;
}

export function searchSemanticLite(
  index: SemanticLiteEntry[],
  query: string,
  limit: number
): SemanticLiteEntry[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];

  const queryTokens = tokenizeSemanticText(query);
  if (queryTokens.length === 0) return [];

  return index
    .map<ScoredEntry>((entry) => ({
      entry,
      score: scoreEntry(entry.tokens, queryTokens)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.file.localeCompare(right.entry.file))
    .slice(0, safeLimit)
    .map((item) => item.entry);
}

export function tokenizeSemanticText(text: string): string[] {
  const tokens = new Set<string>();
  const chunks = text.match(/[A-Za-z][A-Za-z0-9_]*|\d+|[\u4e00-\u9fff]+/g) ?? [];

  for (const chunk of chunks) {
    if (/^[\u4e00-\u9fff]+$/.test(chunk)) {
      addChineseTokens(tokens, chunk);
    } else {
      addAsciiTokens(tokens, chunk);
    }
  }

  return [...tokens];
}

function scoreEntry(entryTokens: string[], queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;

  let score = 0;
  for (const queryToken of queryTokens) {
    const exactMatch = entryTokens.includes(queryToken);
    const fuzzyMatch = exactMatch
      ? false
      : entryTokens.some(
          (entryToken) =>
            entryToken.length >= 3 &&
            queryToken.length >= 3 &&
            (entryToken.includes(queryToken) || queryToken.includes(entryToken))
        );

    if (exactMatch) {
      score += 2;
    } else if (fuzzyMatch) {
      score += 1;
    }
  }

  return score / queryTokens.length;
}

function compactSemanticText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(isSemanticLine);

  return lines.join(" ").slice(0, COMPACT_TEXT_LIMIT);
}

function isSemanticLine(line: string): boolean {
  return (
    /[\u4e00-\u9fff]/.test(line) ||
    /\b(?:class|interface|record|enum|public|private|protected|return|throw|catch)\b/.test(line) ||
    /@\w+/.test(line) ||
    /<(?:mapper|select|insert|update|delete)\b/i.test(line) ||
    /\b(?:select|from|join|where|update|insert|delete)\b/i.test(line) ||
    /^[\w.-]+\s*:/.test(line) ||
    /\b[A-Z][A-Za-z0-9_]*(?:Service|Controller|Mapper|Exception|Enum)\b/.test(line) ||
    /\b[A-Z][A-Z0-9_]{5,}\b/.test(line)
  );
}

function addChineseTokens(tokens: Set<string>, text: string): void {
  if (text.length >= 2) tokens.add(text);

  for (let index = 0; index < text.length - 1; index += 1) {
    tokens.add(text.slice(index, index + 2));
  }
}

function addAsciiTokens(tokens: Set<string>, text: string): void {
  for (const part of text.split(/_+/)) {
    if (!part) continue;

    const words = splitCamelCase(part);
    for (const word of words) {
      const normalized = word.toLowerCase();
      if (normalized.length > 0) tokens.add(normalized);
    }

    const normalizedPart = part.toLowerCase();
    if (normalizedPart.length > 0) tokens.add(normalizedPart);
  }
}

function splitCamelCase(text: string): string[] {
  return text.match(/[A-Z]+(?=[A-Z][a-z0-9]|$)|[A-Z]?[a-z]+|[0-9]+/g) ?? [text];
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}
