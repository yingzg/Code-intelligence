import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import fg from "fast-glob";
import { readSnippet } from "../snippet.js";
import { buildIgnorePatterns, JAVA_SOURCE_PATTERNS } from "../source-roots.js";

const MAPPING_METHODS: Record<string, string | undefined> = {
  RequestMapping: undefined,
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH"
};
const MAPPING_NAMES = Object.keys(MAPPING_METHODS);
const MAPPING_PATTERN = new RegExp(`@(${MAPPING_NAMES.join("|")})\\b`);

type MappingAnnotation = {
  annotation: string;
  startLine: number;
  endLine: number;
  paths: string[];
  http_methods: Array<string | undefined>;
};

type JavaTypeDeclaration = {
  name: string;
  line: number;
};

type JavaMethodDeclaration = {
  name: string;
  line: number;
};

type CommentState = {
  inBlockComment: boolean;
};

export type RouteIndexEntry = {
  id: string;
  project: string;
  file: string;
  line: number;
  route: string;
  http_method?: string;
  symbol: string;
  location_type: "controller" | "route" | "dubbo_interface" | "dubbo_provider";
  snippet: string;
};

export async function buildRouteIndex(input: { project: string; root: string }): Promise<RouteIndexEntry[]> {
  const files = await fg(JAVA_SOURCE_PATTERNS, {
    cwd: input.root,
    absolute: true,
    onlyFiles: true,
    ignore: buildIgnorePatterns()
  });
  const entries: RouteIndexEntry[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (!hasMappingAnnotation(text)) continue;

    const lines = text.split(/\r?\n/);
    const annotations = extractMappingAnnotations(lines);
    const typeDeclaration = findTypeDeclaration(lines);
    const classMapping = findClassMapping(annotations, typeDeclaration);
    const methodDeclarations = findMethodDeclarations(lines);
    const relativeFile = toPosixPath(relative(input.root, file));

    for (const mapping of annotations) {
      if (classMapping !== undefined && mapping.startLine === classMapping.startLine) continue;

      const method = findAnnotatedMethod(mapping, methodDeclarations, annotations);
      if (!method) continue;

      const classPaths = classMapping?.paths.length ? classMapping.paths : [""];
      const methodPaths = mapping.paths.length ? mapping.paths : [""];

      for (const classPath of classPaths) {
        for (const methodPath of methodPaths) {
          const route = normalizeRoute(classPath, methodPath);

          for (const httpMethod of mapping.http_methods) {
            const idMethod = httpMethod ?? "ANY";

            entries.push({
              id: `${input.project}:route:${relativeFile}:${mapping.startLine}:${method.name}:${idMethod}:${route}`,
              project: input.project,
              file: relativeFile,
              line: mapping.startLine,
              route,
              http_method: httpMethod,
              symbol: `${typeDeclaration?.name ?? "UnknownClass"}.${method.name}`,
              location_type: "controller",
              snippet: await readSnippet(file, mapping.startLine)
            });
          }
        }
      }
    }
  }

  return entries;
}

function hasMappingAnnotation(text: string): boolean {
  return MAPPING_PATTERN.test(text);
}

function findTypeDeclaration(lines: string[]): JavaTypeDeclaration | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/\b(?:class|interface|record)\s+([A-Za-z_][\w]*)\b/);
    if (match) {
      return {
        name: match[1],
        line: index + 1
      };
    }
  }

  return undefined;
}

function findClassMapping(
  annotations: MappingAnnotation[],
  typeDeclaration: JavaTypeDeclaration | undefined
): MappingAnnotation | undefined {
  if (!typeDeclaration) return undefined;

  return annotations
    .filter((annotation) => annotation.annotation === "RequestMapping" && annotation.endLine < typeDeclaration.line)
    .at(-1);
}

function findMethodDeclarations(lines: string[]): JavaMethodDeclaration[] {
  const declarations: JavaMethodDeclaration[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const methodName = extractMethodName(lines.slice(index, index + 8).join(" "));
    if (!methodName) continue;

    declarations.push({
      name: methodName,
      line: index + 1
    });
  }

  return declarations;
}

function findAnnotatedMethod(
  mapping: MappingAnnotation,
  methods: JavaMethodDeclaration[],
  annotations: MappingAnnotation[]
): JavaMethodDeclaration | undefined {
  const nextMethod = methods.find((method) => method.line > mapping.endLine);
  if (!nextMethod) return undefined;

  const nextMapping = annotations.find(
    (annotation) => annotation.startLine > mapping.endLine && annotation.startLine < nextMethod.line
  );
  if (nextMapping) return undefined;

  return nextMethod.line - mapping.endLine <= 12 ? nextMethod : undefined;
}

function extractMappingAnnotations(lines: string[]): MappingAnnotation[] {
  const annotations: MappingAnnotation[] = [];
  const commentState: CommentState = { inBlockComment: false };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const searchableLine = maskCommentsAndStrings(line, commentState);
    const match = searchableLine.match(MAPPING_PATTERN);
    if (!match) continue;

    const annotation = match[1];
    const block = collectAnnotationBlock(lines, index, match.index ?? 0);
    annotations.push({
      annotation,
      startLine: index + 1,
      endLine: block.endLine,
      paths: extractAnnotationPaths(block.text),
      http_methods: extractHttpMethods(annotation, block.text)
    });

    index = block.endLine - 1;
  }

  return annotations;
}

function collectAnnotationBlock(
  lines: string[],
  startIndex: number,
  annotationColumn: number
): { text: string; endLine: number } {
  const collected: string[] = [];
  let depth = 0;
  let sawOpenParen = false;

  for (let index = startIndex; index < lines.length; index += 1) {
    const fragment = index === startIndex ? lines[index].slice(annotationColumn) : lines[index];
    collected.push(fragment);

    for (const char of fragment) {
      if (char === "(") {
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

function extractAnnotationPaths(annotationText: string): string[] {
  const argumentsText = annotationText.match(/\(([\s\S]*)\)/)?.[1] ?? "";
  const namedValue = readNamedArgumentValue(argumentsText, ["value", "path"]);
  if (namedValue !== undefined) return extractStringLiterals(namedValue);
  if (/\b\w+\s*=/.test(argumentsText)) return [];

  return extractStringLiterals(argumentsText.trim());
}

function readNamedArgumentValue(argumentsText: string, names: string[]): string | undefined {
  const pattern = new RegExp(`\\b(?:${names.join("|")})\\s*=`, "g");
  const match = pattern.exec(argumentsText);
  if (!match) return undefined;

  let index = match.index + match[0].length;
  while (/\s/.test(argumentsText[index] ?? "")) index += 1;

  if (argumentsText[index] === "{") {
    return readBalancedValue(argumentsText, index, "{", "}");
  }

  if (argumentsText[index] === "\"") {
    return readQuotedValue(argumentsText, index);
  }

  return readUntilTopLevelComma(argumentsText, index);
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

function readUntilTopLevelComma(text: string, startIndex: number): string {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] === ",") return text.slice(startIndex, index);
  }

  return text.slice(startIndex);
}

function extractStringLiterals(text: string): string[] {
  const paths: string[] = [];
  const regex = /"([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    paths.push(match[1]);
  }

  return paths;
}

function extractHttpMethods(annotation: string, annotationText: string): Array<string | undefined> {
  const directMethod = MAPPING_METHODS[annotation];
  if (directMethod) return [directMethod];

  const methodArgument = annotationText.match(/\bmethod\s*=\s*(\{[\s\S]*?\}|RequestMethod\.[A-Z]+)/)?.[1];
  if (!methodArgument) return [undefined];

  const methods = [...methodArgument.matchAll(/RequestMethod\.([A-Z]+)/g)].map((match) => match[1]);
  return methods.length > 0 ? methods : [undefined];
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

function extractMethodName(signatureText: string): string | undefined {
  const normalized = signatureText
    .replace(/@\w+(?:\([^)]*\))?/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(
    /^(?!(?:if|for|while|switch|catch|return|new)\b)(?:(?:public|protected|private|static|final|synchronized|abstract|native|strictfp)\s+)*(?:<[^>]+>\s+)?[\w.$<>\[\],?&\s]+?\s+([A-Za-z_][\w]*)\s*\([^;{}]*\)\s*(?:throws\s+[\w.,\s]+)?(?:\{|$)/
  );

  return match?.[1];
}

function normalizeRoute(left: string, right: string): string {
  const cleanLeft = left.trim();
  const cleanRight = right.trim();

  if (cleanLeft === "" && cleanRight === "") return "/";
  if (cleanLeft === "") return withLeadingSlash(cleanRight);
  if (cleanRight === "") return withLeadingSlash(cleanLeft);

  const joined = `${cleanLeft.replace(/\/+$/, "")}/${cleanRight.replace(/^\/+/, "")}`;
  return withLeadingSlash(joined);
}

function withLeadingSlash(route: string): string {
  return route.startsWith("/") ? route : `/${route}`;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}
