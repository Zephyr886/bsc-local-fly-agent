# Fly Profile v1 WP-07 训练与评估记录

日期：2026-09-20
仓库：`bsc-local-fly-agent`
工作包：WP-07（训练轮次与评估服务）

## 来源链与状态

新增 `TrainingService` 和 `EvaluationService`。每次运行同时写入 SQLite 与果蝇目录：

```text
flies/<flyId>/training-runs/<trainingRunId>/run.json
flies/<flyId>/evaluations/<evaluationId>.json
```

训练开始时固定 `flyId`、Profile revision/hash、token、mode、modelVersion、数据源和 checkpointBefore。SQLite 只提供终态更新方法，不允许改变这些身份字段。停止 live training 时的顺序是：

1. 停止 simulation 并等待 pending worker；
2. 请求 MaleCNS 保存并 park；
3. 验证 checkpoint 文件存在；
4. 验证相邻 metadata 的 flyId、revision、profileHash 和 modelVersion；
5. 计算 checkpoint 文件 SHA-256；
6. 最后把数据库和 `run.json` 标为 completed。

失败状态写入不包含堆栈或绝对路径的错误摘要。进程启动时，遗留的 running training 会变为 interrupted，遗留的 running evaluation 会变为 failed，绝不会伪装成 completed。

## Live observation

`live-observation` 继续复用 `SimulationRuntime`，但由训练服务生成明确的 trainingRunId。FlyManager 把该 ID 加入本次不可变 activation context，因此 session、SQLite 审计记录和训练文件使用同一个来源标识。数据源摘要记录 market mode、price method、pair 和 stage，不记录钱包、RPC 凭据或环境变量。

## Deterministic replay 数据集

回放数据只允许从 `data/replay-datasets` 中显式选择。加载器执行：

- 规范路径和 realpath 双重根目录检查，拒绝 `..` 与符号链接逃逸；
- 最大 16 MiB；
- 严格 JSON、固定顶层字段和固定 observation 字段；
- token、时间、history、市场/流量/流动性数值验证；
- observation 时间严格递增；
- 记录原始文件 `sha256:`、相对路径和字节数。

格式标识为 `flap-deterministic-replay` v1。每个 observation 包含固定时间、价格 history、market、flow 和 token 快照；数据集同时声明费用、滑点、Gas 和初始模拟资产假设。回放不连接网络，也不接收客户端磁盘路径作为 checkpoint。

## 冻结评估

评估要求活动 checkpoint 已存在且 metadata 与当前 activation context 一致。服务在果蝇 evaluations 目录创建仅供本次运行的临时副本，使用独立 MaleCNS client，并强制每个 worker 请求 `learning=false`。评估完成后：

- 对原始 checkpoint 重新计算 SHA-256，必须与评估前相同；
- 临时 checkpoint 和 metadata 目录被删除；
- SQLite 和 evaluation JSON 记录数据集哈希、Profile hash、checkpoint hash、冻结状态和指标。

确定性摘要哈希覆盖决策、收益、回撤、动作频率和模拟假设；神经计算耗时与峰值 RSS 仍保留在 `performance`，但不进入确定性摘要哈希，因为它们属于机器运行诊断。

## 指标

训练与评估记录首批指标：

- observation 数量；
- BUY / SELL / HOLD 数量；
- Hybrid 放行数量；
- 阻断原因计数；
- 模拟净值与最大回撤；
- 每小时动作频率；
- 平均 utility；
- 平均神经计算耗时和峰值 RSS；
- 样本数、费用、滑点、Gas 和 simulation-only 假设。

SimulationRuntime 为每个决策增加最小 `runtimeMetrics` 审计快照，用于 live run 的净值、回撤和性能汇总；不改变原版 Hybrid V2 源码。

## 验收结果

- `npm test`：82 个 Node 测试通过，0 个跳过。
- 专项覆盖 live run 来源冻结与保存顺序、崩溃恢复、本地回放路径/哈希、checkpoint 来源链、冻结评估以及重复确定性摘要。
- 真实 MaleCNS 临时目录探针：从同一 checkpoint 的两个副本回放相同 observation，确定性摘要哈希一致；被测基准 checkpoint 前后 SHA-256 一致；所有评估请求均为 `learning=false`。
- 未修改真实用户 checkpoint、生产数据、钱包或链上状态；未连接生产服务。

WP-07 提供服务层与审计模型。HTTP 路由、结构化错误和请求体边界属于 WP-08。
