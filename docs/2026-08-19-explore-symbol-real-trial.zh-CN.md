# explore_symbol v0.3 真实项目试用记录

日期：2026-08-19

测试项目：

```text
/mnt/g/workSpace/mi-intl-scheme
```

Code Intelligence 注册项目：

```text
mi-intl-scheme
```

GitNexus repo label：

```text
mi-intl-scheme
```

## 1. 试用命令

```bash
code-intel explore mi-intl-scheme \
  --query SGPStoreIncentiveImeiConsumer \
  --type symbol \
  --direction downstream \
  --depth 2 \
  --limit 5
```

本地源码调试时等价命令：

```bash
node packages/cli/dist/index.js explore mi-intl-scheme \
  --query SGPStoreIncentiveImeiConsumer \
  --type symbol \
  --direction downstream \
  --depth 2 \
  --limit 5
```

## 2. 关键结果

### 2.1 anchor

默认排除测试代码后，anchor 落在生产代码：

```text
intl-scheme-job/src/main/java/com/xiaomi/intl/scheme/job/consumer/SGPStoreIncentiveImeiConsumer.java
SGPStoreIncentiveImeiConsumer.onMessage
```

这说明 `explore` 没有被 `src/test` 下的测试类抢走入口。

### 2.2 relations

本次得到 4 条 GitNexus 关系边，关键下游包括：

```text
SGPStoreIncentiveImeiConsumer.onMessage
  -> AbstractStoreIncentiveImeiConsumer.doHandlerMessage

AbstractStoreIncentiveImeiConsumer.doHandlerMessage
  -> StoreIncentiveCommandService.saveImeiDetailOfMessageConsumer

AbstractStoreIncentiveImeiConsumer.doHandlerMessage
  -> AbstractStoreIncentiveImeiConsumer.getStoreIncentiveCommandService

AbstractStoreIncentiveImeiConsumer.doHandlerMessage
  -> AbstractTask.LOGGER_TRACE
```

这说明 GitNexus anchor 后续 context 已经使用 UID 查询，而不是退化成短方法名 `onMessage`。

### 2.3 candidate_paths

本次生成 4 条候选路径，其中最有业务价值的一条是：

```text
onMessage
  --calls-->
AbstractStoreIncentiveImeiConsumer.doHandlerMessage
  --calls-->
StoreIncentiveCommandService.saveImeiDetailOfMessageConsumer
```

路径状态：

```text
path_status = candidate
confidence = medium
evidence_sources = gitnexus
```

注意：这条路径是候选路径，不是 trace 验证过的完整调用链。

## 3. diagnostics

本次返回的关键 diagnostics：

```text
INDEX_STALE
GITNEXUS_RELATIONS_USED
PATH_VERIFICATION_SKIPPED
```

含义：

| code | 含义 |
| --- | --- |
| `INDEX_STALE` | Code Intelligence 本地索引可能过期。本次 commit 相同但工作区 dirty，因此置信度要保守。 |
| `GITNEXUS_RELATIONS_USED` | 已经使用 GitNexus context 生成关系证据。 |
| `PATH_VERIFICATION_SKIPPED` | v0.3 返回候选路径，不把 context 拼出来的路径伪造成完整调用链。 |

## 4. 当前结论

本次试用验证了 v0.3 的两个关键修正：

- 默认排除测试代码，避免生产排障入口跑偏。
- GitNexus anchor 后续使用 UID 做 context，避免短方法名导致关系扩展失败。

当前 `explore` 已经可以用于“从一个线索出发，展开候选代码上下文”的场景。

## 5. 后续还要继续试用的 case

还需要继续沉淀 2 到 3 个稳定 demo case：

| case | 输入线索 | 目标 |
| --- | --- | --- |
| 接口链路理解 | 一个 Controller route | 展示 Controller -> Service -> Mapper/SQL |
| 错误码或日志排障 | 一个错误码或日志关键字 | 展示错误定义、抛出点、调用方候选 |
| 数据链路理解 | 一个表名或 SQL 片段 | 展示 Mapper SQL -> Mapper 方法 -> 上游 Service |

这些 case 完成后，再进入模拟面试会更稳。
