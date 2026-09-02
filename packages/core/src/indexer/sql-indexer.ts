import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import fg from "fast-glob";
import { buildIgnorePatterns, JAVA_SOURCE_PATTERNS } from "../source-roots.js";

const SQL_ANNOTATIONS = ["Select", "Update", "Insert", "Delete"];
const SQL_ANNOTATION_PATTERN = new RegExp(`@(${SQL_ANNOTATIONS.join("|")})\\b`);
const SQL_EXCERPT_LIMIT = 500;

export type SqlIndexEntry = {
  id: string;
  project: string;
  file: string;
  line: number;
  namespace?: string;
  mapper_id?: string;
  table: string;
  sql_excerpt: string;
};

type SqlBlock = {
  mapper_id?: string;
  sql: string;
  startLine: number;
};

type TableMatch = {
  table: string;
  offset: number;
};

type CommentState = {
  inBlockComment: boolean;
  inTextBlock: boolean;
};

type JavaAnnotationValue = {
  text: string;
  startLineOffset: number;
};

export async function buildSqlIndex(input: { project: string; root: string }): Promise<SqlIndexEntry[]> {
  const files = await fg(["**/src/main/resources/**/*.xml", ...JAVA_SOURCE_PATTERNS], {
    cwd: input.root,
    absolute: true,
    onlyFiles: true,
    ignore: buildIgnorePatterns()
  });
  const entries: SqlIndexEntry[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const relativeFile = toPosixPath(relative(input.root, file));
    const isXml = file.endsWith(".xml");
    const namespace = isXml ? extractXmlNamespace(text) : extractJavaNamespace(text);
    const blocks = isXml ? extractXmlSqlBlocks(text) : extractJavaAnnotationSqlBlocks(text);

    for (const block of blocks) {
      const excerpt = compactSql(block.sql);
      const tables = extractTables(block.sql);

      for (const tableMatch of tables) {
        const line = block.startLine + lineForOffset(block.sql, tableMatch.offset) - 1;
        entries.push({
          id: `${input.project}:sql:${relativeFile}:${line}:${block.mapper_id ?? "unknown"}:${tableMatch.table}`,
          project: input.project,
          file: relativeFile,
          line,
          namespace,
          mapper_id: block.mapper_id,
          table: tableMatch.table,
          sql_excerpt: excerpt
        });
      }
    }
  }

  return dedupeEntries(entries);
}

function extractXmlNamespace(text: string): string | undefined {
  return getXmlAttribute(text.match(/<mapper\b[^>]*>/i)?.[0] ?? "", "namespace");
}

function extractXmlSqlBlocks(text: string): SqlBlock[] {
  const blocks: SqlBlock[] = [];
  const regex = /<(select|insert|update|delete)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      mapper_id: getXmlAttribute(match[2], "id"),
      sql: normalizeXmlSql(match[3]),
      startLine: lineForOffset(text, match.index + match[0].indexOf(match[3]))
    });
  }

  return blocks;
}

function extractJavaNamespace(text: string): string | undefined {
  const packageName = text.match(/\bpackage\s+([\w.]+)\s*;/)?.[1];
  const typeName = text.match(/\b(?:interface|class)\s+([A-Za-z_][\w]*)\b/)?.[1];
  if (!typeName) return undefined;

  return packageName ? `${packageName}.${typeName}` : typeName;
}

function extractJavaAnnotationSqlBlocks(text: string): SqlBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: SqlBlock[] = [];
  const commentState: CommentState = { inBlockComment: false, inTextBlock: false };

  for (let index = 0; index < lines.length; index += 1) {
    const searchableLine = maskCommentsAndStrings(lines[index], commentState);
    const match = searchableLine.match(SQL_ANNOTATION_PATTERN);
    if (!match) continue;

    const block = collectAnnotationBlock(lines, index, match.index ?? 0);
    const sql = extractJavaSqlLiteral(block.text);
    const mapper_id = findNextJavaMethodName(lines, block.endLine);
    if (sql !== undefined) {
      blocks.push({
        mapper_id,
        sql: sql.text,
        startLine: index + 1 + sql.startLineOffset
      });
    }

    index = block.endLine - 1;
  }

  return blocks;
}

function collectAnnotationBlock(
  lines: string[],
  startIndex: number,
  annotationColumn: number
): { text: string; endLine: number } {
  const collected: string[] = [];
  let depth = 0;
  let sawOpenParen = false;
  let inString = false;
  let inChar = false;
  let inTextBlock = false;
  let escaped = false;
  let inBlockComment = false;

  for (let index = startIndex; index < lines.length; index += 1) {
    const fragment = index === startIndex ? lines[index].slice(annotationColumn) : lines[index];
    collected.push(fragment);

    for (let column = 0; column < fragment.length; column += 1) {
      const char = fragment[column];
      const next = fragment[column + 1];

      if (inTextBlock) {
        if (fragment.startsWith("\"\"\"", column)) {
          inTextBlock = false;
          column += 2;
        }
        continue;
      }

      if (inBlockComment) {
        if (char === "*" && next === "/") {
          inBlockComment = false;
          column += 1;
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

      if (fragment.startsWith("\"\"\"", column)) {
        inTextBlock = true;
        column += 2;
        continue;
      }

      if (char === "/" && next === "/") break;

      if (char === "/" && next === "*") {
        inBlockComment = true;
        column += 1;
      } else if (char === "\"") {
        inString = true;
      } else if (char === "'") {
        inChar = true;
      } else if (char === "(") {
        depth += 1;
        sawOpenParen = true;
      } else if (char === ")") {
        depth -= 1;
      }
    }

    if (!sawOpenParen || depth <= 0) {
      return {
        text: collected.join("\n"),
        endLine: index + 1
      };
    }
  }

  return {
    text: collected.join("\n"),
    endLine: lines.length
  };
}

function extractJavaSqlLiteral(annotationText: string): JavaAnnotationValue | undefined {
  const argumentsText = annotationText.match(/\(([\s\S]*)\)/)?.[1] ?? "";
  const valueArgument = readJavaAnnotationValue(argumentsText);
  if (valueArgument === undefined) return undefined;

  const sql = materializeJavaStringLiterals(valueArgument.text);
  return sql === undefined
    ? undefined
    : {
        text: sql,
        startLineOffset: lineForOffset(argumentsText, valueArgument.offset) - 1
      };
}

function readJavaAnnotationValue(argumentsText: string): { text: string; offset: number } | undefined {
  const namedValue = readNamedArgumentValue(argumentsText, "value");
  if (namedValue !== undefined) return namedValue;
  if (hasTopLevelNamedArgument(argumentsText)) return undefined;

  const offset = firstNonWhitespaceOffset(argumentsText);
  return {
    text: argumentsText.slice(offset).trimEnd(),
    offset
  };
}

function findNextJavaMethodName(lines: string[], afterLine: number): string | undefined {
  for (let index = afterLine; index < Math.min(lines.length, afterLine + 8); index += 1) {
    const methodName = extractMethodName(lines.slice(index, index + 6).join(" "));
    if (methodName) return methodName;
  }

  return undefined;
}

function extractMethodName(signatureText: string): string | undefined {
  const normalized = signatureText
    .replace(/@\w+(?:\([^)]*\))?/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(
    /^(?!(?:if|for|while|switch|catch|return|new)\b)(?:(?:public|protected|private|static|final|default|synchronized|abstract|native|strictfp)\s+)*(?:<[^>]+>\s+)?[\w.$<>\[\],?&\s]+?\s+([A-Za-z_][\w]*)\s*\([^;{}]*\)\s*(?:throws\s+[\w.,\s]+)?(?:;|\{|$)/
  );

  return match?.[1];
}

function normalizeXmlSql(sql: string): string {
  return sql.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, (tag) => tag.replace(/[^\n]/g, " "));
}

function extractTables(sql: string): TableMatch[] {
  const normalized = maskSqlCommentsAndStrings(sql);
  const seen = new Set<string>();
  const tables: TableMatch[] = [];
  const identifier = "(?:`[^`]+`|\"[^\"]+\"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)";
  const regex = new RegExp(`\\b(?:from|join|update|into)\\s+(${identifier}(?:\\.${identifier})*)`, "gi");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(normalized)) !== null) {
    const table = normalizeTableName(match[1]);
    if (seen.has(table)) continue;
    seen.add(table);
    tables.push({
      table,
      offset: match.index + match[0].lastIndexOf(match[1])
    });
  }

  return tables;
}

function maskSqlCommentsAndStrings(sql: string): string {
  let masked = "";
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inBracketIdentifier = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        masked += char;
      } else {
        masked += " ";
      }
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        masked += "  ";
        index += 2;
        inBlockComment = false;
      } else {
        masked += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (inSingleQuote) {
      if (char === "'" && next === "'") {
        masked += "  ";
        index += 2;
        continue;
      }
      inSingleQuote = char !== "'";
      masked += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    if (inDoubleQuote) {
      masked += char;
      if (char === "\"") inDoubleQuote = false;
      index += 1;
      continue;
    }

    if (inBacktick) {
      masked += char;
      if (char === "`") inBacktick = false;
      index += 1;
      continue;
    }

    if (inBracketIdentifier) {
      masked += char;
      if (char === "]") inBracketIdentifier = false;
      index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      masked += "  ";
      index += 2;
      inLineComment = true;
    } else if (char === "/" && next === "*") {
      masked += "  ";
      index += 2;
      inBlockComment = true;
    } else if (char === "'") {
      masked += " ";
      index += 1;
      inSingleQuote = true;
    } else if (char === "\"") {
      masked += char;
      index += 1;
      inDoubleQuote = true;
    } else if (char === "`") {
      masked += char;
      index += 1;
      inBacktick = true;
    } else if (char === "[") {
      masked += char;
      index += 1;
      inBracketIdentifier = true;
    } else {
      masked += char;
      index += 1;
    }
  }

  return masked;
}

function normalizeTableName(table: string): string {
  return table
    .split(".")
    .map((part) => part.replace(/^`|`$/g, "").replace(/^"|"$/g, "").replace(/^\[|\]$/g, ""))
    .join(".");
}

function compactSql(sql: string): string {
  const compacted = sql.replace(/\s+/g, " ").trim();
  return compacted.length > SQL_EXCERPT_LIMIT ? `${compacted.slice(0, SQL_EXCERPT_LIMIT - 3)}...` : compacted;
}

function lineForOffset(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function dedupeEntries(entries: SqlIndexEntry[]): SqlIndexEntry[] {
  const seen = new Set<string>();
  const result: SqlIndexEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.id}:${entry.sql_excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }

  return result;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function unescapeJavaString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function getXmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*([\"'])(.*?)\\1`));
  return match?.[2];
}

function readNamedArgumentValue(argumentsText: string, name: string): { text: string; offset: number } | undefined {
  const assignment = findTopLevelNamedArgument(argumentsText, name);
  if (assignment === undefined) return undefined;

  let index = assignment.valueOffset;
  let text: string;

  if (argumentsText[index] === "{") {
    text = readBalancedValue(argumentsText, index, "{", "}");
  } else if (argumentsText.startsWith("\"\"\"", index)) {
    text = readTextBlockValue(argumentsText, index);
  } else if (argumentsText[index] === "\"") {
    text = readQuotedValue(argumentsText, index);
  } else {
    text = readUntilTopLevelComma(argumentsText, index);
  }

  return {
    text,
    offset: index
  };
}

function hasTopLevelNamedArgument(argumentsText: string): boolean {
  return findTopLevelNamedArgument(argumentsText) !== undefined;
}

function findTopLevelNamedArgument(
  argumentsText: string,
  expectedName?: string
): { name: string; valueOffset: number } | undefined {
  let index = 0;

  while (index < argumentsText.length) {
    index = skipWhitespaceAndComments(argumentsText, index);
    const char = argumentsText[index];

    if (char === "{") {
      index = skipBalancedValue(argumentsText, index, "{", "}");
      continue;
    }

    if (argumentsText.startsWith("\"\"\"", index)) {
      index = skipTextBlockValue(argumentsText, index);
      continue;
    }

    if (char === "\"") {
      index = skipQuotedValue(argumentsText, index);
      continue;
    }

    if (char === "'") {
      index = skipCharValue(argumentsText, index);
      continue;
    }

    const nameMatch = argumentsText.slice(index).match(/^([A-Za-z_][\w]*)\b/);
    if (!nameMatch) {
      index += 1;
      continue;
    }

    const name = nameMatch[1];
    let valueOffset = skipWhitespaceAndComments(argumentsText, index + name.length);
    if (argumentsText[valueOffset] !== "=") {
      index += name.length;
      continue;
    }

    valueOffset = skipWhitespaceAndComments(argumentsText, valueOffset + 1);
    if (expectedName === undefined || name === expectedName) {
      return { name, valueOffset };
    }

    index = skipArgumentValue(argumentsText, valueOffset);
  }

  return undefined;
}

function skipWhitespaceAndComments(text: string, startIndex: number): number {
  let index = startIndex;

  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index += 1;
    } else if (text[index] === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index + 2);
      index = newline >= 0 ? newline + 1 : text.length;
    } else if (text[index] === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end >= 0 ? end + 2 : text.length;
    } else {
      break;
    }
  }

  return index;
}

function skipArgumentValue(text: string, startIndex: number): number {
  if (text[startIndex] === "{") return skipBalancedValue(text, startIndex, "{", "}");
  if (text.startsWith("\"\"\"", startIndex)) return skipTextBlockValue(text, startIndex);
  if (text[startIndex] === "\"") return skipQuotedValue(text, startIndex);
  if (text[startIndex] === "'") return skipCharValue(text, startIndex);

  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] === ",") return index + 1;
  }

  return text.length;
}

function skipBalancedValue(text: string, startIndex: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let inChar = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

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

    if (text.startsWith("\"\"\"", index)) {
      index = skipTextBlockValue(text, index) - 1;
    } else if (char === "\"") {
      inString = true;
    } else if (char === "'") {
      inChar = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return text.length;
}

function skipQuotedValue(text: string, startIndex: number): number {
  return readQuotedValue(text, startIndex).length + startIndex;
}

function skipTextBlockValue(text: string, startIndex: number): number {
  return readTextBlockValue(text, startIndex).length + startIndex;
}

function skipCharValue(text: string, startIndex: number): number {
  let escaped = false;

  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "'") {
      return index + 1;
    }
  }

  return text.length;
}

function readBalancedValue(text: string, startIndex: number, open: string, close: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

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

    if (char === "\"") {
      inString = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }

  return text.slice(startIndex);
}

function readQuotedValue(text: string, startIndex: number): string {
  let escaped = false;

  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      return text.slice(startIndex, index + 1);
    }
  }

  return text.slice(startIndex);
}

function readTextBlockValue(text: string, startIndex: number): string {
  const endIndex = text.indexOf("\"\"\"", startIndex + 3);
  return endIndex >= 0 ? text.slice(startIndex, endIndex + 3) : text.slice(startIndex);
}

function readUntilTopLevelComma(text: string, startIndex: number): string {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] === ",") return text.slice(startIndex, index);
  }

  return text.slice(startIndex);
}

function firstNonWhitespaceOffset(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (!/\s/.test(text[index])) return index;
  }

  return 0;
}

function materializeJavaStringLiterals(text: string): string | undefined {
  let output = "";
  let index = 0;
  let found = false;

  while (index < text.length) {
    if (text.startsWith("\"\"\"", index)) {
      const endIndex = text.indexOf("\"\"\"", index + 3);
      const raw = endIndex >= 0 ? text.slice(index + 3, endIndex) : text.slice(index + 3);
      output += raw;
      found = true;
      index = endIndex >= 0 ? endIndex + 3 : text.length;
      continue;
    }

    if (text[index] === "\"") {
      const literal = readJavaStringLiteralContent(text, index);
      output += literal.value;
      found = true;
      index = literal.endIndex + 1;
      continue;
    }

    output += text[index] === "\n" ? "\n" : " ";
    index += 1;
  }

  return found ? output : undefined;
}

function readJavaStringLiteralContent(text: string, startIndex: number): { value: string; endIndex: number } {
  let value = "";
  let escaped = false;

  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      value += unescapeJavaString(`\\${char}`);
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      return { value, endIndex: index };
    } else {
      value += char;
    }
  }

  return { value, endIndex: text.length };
}

function maskCommentsAndStrings(line: string, state: CommentState): string {
  let masked = "";
  let index = 0;
  let inString = false;
  let inChar = false;
  let escaped = false;

  while (index < line.length) {
    const char = line[index];
    const next = line[index + 1];

    if (state.inTextBlock) {
      if (line.startsWith("\"\"\"", index)) {
        masked += "   ";
        index += 3;
        state.inTextBlock = false;
      } else {
        masked += " ";
        index += 1;
      }
      continue;
    }

    if (state.inBlockComment) {
      if (char === "*" && next === "/") {
        masked += "  ";
        index += 2;
        state.inBlockComment = false;
      } else {
        masked += " ";
        index += 1;
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
      masked += " ";
      index += 1;
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
      masked += " ";
      index += 1;
      continue;
    }

    if (line.startsWith("\"\"\"", index)) {
      masked += "   ";
      index += 3;
      state.inTextBlock = true;
      continue;
    }

    if (char === "/" && next === "/") {
      masked += " ".repeat(line.length - index);
      break;
    }

    if (char === "/" && next === "*") {
      masked += "  ";
      index += 2;
      state.inBlockComment = true;
      continue;
    }

    if (char === "\"") {
      masked += " ";
      index += 1;
      inString = true;
      continue;
    }

    if (char === "'") {
      masked += " ";
      index += 1;
      inChar = true;
      continue;
    }

    masked += char;
    index += 1;
  }

  return masked;
}
