# 确定性回放数据集 v1 规范

状态：本地 v1 RC 补充规范，2026-09-21。本文面向准备数据的用户和负责转换 K 线的 Agent。运行时验证实现位于 `src/training/shared.mjs`，回放语义位于 `src/training/replay-engine.mjs`；二者优先于本文。

## 用途与非用途

确定性回放数据集把一段已经冻结的市场观察送入同一 MaleCNS + Profiled Hybrid V2 管线，用于训练或冻结学习评估。回放期间不访问网络；系统记录原始文件 SHA-256、相对路径和字节数。

它不是交易所通用 K 线格式，也不接受 CSV、TradingView 导出或只有 OHLCV 的 JSON。原始 K 线必须先转换为本文定义的完整 observation。数据集和回放结果只用于模拟研究，不证明历史成交可实现，也不表示未来盈利。

## 放置目录与选择方式

- Windows 桌面版：`%LOCALAPPDATA%/FLAP Fly Agent/data/replay-datasets/`
- 源码版：仓库内 `data/replay-datasets/`

管理页填写相对于该目录的路径。例如文件位于 `data/replay-datasets/bnb/demo.json`，输入 `bnb/demo.json`。绝对路径、`..`、目录逃逸和指向目录外的符号链接都会被拒绝。

文件要求：

- UTF-8 严格 JSON；重复键、未知键和缺失键均拒绝。
- 普通文件，2 bytes–16 MiB。
- 所有数值必须为 JSON number 且有限；不能使用字符串数字、`NaN` 或 `Infinity`。
- observation 至少一条，`at` 必须严格递增。
- 顶层及嵌套对象不能加入自定义 provenance 字段；来源说明应放在同名 sidecar，例如 `demo.provenance.json`，该 sidecar 不参与回放。

## 顶层结构

顶层必须且只能包含以下六个字段：

| 字段 | 类型 | 规则 |
|---|---|---|
| `format` | string | 固定为 `flap-deterministic-replay` |
| `version` | integer | 固定为 `1` |
| `tokenAddress` | string | 非零 `0x` + 40 位十六进制 EVM 地址 |
| `symbol` | string | 1–32 个字符，仅用于显示和神经请求身份 |
| `observations` | array | 一条或多条严格递增的完整观察 |
| `assumptions` | object | 模拟费用和初始账户假设 |

```json
{
  "format": "flap-deterministic-replay",
  "version": 1,
  "tokenAddress": "0x1111111111111111111111111111111111111111",
  "symbol": "DEMO",
  "observations": [],
  "assumptions": {
    "feePercent": 0.6,
    "slippagePercent": 0.5,
    "gasBnb": 0.00003,
    "initialQuote": 100,
    "initialToken": 0,
    "initialBnb": 1
  }
}
```

上面的空 `observations` 只用于展示结构，不能通过验证。

## Observation

每个 observation 必须且只能包含 `at`、`history`、`market`、`flow`、`token`。

### `at`

可由 JavaScript `Date.parse` 解析的时间字符串。建议统一使用 UTC ISO 8601，例如 `2026-09-20T00:00:59.000Z`。相邻 observation 可以按 Profile 的神经决策间隔采样，但所有时间必须严格递增。

### `history`

1–360 个大于 0 的价格 number，最后一个值是 observation 当时价格。

**当前 v1 回放引擎把数组重建为每项相隔 1 秒、OHLC 都等于该值、volume=1 的内部蜡烛。** 因此：

- 推荐来源是 1 秒收盘价或逐笔成交聚合出的 1 秒收盘价。
- 为通过默认 Profile 的健康门，建议每条 observation 至少提供 60 个真实 1 秒价格样本；实际下限取 Profile 的 `perception.minimumHealthySamples`。
- 60 秒和 300 秒回报由这个 1 秒序列计算。把 1 分钟 K 线直接当数组元素会把 1 分钟错误解释成 1 秒。
- 只有更粗 K 线时，Agent 必须先告知用户会发生重采样。前向填充可以保持已知价格但会压低波动，线性插值会发明未观察价格；两者都必须在 sidecar 中标记，不能冒充真实 1 秒行情。
- `history` 只使用收盘价；原始 open/high/low 不会直接进入 MaleCNS。v1 内部的 300 秒低点也是由这些重建 close 得到。

### `market`

必须且只能包含：

| 字段 | 类型/建议范围 | OHLCV 转换建议 |
|---|---|---|
| `positionPercentile` | number，0–1 | `history` 中小于等于当前价格的数量 ÷ 样本数 |
| `position` | number | `ln(current / median(history))` |
| `activity` | number，0–1 | `clamp(priceActivity×0.7 + volumeActivity×0.3, 0, 1)`；无可信 volume 时用 `priceActivity` 并记录降级 |
| `priceActivity` | number，0–1 | 最近最多 60 个 1 秒 close 的对数收益 RMS，再除以 `0.015` 并 clamp 到 0–1 |
| `volumeActivity` | number 或 null | 有统一口径 volume 时：`clamp((volumeRatio-0.5)/1.5, 0, 1)`；否则 null |
| `minIntervalSeconds` | 非负 number | 建议 `round(30-activity×25)`；最终仍会被 Profile 风控最小间隔收紧 |
| `volumeRatio` | 非负 number 或 null | 最近 60 秒 quote volume ÷ 更早基线的等长折算量；无可靠 volume 时 null |
| `priceSamples` | 非负 number，建议整数 | 实际有效价格样本数；不得把插值点伪装成独立市场采样 |
| `updatedAt` | string | 建议与 `at` 相同；超过 Profile `marketMaxAgeSeconds` 会关闭数据健康门 |

`clamp(x,0,1)=max(0,min(1,x))`。volume 必须先统一单位：若来源给 base-token volume，可用 `baseVolume × close` 转为 quote volume；若已给 quote volume则不要再次换算。不能混用不同交易对或不同报价资产的 volume。

### `flow`

`flow` 必须且只能包含 `scannedAt`、`error`、`windows`；`windows` 必须且只能包含 `m5`；`m5` 必须且只能包含 `buyVolume`、`sellVolume`。固定结构：

```json
{
  "scannedAt": "2026-09-20T00:00:59.000Z",
  "error": null,
  "windows": {
    "m5": {
      "buyVolume": 12.5,
      "sellVolume": 9.25
    }
  }
}
```

- `buyVolume`、`sellVolume` 是最近 5 分钟的非负 quote volume。
- `scannedAt` 建议等于 `at`；太旧会触发 `flowMaxAgeSeconds` 健康门。
- `error` 必须为 null 或 string；非 null 表示数据源有错误，回放会把市场数据标为不健康。
- 普通 OHLCV 不能证明主动买/卖方向。最保守的转换是二者都设为 0，使 Hybrid 使用中性买卖占比；不能把总 volume 同时填入两个字段。
- 若使用 close≥open 归买、close<open 归卖等 tick-rule 近似，必须在 sidecar 声明算法和原始周期。这是估计值，不是链上 swap 方向事实。

### `token`

`token` 必须且只能包含 `quotePrice`、`buyTaxPercent`、`liquidity`；`liquidity` 必须且只能包含 `quote`、`token`。固定结构：

```json
{
  "quotePrice": 0.00042,
  "buyTaxPercent": 0,
  "liquidity": {
    "quote": 250,
    "token": 595238.0952380953
  }
}
```

| 字段 | 含义 |
|---|---|
| `quotePrice` | 池的报价资产 / token 价格，必须非负；对于 USDT 池通常与 `history` 最后值一致 |
| `buyTaxPercent` | 买入税百分比；未知时填 0 代表“明确假设为零”，必须记录在 sidecar |
| `liquidity.quote` | observation 时点的报价资产储备（人类可读单位） |
| `liquidity.token` | observation 时点的 token 储备（人类可读单位） |

OHLCV 本身通常不含池储备或税率。应优先从同一交易对的链上 reserve/swap 快照、可信索引器或归档节点取得。用固定储备可以做“固定流动性假设实验”，但不能称为历史流动性回放。quote/token 储备必须大于 0 才可能通过数据健康和价格冲击门。

若 `history` 统一为 TOKEN/USDT，而实际池使用 WBNB 等报价资产，`token.quotePrice` 与池储备仍必须使用池本身的 quote 单位；转换 sidecar 应记录 quote token、decimals、TOKEN/USDT 换算来源和时间。

## Assumptions

必须且只能包含六个非负有限 number：

| 字段 | 含义 |
|---|---|
| `feePercent` | 模拟交易费百分比 |
| `slippagePercent` | 回放报告中的滑点假设；Profile 风险字段仍单独冻结 |
| `gasBnb` | 每次模拟动作扣除的 BNB Gas 假设 |
| `initialQuote` | Hybrid 模拟账户初始报价资产 |
| `initialToken` | 初始 token 数量 |
| `initialBnb` | 初始 BNB，用于 Gas 约束 |

这些不是从 K 线推导的事实，必须由用户明确选择。比较多个 Profile 时应使用同一 assumptions；否则结果不可直接横向比较。

## 一条完整 observation 示例

下面的结构可以通过字段验证，但只有 5 个 history 样本，默认 Profile 会把它判为市场数据不健康。正式数据应提供至少 60 个真实 1 秒样本。

```json
{
  "at": "2026-09-20T00:00:59.000Z",
  "history": [0.0004, 0.000405, 0.00041, 0.000415, 0.00042],
  "market": {
    "positionPercentile": 1,
    "position": 0.02409755,
    "activity": 0.18,
    "priceActivity": 0.257,
    "volumeActivity": null,
    "minIntervalSeconds": 25,
    "volumeRatio": null,
    "priceSamples": 5,
    "updatedAt": "2026-09-20T00:00:59.000Z"
  },
  "flow": {
    "scannedAt": "2026-09-20T00:00:59.000Z",
    "error": null,
    "windows": { "m5": { "buyVolume": 0, "sellVolume": 0 } }
  },
  "token": {
    "quotePrice": 0.00042,
    "buyTaxPercent": 0,
    "liquidity": { "quote": 250, "token": 595238.0952380953 }
  }
}
```

## 给转换 Agent 的操作合同

用户可以把原始 K 线文件和本文一起交给 Agent，但转换前必须先确认：

1. K 线时间戳单位、时区、周期和是否有缺口。
2. price 的方向与单位，例如 TOKEN/USDT，而不是倒数。
3. volume 是 base volume 还是 quote volume。
4. tokenAddress、symbol、chainId 和交易对地址。
5. 是否有逐笔方向、池 reserve、quote token 汇率和税率数据。
6. assumptions 的六个值由谁决定。

Agent 应执行：

1. 保留原始文件，只向新文件输出；不得覆盖来源。
2. 按时间排序、去重，拒绝无法解释的负值、零价格和非有限值。
3. 明确 1 秒重采样方法；不能静默把分钟 K 线当作秒数据。
4. 计算 market 派生字段；对缺失 flow 使用中性零值或用户批准的显式近似。
5. 从独立来源填入每个时点的池信息；若只能使用固定假设，在 sidecar 醒目标记。
6. 生成主数据集 `.json` 和不参与回放的 `.provenance.json`，后者记录原始文件 SHA-256、转换工具/提示版本、时间范围、时区、重采样、缺口、flow/liquidity/tax 来源与所有假设。
7. 确认输出小于等于 16 MiB，并用应用运行一次验证；不要仅以 JSON 能解析作为完成标准。

建议 sidecar 至少包含：`sourceFiles`、`sourceSha256`、`chainId`、`pairAddress`、`quoteToken`、`inputCadence`、`outputCadence`、`resampling`、`gapPolicy`、`volumeUnit`、`flowMethod`、`liquiditySource`、`taxSource`、`assumptionsOwner`、`converterVersion` 和 `createdAt`。sidecar 没有运行时 Schema，但应与主文件一起备份。

## 常见拒绝或失真原因

- 路径不在 `data/replay-datasets` 内。
- 额外添加 provenance 字段，或缺少固定字段。
- observation 时间重复/倒序，或时间戳秒/毫秒混淆。
- 使用字符串数字、负 volume、零/负 history price。
- `updatedAt` / `scannedAt` 早于 `at` 太多，导致数据健康门关闭。
- `history` 或 `priceSamples` 少于 Profile 的 `minimumHealthySamples`。
- 把分钟 K 线原样当成秒序列，使 60/300 秒特征变成 60/300 根 K 线。
- 用 OHLCV 总量伪造买卖方向，或用任意常数冒充历史池储备。
- `history` 的估值单位、`quotePrice` 的池报价单位与 assumptions 混用却没有说明。

## 可重复性边界

相同 checkpoint、Profile revision/hash、数据集原始字节和运行时版本会产生相同的确定性摘要；神经计算耗时和峰值内存属于机器性能指标，不进入确定性摘要哈希。只要转换算法、重采样、来源数据或 assumptions 任一变化，就应生成新文件和新 SHA-256，不应覆盖旧数据集。
