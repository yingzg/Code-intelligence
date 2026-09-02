import { z } from "zod";

export const StackSchema = z.enum([
  "java-spring-mybatis",
  "java-spring",
  "java-dubbo-mybatis",
  "java-generic"
]);

export const QueryTypeSchema = z.enum([
  "route",
  "error",
  "sql",
  "table",
  "symbol",
  "keyword",
  "semantic",
  "call_chain"
]);

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);

export const IndexStateSchema = z.enum([
  "ready",
  "missing",
  "stale",
  "partial",
  "failed"
]);

export const SourceSchema = z.enum([
  "java_index",
  "gitnexus",
  "grep",
  "semantic_lite"
]);

export const LocationTypeSchema = z.enum([
  "route",
  "controller",
  "service",
  "dubbo_interface",
  "dubbo_provider",
  "mapper",
  "sql",
  "config",
  "constant",
  "enum",
  "exception",
  "log_statement",
  "test",
  "unknown"
]);

export const LanguageSchema = z.enum([
  "java",
  "xml",
  "properties",
  "yaml",
  "sql",
  "unknown"
]);

export const RelationTypeSchema = z.enum([
  "calls",
  "implements",
  "maps_to_sql",
  "handles_route",
  "throws",
  "logs",
  "reads_config",
  "uses_table",
  "contains",
  "has_method",
  "has_property",
  "imports",
  "accesses",
  "extends",
  "method_overrides",
  "method_implements",
  "typed_as",
  "references"
]);

export const DiagnosticCodeSchema = z.enum([
  "PROJECT_NOT_REGISTERED",
  "PROJECT_PATH_NOT_FOUND",
  "INDEX_MISSING",
  "INDEX_DISABLED",
  "INDEX_STALE",
  "GITNEXUS_UNAVAILABLE",
  "GITNEXUS_INDEX_MISSING",
  "GITNEXUS_REPO_AMBIGUOUS",
  "GITNEXUS_REPO_NOT_REGISTERED",
  "GITNEXUS_INDEX_STALE",
  "GITNEXUS_QUERY_FAILED",
  "GITNEXUS_RELATIONS_USED",
  "GITNEXUS_RELATIONS_UNAVAILABLE",
  "GITNEXUS_UNKNOWN_RELATION_TYPE",
  "ANCHOR_NOT_FOUND",
  "ANCHOR_AMBIGUOUS",
  "RELATION_LIMIT_REACHED",
  "FANOUT_LIMIT_REACHED",
  "DOWNSTREAM_DEPTH_LIMIT_REACHED",
  "UPSTREAM_DEPTH_LIMIT_REACHED",
  "PATH_EXTRACTION_PARTIAL",
  "PATH_TRUNCATED",
  "PATH_VERIFICATION_SKIPPED",
  "MAIN_PATHS_BUILT",
  "MAIN_PATH_LOW_CONFIDENCE",
  "MAIN_PATH_COVERAGE_PARTIAL",
  "MAIN_PATH_ANCHOR_AMBIGUOUS",
  "MAIN_PATH_BUDGET_REACHED",
  "MAIN_PATH_SIDE_RELATIONS_TRUNCATED",
  "MAIN_PATH_FOLDED_DETAILS",
  "MAIN_PATH_NO_STRONG_RELATION_CHAIN",
  "SEMANTIC_INDEX_MISSING",
  "GREP_FALLBACK_USED",
  "LOW_CONFIDENCE"
]);

export const ExploreDirectionSchema = z.enum(["upstream", "downstream", "both"]);
export const PathTypeSchema = z.enum(["upstream", "downstream", "entry_path", "data_path", "sql_path", "unknown"]);
export const PathStatusSchema = z.enum(["candidate", "verified", "partial", "truncated"]);
export const MainPathTypeSchema = z.enum(["upstream", "downstream", "entry_to_target", "target_to_data", "mixed"]);
export const MainPathStatusSchema = z.enum(["complete_candidate", "partial_candidate", "truncated", "low_confidence"]);
export const FoldTypeSchema = z.enum([
  "validation",
  "parameter_assembly",
  "exception",
  "lock",
  "dto_accessor",
  "utility",
  "test",
  "low_priority_detail"
]);
export const SideRelationTypeSchema = z.enum([
  "import_noise",
  "test_noise",
  "utility_detail",
  "dto_detail",
  "parallel_branch",
  "low_score_relation"
]);
export const CoverageSourceSchema = z.enum(["gitnexus", "java_index", "java-index", "grep", "semantic_lite", "manual"]);

export const QueryHintsSchema = z.object({
  class_name: z.string().optional(),
  method_name: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  trace_source: z.string().optional(),
  from_uid: z.string().optional(),
  from_file: z.string().optional(),
  to_uid: z.string().optional(),
  to_file: z.string().optional()
}).strict();

export const ProjectRefSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  stack: StackSchema,
  gitnexus_repo: z.string().optional(),
  commit_hash: z.string().optional(),
  dirty: z.boolean()
}).strict();

export const QueryRefSchema = z.object({
  type: QueryTypeSchema,
  text: z.string().min(1),
  hints: QueryHintsSchema.optional()
}).strict();

export const IndexStatusSchema = z.object({
  state: IndexStateSchema,
  indexed_at: z.string().optional(),
  indexed_commit: z.string().optional(),
  current_commit: z.string().optional(),
  message: z.string().optional(),
  suggested_command: z.string().optional()
}).strict();

export const CodeLocationSchema = z.object({
  id: z.string().min(1),
  project: z.string().min(1),
  file: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  symbol: z.string().optional(),
  language: LanguageSchema,
  location_type: LocationTypeSchema,
  snippet: z.string(),
  match_reason: z.string(),
  score: z.number().min(0).max(1),
  confidence: ConfidenceSchema,
  source: SourceSchema
}).strict().refine((location) => {
  if (location.start_line === undefined || location.end_line === undefined) {
    return true;
  }

  return location.end_line >= location.start_line;
}, {
  message: "end_line must be greater than or equal to start_line",
  path: ["end_line"]
});

export const EvidenceRefSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  snippet: z.string(),
  source: SourceSchema,
  extracted_by: z.string().min(1),
  raw_relation_type: z.string().optional()
}).strict();

export const CodeRelationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relation_type: RelationTypeSchema,
  raw_relation_type: z.string().optional(),
  confidence: ConfidenceSchema,
  evidence: z.array(EvidenceRefSchema)
}).strict();

export const DiagnosticSchema = z.object({
  level: z.enum(["info", "warning", "error"]),
  code: DiagnosticCodeSchema,
  message: z.string().min(1),
  suggested_action: z.string().optional()
}).strict();

export const SearchResponseSchema = z.object({
  request_id: z.string().min(1),
  project: ProjectRefSchema,
  query: QueryRefSchema,
  index_status: IndexStatusSchema,
  summary: z.string(),
  locations: z.array(CodeLocationSchema),
  relations: z.array(CodeRelationSchema),
  diagnostics: z.array(DiagnosticSchema)
}).strict();

export const CodePathSchema = z.object({
  id: z.string().min(1),
  path_type: PathTypeSchema,
  path_status: PathStatusSchema,
  nodes: z.array(CodeLocationSchema),
  relations: z.array(CodeRelationSchema),
  depth: z.number().int().min(0),
  confidence: ConfidenceSchema,
  evidence_sources: z.array(SourceSchema),
  diagnostics: z.array(DiagnosticSchema),
  summary: z.string().min(1)
}).strict();

export const ScoreFactorSchema = z.object({
  name: z.string().min(1),
  weight: z.number(),
  reason: z.string().min(1)
}).strict();

export const FoldedStepSchema = z.object({
  relation_id: z.string().min(1),
  fold_type: FoldTypeSchema,
  summary: z.string().min(1),
  evidence: z.array(EvidenceRefSchema).default([])
}).strict();

export const MainPathCoverageSchema = z.object({
  complete: z.boolean(),
  reason: z.string().min(1),
  missing_segments: z.array(z.string()).default([])
}).strict();

export const ExploreCoverageSchema = z.object({
  complete: z.boolean(),
  relation_budget_reached: z.boolean(),
  fanout_limit_reached: z.boolean(),
  depth_limit_reached: z.boolean(),
  anchor_ambiguous: z.boolean(),
  used_sources: z.array(CoverageSourceSchema),
  omitted_relation_count: z.number().int().nonnegative().optional(),
  note: z.string().min(1)
}).strict();

export const BudgetSummarySchema = z.object({
  requested_depth: z.number().int().nonnegative(),
  requested_limit: z.number().int().positive(),
  relation_budget: z.number().int().positive(),
  explored_relation_count: z.number().int().nonnegative(),
  returned_relation_count: z.number().int().nonnegative(),
  main_path_count: z.number().int().nonnegative(),
  side_relation_count: z.number().int().nonnegative(),
  folded_step_count: z.number().int().nonnegative(),
  budget_hit: z.boolean(),
  budget_hit_reasons: z.array(z.string())
}).strict();

export const SideRelationSchema = CodeRelationSchema.extend({
  id: z.string().min(1),
  side_type: SideRelationTypeSchema,
  reason: z.string().min(1)
}).strict();

export const MainPathSchema = z.object({
  id: z.string().min(1),
  path_type: MainPathTypeSchema,
  path_status: MainPathStatusSchema,
  nodes: z.array(CodeLocationSchema),
  relations: z.array(CodeRelationSchema),
  folded_steps: z.array(FoldedStepSchema).default([]),
  side_relation_ids: z.array(z.string()).default([]),
  score: z.number(),
  confidence: ConfidenceSchema,
  score_breakdown: z.array(ScoreFactorSchema),
  confidence_reason: z.string().min(1),
  coverage: MainPathCoverageSchema,
  summary: z.string().min(1)
}).strict();

export const ExploreResponseSchema = z.object({
  request_id: z.string().min(1),
  project: ProjectRefSchema,
  query: QueryRefSchema,
  index_status: IndexStatusSchema,
  anchors: z.array(CodeLocationSchema),
  relations: z.array(CodeRelationSchema),
  candidate_paths: z.array(CodePathSchema),
  main_paths: z.array(MainPathSchema).default([]),
  side_relations: z.array(SideRelationSchema).default([]),
  coverage: ExploreCoverageSchema.optional(),
  budget_summary: BudgetSummarySchema.optional(),
  diagnostics: z.array(DiagnosticSchema),
  summary: z.string()
}).strict();

export type Stack = z.infer<typeof StackSchema>;
export type QueryType = z.infer<typeof QueryTypeSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type CodeLocation = z.infer<typeof CodeLocationSchema>;
export type CodeRelation = z.infer<typeof CodeRelationSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type ExploreDirection = z.infer<typeof ExploreDirectionSchema>;
export type CodePath = z.infer<typeof CodePathSchema>;
export type ScoreFactor = z.infer<typeof ScoreFactorSchema>;
export type FoldedStep = z.infer<typeof FoldedStepSchema>;
export type SideRelation = z.infer<typeof SideRelationSchema>;
export type MainPath = z.infer<typeof MainPathSchema>;
export type ExploreCoverage = z.infer<typeof ExploreCoverageSchema>;
export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;
export type ExploreResponse = z.infer<typeof ExploreResponseSchema>;
