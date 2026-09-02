import { describe, expect, it } from "vitest";
import {
  CodeRelationSchema,
  CodePathSchema,
  ExploreResponseSchema,
  SearchResponseSchema
} from "../src/schemas.js";

const validSearchResponse = (): any => ({
  request_id: "req-1",
  project: {
    name: "trade-service",
    path: "/repo/trade-service",
    stack: "java-spring-mybatis",
    commit_hash: "abc123",
    dirty: false
  },
  query: { type: "route", text: "/api/trade/order/detail" },
  index_status: { state: "ready" },
  summary: "命中订单详情接口入口。",
  locations: [
    {
      id: "loc-1",
      project: "trade-service",
      file: "src/main/java/com/example/trade/web/OrderController.java",
      start_line: 17,
      end_line: 20,
      symbol: "OrderController.detail",
      language: "java",
      location_type: "controller",
      snippet: "@GetMapping(\"/detail\")",
      match_reason: "接口路径精确匹配。",
      score: 0.98,
      confidence: "high",
      source: "java_index"
    }
  ],
  relations: [],
  diagnostics: []
});

describe("SearchResponseSchema", () => {
  it("accepts a valid generic code search response", () => {
    const parsed = SearchResponseSchema.parse(validSearchResponse());

    expect(parsed.locations[0].confidence).toBe("high");
  });

  it("accepts a code location without line numbers", () => {
    const response = validSearchResponse();
    delete response.locations[0].start_line;
    delete response.locations[0].end_line;

    const parsed = SearchResponseSchema.parse(response);

    expect(parsed.locations[0].start_line).toBeUndefined();
    expect(parsed.locations[0].end_line).toBeUndefined();
  });

  it("rejects a code location without score", () => {
    const response = validSearchResponse();
    delete response.locations[0].score;

    expect(() => SearchResponseSchema.parse(response)).toThrow();
  });

  it("rejects a code location score greater than 1", () => {
    const response = validSearchResponse();
    response.locations[0].score = 1.01;

    expect(() => SearchResponseSchema.parse(response)).toThrow();
  });

  it("accepts boundary scores 0 and 1", () => {
    const zeroScoreResponse = validSearchResponse();
    zeroScoreResponse.locations[0].score = 0;
    const oneScoreResponse = validSearchResponse();
    oneScoreResponse.locations[0].score = 1;

    expect(SearchResponseSchema.parse(zeroScoreResponse).locations[0].score).toBe(0);
    expect(SearchResponseSchema.parse(oneScoreResponse).locations[0].score).toBe(1);
  });

  it("rejects a code location with end_line before start_line", () => {
    const response = validSearchResponse();
    response.locations[0].start_line = 20;
    response.locations[0].end_line = 17;

    expect(() => SearchResponseSchema.parse(response)).toThrow();
  });

  it("rejects an unsupported source", () => {
    const response = validSearchResponse();
    response.locations[0].source = "online_troubleshoot";

    expect(() => SearchResponseSchema.parse(response)).toThrow();
  });

  it("rejects unknown fields", () => {
    const topLevelResponse = validSearchResponse();
    topLevelResponse.online_troubleshoot_case_id = "case-1";
    const locationResponse = validSearchResponse();
    locationResponse.locations[0].online_troubleshoot_case_id = "case-1";

    expect(() => SearchResponseSchema.parse(topLevelResponse)).toThrow();
    expect(() => SearchResponseSchema.parse(locationResponse)).toThrow();
  });

  it("preserves query hints", () => {
    const response = validSearchResponse();
    response.query.hints = {
      class_name: "OrderController",
      method_name: "detail",
      file: "OrderController.java",
      line: 17,
      trace_source: "access_log"
    };

    const parsed = SearchResponseSchema.parse(response);

    expect(parsed.query.hints).toEqual(response.query.hints);
  });

  it("preserves diagnostic suggested_action", () => {
    const response = validSearchResponse();
    response.diagnostics = [
      {
        level: "warning",
        code: "LOW_CONFIDENCE",
        message: "匹配结果置信度较低。",
        suggested_action: "请补充类名或方法名。"
      }
    ];

    const parsed = SearchResponseSchema.parse(response);

    expect(parsed.diagnostics[0].suggested_action).toBe("请补充类名或方法名。");
  });

  it("preserves raw relation types on relations and evidence", () => {
    const response = validSearchResponse();
    response.relations = [
      {
        from: "Class:src/A.java:A",
        to: "Class:src/Anno.java:Anno",
        relation_type: "references",
        raw_relation_type: "annotated_by",
        confidence: "medium",
        evidence: [
          {
            file: "src/Anno.java",
            snippet: "",
            source: "gitnexus",
            extracted_by: "gitnexus.context.outgoing",
            raw_relation_type: "annotated_by"
          }
        ]
      }
    ];

    const parsed = SearchResponseSchema.parse(response);

    expect(parsed.relations[0].raw_relation_type).toBe("annotated_by");
    expect(parsed.relations[0].evidence[0].raw_relation_type).toBe("annotated_by");
  });
});

describe("CodeRelationSchema", () => {
  it("accepts method_implements relation and raw relation type", () => {
    const parsed = CodeRelationSchema.parse({
      from: "Method:src/A.java:A.run#0",
      to: "Method:src/I.java:I.run#0",
      relation_type: "method_implements",
      raw_relation_type: "method_implements",
      confidence: "medium",
      evidence: [
        {
          file: "src/I.java",
          snippet: "",
          source: "gitnexus",
          extracted_by: "gitnexus.context.incoming",
          raw_relation_type: "method_implements"
        }
      ]
    });

    expect(parsed.relation_type).toBe("method_implements");
    expect(parsed.raw_relation_type).toBe("method_implements");
    expect(parsed.evidence[0].raw_relation_type).toBe("method_implements");
  });
});

describe("ExploreResponseSchema", () => {
  it("validates candidate code paths with explicit status and evidence sources", () => {
    expect(CodePathSchema.parse({
      id: "path_1",
      path_type: "downstream",
      path_status: "candidate",
      nodes: [
        {
          id: "Method:src/A.java:A.run#0",
          project: "p",
          file: "src/A.java",
          start_line: 10,
          symbol: "A.run",
          language: "java",
          location_type: "service",
          snippet: "void run() {}",
          match_reason: "anchor",
          score: 0.8,
          confidence: "medium",
          source: "gitnexus"
        }
      ],
      relations: [],
      depth: 0,
      confidence: "medium",
      evidence_sources: ["gitnexus"],
      diagnostics: [],
      summary: "候选路径：A.run"
    })).toMatchObject({
      path_status: "candidate",
      evidence_sources: ["gitnexus"]
    });
  });

  it("validates explore responses separately from search responses", () => {
    expect(ExploreResponseSchema.parse({
      request_id: "req_1",
      project: {
        name: "p",
        path: "/repo",
        stack: "java-generic",
        dirty: false
      },
      query: {
        type: "symbol",
        text: "A.run"
      },
      index_status: {
        state: "ready"
      },
      anchors: [],
      relations: [],
      candidate_paths: [],
      diagnostics: [
        {
          level: "info",
          code: "PATH_VERIFICATION_SKIPPED",
          message: "v0.3 返回候选路径，不把候选路径标记为完整调用链。"
        }
      ],
      summary: "未找到候选路径。"
    })).toMatchObject({
      request_id: "req_1",
      candidate_paths: []
    });
  });

  it("validates v0.4 main path fields for upstream agent consumption", () => {
    const target = {
      id: "Method:src/main/java/com/example/trade/service/OrderService.java:OrderService.detail#0",
      project: "p",
      file: "src/main/java/com/example/trade/service/OrderService.java",
      start_line: 12,
      end_line: 16,
      symbol: "OrderService.detail",
      language: "java",
      location_type: "service",
      snippet: "OrderDetail detail(String id) { return mapper.select(id); }",
      match_reason: "anchor",
      score: 0.8,
      confidence: "medium",
      source: "gitnexus"
    };
    const mapper = {
      id: "Method:src/main/java/com/example/trade/mapper/OrderMapper.java:OrderMapper.select#0",
      project: "p",
      file: "src/main/java/com/example/trade/mapper/OrderMapper.java",
      start_line: 8,
      end_line: 8,
      symbol: "OrderMapper.select",
      language: "java",
      location_type: "mapper",
      snippet: "OrderDetail select(String id);",
      match_reason: "relation endpoint",
      score: 0.6,
      confidence: "medium",
      source: "gitnexus"
    };
    const relation = {
      from: target.id,
      to: mapper.id,
      relation_type: "calls",
      raw_relation_type: "calls",
      confidence: "medium",
      evidence: [
        {
          file: target.file,
          snippet: "mapper.select(id)",
          source: "gitnexus",
          extracted_by: "gitnexus.context.outgoing",
          raw_relation_type: "calls"
        }
      ]
    };

    const parsed = ExploreResponseSchema.parse({
      request_id: "req_1",
      project: {
        name: "p",
        path: "/repo",
        stack: "java-generic",
        dirty: false
      },
      query: {
        type: "symbol",
        text: "OrderService.detail"
      },
      index_status: {
        state: "ready"
      },
      anchors: [target],
      relations: [relation],
      candidate_paths: [],
      main_paths: [
        {
          id: "main_path_1",
          path_type: "target_to_data",
          path_status: "partial_candidate",
          nodes: [target, mapper],
          relations: [relation],
          folded_steps: [
            {
              relation_id: "folded_relation_1",
              fold_type: "validation",
              summary: "checkParam 被折叠为参数校验步骤",
              evidence: []
            }
          ],
          side_relation_ids: ["side_relation_1"],
          score: 0.72,
          confidence: "medium",
          score_breakdown: [
            {
              name: "CALL_EDGE",
              weight: 0.45,
              reason: "calls 边适合作为主链路骨架。"
            }
          ],
          confidence_reason: "目标方法到 mapper 存在连续 calls 证据。",
          coverage: {
            complete: false,
            reason: "命中深度预算，主链路可用但不是完整调用图。",
            missing_segments: ["mapper 到 SQL 的静态边未返回"]
          },
          summary: "OrderService.detail --calls--> OrderMapper.select"
        }
      ],
      side_relations: [
        {
          id: "side_relation_1",
          side_type: "utility_detail",
          reason: "工具方法不进入主链路骨架。",
          ...relation,
          to: "Method:src/main/java/com/example/trade/util/LockUtil.java:LockUtil.lock#0"
        }
      ],
      coverage: {
        complete: false,
        relation_budget_reached: false,
        fanout_limit_reached: false,
        depth_limit_reached: true,
        anchor_ambiguous: false,
        used_sources: ["gitnexus"],
        omitted_relation_count: 1,
        note: "本次返回预算内候选主链路，relations 不是完整图谱。"
      },
      budget_summary: {
        requested_depth: 2,
        requested_limit: 20,
        relation_budget: 80,
        explored_relation_count: 2,
        returned_relation_count: 1,
        main_path_count: 1,
        side_relation_count: 1,
        folded_step_count: 1,
        budget_hit: true,
        budget_hit_reasons: ["depth"]
      },
      diagnostics: [
        {
          level: "info",
          code: "MAIN_PATHS_BUILT",
          message: "已生成 1 条候选主链路。"
        }
      ],
      summary: "找到 1 个探索起点，1 条关系证据，1 条候选主链路。"
    });

    expect(parsed.main_paths[0].summary).toBe("OrderService.detail --calls--> OrderMapper.select");
    expect(parsed.coverage.complete).toBe(false);
    expect(parsed.budget_summary.main_path_count).toBe(1);
  });
});
