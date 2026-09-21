# Fly Profile v1 字段手册

状态：本地 v1 RC，2026-09-20。Schema 的唯一机器真相是 `schemas/fly-profile-v1.schema.json`，System Policy 的唯一机器真相是 `src/policy/system-policy.mjs`。

> **重要：默认值和内置预设只提供可复现的实验起点，不代表盈利能力、未来收益、低风险或实盘适用性。训练和评估结果也不是收益承诺。**

Profile 使用 `flap.ai/v1` / `FlyProfile`。`profileHash` 是 canonical `spec` 的 SHA-256；显示名称、说明和标签不进入行为哈希。每次保存 Profile 或 metadata 都创建新的不可变 revision，回滚也是复制旧内容生成新 revision。

## 生效模式

| 模式 | 含义 |
|---|---|
| `hot` | 只影响显示 metadata，可立即生效。 |
| `next-start` | 保存后等待下一次启动；当前运行不被悄悄改写。 |
| `next-training-run` | 下一训练轮次冻结新值；已经开始的轮次继续使用启动时 revision。 |
| `fork-required` | 兼容身份不可在原果蝇上原地改变；需要克隆/新建兼容果蝇。 |

## Metadata

| 字段 | 约束 | 生效 |
|---|---|---|
| `metadata.name` | 1–80 个字符 | `hot` |
| `metadata.description` | 最多 500 个字符 | `hot` |
| `metadata.tags` | 最多 20 个唯一标签；每个 1–32 字符且首尾不能是空白 | `hot` |
| `metadata.flyId` | UUID；创建后不变 | 身份字段 |
| `metadata.revision` | 从 1 单调递增 | 并发控制字段 |
| `metadata.profileHash` | `sha256:` 加 64 位小写十六进制 | 由 canonical `spec` 计算 |

## Compatibility 与 Universe

表中默认值使用 JSON 字面量，方便与 Schema 和源码逐项核对。

| 字段 | 默认值 | 类型与范围 / 含义 | 生效 |
|---|---|---|---|
| `compatibility.brainModel` | `"malecns-v1"` | 固定 MaleCNS v1 模型 | `fork-required` |
| `compatibility.strategyEngine` | `"hybrid-v2-profiled"` | 固定 Profile 化 Hybrid V2 | `fork-required` |
| `compatibility.profileSchemaVersion` | `1` | 固定 Profile Schema 版本 | `fork-required` |
| `universe.chainId` | `56` | 固定 BNB Smart Chain | `next-start` |
| `universe.tokenBinding` | `"device-selected"` | `device-selected` 或 `fixed` | `next-start` |
| `universe.tokenAddress` | `null` | device-selected 必须为 null；fixed 必须为非零 EVM 地址 | `next-start` |
| `universe.quotePreference` | `"USDT"` | 固定 USDT 报价偏好 | `next-start` |

## Perception 与 Learning

| 字段 | 默认值 | 类型与范围 / 含义 | 生效 |
|---|---|---|---|
| `perception.marketRefreshMs` | `1000` | 整数 1000–60000 ms；市场刷新间隔 | `next-start` |
| `perception.neuralDecisionIntervalSeconds` | `10` | 整数 10–3600 s；神经决策间隔 | `next-start` |
| `perception.historyCandles` | `36` | 整数 36–360；感觉输入历史 K 线数 | `next-start` |
| `perception.minimumHealthySamples` | `60` | 整数 60–600；数据健康门最少样本 | `next-start` |
| `perception.marketMaxAgeSeconds` | `15` | 整数 5–60 s；市场样本最大年龄 | `next-start` |
| `perception.flowMaxAgeSeconds` | `20` | 整数 5–120 s；资金流样本最大年龄 | `next-start` |
| `learning.enabled` | `true` | boolean；关闭时冻结学习 | `next-training-run` |
| `learning.neuralMs` | `500` | 数值 100–2000 ms，0.1 的倍数；每次神经模拟时长 | `next-start` |
| `learning.decoderThresholdHz` | `2` | 数值 0.1–50 Hz；神经输出解码阈值 | `next-start` |
| `learning.checkpointEverySeconds` | `60` | 整数 30–3600 s；自动 checkpoint 周期 | `next-start` |

## Reward

| 字段 | 默认值 | 类型与范围 / 含义 | 生效 |
|---|---|---|---|
| `reward.settlementHorizonsSeconds` | `[300,900,3600]` | 1–5 个唯一、严格递增整数；每项 300–86400 s | `next-training-run` |
| `reward.primaryHorizonSeconds` | `3600` | 整数 300–86400 s，且必须出现在 settlement horizons | `next-training-run` |
| `reward.returnScale` | `0.05` | 数值 0.001–1；回报归一化尺度 | `next-training-run` |
| `reward.followWeight` | `0.65` | 数值 0–1；跟随方向奖励权重 | `next-training-run` |
| `reward.positionWeight` | `0.2` | 数值 0–1；位置奖励权重 | `next-training-run` |
| `reward.favorableWeight` | `0.1` | 数值 0–1；有利波动权重 | `next-training-run` |
| `reward.drawdownWeight` | `-0.05` | 数值 -1–0；回撤惩罚权重 | `next-training-run` |
| `reward.pulseDeadband` | `0` | 数值 0–0.5；脉冲死区 | `next-training-run` |
| `reward.minimumPulseStrength` | `0.05` | 数值 0–1；最小有效脉冲强度 | `next-training-run` |

四个 reward 权重绝对值之和不得超过 1.5，且至少一个正权重必须大于 0。

## Strategy

| 字段 | 默认值 | 类型与范围 / 含义 | 生效 |
|---|---|---|---|
| `strategy.quantThreshold` | `0.62` | 数值 0.5–0.95；量化门槛 | `next-start` |
| `strategy.positionBuyCeiling` | `0.55` | 数值 0.05–0.95；允许 BUY 的位置上限 | `next-start` |
| `strategy.positionBurnFloor` | `0.55` | 数值 0.05–0.95；允许 BURN 的位置下限 | `next-start` |
| `strategy.buyMaxReturn60s` | `0` | 数值 -0.5–0.5；BUY 的 60 秒回报上限 | `next-start` |
| `strategy.buyMaxReturn300s` | `0` | 数值 -0.5–0.5；BUY 的 300 秒回报上限 | `next-start` |
| `strategy.buyMaxDistanceFromLow300s` | `0.02` | 数值 0–0.5；BUY 距 300 秒低点上限 | `next-start` |
| `strategy.burnMinReturn60s` | `0.02` | 数值 -0.5–0.5；BURN 的 60 秒最小回报 | `next-start` |
| `strategy.burnMinReboundFromLow300s` | `0.02` | 数值 0–0.5；BURN 距 300 秒低点最小反弹 | `next-start` |
| `strategy.frequencyActiveThreshold` | `0.5` | 数值 0.05–0.95；活跃/安静频率分区阈值 | `next-start` |
| `strategy.activeWindowSeconds` | `300` | 整数 60–86400 s；活跃窗口 | `next-start` |
| `strategy.activeMinActions` | `1` | 整数 0–100；活跃窗口最少动作 | `next-start` |
| `strategy.activeMaxActions` | `10` | 整数 1–100，且不得小于 activeMinActions | `next-start` |
| `strategy.quietWindowSeconds` | `3600` | 整数 60–86400 s；安静窗口 | `next-start` |
| `strategy.quietMinActions` | `1` | 整数 0–100；安静窗口最少动作 | `next-start` |
| `strategy.quietMaxActions` | `5` | 整数 1–100，且不得小于 quietMinActions | `next-start` |
| `strategy.twapIntervalSeconds` | `300` | 整数 60–86400 s；TWAP 动作间隔 | `next-start` |
| `strategy.buyPercent` | `2` | 数值 0–100%；BUY 比例 | `next-start` |
| `strategy.burnPercent` | `1` | 数值 0–100%；BURN 比例 | `next-start` |

## Risk 与 Effective Risk

| 字段 | 默认值 | 类型与范围 / 含义 | 生效 |
|---|---|---|---|
| `risk.liveTradingEnabled` | `false` | boolean；Profile 实盘开关仍受 System Policy 控制 | `next-start` |
| `risk.capitalBudgetPercent` | `10` | Profile 允许 0.1–25%；有效值不超过 10% | `next-start` |
| `risk.maxPoolParticipationPercent` | `0.5` | Profile 允许 0.01–2%；有效值不超过 0.5% | `next-start` |
| `risk.maxBuyBnb` | `"0.2"` | 大于 0 的十进制字符串；有效值不超过 0.2 BNB | `next-start` |
| `risk.slippagePercent` | `0.5` | 数值 0.1–15%；仍受交易构造安全边界约束 | `next-start` |
| `risk.dailyActionLimit` | `24` | Profile 允许整数 1–100；有效值不超过 24 | `next-start` |
| `risk.minimumActionIntervalSeconds` | `60` | 整数 60–86400 s；有效值不低于 60 s | `next-start` |

界面和 API 同时显示请求 Profile 与 Effective Risk。System Policy 只能把风险收紧，不能被 Profile 放宽；交易 deadline 固定为 300 秒。即便所有开关允许，实盘仍要求有效 Hybrid 提案、逐笔预览、密码和确认短语。

## Runtime

| 字段 | 默认值 | 类型与范围 / 含义 | 生效 |
|---|---|---|---|
| `runtime.autoSave` | `true` | 固定 true；自动保存运行记录 | `next-start` |
| `runtime.retainDecisionCount` | `500` | 整数 100–5000；保留决策数 | `next-start` |
| `runtime.retainOutcomeCount` | `1000` | 整数 100–10000；保留结果数 | `next-start` |
| `runtime.retainFeedbackCount` | `100` | 整数 10–1000；保留反馈数 | `next-start` |

## 四个内置预设

- `balanced-v1`：默认、均衡的实验起点。
- `conservative-v1`：更低动作频率与更紧风险参数。
- `active-research-v1`：研究用途的更活跃配置，仍受 System Policy 上限约束。
- `frozen-evaluation-v1`：关闭学习，用于可重复评估。

预设不是排名，不表示哪一只更可能盈利。比较预设时应使用同一确定性数据集、冻结的 Profile revision 和 checkpoint，并同时查看回撤、动作数与数据健康状态，而不是只看单一收益指标。
