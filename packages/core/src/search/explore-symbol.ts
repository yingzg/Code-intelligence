import { readGitState } from "../git.js";
import { inspectGitNexus } from "../gitnexus.js";
import { createGitNexusAdapter } from "../gitnexus/adapter.js";
import {
  findUnknownGitNexusRelationTypes,
  gitNexusRelationsUnavailableDiagnostic,
  gitNexusRelationsUsedDiagnostic,
  gitNexusUnknownRelationTypesDiagnostic,
  mapGitNexusContextToRelations
} from "../gitnexus/mapper.js";
import type {
  BudgetSummary,
  CodeLocation,
  CodePath,
  CodeRelation,
  Diagnostic,
  ExploreDirection,
  ExploreCoverage,
  ExploreResponse,
  QueryType,
  Stack
} from "../schemas.js";
import { ExploreResponseSchema } from "../schemas.js";
import { buildBudgetSummary, buildExploreCoverage, buildMainPaths, relationExpansionPriority } from "./main-path/index.js";
import { searchCode } from "./search-router.js";

const DEFAULT_DEPTH = 2;
const DEFAULT_LIMIT = 20;
const DEFAULT_RELATION_BUDGET = 60;
const DEFAULT_ANCHOR_LIMIT = 3;
const DEFAULT_FANOUT = 30;
const DEFAULT_MAIN_PATH_LIMIT = 3;

type ExploreGitNexusAdapter = Pick<ReturnType<typeof createGitNexusAdapter>, "context">;
type ExploreFrontierNode = {
  id: string;
  symbol: string;
  contextKey: string;
};

export async function exploreSymbol(input: {
  home: string;
  project: string;
  root: string;
  gitnexusRepo?: string;
  query: string;
  type?: QueryType;
  direction?: ExploreDirection;
  depth?: number;
  limit?: number;
  relationBudget?: number;
  mainPathLimit?: number;
  excludeTests?: boolean;
  anchorLimit?: number;
  fanout?: number;
  adapter?: ExploreGitNexusAdapter;
}): Promise<ExploreResponse> {
  const direction = input.direction ?? "both";
  const depth = normalizeDepth(input.depth);
  const limit = normalizeLimit(input.limit);
  const relationBudget = normalizeRelationBudget(input.relationBudget);
  const mainPathLimit = normalizeMainPathLimit(input.mainPathLimit);
  const anchorLimit = normalizeAnchorLimit(input.anchorLimit);
  const searchLimit = Math.max(anchorLimit * 3, 10);
  const fanout = normalizeFanout(input.fanout);
  const currentGit = await readGitState(input.root);
  const diagnostics: Diagnostic[] = [];
  const search = await searchCode({
    home: input.home,
    project: input.project,
    root: input.root,
    gitnexusRepo: input.gitnexusRepo,
    type: input.type,
    query: input.query,
    limit: searchLimit,
    includeRelations: false
  });
  diagnostics.push(...search.diagnostics);

  const excludeTests = input.excludeTests ?? true;
  const anchors = rankAnchors(filterAnchors(search.locations, excludeTests), input.query, direction).slice(0, anchorLimit);
  if (anchors.length === 0) {
    diagnostics.push({
      level: "warning",
      code: "ANCHOR_NOT_FOUND",
      message: "未找到可作为 explore 起点的代码位置。"
    });
  } else if (anchors.length > 1) {
    diagnostics.push({
      level: "info",
      code: "ANCHOR_AMBIGUOUS",
      message: `找到 ${anchors.length} 个候选探索起点；结果会合并多个 anchor 的关系，必要时请使用更精确 query。`
    });
  }
  const relations = await expandAnchorRelations({
    root: input.root,
    project: input.project,
    gitnexusRepo: input.gitnexusRepo,
    anchors,
    direction,
    depth,
    relationBudget,
    fanout,
    diagnostics,
    adapter: input.adapter
  });
  const candidatePaths = buildCandidatePaths({
    project: input.project,
    anchors,
    relations,
    direction,
    depth,
    limit,
    excludeTests,
    diagnostics
  });
  const mainPathResult = buildMainPaths({
    anchors,
    relations,
    candidatePaths,
    direction,
    depth,
    mainPathLimit,
    diagnostics: []
  });
  diagnostics.push(...mainPathResult.diagnostics);
  const coverage = buildExploreCoverage({
    diagnostics,
    usedSources: usedCoverageSources(relations),
    anchorCount: anchors.length
  });
  const budgetSummary = buildBudgetSummary({
    requestedDepth: depth,
    requestedLimit: limit,
    relationBudget,
    exploredRelationCount: relations.length,
    returnedRelationCount: relations.length,
    mainPathCount: mainPathResult.main_paths.length,
    sideRelationCount: mainPathResult.side_relations.length,
    foldedStepCount: mainPathResult.main_paths.reduce((sum, path) => sum + path.folded_steps.length, 0),
    diagnostics
  });

  const response: ExploreResponse = {
    request_id: createRequestId(),
    project: {
      name: input.project,
      path: input.root,
      stack: "java-generic" satisfies Stack,
      gitnexus_repo: input.gitnexusRepo,
      commit_hash: currentGit.commit_hash,
      dirty: currentGit.dirty
    },
    query: {
      type: search.query.type,
      text: input.query
    },
    index_status: search.index_status,
    anchors,
    relations,
    candidate_paths: candidatePaths,
    main_paths: mainPathResult.main_paths,
    side_relations: mainPathResult.side_relations,
    coverage,
    budget_summary: budgetSummary,
    diagnostics,
    summary: summarize(anchors.length, relations.length, mainPathResult.main_paths.length, direction, depth, limit, relationBudget)
  };

  return ExploreResponseSchema.parse(response);
}

function filterAnchors(locations: CodeLocation[], excludeTests: boolean): CodeLocation[] {
  if (!excludeTests) return locations;
  return locations.filter((location) => !isTestFile(location.file));
}

type AnchorKind = "method" | "interface" | "class" | "file" | "unknown";

type AnchorRankContext = {
  queryMethodName?: string;
  interfaceClassNames: Set<string>;
  interfaceFiles: Set<string>;
};

type MethodSignatureQuery = {
  methodName?: string;
  parameterTypes: string[];
};

function rankAnchors(
  anchors: CodeLocation[],
  query: string,
  direction: ExploreDirection
): CodeLocation[] {
  const signature = parseMethodSignatureQuery(query);
  const signatureFilteredAnchors = filterAnchorsForSignature(anchors, signature);
  const context: AnchorRankContext = {
    queryMethodName: signature.methodName,
    interfaceClassNames: new Set(
      signatureFilteredAnchors
        .filter((anchor) => anchorKind(anchor) === "interface")
        .map((anchor) => anchorClassName(anchor))
        .filter((name): name is string => name !== undefined)
    ),
    interfaceFiles: new Set(
      signatureFilteredAnchors
        .filter((anchor) => anchorKind(anchor) === "interface")
        .map((anchor) => normalizePath(anchor.file))
    )
  };

  return signatureFilteredAnchors
    .map((anchor, index) => ({
      anchor,
      index,
      rank: anchorRank(anchor, direction, context)
    }))
    .sort((left, right) => left.rank - right.rank || right.anchor.score - left.anchor.score || left.index - right.index)
    .map((item) => item.anchor);
}

function anchorRank(
  anchor: CodeLocation,
  direction: ExploreDirection,
  context: AnchorRankContext
): number {
  const kind = anchorKind(anchor);
  let rank = sourceSetRank(anchor.file);

  if (kind === "method") {
    rank += 0;
    const methodName = anchorMethodName(anchor);
    if (context.queryMethodName && methodName === context.queryMethodName) {
      rank -= 100;
    } else if (context.queryMethodName) {
      rank += 200;
    }

    if (isImplementationMethod(anchor, context)) {
      rank -= direction === "downstream" ? 60 : 30;
    } else if (isInterfaceMethod(anchor, context)) {
      rank += direction === "downstream" ? 20 : 10;
    }

    return rank;
  }

  if (kind === "class") return rank + 300;
  if (kind === "interface") return rank + (direction === "downstream" ? 380 : 350);
  if (kind === "file") return rank + 700;
  return rank + 500;
}

function sourceSetRank(file: string): number {
  const normalized = normalizePath(file);
  if (normalized.startsWith("src/main/") || normalized.includes("/src/main/")) return 0;
  if (isTestFile(file)) return 1000;
  return 100;
}

function anchorKind(anchor: CodeLocation): AnchorKind {
  if (anchor.id.startsWith("Method:")) return "method";
  if (anchor.id.startsWith("Interface:")) return "interface";
  if (anchor.id.startsWith("Class:") || anchor.id.startsWith("Enum:")) return "class";
  if (anchor.id.startsWith("File:")) return "file";
  if (!anchor.symbol) return "file";
  return "unknown";
}

function methodNameFromQuery(query: string): string | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;

  const beforeParams = trimmed.split("(", 1)[0].trim();
  const dotted = beforeParams.match(/[.#]([A-Za-z_$][\w$]*)$/);
  if (dotted) return dotted[1];

  if (trimmed.includes("(")) {
    const methodLike = beforeParams.match(/([A-Za-z_$][\w$]*)$/);
    return methodLike?.[1];
  }

  return undefined;
}

function parseMethodSignatureQuery(query: string): MethodSignatureQuery {
  const methodName = methodNameFromQuery(query);
  const paramsMatch = query.match(/\(([^)]*)\)/);
  if (!paramsMatch) return { methodName, parameterTypes: [] };

  const parameterTypes = paramsMatch[1]
    .split(",")
    .map((part) => parameterTypeFromDeclaration(part))
    .filter((type): type is string => type !== undefined);

  return { methodName, parameterTypes };
}

function parameterTypeFromDeclaration(value: string): string | undefined {
  const cleaned = value
    .replace(/@\w+(?:\([^)]*\))?/g, " ")
    .replace(/\bfinal\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;

  const tokens = cleaned.split(" ");
  const typeToken = tokens.length > 1 ? tokens.slice(0, -1).join(" ") : tokens[0];
  const match = typeToken.match(/[A-Za-z_$][\w$]*(?:\[\])?(?:\.\.\.)?$/);
  return match?.[0].replace(/\.\.\.$/, "").replace(/\[\]$/, "");
}

function filterAnchorsForSignature(anchors: CodeLocation[], signature: MethodSignatureQuery): CodeLocation[] {
  if (!signature.methodName) return anchors;

  const exactMethodAnchors = anchors.filter((anchor) =>
    anchorKind(anchor) === "method" && anchorMethodName(anchor) === signature.methodName
  );
  if (exactMethodAnchors.length === 0) return anchors;

  if (signature.parameterTypes.length === 0) return exactMethodAnchors;

  const parameterMatchedAnchors = exactMethodAnchors.filter((anchor) =>
    signature.parameterTypes.every((type) => anchorContainsParameterType(anchor, type))
  );
  return parameterMatchedAnchors.length > 0 ? parameterMatchedAnchors : exactMethodAnchors;
}

function anchorContainsParameterType(anchor: CodeLocation, parameterType: string): boolean {
  const haystack = `${anchor.snippet ?? ""}\n${anchor.symbol ?? ""}\n${anchor.id}`;
  return haystack.includes(parameterType);
}

function anchorMethodName(anchor: CodeLocation): string | undefined {
  const symbol = anchor.symbol ?? symbolFromRelationId(anchor.id);
  const beforeParams = symbol.split("(", 1)[0].replace(/#\d+$/, "");
  const match = beforeParams.match(/[.#]([A-Za-z_$][\w$]*)$/);
  if (match) return match[1];
  const shortName = beforeParams.match(/^([A-Za-z_$][\w$]*)$/);
  if (shortName) return shortName[1];
  return undefined;
}

function anchorClassName(anchor: CodeLocation): string | undefined {
  const symbol = (anchor.symbol ?? symbolFromRelationId(anchor.id)).split("(", 1)[0].replace(/#\d+$/, "");
  const identifiers = symbol.match(/[A-Za-z_$][\w$]*/g) ?? [];
  if (anchorKind(anchor) === "method" && identifiers.length >= 2) {
    return identifiers.at(-2);
  }
  if (identifiers.length > 0) return identifiers.at(-1);

  const fileName = normalizePath(anchor.file).split("/").at(-1);
  return fileName?.replace(/\.[^.]+$/, "") || undefined;
}

function isImplementationMethod(anchor: CodeLocation, context: AnchorRankContext): boolean {
  const className = anchorClassName(anchor);
  if (!className) return false;
  if (/(?:Impl|Implementation)$/.test(className)) return true;

  for (const interfaceName of context.interfaceClassNames) {
    if (className === `${interfaceName}Impl` || className === `${interfaceName}Implementation`) return true;
  }

  return false;
}

function isInterfaceMethod(anchor: CodeLocation, context: AnchorRankContext): boolean {
  const className = anchorClassName(anchor);
  return context.interfaceFiles.has(normalizePath(anchor.file))
    || (className !== undefined && context.interfaceClassNames.has(className));
}

function isTestFile(file: string): boolean {
  const normalized = normalizePath(file);
  return normalized.startsWith("src/test/") || normalized.includes("/src/test/");
}

function normalizePath(file: string): string {
  return file.replaceAll("\\", "/");
}

function normalizeDepth(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DEPTH;
  if (!Number.isInteger(value) || value <= 0) throw new Error("depth 必须是正整数");
  return Math.min(value, 4);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value <= 0) throw new Error("limit 必须是正整数");
  return value;
}

function normalizeRelationBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RELATION_BUDGET;
  if (!Number.isInteger(value) || value <= 0) throw new Error("relationBudget 必须是正整数");
  return value;
}

function normalizeMainPathLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAIN_PATH_LIMIT;
  if (!Number.isInteger(value) || value <= 0) throw new Error("mainPathLimit 必须是正整数");
  return value;
}

function normalizeAnchorLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ANCHOR_LIMIT;
  if (!Number.isInteger(value) || value <= 0) throw new Error("anchorLimit 必须是正整数");
  return value;
}

function normalizeFanout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FANOUT;
  if (!Number.isInteger(value) || value <= 0) throw new Error("fanout 必须是正整数");
  return value;
}

function buildCandidatePaths(input: {
  project: string;
  anchors: CodeLocation[];
  relations: CodeRelation[];
  direction: ExploreDirection;
  depth: number;
  limit: number;
  excludeTests: boolean;
  diagnostics: Diagnostic[];
}): CodePath[] {
  const paths: CodePath[] = [];
  const anchorsById = new Map(input.anchors.map((anchor) => [anchor.id, anchor]));
  const nodesById = new Map<string, CodeLocation>(input.anchors.map((anchor) => [anchor.id, anchor]));
  const relationsByNode = indexRelations(
    candidatePathRelations(input.relations, nodesById, input.excludeTests),
    input.direction
  );

  for (const anchor of input.anchors) {
    walkPath({
      project: input.project,
      currentId: anchor.id,
      currentNodes: [anchor],
      currentRelations: [],
      maxDepth: input.depth,
      limit: input.limit,
      direction: input.direction,
      relationsByNode,
      nodesById,
      anchorsById,
      paths,
      visited: new Set([anchor.id])
    });
    if (paths.length >= input.limit) break;
  }

  if (paths.length > 0) {
    input.diagnostics.push({
      level: "info",
      code: "PATH_VERIFICATION_SKIPPED",
      message: "v0.3 返回候选路径；除 GitNexus trace 结果外，不把候选路径标记为完整调用链。"
    });
  } else if (input.relations.length > 0) {
    input.diagnostics.push({
      level: "info",
      code: "PATH_EXTRACTION_PARTIAL",
      message: "已生成关系边，但未能组装成候选路径。"
    });
  }

  return paths.slice(0, input.limit);
}

function walkPath(input: {
  project: string;
  currentId: string;
  currentNodes: CodeLocation[];
  currentRelations: CodeRelation[];
  maxDepth: number;
  limit: number;
  direction: ExploreDirection;
  relationsByNode: Map<string, CodeRelation[]>;
  nodesById: Map<string, CodeLocation>;
  anchorsById: Map<string, CodeLocation>;
  paths: CodePath[];
  visited: Set<string>;
}): void {
  if (input.currentRelations.length >= input.maxDepth || input.paths.length >= input.limit) return;

  for (const relation of input.relationsByNode.get(input.currentId) ?? []) {
    const nextId = nextIdForRelation(input.currentId, relation);
    if (!nextId || input.visited.has(nextId)) continue;

    const nextNode = input.nodesById.get(nextId) ?? endpointToLocation(input.project, nextId, relation);
    input.nodesById.set(nextId, nextNode);
    const relations = [...input.currentRelations, relation];
    const nodes = [...input.currentNodes, nextNode];
    const pathDiagnostics: Diagnostic[] = [];
    const pathStatus: CodePath["path_status"] = "candidate";

    input.paths.push({
      id: `path_${input.paths.length + 1}`,
      path_type: pathType(input.direction),
      path_status: pathStatus,
      nodes,
      relations,
      depth: relations.length,
      confidence: pathConfidence(relations, pathStatus),
      evidence_sources: relationEvidenceSources(relations),
      diagnostics: pathDiagnostics,
      summary: summarizePath(nodes, relations)
    });
    if (input.paths.length >= input.limit) return;

    input.visited.add(nextId);
    walkPath({
      ...input,
      currentId: nextId,
      currentNodes: nodes,
      currentRelations: relations,
      visited: input.visited
    });
    input.visited.delete(nextId);
  }
}

function indexRelations(relations: CodeRelation[], direction: ExploreDirection): Map<string, CodeRelation[]> {
  const result = new Map<string, CodeRelation[]>();
  for (const relation of relations) {
    if (direction === "downstream" || direction === "both") {
      addRelation(result, relation.from, relation);
    }
    if (direction === "upstream" || direction === "both") {
      addRelation(result, relation.to, relation);
    }
  }
  return result;
}

const PATH_RELATION_PRIORITY = new Map<CodeRelation["relation_type"], number>([
  ["calls", 0],
  ["method_implements", 1],
  ["method_overrides", 2],
  ["maps_to_sql", 3],
  ["uses_table", 4],
  ["implements", 5],
  ["has_method", 6]
]);

function candidatePathRelations(
  relations: CodeRelation[],
  nodesById: Map<string, CodeLocation>,
  excludeTests: boolean
): CodeRelation[] {
  return relations
    .map((relation, index) => ({ relation, index, priority: PATH_RELATION_PRIORITY.get(relation.relation_type) }))
    .filter((item): item is { relation: CodeRelation; index: number; priority: number } =>
      item.priority !== undefined && (!excludeTests || !relationTouchesTestEndpoint(item.relation, nodesById))
    )
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((item) => item.relation);
}

function relationTouchesTestEndpoint(relation: CodeRelation, nodesById: Map<string, CodeLocation>): boolean {
  return relationEndpointIsTest(relation.from, nodesById)
    || relationEndpointIsTest(relation.to, nodesById)
    || relation.evidence.some((evidence) => isTestFile(evidence.file));
}

function relationEndpointIsTest(id: string, nodesById: Map<string, CodeLocation>): boolean {
  const knownNode = nodesById.get(id);
  return (knownNode !== undefined && isTestFile(knownNode.file)) || isTestFile(id);
}

function addRelation(index: Map<string, CodeRelation[]>, nodeId: string, relation: CodeRelation): void {
  const relations = index.get(nodeId) ?? [];
  relations.push(relation);
  index.set(nodeId, relations);
}

function nextIdForRelation(currentId: string, relation: CodeRelation): string | undefined {
  if (relation.from === currentId) return relation.to;
  if (relation.to === currentId) return relation.from;
  return undefined;
}

function endpointToLocation(project: string, id: string, relation: CodeRelation): CodeLocation {
  const evidence = relation.evidence[0];
  const file = evidence?.file ?? "unknown";
  return {
    id,
    project,
    file,
    start_line: evidence?.line,
    end_line: evidence?.line,
    symbol: symbolFromRelationId(id),
    language: languageFromFile(file),
    location_type: locationTypeFromId(id, file),
    snippet: evidence?.snippet ?? "",
    match_reason: `GitNexus 关系端点 ${symbolFromRelationId(id)}`,
    score: 0.6,
    confidence: relation.confidence,
    source: evidence?.source ?? "gitnexus"
  };
}

function pathDiagnosticsFor(truncated: boolean): Diagnostic[] {
  if (!truncated) return [];
  return [
    {
      level: "info",
      code: "PATH_TRUNCATED",
      message: "候选路径因为关系数量、fanout 或 depth 限制被截断。"
    }
  ];
}

function summarizePath(nodes: CodeLocation[], relations: CodeRelation[]): string {
  const labels: string[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    labels.push(summaryLabel(nodes[index]));
    const relation = relations[index];
    const nextNode = nodes[index + 1];
    if (relation && nextNode) labels.push(summaryArrow(nodes[index].id, nextNode.id, relation));
  }
  return labels.join(" ");
}

function summaryLabel(node: CodeLocation): string {
  const idLabel = summaryLabelFromId(node.id);
  if (idLabel) return idLabel;
  return node.symbol ?? node.id;
}

function summaryLabelFromId(id: string): string | undefined {
  const parts = id.split(":");
  const kind = parts[0];
  const symbolPart = parts.at(-1)?.replace(/#\d+$/, "");
  if (!symbolPart) return undefined;

  if (kind === "Method" || kind === "Constructor") {
    const match = symbolPart.match(/([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)$/);
    return match?.[1];
  }

  if (kind === "Class" || kind === "Interface" || kind === "Enum") {
    const match = symbolPart.match(/([A-Za-z_$][\w$]*)$/);
    return match?.[1];
  }

  if (kind === "File") {
    return normalizePath(symbolPart).split("/").at(-1);
  }

  return undefined;
}

function summaryArrow(currentId: string, nextId: string, relation: CodeRelation): string {
  if (relation.from === currentId && relation.to === nextId) return `--${relation.relation_type}-->`;
  if (relation.to === currentId && relation.from === nextId) return `<--${relation.relation_type}--`;
  return `--${relation.relation_type}-->`;
}

function pathType(direction: ExploreDirection): CodePath["path_type"] {
  if (direction === "upstream") return "upstream";
  if (direction === "downstream") return "downstream";
  return "unknown";
}

function pathConfidence(
  relations: CodeRelation[],
  status: CodePath["path_status"]
): CodePath["confidence"] {
  if (status === "verified") return "high";
  if (status === "truncated") return "low";
  if (relations.some((relation) => relation.relation_type === "references" || relation.confidence === "low")) return "low";
  return "medium";
}

function relationEvidenceSources(relations: CodeRelation[]): CodePath["evidence_sources"] {
  const sources = new Set<CodePath["evidence_sources"][number]>();
  for (const relation of relations) {
    for (const evidence of relation.evidence) {
      sources.add(evidence.source);
    }
  }
  return [...sources];
}

function locationTypeFromId(id: string, file: string): CodeLocation["location_type"] {
  const lowerFile = file.toLowerCase();
  if (lowerFile.includes("controller")) return "controller";
  if (lowerFile.includes("mapper")) return "mapper";
  if (lowerFile.includes("service")) return "service";
  if (id.startsWith("Method:")) return "service";
  if (id.startsWith("Property:")) return "constant";
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

async function expandAnchorRelations(input: {
  root: string;
  project: string;
  gitnexusRepo?: string;
  anchors: CodeLocation[];
  direction: ExploreDirection;
  depth: number;
  relationBudget: number;
  fanout: number;
  diagnostics: Diagnostic[];
  adapter?: ExploreGitNexusAdapter;
}): Promise<CodeRelation[]> {
  if (input.anchors.length === 0) return [];

  if (!input.adapter) {
    const gitnexus = await inspectGitNexus(input.root);
    if (!gitnexus.installed || !gitnexus.repo_index_exists) {
      input.diagnostics.push(gitNexusRelationsUnavailableDiagnostic());
      return [];
    }
  }

  const adapter = input.adapter ?? createGitNexusAdapter();
  const repo = input.gitnexusRepo ?? input.project;
  const relations: CodeRelation[] = [];
  const visited = new Set<string>();
  let frontier = input.anchors
    .filter((anchor) => anchor.symbol)
    .map((anchor) => ({
      id: anchor.id,
      symbol: anchor.symbol!,
      contextKey: contextKeyForLocation(anchor)
    }));

  for (let level = 0; level < input.depth && frontier.length > 0; level += 1) {
    const nextFrontier: typeof frontier = [];

    for (const node of frontier) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);

      try {
        const context = await adapter.context({
          repoPath: input.root,
          repo,
          symbol: node.contextKey,
          limit: input.fanout + 1
        });
        const mapped = mapGitNexusContextToRelations({
          fromLocationId: node.id,
          context: normalizeGitNexusContext(context)
        }).filter((relation) => relationAllowed(input.direction, relation, node.id));
        const ordered = mapped.length > input.fanout
          ? [...mapped].sort((left, right) => relationExpansionPriority(right) - relationExpansionPriority(left))
          : mapped;
        const allowed = ordered.slice(0, input.fanout);

        relations.push(...allowed);
        nextFrontier.push(...nextFrontierFromRelations(allowed, node.id, input.direction));
        if (mapped.length > input.fanout) {
          pushDiagnosticOnce(input.diagnostics, {
            level: "info",
            code: "FANOUT_LIMIT_REACHED",
            message: `节点 ${node.symbol} 的关系数量超过 fanout=${input.fanout}，已按主链路优先级裁剪。`
          });
        }
        if (dedupeRelations(relations).length > input.relationBudget) {
          input.diagnostics.push({
            level: "info",
            code: "RELATION_LIMIT_REACHED",
            message: `关系数量超过 relationBudget=${input.relationBudget}，已停止扩展。`
          });
          return finalizeRelations(relations, input.relationBudget, input.diagnostics);
        }
      } catch (error) {
        input.diagnostics.push({
          level: "warning",
          code: "GITNEXUS_QUERY_FAILED",
          message: `GitNexus context 查询失败：${errorMessage(error)}`
        });
      }
    }

    frontier = dedupeFrontier(nextFrontier).filter((node) => !visited.has(node.id));
    if (level === input.depth - 1 && frontier.length > 0) {
      pushDepthLimitDiagnostics(input.diagnostics, input.direction, input.depth);
    }
  }

  return finalizeRelations(relations, input.relationBudget, input.diagnostics);
}

function pushDepthLimitDiagnostics(
  diagnostics: Diagnostic[],
  direction: ExploreDirection,
  depth: number
): void {
  if (direction === "downstream" || direction === "both") {
    pushDiagnosticOnce(diagnostics, {
      level: "info",
      code: "DOWNSTREAM_DEPTH_LIMIT_REACHED",
      message: `下游探索达到 depth=${depth}，仍存在未继续展开的候选节点。`
    });
  }
  if (direction === "upstream" || direction === "both") {
    pushDiagnosticOnce(diagnostics, {
      level: "info",
      code: "UPSTREAM_DEPTH_LIMIT_REACHED",
      message: `上游探索达到 depth=${depth}，仍存在未继续展开的候选节点。`
    });
  }
}

function pushDiagnosticOnce(diagnostics: Diagnostic[], diagnostic: Diagnostic): void {
  if (diagnostics.some((item) => item.code === diagnostic.code)) return;
  diagnostics.push(diagnostic);
}

function finalizeRelations(
  relations: CodeRelation[],
  relationBudget: number,
  diagnostics: Diagnostic[]
): CodeRelation[] {
  const beforeLimit = dedupeRelations(relations);
  if (beforeLimit.length > relationBudget && !diagnostics.some((item) => item.code === "RELATION_LIMIT_REACHED")) {
    diagnostics.push({
      level: "info",
      code: "RELATION_LIMIT_REACHED",
      message: `关系数量超过 relationBudget=${relationBudget}，已截断。`
    });
  }
  const deduped = beforeLimit.slice(0, relationBudget);
  if (deduped.length > 0) {
    diagnostics.push(gitNexusRelationsUsedDiagnostic(deduped.length));
    const unknownTypes = findUnknownGitNexusRelationTypes(deduped);
    if (unknownTypes.length > 0) {
      diagnostics.push(gitNexusUnknownRelationTypesDiagnostic(unknownTypes));
    }
  } else if (!diagnostics.some((item) => item.code === "GITNEXUS_QUERY_FAILED")) {
    diagnostics.push(gitNexusRelationsUnavailableDiagnostic());
  }

  return deduped;
}

function nextFrontierFromRelations(
  relations: CodeRelation[],
  currentId: string,
  direction: ExploreDirection
): ExploreFrontierNode[] {
  const nodes: ExploreFrontierNode[] = [];
  for (const relation of relations) {
    if (direction === "downstream" || direction === "both") {
      if (relation.from === currentId) {
        nodes.push({
          id: relation.to,
          symbol: symbolFromRelationId(relation.to),
          contextKey: relation.to
        });
      }
    }
    if (direction === "upstream" || direction === "both") {
      if (relation.to === currentId) {
        nodes.push({
          id: relation.from,
          symbol: symbolFromRelationId(relation.from),
          contextKey: relation.from
        });
      }
    }
  }

  return nodes.filter((node) => node.symbol.length > 0);
}

function symbolFromRelationId(id: string): string {
  const lastSegment = id.split(":").at(-1) ?? id;
  return lastSegment.replace(/#\d+$/, "");
}

function contextKeyForLocation(location: CodeLocation): string {
  if (location.source === "gitnexus") return location.id;
  return location.symbol ?? location.id;
}

function dedupeFrontier<T extends { id: string }>(nodes: T[]): T[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function relationAllowed(direction: ExploreDirection, relation: CodeRelation, anchorId: string): boolean {
  if (direction === "both") return true;
  if (direction === "downstream") return relation.from === anchorId;
  return relation.to === anchorId;
}

function normalizeGitNexusContext(value: unknown): Parameters<typeof mapGitNexusContextToRelations>[0]["context"] {
  if (!isRecord(value)) return {};
  return {
    incoming: isRecord(value.incoming) ? normalizeEdgeMap(value.incoming) : undefined,
    outgoing: isRecord(value.outgoing) ? normalizeEdgeMap(value.outgoing) : undefined,
    typed_properties: Array.isArray(value.typed_properties)
      ? value.typed_properties.filter(isGitNexusTarget)
      : undefined
  };
}

function normalizeEdgeMap(value: Record<string, unknown>): Record<string, Array<{ uid: string; name: string; filePath: string }>> {
  const result: Record<string, Array<{ uid: string; name: string; filePath: string }>> = {};
  for (const [key, items] of Object.entries(value)) {
    if (!Array.isArray(items)) continue;
    result[key] = items.filter(isGitNexusTarget);
  }
  return result;
}

function isGitNexusTarget(value: unknown): value is { uid: string; name: string; filePath: string } {
  return isRecord(value) &&
    typeof value.uid === "string" &&
    typeof value.name === "string" &&
    typeof value.filePath === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeRelations(relations: CodeRelation[]): CodeRelation[] {
  const seen = new Set<string>();
  return relations.filter((relation) => {
    const key = `${relation.from}\u0000${relation.to}\u0000${relation.relation_type}\u0000${relation.raw_relation_type ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(
  anchorCount: number,
  relationCount: number,
  mainPathCount: number,
  direction: ExploreDirection,
  depth: number,
  limit: number,
  relationBudget: number
): string {
  return `找到 ${anchorCount} 个探索起点，${relationCount} 条关系证据，${mainPathCount} 条候选主链路。direction=${direction}, depth=${depth}, limit=${limit}, relationBudget=${relationBudget}。`;
}

function usedCoverageSources(relations: CodeRelation[]): ExploreCoverage["used_sources"] {
  const sources = new Set<ExploreCoverage["used_sources"][number]>();
  for (const relation of relations) {
    for (const evidence of relation.evidence) {
      if (evidence.source === "gitnexus") sources.add("gitnexus");
      if (evidence.source === "java_index") sources.add("java_index");
      if (evidence.source === "grep") sources.add("grep");
      if (evidence.source === "semantic_lite") sources.add("semantic_lite");
    }
  }
  return [...sources];
}

function createRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
