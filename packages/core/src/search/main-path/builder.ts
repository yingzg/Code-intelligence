import type {
  CodeLocation,
  CodePath,
  CodeRelation,
  Diagnostic,
  ExploreDirection,
  MainPath,
  SideRelation
} from "../../schemas.js";
import { foldPathDetails } from "./folding.js";
import { relationExpansionPriority, relationKey, splitSideRelations } from "./pruner.js";
import { scorePathForMainPath } from "./scoring.js";

export type BuildMainPathsInput = {
  anchors: CodeLocation[];
  relations: CodeRelation[];
  candidatePaths: CodePath[];
  direction: ExploreDirection;
  depth: number;
  mainPathLimit: number;
  diagnostics: Diagnostic[];
};

export type BuildMainPathsOutput = {
  main_paths: MainPath[];
  side_relations: SideRelation[];
  diagnostics: Diagnostic[];
};

type PathDraft = {
  path_type: MainPath["path_type"];
  nodes: CodeLocation[];
  relations: CodeRelation[];
};

type StepPath = {
  nodes: CodeLocation[];
  relations: CodeRelation[];
};

export function buildMainPaths(input: BuildMainPathsInput): BuildMainPathsOutput {
  const nodesById = buildNodesById(input.anchors, input.relations);
  const targetAnchorIds = new Set(input.anchors.map((anchor) => anchor.id));
  const drafts: PathDraft[] = [];

  for (const anchor of input.anchors) {
    if (input.direction === "upstream") {
      drafts.push(...buildUpstreamDrafts(anchor, input, nodesById));
    } else if (input.direction === "downstream") {
      drafts.push(...buildDownstreamDrafts(anchor, input, nodesById));
    } else {
      drafts.push(...buildMixedDrafts(anchor, input, nodesById));
      drafts.push(...buildUpstreamDrafts(anchor, input, nodesById));
      drafts.push(...buildDownstreamDrafts(anchor, input, nodesById));
    }
  }

  const scored = dedupeScoredDrafts(drafts
    .filter((draft) => draft.relations.some((relation) => relation.relation_type === "calls"))
    .map((draft) => {
      const folded = foldPathDetails(draft);
      const score = scorePathForMainPath({
        nodes: folded.nodes,
        relations: folded.relations,
        targetAnchorIds,
        direction: input.direction
      });
      return { draft, folded, score };
    })
    .sort((left, right) => right.score.score - left.score.score));

  const mainPathRelationKeys = new Set<string>();
  const main_paths: MainPath[] = scored.slice(0, input.mainPathLimit).map((item, index) => {
    for (const relation of item.folded.relations) {
      mainPathRelationKeys.add(relationKey(relation));
    }

    return {
      id: `main_path_${index + 1}`,
      path_type: item.draft.path_type,
      path_status: item.score.confidence === "low" ? "low_confidence" : "partial_candidate",
      nodes: item.folded.nodes,
      relations: item.folded.relations,
      folded_steps: foldedStepsFromSideRelations(input.relations, item.folded.nodes, item.folded.relations),
      side_relation_ids: [],
      score: item.score.score,
      confidence: item.score.confidence,
      score_breakdown: item.score.score_breakdown,
      confidence_reason: item.score.confidence_reason,
      coverage: {
        complete: false,
        reason: "V0.4 返回候选主链路，未声明为完整运行时调用链。",
        missing_segments: []
      },
      summary: summarizePath(item.folded.nodes, item.folded.relations)
    };
  });

  const split = splitSideRelations({
    relations: input.relations,
    mainPathRelationKeys
  });
  const side_relations = split.sideRelations;
  for (const mainPath of main_paths) {
    mainPath.side_relation_ids = side_relations.map((relation) => relation.id);
  }

  const diagnostics: Diagnostic[] = [...input.diagnostics];
  if (main_paths.length > 0) {
    diagnostics.push({
      level: "info",
      code: "MAIN_PATHS_BUILT",
      message: `已生成 ${main_paths.length} 条候选主链路。`
    });
    if (main_paths.some((path) => path.folded_steps.length > 0)) {
      diagnostics.push({
        level: "info",
        code: "MAIN_PATH_FOLDED_DETAILS",
        message: "部分校验、异常、锁或工具细节已折叠到 folded_steps。"
      });
    }
  } else {
    diagnostics.push({
      level: "warning",
      code: "MAIN_PATH_NO_STRONG_RELATION_CHAIN",
      message: "未能从当前关系证据中构建稳定主链路；建议提高 relationBudget、缩小 query 或使用更精确方法签名。"
    });
  }

  return {
    main_paths,
    side_relations,
    diagnostics
  };
}

function dedupeScoredDrafts<T extends { folded: { nodes: CodeLocation[]; relations: CodeRelation[] } }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.folded.relations.map(relationKey).join("|")}\n${summarizePath(item.folded.nodes, item.folded.relations)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildUpstreamDrafts(anchor: CodeLocation, input: BuildMainPathsInput, nodesById: Map<string, CodeLocation>): PathDraft[] {
  return upstreamPaths(anchor.id, input.relations, nodesById, input.depth).map((path) => ({
    path_type: "upstream",
    nodes: path.nodes,
    relations: path.relations
  }));
}

function buildDownstreamDrafts(anchor: CodeLocation, input: BuildMainPathsInput, nodesById: Map<string, CodeLocation>): PathDraft[] {
  return downstreamPaths(anchor.id, input.relations, nodesById, input.depth).map((path) => ({
    path_type: "downstream",
    nodes: path.nodes,
    relations: path.relations
  }));
}

function buildMixedDrafts(anchor: CodeLocation, input: BuildMainPathsInput, nodesById: Map<string, CodeLocation>): PathDraft[] {
  const upstream = upstreamPaths(anchor.id, input.relations, nodesById, input.depth);
  const downstream = downstreamPaths(anchor.id, input.relations, nodesById, input.depth);
  const drafts: PathDraft[] = [];

  for (const up of upstream.length > 0 ? upstream.slice(0, 2) : [{ nodes: [anchor], relations: [] }]) {
    for (const down of downstream.length > 0 ? downstream.slice(0, 2) : [{ nodes: [anchor], relations: [] }]) {
      const nodes = [...up.nodes, ...down.nodes.slice(1)];
      const relations = [...up.relations, ...down.relations];
      if (relations.length > 0) {
        drafts.push({
          path_type: "mixed",
          nodes,
          relations
        });
      }
    }
  }

  return drafts;
}

function upstreamPaths(startId: string, relations: CodeRelation[], nodesById: Map<string, CodeLocation>, depth: number): StepPath[] {
  const paths: StepPath[] = [];
  walkUpstream({
    currentId: startId,
    nodes: [locationFor(startId, nodesById, relations)],
    relations: [],
    allRelations: relations,
    nodesById,
    depth,
    paths,
    visited: new Set([startId])
  });
  return paths.map((path) => ({
    nodes: [...path.nodes].reverse(),
    relations: [...path.relations].reverse()
  }));
}

function downstreamPaths(startId: string, relations: CodeRelation[], nodesById: Map<string, CodeLocation>, depth: number): StepPath[] {
  const paths: StepPath[] = [];
  walkDownstream({
    currentId: startId,
    nodes: [locationFor(startId, nodesById, relations)],
    relations: [],
    allRelations: relations,
    nodesById,
    depth,
    paths,
    visited: new Set([startId])
  });
  return paths;
}

function walkUpstream(input: WalkInput): void {
  if (input.relations.length >= input.depth) {
    if (input.relations.length > 0) input.paths.push({ nodes: input.nodes, relations: input.relations });
    return;
  }

  const nextRelations = input.allRelations
    .filter((relation) => relation.to === input.currentId && isMainPathRelation(relation))
    .sort((left, right) => relationExpansionPriority(right) - relationExpansionPriority(left));

  if (nextRelations.length === 0) {
    if (input.relations.length > 0) input.paths.push({ nodes: input.nodes, relations: input.relations });
    return;
  }

  for (const relation of nextRelations.slice(0, 4)) {
    if (input.visited.has(relation.from)) continue;
    input.visited.add(relation.from);
    walkUpstream({
      ...input,
      currentId: relation.from,
      nodes: [...input.nodes, locationFor(relation.from, input.nodesById, input.allRelations, relation)],
      relations: [...input.relations, relation],
      visited: input.visited
    });
    input.visited.delete(relation.from);
  }
}

function walkDownstream(input: WalkInput): void {
  if (input.relations.length >= input.depth) {
    if (input.relations.length > 0) input.paths.push({ nodes: input.nodes, relations: input.relations });
    return;
  }

  const nextRelations = input.allRelations
    .filter((relation) => relation.from === input.currentId && isMainPathRelation(relation))
    .sort((left, right) => relationExpansionPriority(right) - relationExpansionPriority(left));

  if (nextRelations.length === 0) {
    if (input.relations.length > 0) input.paths.push({ nodes: input.nodes, relations: input.relations });
    return;
  }

  for (const relation of nextRelations.slice(0, 4)) {
    if (input.visited.has(relation.to)) continue;
    input.visited.add(relation.to);
    walkDownstream({
      ...input,
      currentId: relation.to,
      nodes: [...input.nodes, locationFor(relation.to, input.nodesById, input.allRelations, relation)],
      relations: [...input.relations, relation],
      visited: input.visited
    });
    input.visited.delete(relation.to);
  }
}

type WalkInput = {
  currentId: string;
  nodes: CodeLocation[];
  relations: CodeRelation[];
  allRelations: CodeRelation[];
  nodesById: Map<string, CodeLocation>;
  depth: number;
  paths: StepPath[];
  visited: Set<string>;
};

function isMainPathRelation(relation: CodeRelation): boolean {
  if (relationTouchesTest(relation)) return false;
  return relation.relation_type === "calls"
    || relation.relation_type === "method_implements"
    || relation.relation_type === "method_overrides"
    || relation.relation_type === "implements"
    || relation.relation_type === "maps_to_sql"
    || relation.relation_type === "uses_table"
    || relation.relation_type === "has_method";
}

function foldedStepsFromSideRelations(allRelations: CodeRelation[], mainNodes: CodeLocation[], mainRelations: CodeRelation[]): MainPath["folded_steps"] {
  const mainRelationKeys = new Set(mainRelations.map((relation) => relationKey(relation)));
  const nodesById = buildNodesById(mainNodes, allRelations);
  const folded = foldPathDetails({
    nodes: [...nodesById.values()],
    relations: allRelations.filter((relation) => !mainRelationKeys.has(relationKey(relation)))
  });
  return folded.folded_steps;
}

function buildNodesById(anchors: CodeLocation[], relations: CodeRelation[]): Map<string, CodeLocation> {
  const nodesById = new Map<string, CodeLocation>();
  for (const anchor of anchors) nodesById.set(anchor.id, anchor);
  for (const relation of relations) {
    if (!nodesById.has(relation.from)) nodesById.set(relation.from, locationFor(relation.from, nodesById, relations, relation));
    if (!nodesById.has(relation.to)) nodesById.set(relation.to, locationFor(relation.to, nodesById, relations, relation));
  }
  return nodesById;
}

function locationFor(id: string, nodesById: Map<string, CodeLocation>, relations: CodeRelation[], relation?: CodeRelation): CodeLocation {
  const existing = nodesById.get(id);
  if (existing) return existing;

  const evidence = relation?.evidence[0] ?? relations.find((item) => item.from === id || item.to === id)?.evidence[0];
  const file = fileFromId(id) ?? evidence?.file ?? "unknown";
  return {
    id,
    project: "unknown",
    file,
    start_line: evidence?.line,
    end_line: evidence?.line,
    symbol: symbolFromId(id),
    language: languageFromFile(file),
    location_type: locationTypeFromFile(file),
    snippet: evidence?.snippet ?? "",
    match_reason: `GitNexus 关系端点 ${symbolFromId(id)}`,
    score: 0.6,
    confidence: relation?.confidence ?? "medium",
    source: evidence?.source ?? "gitnexus"
  };
}

function summarizePath(nodes: CodeLocation[], relations: CodeRelation[]): string {
  const labels: string[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    labels.push(summaryLabel(nodes[index]));
    const relation = relations[index];
    const next = nodes[index + 1];
    if (relation && next) labels.push(summaryArrow(nodes[index].id, next.id, relation));
  }
  return labels.join(" ");
}

function summaryArrow(currentId: string, nextId: string, relation: CodeRelation): string {
  if (relation.from === currentId && relation.to === nextId) return `--${relation.relation_type}-->`;
  if (relation.to === currentId && relation.from === nextId) return `<--${relation.relation_type}--`;
  return `--${relation.relation_type}-->`;
}

function summaryLabel(node: CodeLocation): string {
  const routeMethodLabel = routeMethodLabelFromLocation(node);
  if (routeMethodLabel) return routeMethodLabel;
  return symbolFromId(node.id) || node.symbol || node.id;
}

function routeMethodLabelFromLocation(node: CodeLocation): string | undefined {
  const routeSymbol = [node.symbol, symbolFromId(node.id)].find((value) => value?.startsWith("/"));
  if (!routeSymbol) return undefined;
  const pathSource = `${node.file}\n${node.id}`;
  const javaFile = pathSource.match(/([A-Za-z_$][\w$]*\.java)/)?.[1];
  const routeSegments = routeSymbol.split("/").filter(Boolean);
  const fallbackClassName = routeSegments.length >= 2
    ? `${toPascalCase(routeSegments[routeSegments.length - 2])}Controller`
    : undefined;
  const className = javaFile?.replace(/\.java$/, "") ?? fallbackClassName;
  const methodName = node.snippet.match(/\b(?:public|private|protected)?\s*[\w<>\[\], ?]+\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1]
    ?? routeSegments.at(-1);
  if (!className || !methodName) return undefined;
  return `${className}.${methodName}`;
}

function toPascalCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function fileFromPath(file: string): string | undefined {
  return file.replaceAll("\\", "/").split("/").at(-1);
}

function symbolFromId(id: string): string {
  const symbol = id.split(":").at(-1)?.replace(/#\d+$/, "") ?? id;
  if (id.startsWith("Method:") || id.startsWith("Constructor:")) {
    const match = symbol.match(/([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)$/);
    return match?.[1] ?? symbol;
  }
  if (id.startsWith("Class:") || id.startsWith("Interface:")) {
    return symbol.match(/([A-Za-z_$][\w$]*)$/)?.[1] ?? symbol;
  }
  return symbol;
}

function fileFromId(id: string): string | undefined {
  return id.split(":")[1];
}

function languageFromFile(file: string): CodeLocation["language"] {
  if (file.endsWith(".java")) return "java";
  if (file.endsWith(".xml")) return "xml";
  if (file.endsWith(".sql")) return "sql";
  return "unknown";
}

function locationTypeFromFile(file: string): CodeLocation["location_type"] {
  if (file.includes("/controller/") || file.includes("/web/")) return "controller";
  if (file.includes("/mapper/")) return "mapper";
  if (file.includes("/repository/") || file.includes("/dao/")) return "service";
  if (file.includes("/test/")) return "test";
  return "service";
}

function relationTouchesTest(relation: CodeRelation): boolean {
  return isTestLike(relation.from)
    || isTestLike(relation.to)
    || relation.evidence.some((evidence) => isTestLike(evidence.file));
}

function isTestLike(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized.includes("/src/test/")
    || normalized.startsWith("src/test/")
    || /\b\w+Test\b/.test(normalized);
}
