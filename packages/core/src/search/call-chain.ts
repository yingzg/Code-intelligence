import { readGitState } from "../git.js";
import { createGitNexusAdapter } from "../gitnexus/adapter.js";
import {
  findUnknownGitNexusRelationTypes,
  gitNexusRelationsUnavailableDiagnostic,
  gitNexusRelationsUsedDiagnostic,
  gitNexusUnknownRelationTypesDiagnostic,
  mapGitNexusTraceToRelations
} from "../gitnexus/mapper.js";
import type { Diagnostic, SearchResponse, Stack } from "../schemas.js";
import { SearchResponseSchema } from "../schemas.js";

export async function traceCallChain(input: {
  home: string;
  project: string;
  root: string;
  gitnexusRepo?: string;
  from: string;
  to: string;
  fromUid?: string;
  fromFile?: string;
  toUid?: string;
  toFile?: string;
  depth?: number;
}): Promise<SearchResponse> {
  const currentGit = await readGitState(input.root);
  const diagnostics: Diagnostic[] = [];
  let relations: SearchResponse["relations"] = [];

  try {
    const trace = await createGitNexusAdapter().trace({
      repoPath: input.root,
      repo: input.gitnexusRepo ?? input.project,
      from: input.from,
      to: input.to,
      fromUid: input.fromUid,
      fromFile: input.fromFile,
      toUid: input.toUid,
      toFile: input.toFile,
      depth: input.depth
    });
    const traceDiagnostic = traceStatusDiagnostic(trace);
    if (traceDiagnostic) diagnostics.push(traceDiagnostic);
    relations = mapGitNexusTraceToRelations(trace);
  } catch (error) {
    diagnostics.push({
      level: "warning",
      code: "GITNEXUS_QUERY_FAILED",
      message: `GitNexus trace 查询失败：${errorMessage(error)}`
    });
  }

  if (relations.length > 0) {
    diagnostics.push(gitNexusRelationsUsedDiagnostic(relations.length));
    const unknownRelationTypes = findUnknownGitNexusRelationTypes(relations);
    if (unknownRelationTypes.length > 0) {
      diagnostics.push(gitNexusUnknownRelationTypesDiagnostic(unknownRelationTypes));
    }
  } else if (!diagnostics.some((item) =>
    item.code === "GITNEXUS_QUERY_FAILED" || item.code === "GITNEXUS_RELATIONS_UNAVAILABLE"
  )) {
    diagnostics.push(gitNexusRelationsUnavailableDiagnostic());
  }

  const response: SearchResponse = {
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
      type: "call_chain",
      text: `${input.from} -> ${input.to}`,
      hints: {
        trace_source: "gitnexus.trace",
        from_uid: input.fromUid,
        from_file: input.fromFile,
        to_uid: input.toUid,
        to_file: input.toFile
      }
    },
    index_status: {
      state: "ready",
      current_commit: currentGit.commit_hash
    },
    summary: relations.length > 0
      ? `找到 ${relations.length} 条调用链关系。`
      : "未发现高置信调用链关系。",
    locations: [],
    relations,
    diagnostics
  };

  return SearchResponseSchema.parse(response);
}

function traceStatusDiagnostic(value: unknown): Diagnostic | undefined {
  if (!isRecord(value)) return undefined;
  const status = stringField(value, "status");
  const suggestion = stringField(value, "suggestion");

  if (status === "not_found") {
    const message = stringField(value, "error") ?? "符号不存在或无法唯一解析。";
    return {
      level: "info",
      code: "GITNEXUS_RELATIONS_UNAVAILABLE",
      message: `GitNexus trace 未找到调用链：${message}`,
      suggested_action: suggestion
    };
  }

  if (status === "no_path") {
    return {
      level: "info",
      code: "GITNEXUS_RELATIONS_UNAVAILABLE",
      message: "GitNexus trace 未找到有向路径。",
      suggested_action: suggestion
    };
  }

  if (status === "ambiguous") {
    const message = stringField(value, "message") ?? "符号存在多个候选。";
    return {
      level: "info",
      code: "GITNEXUS_RELATIONS_UNAVAILABLE",
      message: `GitNexus trace 符号存在歧义：${message}`,
      suggested_action: suggestion ?? "使用 --from-uid/--to-uid 或 --from-file/--to-file 消除歧义。"
    };
  }

  return undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
