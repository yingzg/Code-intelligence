import { join } from "node:path";
import type { CodeLocation, CodeRelation, Diagnostic } from "../schemas.js";
import { readSnippet } from "../snippet.js";

export type GitNexusDefinition = {
  id: string;
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
};

export type GitNexusEdgeTarget = {
  uid: string;
  name: string;
  filePath: string;
};

export type GitNexusTypedProperty = GitNexusEdgeTarget & {
  declaredType?: string;
};

export type GitNexusContextLike = {
  incoming?: Record<string, GitNexusEdgeTarget[]>;
  outgoing?: Record<string, GitNexusEdgeTarget[]>;
  typed_properties?: GitNexusTypedProperty[];
};

const KNOWN_GITNEXUS_RELATION_TYPES = new Set([
  "calls",
  "implements",
  "imports",
  "accesses",
  "has_method",
  "has_property",
  "contains",
  "extends",
  "method_overrides",
  "method_implements",
  "throws",
  "logs",
  "maps_to_sql",
  "handles_route",
  "reads_config",
  "uses_table",
  "typed_as",
  "references"
]);

export async function mapGitNexusDefinitionsToLocations(input: {
  project: string;
  root: string;
  definitions: GitNexusDefinition[];
}): Promise<CodeLocation[]> {
  const locations: CodeLocation[] = [];

  for (const definition of input.definitions) {
    // GitNexus 的 File 节点没有行号，无法定位到具体代码行，跳过
    if (definition.startLine === undefined) continue;

    locations.push({
      id: definition.id,
      project: input.project,
      file: definition.filePath,
      start_line: definition.startLine,
      end_line: definition.endLine,
      symbol: definition.name,
      language: languageFromFile(definition.filePath),
      location_type: locationTypeFromId(definition.id),
      snippet: await readSnippetSafe(join(input.root, definition.filePath), definition.startLine),
      match_reason: `GitNexus 图谱命中 ${definition.name}`,
      score: 0.8,
      confidence: "medium",
      source: "gitnexus"
    });
  }

  return locations;
}

async function readSnippetSafe(file: string, line: number): Promise<string> {
  try {
    return await readSnippet(file, line);
  } catch {
    return "";
  }
}

export function mapGitNexusContextToRelations(input: {
  fromLocationId: string;
  context: GitNexusContextLike;
}): CodeRelation[] {
  const relations: CodeRelation[] = [];

  for (const [kind, targets] of Object.entries(input.context.incoming ?? {})) {
    for (const target of targets) {
      relations.push(relation(target.uid, input.fromLocationId, kind, target, "gitnexus.context.incoming"));
    }
  }

  for (const [kind, targets] of Object.entries(input.context.outgoing ?? {})) {
    for (const target of targets) {
      relations.push(relation(input.fromLocationId, target.uid, kind, target, "gitnexus.context.outgoing"));
    }
  }

  for (const property of input.context.typed_properties ?? []) {
    relations.push(relation(property.uid, input.fromLocationId, "typed_as", property, "gitnexus.context.typed_properties"));
  }

  return dedupeRelations(relations);
}

export function mapGitNexusTraceToRelations(value: unknown): CodeRelation[] {
  const { path, edgeTypes } = extractTrace(value);
  if (path.length < 2) return [];

  const relations: CodeRelation[] = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const from = path[index];
    const to = path[index + 1];
    relations.push(relation(from.uid, to.uid, edgeTypes[index] ?? "calls", to, "gitnexus.trace"));
  }

  return dedupeRelations(relations);
}

export function findUnknownGitNexusRelationTypes(relations: CodeRelation[]): string[] {
  const unknown = new Set<string>();
  for (const relation of relations) {
    const raw = relation.raw_relation_type;
    if (raw && !isKnownGitNexusRelationType(raw)) {
      unknown.add(raw);
    }
  }
  return [...unknown].sort();
}

export function gitNexusUnknownRelationTypesDiagnostic(types: string[]): Diagnostic {
  return {
    level: "info",
    code: "GITNEXUS_UNKNOWN_RELATION_TYPE",
    message: `发现未显式归一的 GitNexus 关系类型：${types.join(", ")}；已保留 raw_relation_type 并降级为 references。`
  };
}

export function gitNexusRelationsUsedDiagnostic(count: number): Diagnostic {
  return {
    level: "info",
    code: "GITNEXUS_RELATIONS_USED",
    message: `已使用 GitNexus 生成 ${count} 条关系证据。`
  };
}

export function gitNexusRelationsUnavailableDiagnostic(): Diagnostic {
  return {
    level: "info",
    code: "GITNEXUS_RELATIONS_UNAVAILABLE",
    message: "未生成 GitNexus 关系证据。"
  };
}

function relation(
  from: string,
  to: string,
  rawRelationType: string,
  target: GitNexusEdgeTarget,
  extractedBy: string
): CodeRelation {
  const raw_relation_type = rawRelationType;
  return {
    from,
    to,
    relation_type: relationType(rawRelationType),
    raw_relation_type,
    confidence: "medium",
    evidence: [
      {
        file: target.filePath,
        snippet: "",
        source: "gitnexus",
        extracted_by: extractedBy,
        raw_relation_type
      }
    ]
  };
}

function relationType(kind: string): CodeRelation["relation_type"] {
  const normalized = normalizeRelationType(kind);
  if (normalized === "calls") return "calls";
  if (normalized === "implements") return "implements";
  if (normalized === "imports") return "imports";
  if (normalized === "accesses") return "accesses";
  if (normalized === "has_method") return "has_method";
  if (normalized === "has_property") return "has_property";
  if (normalized === "contains") return "contains";
  if (normalized === "extends") return "extends";
  if (normalized === "method_overrides") return "method_overrides";
  if (normalized === "method_implements") return "method_implements";
  if (normalized === "throws") return "throws";
  if (normalized === "logs") return "logs";
  if (normalized === "maps_to_sql") return "maps_to_sql";
  if (normalized === "handles_route") return "handles_route";
  if (normalized === "reads_config") return "reads_config";
  if (normalized === "uses_table") return "uses_table";
  if (normalized === "typed_as") return "typed_as";
  if (normalized === "references") return "references";
  return "references";
}

function isKnownGitNexusRelationType(kind: string): boolean {
  return KNOWN_GITNEXUS_RELATION_TYPES.has(normalizeRelationType(kind));
}

function normalizeRelationType(kind: string): string {
  return kind.trim().toLowerCase();
}

function locationTypeFromId(id: string): CodeLocation["location_type"] {
  if (id.startsWith("Method:")) return "service";
  if (id.startsWith("Property:")) return "constant";
  if (id.startsWith("Class:") || id.startsWith("Interface:") || id.startsWith("Enum:")) return "unknown";
  return "unknown";
}

function languageFromFile(file: string): CodeLocation["language"] {
  if (file.endsWith(".java")) return "java";
  if (file.endsWith(".xml")) return "xml";
  if (file.endsWith(".yml") || file.endsWith(".yaml")) return "yaml";
  if (file.endsWith(".properties")) return "properties";
  if (file.endsWith(".sql")) return "sql";
  return "unknown";
}

function dedupeRelations(relations: CodeRelation[]): CodeRelation[] {
  const seen = new Set<string>();
  return relations.filter((item) => {
    const key = `${item.from}\u0000${item.to}\u0000${item.relation_type}\u0000${item.raw_relation_type ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractTrace(value: unknown): { path: GitNexusEdgeTarget[]; edgeTypes: string[] } {
  if (!isRecord(value)) return { path: [], edgeTypes: [] };
  const candidates = [
    value.path,
    value.nodes,
    value.symbols,
    value.trace,
    value.hops
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const path = candidate
      .map(normalizeTraceNode)
      .filter((item): item is GitNexusEdgeTarget => item !== undefined);
    if (path.length > 0) {
      return {
        path,
        edgeTypes: normalizeTraceEdgeTypes(value.edges)
      };
    }
  }

  return { path: [], edgeTypes: [] };
}

function normalizeTraceNode(value: unknown): GitNexusEdgeTarget | undefined {
  if (!isRecord(value)) return undefined;
  const uid = stringField(value, "uid") ?? stringField(value, "id");
  const name = stringField(value, "name") ?? uid;
  const filePath = stringField(value, "filePath") ?? stringField(value, "file") ?? "";
  if (!name) return undefined;
  if (uid) return { uid, name, filePath };
  if (!filePath) return undefined;

  const line = numberField(value, "startLine") ?? numberField(value, "line");
  return {
    uid: `Trace:${filePath}:${line ?? "unknown"}:${name}`,
    name,
    filePath
  };
}

function normalizeTraceEdgeTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((edge) => {
    if (!isRecord(edge)) return "calls";
    const relType = stringField(edge, "relType") ?? stringField(edge, "type");
    return relType ?? "calls";
  });
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
