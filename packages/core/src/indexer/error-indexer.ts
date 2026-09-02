import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import fg from "fast-glob";
import { readSnippet } from "../snippet.js";
import { buildIgnorePatterns, JAVA_SOURCE_PATTERNS } from "../source-roots.js";

const EXCEPTION_PATTERN = /\b([A-Z][A-Za-z0-9_]*Exception)\b/g;
const ERROR_CODE_PATTERN = /\b([A-Z][A-Z0-9_]{5,})\b/g;
const DECLARED_ERROR_CODE_PATTERN = /\b([A-Z][A-Z0-9_]{5,})\b(?=\s*(?:\(|=|,|;))/g;
const CLASS_EXCEPTION_PATTERN = /\b(?:class|interface|record)\s+([A-Z][A-Za-z0-9_]*Exception)\b/g;
const THROW_PATTERN = /\bthrow\s+new\s+([A-Z][A-Za-z0-9_]*Exception)\b/g;
const CATCH_HEADER_PATTERN = /\bcatch\s*\(\s*([^)]*)\)/g;
const LOG_PATTERN = /\b(?:log|logger)\s*\.\s*(error|warn)\s*\(/i;

export type ErrorIndexEntry = {
  id: string;
  project: string;
  file: string;
  line: number;
  token: string;
  kind: "exception" | "error_code" | "throw" | "catch" | "log_statement";
  snippet: string;
};

type PendingEntry = Omit<ErrorIndexEntry, "id" | "snippet">;

export async function buildErrorIndex(input: { project: string; root: string }): Promise<ErrorIndexEntry[]> {
  const files = await fg(JAVA_SOURCE_PATTERNS, {
    cwd: input.root,
    absolute: true,
    onlyFiles: true,
    ignore: buildIgnorePatterns()
  });
  const entries: ErrorIndexEntry[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    const relativeFile = toPosixPath(relative(input.root, file));
    const pending = collectFileEntries({
      project: input.project,
      file: relativeFile,
      text,
      lines
    });

    for (const entry of dedupePendingEntries(pending)) {
      entries.push({
        ...entry,
        id: `${entry.project}:error:${entry.file}:${entry.line}:${entry.kind}:${entry.token}`,
        snippet: await readSnippet(file, entry.line)
      });
    }
  }

  return dedupeEntries(entries);
}

function collectFileEntries(input: {
  project: string;
  file: string;
  text: string;
  lines: string[];
}): PendingEntry[] {
  const searchableText = maskCommentsAndNonTextBlockStrings(input.text);
  const entries: PendingEntry[] = [];

  entries.push(...collectPatternEntries(input, searchableText, CLASS_EXCEPTION_PATTERN, "exception"));
  entries.push(...collectDeclaredErrorCodes(input, searchableText));
  entries.push(...collectCatches(input, searchableText));
  entries.push(...collectThrows(input, searchableText));
  entries.push(...collectLogStatements(input, searchableText));

  return entries;
}

function collectDeclaredErrorCodes(
  input: { project: string; file: string; text: string; lines: string[] },
  searchableText: string
): PendingEntry[] {
  const entries: PendingEntry[] = [];
  let match: RegExpExecArray | null;

  DECLARED_ERROR_CODE_PATTERN.lastIndex = 0;
  while ((match = DECLARED_ERROR_CODE_PATTERN.exec(searchableText)) !== null) {
    entries.push({
      project: input.project,
      file: input.file,
      line: lineForOffset(searchableText, match.index),
      token: match[1],
      kind: "error_code"
    });
  }

  return entries;
}

function collectCatches(
  input: { project: string; file: string; text: string; lines: string[] },
  searchableText: string
): PendingEntry[] {
  const entries: PendingEntry[] = [];
  let match: RegExpExecArray | null;

  CATCH_HEADER_PATTERN.lastIndex = 0;
  while ((match = CATCH_HEADER_PATTERN.exec(searchableText)) !== null) {
    const line = lineForOffset(searchableText, match.index);

    for (const token of extractExceptions(match[1])) {
      entries.push({
        project: input.project,
        file: input.file,
        line,
        token,
        kind: "catch"
      });
    }
  }

  return entries;
}

function collectPatternEntries(
  input: { project: string; file: string; text: string; lines: string[] },
  searchableText: string,
  pattern: RegExp,
  kind: "exception" | "catch"
): PendingEntry[] {
  const entries: PendingEntry[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(searchableText)) !== null) {
    entries.push({
      project: input.project,
      file: input.file,
      line: lineForOffset(searchableText, match.index),
      token: match[1],
      kind
    });
  }

  return entries;
}

function collectThrows(
  input: { project: string; file: string; text: string; lines: string[] },
  searchableText: string
): PendingEntry[] {
  const entries: PendingEntry[] = [];
  let match: RegExpExecArray | null;

  while ((match = THROW_PATTERN.exec(searchableText)) !== null) {
    const statement = collectJavaStatement(input.text, match.index);
    const line = lineForOffset(input.text, match.index);

    entries.push({
      project: input.project,
      file: input.file,
      line,
      token: match[1],
      kind: "throw"
    });

    for (const token of extractErrorCodes(statement.text)) {
      entries.push({
        project: input.project,
        file: input.file,
        line: statement.startLine,
        token,
        kind: "error_code"
      });
    }
  }

  return entries;
}

function collectLogStatements(
  input: { project: string; file: string; text: string; lines: string[] },
  searchableText: string
): PendingEntry[] {
  const entries: PendingEntry[] = [];
  let offset = 0;

  while (offset < searchableText.length) {
    const match = LOG_PATTERN.exec(searchableText.slice(offset));
    if (!match) break;

    const startOffset = offset + match.index;
    const statement = collectJavaStatement(input.text, startOffset);
    const line = lineForOffset(input.text, startOffset);
    const compactStatement = statement.text.trim().replace(/\s+/g, " ");

    entries.push({
      project: input.project,
      file: input.file,
      line,
      token: compactStatement,
      kind: "log_statement"
    });

    for (const token of extractExceptions(statement.text)) {
      entries.push({
        project: input.project,
        file: input.file,
        line: statement.startLine,
        token,
        kind: "exception"
      });
    }

    for (const token of extractErrorCodes(statement.text)) {
      entries.push({
        project: input.project,
        file: input.file,
        line: statement.startLine,
        token,
        kind: "error_code"
      });
    }

    offset = Math.max(startOffset + statement.text.length, startOffset + 1);
  }

  return entries;
}

function collectJavaStatement(text: string, startOffset: number): { text: string; startLine: number } {
  let inString = false;
  let inChar = false;
  let inTextBlock = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let offset = startOffset; offset < text.length; offset += 1) {
    const char = text[offset];
    const next = text[offset + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        offset += 1;
      }
      continue;
    }

    if (inTextBlock) {
      if (text.startsWith("\"\"\"", offset)) {
        inTextBlock = false;
        offset += 2;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (inChar) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "'") {
        inChar = false;
      }
      continue;
    }

    if (text.startsWith("\"\"\"", offset)) {
      inTextBlock = true;
      offset += 2;
    } else if (char === "/" && next === "/") {
      inLineComment = true;
      offset += 1;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      offset += 1;
    } else if (char === "\"") {
      inString = true;
    } else if (char === "'") {
      inChar = true;
    } else if (char === ";") {
      return {
        text: text.slice(startOffset, offset + 1),
        startLine: lineForOffset(text, startOffset)
      };
    }
  }

  return {
    text: text.slice(startOffset),
    startLine: lineForOffset(text, startOffset)
  };
}

function extractExceptions(text: string): string[] {
  return uniqueMatches(text, EXCEPTION_PATTERN);
}

function extractErrorCodes(text: string): string[] {
  return uniqueMatches(text, ERROR_CODE_PATTERN);
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  const tokens = new Set<string>();
  let match: RegExpExecArray | null;

  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) {
    tokens.add(match[1]);
  }

  return [...tokens];
}

function maskCommentsAndNonTextBlockStrings(text: string): string {
  let result = "";
  let inLineComment = false;
  let inBlockComment = false;
  let inTextBlock = false;
  let inString = false;
  let inChar = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === "\r" || char === "\n") {
        inLineComment = false;
        result += char;
      } else {
        result += " ";
      }
      continue;
    }

    if (inTextBlock) {
      if (text.startsWith("\"\"\"", index)) {
        inTextBlock = false;
        result += "   ";
        index += 2;
      } else {
        result += maskNonNewline(char);
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        result += "  ";
        index += 1;
      } else {
        result += maskNonNewline(char);
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      result += maskNonNewline(char);
      continue;
    }

    if (inChar) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "'") {
        inChar = false;
      }
      result += maskNonNewline(char);
      continue;
    }

    if (text.startsWith("\"\"\"", index)) {
      inTextBlock = true;
      result += "   ";
      index += 2;
    } else if (char === "/" && next === "/") {
      inLineComment = true;
      result += "  ";
      index += 1;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      result += "  ";
      index += 1;
    } else if (char === "\"") {
      inString = true;
      result += " ";
    } else if (char === "'") {
      inChar = true;
      result += " ";
    } else {
      result += char;
    }
  }

  return result;
}

function maskNonNewline(char: string): string {
  return char === "\r" || char === "\n" ? char : " ";
}

function lineForOffset(text: string, offset: number): number {
  let line = 1;

  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") line += 1;
  }

  return line;
}

function dedupeEntries(entries: ErrorIndexEntry[]): ErrorIndexEntry[] {
  const seen = new Set<string>();
  const deduped: ErrorIndexEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.project}\0${entry.file}\0${entry.line}\0${entry.kind}\0${entry.token}`;
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

function dedupePendingEntries(entries: PendingEntry[]): PendingEntry[] {
  const seen = new Set<string>();
  const deduped: PendingEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.project}\0${entry.file}\0${entry.line}\0${entry.kind}\0${entry.token}`;
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}
