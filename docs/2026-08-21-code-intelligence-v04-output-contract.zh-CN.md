# Code Intelligence V0.4 输出字段契约

## 1. 契约目标

V0.4 的目标不是把更多 JSON 字段直接丢给上游 Agent，而是把 `explore` 的输出拆成“主消费层”和“证据审计层”，让人和 Agent 都知道默认该看什么、哪些结论可以说、哪些结论不能说。

核心原则：

- `main_paths` 是默认入口，用于线上排障、业务理解和流程图草稿。
- `relations` 是预算内关系证据子集，不代表完整 GitNexus 图谱。
- `candidate_paths` 是 V0.3 兼容字段，保留审计价值，不再建议作为第一消费入口。
- `coverage.complete=false` 时，不能宣称完整调用链。
- `diagnostics` 是降级和二次探索依据，不是普通日志。

## 2. 字段分层

主消费层：

```text
main_paths
coverage
diagnostics
summary
```

证据审计层：

```text
anchors
relations
side_relations
candidate_paths
budget_summary
```

上游 Agent 默认只需要先读主消费层。只有当 `coverage.complete=false`、`confidence=low`、用户要求展开细节，或需要复盘证据时，才继续读取证据审计层。

## 3. 新增字段总览

```json
{
  "main_paths": [],
  "side_relations": [],
  "coverage": {},
  "budget_summary": {}
}
```

`main_paths`：候选主链路。它是 Code Intelligence 从关系图谱邻域中筛出的业务阅读路径。

`side_relations`：未进入主链路骨架的辅助关系，例如 imports、测试调用、工具细节、DTO 访问。

`coverage`：本次探索覆盖度声明，告诉上游 Agent 是否命中预算、fanout、depth 或 anchor 歧义。

`budget_summary`：预算摘要，告诉上游 Agent 本次请求深度、展示限制、关系预算、返回主链路数量和预算命中原因。

## 4. main_paths

示例：

```json
{
  "id": "main_path_1",
  "path_type": "mixed",
  "path_status": "partial_candidate",
  "summary": "SettlementBillCommandProviderImpl.preCheckRebate --calls--> SettlementBillCommandServiceImpl.preCheckRebate --calls--> SettlementAndRebateServiceImpl.preCheckRebate",
  "confidence": "medium",
  "confidence_reason": "存在 calls 证据，可作为候选主链路优先验证。",
  "score": 1.25,
  "score_breakdown": [
    {
      "name": "RELATION_CALLS",
      "weight": 0.45,
      "reason": "calls 边的主链路基础权重为 0.45。"
    }
  ],
  "coverage": {
    "complete": false,
    "reason": "V0.4 返回候选主链路，未声明为完整运行时调用链。",
    "missing_segments": []
  },
  "folded_steps": [],
  "side_relation_ids": []
}
```

字段解释：

- `path_type`：`upstream`、`downstream`、`entry_to_target`、`target_to_data`、`mixed`。
- `path_status`：`complete_candidate`、`partial_candidate`、`truncated`、`low_confidence`。
- `summary`：人类可读主链路摘要，必须尽量带类名，避免裸 `preCheckRebate --calls--> preCheckRebate`。
- `confidence`：主链路适合作为优先验证路径的置信度，不是 Java 运行时绝对准确率。
- `score_breakdown`：评分解释，便于复盘为什么这条链路排在前面。
- `folded_steps`：折叠细节，例如参数校验、异常构造、锁、工具方法。
- `side_relation_ids`：可用于从 `side_relations` 找到相关辅助证据。

## 5. coverage

示例：

```json
{
  "complete": false,
  "relation_budget_reached": true,
  "fanout_limit_reached": false,
  "depth_limit_reached": true,
  "anchor_ambiguous": false,
  "used_sources": ["gitnexus"],
  "omitted_relation_count": 12,
  "note": "本次返回预算内候选主链路，relations 不是完整图谱。"
}
```

消费规则：

- `complete=true`：表示本次探索没有命中预算、fanout、depth 或 anchor 歧义，但仍建议结合代码证据验证业务结论。
- `complete=false`：表示结果可作为候选证据，不能宣称完整调用图。
- `relation_budget_reached=true`：说明 `relations` 被预算限制，不代表 `main_paths` 一定低置信。
- `fanout_limit_reached=true`：说明某个节点邻接关系过多，已按主链路优先级裁剪。
- `anchor_ambiguous=true`：说明起点不唯一，上游 Agent 应展示多个候选或要求用户补充类名/签名。

## 6. budget_summary

示例：

```json
{
  "requested_depth": 2,
  "requested_limit": 20,
  "relation_budget": 80,
  "explored_relation_count": 60,
  "returned_relation_count": 60,
  "main_path_count": 2,
  "side_relation_count": 8,
  "folded_step_count": 3,
  "budget_hit": true,
  "budget_hit_reasons": ["depth"]
}
```

注意：

- `requested_limit` 主要控制候选路径展示数量。
- `relation_budget` 控制内部关系探索预算。
- `budget_hit=true` 不等价于 `main_paths` 不可信；它只说明覆盖范围不完整。

## 7. side_relations

`side_relations` 保存未进入主链路骨架的关系。

常见类型：

- `import_noise`：imports 关系，只能证明静态依赖。
- `test_noise`：测试调用，不进入默认生产主链路。
- `utility_detail`：工具或锁相关细节。
- `dto_detail`：DTO、VO、字段访问细节。
- `parallel_branch`：并行分支或引用关系。
- `low_score_relation`：其他低分关系。

## 8. 上游 Agent 消费规则

默认流程：

1. 读取 `summary` 获取一句话概览。
2. 读取 `main_paths`，优先选择 `confidence=high` 或 `confidence=medium` 的链路。
3. 读取 `coverage` 判断是否需要谨慎表述。
4. 读取 `diagnostics` 判断是否需要提高预算、缩小 query 或二次 explore。
5. 需要展开细节时，通过 `folded_steps` 和 `side_relation_ids` 读取辅助证据。
6. 需要审计时读取 `relations` 和 `candidate_paths`。

可以说：

- “基于当前预算和 GitNexus 关系证据，优先主链路可能是……”
- “该链路为候选主链路，适合作为排障优先验证路径。”
- “本次命中 relation budget，关系集合不是完整图谱。”

不能说：

- “这就是完整调用链。”
- “没有出现在 relations 里的边一定不存在。”
- “main_paths 为空说明代码没有调用关系。”
- “confidence=medium 等于 Java 编译器级确定。”

## 9. 降级动作

看到 `MAIN_PATH_NO_STRONG_RELATION_CHAIN`：

- 缩小 query 到类名或方法签名。
- 增大 `relation_budget`。
- 分别尝试 `direction=upstream` 和 `direction=downstream`。

看到 `ANCHOR_AMBIGUOUS`：

- 展示多个候选 anchor。
- 要求用户补充类名、文件路径或方法签名。

看到 `RELATION_LIMIT_REACHED`：

- 不要直接否定主链路。
- 说明 `relations` 不完整。
- 必要时提高 `relation_budget` 后重试。

看到 `FANOUT_LIMIT_REACHED`：

- 说明某个节点关系过多，工具已按主链路优先级裁剪。
- 需要细节时围绕主链路节点二次 explore。

## 10. 与 V0.3 兼容

V0.4 保留 V0.3 字段：

- `anchors`
- `relations`
- `candidate_paths`
- `diagnostics`

但推荐消费入口变化为：

```text
V0.3: candidate_paths + relations
V0.4: main_paths + coverage + diagnostics
```

这不是删除关系证据，而是把“给人和 Agent 看的主链路”和“用于审计的底层关系证据”分层。
