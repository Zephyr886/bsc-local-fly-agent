# FLAP Fly Profile v1：Agent 可执行实施计划

状态：实施草案 1.0
适用仓库：`bsc-local-fly-agent`
基线日期：2026-09-19
实施原则：先完成本地多果蝇与通用配置标准，再决定是否部署 Registry V4；Registry V3 和现有卡带必须保持可读。

## 1. 目标、范围与完成定义

### 1.1 产品目标

把当前“一台设备、一个活动卡带、一套固定参数”的程序改造成：

1. 一个用户可在本机创建多只果蝇。
2. 每只果蝇拥有独立的 Profile、神经检查点、训练记录、评估结果和卡带历史。
3. 用户可在控制台修改允许开放的参数，并看到参数的用途、范围、生效方式和风险。
4. 系统安全上限独立于用户 Profile；用户只能收紧，不能绕过系统上限。
5. Profile 可规范化、计算稳定哈希、导入、导出、克隆、修订和回滚。
6. Fly Cartridge v3 保持兼容；新增 Fly Cartridge v4 本地格式后，仍能导入 v3。
7. 第一阶段不重新部署主网合约。只有本地标准经过真实训练验证并冻结后，才进入 Registry V4 决策。

### 1.2 v1 明确不做

- 不同时运行多只全脑果蝇。MaleCNS 单 worker 峰值内存较高，v1 只允许一只活动果蝇运行或训练。
- 不把私钥、钱包密码、RPC API Key、授权 ID 或交易 calldata 写入 Profile 或卡带。
- 不修改 `vendor/stonkfly/` 的上游神经实现。
- 不修改或替换已经部署的 Registry V3。
- 不进行主网合约部署、生产服务器部署或生产数据迁移。
- 不承诺收益，不把模拟评估描述为真实收益证明。

### 1.3 总体验收标准

完成本计划的本地部分后，必须能在全新 Windows 安装中完成以下流程：

1. 创建果蝇 A，选择预设并修改 Profile。
2. 克隆为果蝇 B，修改奖励或策略参数后产生不同 `profileHash`。
3. A、B 使用各自目录、检查点和训练记录，切换时不会串状态。
4. 同一只果蝇的并发 Profile 修改会通过 revision 冲突被拒绝。
5. 默认 Profile 的行为与当前固定参数行为一致。
6. 超出系统安全上限的 Profile 无法保存；运行时再次执行相同约束。
7. v3 卡带可以导入，并被包装为一个默认 Profile 的果蝇。
8. v4 卡带可以导出、验证、重新安装，Profile 与状态哈希校验通过。
9. 原有模拟、钱包、交易确认、桌面初始化和 v3 卡带测试全部继续通过。
10. `npm test`、新增 Python 测试、桌面 smoke test 和安装包升级测试全部通过。

## 2. 当前代码基线与必须保留的约束

### 2.1 当前单实例耦合点

| 位置 | 当前状态 | 重构目标 |
| --- | --- | --- |
| `src/server.mjs` | 启动时创建一个 `FullBrainClient`、一个 `SimulationRuntime`、一个 `CartridgeDeck` | 引入 `FlyManager` 统一选择活动果蝇和绑定运行时 |
| `src/brain/full-brain-client.mjs` | 构造时绑定一个 checkpoint，worker 启动后不可热切换 | worker 停止后按 `flyId` 切换 checkpoint；运行时保持单 worker |
| `server/full-brain/worker.py` | 身份由 `tokenAddress` 决定，设置只接收 learning、neuralMs、thresholdHz | 身份改为 `flyId + modelVersion`，代币只是训练上下文；严格接收白名单参数 |
| `src/agent/simulation.mjs` | `start()` 内硬编码脑、Hybrid 和全脑参数 | 从已验证的 Effective Profile 构造运行时 |
| `src/strategy/hybrid-v2.mjs` | 多数策略参数可由 options 覆盖，奖励公式固定 | 保留原文件；用 Profile 适配层实现可配置奖励并保证默认行为等价 |
| `src/persistence/sqlite-store.mjs` | session 没有 `fly_id`、`profile_revision`、`training_run_id` | 版本化迁移并让所有审计记录可追溯到具体 Profile |
| `src/cartridge/deck.mjs` | 一个 `active.json`，运行路径为 `runs/<uuid>/service.npz` | 每只果蝇独立卡带历史和 checkpoint；保留 v3 入口 |
| `scripts/fly_cartridge_v3.py` | 清单字段集合严格固定 | 不修改 v3 语义；新增独立 v4 工具 |
| `public/index.html` | 单一运行台 | 保留运行台，新增“果蝇管理中心”页面 |
| `src/config.mjs` 与 `src/cartridge/deck.mjs` | 合约地址和系统配置分散 | 统一只读 Registry/Policy 配置模块 |

### 2.2 不可回归的安全边界

- HTTP 服务继续只监听回环地址。
- 钱包专用 API 的字段白名单、限流、AES-256-GCM 和逐笔确认不放宽。
- Profile API 使用普通 32KB 请求限制；卡带 API 使用独立大小限制。
- Python worker 继续使用环境变量白名单，不继承钱包、密码或 RPC 凭据。
- 用户参数保存校验和运行时校验必须各执行一次，不能只依赖前端。
- 当前硬上限至少保留：单笔买入 `0.2 BNB`、滑点 `0.1%–15%`、deadline 300 秒。
- `src/strategy/hybrid-v2.mjs`、`src/brain/fly-brain.mjs` 和 `vendor/stonkfly/` 在兼容阶段保持原始来源校验。
- 所有写盘操作采用临时文件 + 原子 rename；不得原地覆盖有效 Profile 或 checkpoint。

## 3. 通用标准：FLAP Fly Profile v1

### 3.1 文档模型

Profile 使用“信封 + 行为规范”模型：

```json
{
  "apiVersion": "flap.ai/v1",
  "kind": "FlyProfile",
  "metadata": {
    "flyId": "UUID",
    "revision": 1,
    "name": "Low Dip Learner",
    "description": "用户可见说明",
    "tags": ["dip", "conservative"],
    "createdAt": "RFC3339",
    "updatedAt": "RFC3339",
    "profileHash": "sha256:<64 lowercase hex>"
  },
  "spec": {
    "compatibility": {},
    "universe": {},
    "perception": {},
    "learning": {},
    "reward": {},
    "strategy": {},
    "risk": {},
    "runtime": {}
  }
}
```

哈希规则：

- `profileHash = sha256(JCS(spec))`，只哈希 `spec`，不哈希名称、标签、时间戳和 revision。
- 使用 RFC 8785/JCS 等价的 canonical JSON：UTF-8、对象键排序、禁止 `NaN/Infinity/-Infinity`、禁止重复键。
- `flyId` 是本机果蝇身份；克隆时生成新 `flyId`，但未修改行为前可以拥有相同 `profileHash`。
- `revision` 是本机乐观锁版本，每次成功修改加一。
- Profile 中所有百分数统一使用“百分数值”，例如 `2` 表示 2%，字段名必须以 `Percent` 结尾。
- 时间统一使用 UTC RFC3339；金额在 Profile 中使用十进制字符串，运行时才转为安全数值类型。

### 3.2 v1 字段

以下是 v1 首批支持字段。Agent 不得添加未在 Schema 中声明的字段；未知字段必须拒绝，而不是静默忽略。

#### `spec.compatibility`

| 字段 | 类型/默认值 | 约束 |
| --- | --- | --- |
| `brainModel` | `"malecns-v1"` | v1 唯一允许值 |
| `strategyEngine` | `"hybrid-v2-profiled"` | v1 唯一允许值 |
| `profileSchemaVersion` | `1` | 固定值 |

#### `spec.universe`

| 字段 | 类型/默认值 | 约束 |
| --- | --- | --- |
| `chainId` | `56` | v1 固定 BSC Mainnet |
| `tokenBinding` | `"device-selected"` | 可选 `device-selected` 或 `fixed` |
| `tokenAddress` | `null` | `fixed` 时必须为非零 EVM 地址；否则必须为 null |
| `quotePreference` | `"USDT"` | v1 固定值 |

#### `spec.perception`

| 字段 | 默认值 | 允许范围 | 生效方式 |
| --- | ---: | ---: | --- |
| `marketRefreshMs` | 1000 | 1000–60000 | 下次启动 |
| `neuralDecisionIntervalSeconds` | 10 | 10–3600 | 下次启动 |
| `historyCandles` | 36 | 36–360 | 下次启动 |
| `minimumHealthySamples` | 60 | 60–600 | 下次启动 |
| `marketMaxAgeSeconds` | 15 | 5–60 | 下次启动 |
| `flowMaxAgeSeconds` | 20 | 5–120 | 下次启动 |

#### `spec.learning`

| 字段 | 默认值 | 允许范围 | 生效方式 |
| --- | ---: | ---: | --- |
| `enabled` | true | boolean | 下次训练轮次 |
| `neuralMs` | 500 | 100–2000，0.1ms 步进 | 下次启动 |
| `decoderThresholdHz` | 2 | 0.1–50 | 下次启动 |
| `checkpointEverySeconds` | 60 | 30–3600 | 下次启动 |

`eta`、神经记忆衰减和底层权重上下限在 v1 保持模型锁的一部分，不开放给 UI；它们只有在新的 `brainModel` 版本及对应兼容性测试完成后才能进入后续 Schema。

#### `spec.reward`

| 字段 | 默认值 | 允许范围 |
| --- | ---: | ---: |
| `settlementHorizonsSeconds` | `[300,900,3600]` | 1–5 个递增整数，300–86400 |
| `primaryHorizonSeconds` | 3600 | 必须包含在 horizons 中 |
| `returnScale` | 0.05 | 0.001–1 |
| `followWeight` | 0.65 | 0–1 |
| `positionWeight` | 0.20 | 0–1 |
| `favorableWeight` | 0.10 | 0–1 |
| `drawdownWeight` | -0.05 | -1–0 |
| `pulseDeadband` | 0 | 0–0.5 |
| `minimumPulseStrength` | 0.05 | 0–1 |

附加规则：四个 weight 的绝对值总和不得大于 1.5；至少有一个正向权重；默认值必须逐事件产生与现有固定公式相同的 utility。

#### `spec.strategy`

字段映射到 `HYBRID_V2_DEFAULTS`，但不包含初始账户余额：

- `quantThreshold`：默认 0.62，范围 0.5–0.95。
- `positionBuyCeiling`：默认 0.55，范围 0.05–0.95。
- `positionBurnFloor`：默认 0.55，范围 0.05–0.95。
- `buyMaxReturn60s`：默认 0，范围 -0.5–0.5。
- `buyMaxReturn300s`：默认 0，范围 -0.5–0.5。
- `buyMaxDistanceFromLow300s`：默认 0.02，范围 0–0.5。
- `burnMinReturn60s`：默认 0.02，范围 -0.5–0.5。
- `burnMinReboundFromLow300s`：默认 0.02，范围 0–0.5。
- `frequencyActiveThreshold`：默认 0.5，范围 0.05–0.95。
- `activeWindowSeconds`：默认 300，范围 60–86400。
- `activeMinActions`：默认 1，范围 0–100。
- `activeMaxActions`：默认 10，范围 1–100，且不小于 min。
- `quietWindowSeconds`：默认 3600，范围 60–86400。
- `quietMinActions`：默认 1，范围 0–100。
- `quietMaxActions`：默认 5，范围 1–100，且不小于 min。
- `twapIntervalSeconds`：默认 300，范围 60–86400。WP-00 基线确认当前 `SimulationRuntime` 的有效覆盖值为 300；以此值保证 `balanced-v1` 与升级前行为等价。
- `buyPercent`：默认 2，范围 0–100，仍受 risk/system policy 限制。
- `burnPercent`：默认 1，范围 0–100，仍受 risk/system policy 限制。

#### `spec.risk`

| 字段 | 默认值 | Profile 范围 | Effective 规则 |
| --- | ---: | ---: | --- |
| `liveTradingEnabled` | false | boolean | false 时绝不生成可签名实盘提案 |
| `capitalBudgetPercent` | 10 | 0.1–25 | `min(profile, system)` |
| `maxPoolParticipationPercent` | 0.5 | 0.01–2 | `min(profile, system)` |
| `maxBuyBnb` | `"0.2"` | `>0` | `min(profile, 0.2)` |
| `slippagePercent` | 0.5 | 0.1–15 | clamp 到系统范围；越界保存失败 |
| `dailyActionLimit` | 24 | 1–100 | `min(profile, system)` |
| `minimumActionIntervalSeconds` | 60 | 60–86400 | `max(profile, system)` |

`risk` 是用户意图，不是最终安全值。API 必须同时返回 `effectiveRisk` 和每个被系统上限收紧的原因。

#### `spec.runtime`

| 字段 | 默认值 | 约束 |
| --- | ---: | --- |
| `autoSave` | true | v1 必须为 true；字段保留用于标准完整性 |
| `retainDecisionCount` | 500 | 100–5000 |
| `retainOutcomeCount` | 1000 | 100–10000 |
| `retainFeedbackCount` | 100 | 10–1000 |

### 3.3 Profile 预设

首版提供四个只读模板，创建果蝇时复制为可编辑 Profile：

- `balanced-v1`：完全等价当前默认值。
- `conservative-v1`：更高阈值、更小订单、更低频率，默认禁止实盘。
- `active-research-v1`：更高观察频率，但仍受硬性风控。
- `frozen-evaluation-v1`：`learning.enabled=false`，用于对照评估。

预设必须是仓库内版本化 JSON，不允许从网络动态下发。

### 3.4 参数生效分类

API 和 UI 必须展示每个字段的生效分类：

- `hot`：只影响尚未生成的 UI/审计显示；v1 暂不为行为参数使用 hot。
- `next-start`：暂停当前运行后再次启动生效。
- `next-training-run`：新训练轮次开始时生效，旧轮次绑定旧 revision。
- `fork-required`：改变模型兼容性或底层学习语义时必须克隆为新果蝇。v1 的 `brainModel`、`strategyEngine` 属于此类。

运行中的 Profile 可以保存新 revision，但当前 session 继续使用启动时解析出的不可变 Effective Profile，并明确提示“下次启动生效”。

## 4. 目标目录、数据库与运行时结构

### 4.1 文件布局

```text
data/
├─ system-policy.json                 # 可选的只读发行版覆盖；不得由普通面板修改
├─ flies/
│  └─ <flyId>/
│     ├─ fly.json                     # 名称、当前 revision、活动 checkpoint 指针
│     ├─ profiles/
│     │  ├─ 000001.json
│     │  └─ 000002.json
│     ├─ checkpoints/
│     │  └─ <checkpointId>/
│     │     ├─ service.npz
│     │     └─ service.json
│     ├─ training-runs/
│     │  └─ <trainingRunId>/run.json
│     ├─ evaluations/
│     │  └─ <evaluationId>.json
│     └─ cartridges/
│        ├─ imports/<importId>/...
│        └─ exports/<exportId>/...
├─ active-fly.json                    # 仅保存 flyId、revision、checkpointId
├─ bsc-fly-agent.sqlite
└─ local-wallet.vault.json            # 保持独立，绝不迁入 flies/
```

所有路径 ID 必须先做 UUID/固定格式校验，再拼接到固定根目录。禁止接受客户端提供的磁盘路径。

### 4.2 SQLite 迁移

引入 `schema_meta(version INTEGER NOT NULL)`，迁移必须幂等且在事务内完成。目标表：

```text
flies(
  id PK, name, current_revision, active_checkpoint_id,
  created_at, updated_at, archived_at NULL
)
fly_profile_revisions(
  fly_id, revision, profile_hash, document_json, created_at,
  PRIMARY KEY(fly_id, revision), UNIQUE(fly_id, profile_hash, revision)
)
training_runs(
  id PK, fly_id, profile_revision, profile_hash, token_address,
  mode, status, started_at, stopped_at NULL, checkpoint_before,
  checkpoint_after NULL, summary_json
)
evaluations(
  id PK, fly_id, profile_revision, checkpoint_id,
  dataset_hash, status, metrics_json, created_at
)
```

现有表采用非破坏迁移：

- `sessions` 增加可空 `fly_id`、`profile_revision`、`profile_hash`、`training_run_id`。
- `decisions` 和 `transactions` 继续通过 `session_id` 关联，不复制 Profile JSON。
- 旧 session 保持字段为 null，并在 UI 显示“Legacy session”。
- 不删除、不重写旧审计记录。

### 4.3 单活动实例规则

- 任意时刻最多一个 `activeFlyId`。
- 任意时刻最多一个状态为 `running` 的 training run/session。
- 切换活动果蝇前必须：停止 simulation → 等待 pending 全脑请求 → 保存 checkpoint → 关闭 worker → 原子更新 `active-fly.json` → 指向新 checkpoint。
- 任一步失败时恢复旧 active marker 和旧 checkpoint 指针；不得留下“marker 已切换但 worker 仍使用旧 checkpoint”的状态。

## 5. API 契约

所有错误返回：

```json
{
  "error": {
    "code": "PROFILE_REVISION_CONFLICT",
    "message": "用户可读说明",
    "fields": [{"path": "/spec/risk/maxBuyBnb", "reason": "..."}]
  }
}
```

保留旧 API 的现有 `{ "error": "..." }` 兼容到完成前端迁移；新增 `/api/flies` 只使用结构化错误。

### 5.1 果蝇与 Profile

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/flies` | 列表；返回活动状态、revision、profileHash、训练状态 |
| `POST` | `/api/flies` | 从 preset 或 profile 创建；返回 201 |
| `GET` | `/api/flies/:flyId` | 返回 fly、当前 Profile、Effective Profile、统计摘要 |
| `PATCH` | `/api/flies/:flyId` | 只允许修改名称、说明、标签或 archived 状态 |
| `PUT` | `/api/flies/:flyId/profile` | 创建新 revision；请求必须带 `expectedRevision` |
| `GET` | `/api/flies/:flyId/revisions` | revision 列表，不默认返回全部大 JSON |
| `GET` | `/api/flies/:flyId/revisions/:revision` | 获取某一不可变 revision |
| `POST` | `/api/flies/:flyId/rollback` | 以旧 revision 内容创建一个新的 revision，不倒退计数器 |
| `POST` | `/api/flies/:flyId/clone` | 新 flyId；可选复制当前 checkpoint，默认只复制 Profile |
| `POST` | `/api/flies/:flyId/activate` | 仅在 runtime 非 running 时切换活动果蝇 |
| `GET` | `/api/fly-profile/schema` | 返回 Profile v1 JSON Schema、字段说明和生效分类 |
| `GET` | `/api/fly-profile/presets` | 返回内置预设摘要 |

更新 Profile 响应必须包含：新 revision、`profileHash`、`changedPaths`、`activationMode`、`effectiveRisk`、warnings。

### 5.2 训练与评估

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `POST` | `/api/flies/:flyId/training-runs` | 以当前 revision 新建训练轮次；v1 支持 `live-observation` 和 `deterministic-replay` |
| `GET` | `/api/flies/:flyId/training-runs` | 分页返回训练历史 |
| `GET` | `/api/training-runs/:runId` | 返回固定 Profile、token、checkpoint 与摘要 |
| `POST` | `/api/training-runs/:runId/stop` | 保存 checkpoint 后结束 |
| `POST` | `/api/flies/:flyId/evaluations` | 使用冻结学习的 Profile 对 checkpoint 做评估 |
| `GET` | `/api/flies/:flyId/evaluations` | 返回可比较指标 |

训练轮次一旦开始，不允许修改其 `profileRevision/profileHash/tokenAddress/mode`。终止、失败和完成都必须写入最终状态及错误摘要。

### 5.3 旧运行 API 的兼容调整

- `POST /api/simulation/start` 增加可选 `flyId` 和 `expectedProfileRevision`。
- 未传 `flyId` 时只在存在唯一 legacy/default fly 时兼容；多果蝇存在时返回明确错误。
- `GET /api/simulation` 增加 `flyId`、`profileRevision`、`profileHash`、`trainingRunId` 和 `effectiveProfileSummary`。
- 所有实盘 proposal 记录上述四个标识；签名前再次确认当前 proposal 与活动 session/Profile 一致。
- 果蝇切换、Profile rollback 和 checkpoint 切换不能使已生成的授权跨上下文复用。

## 6. 分阶段 Agent 工作包

每个工作包原则上对应一个可独立审查的提交。Agent 开始前必须读取仓库根 `AGENTS.md`、本文件和相关源文件；结束时必须列出实际修改、测试结果、未完成项。不要顺手修改生产仓库。

### WP-00：基线保护与测试清单

**依赖**：无。
**目标**：在功能重构前记录可比较基线。
**主要文件**：`docs/`、`test/`，不改业务行为。

执行：

1. 记录 `npm test` 的测试数量与通过结果。
2. 增加一组 fixture，固定当前默认模拟配置、默认 Profile 映射和默认奖励样本。
3. 为现有 v3 manifest/state 准备最小合法 fixture 或从测试动态生成，不提交真实用户 checkpoint。
4. 增加 Windows mutable path 测试，确认数据仍在 `%LOCALAPPDATA%/FLAP Fly Agent`。
5. 确认当前工作树已有桌面安装器改动与本计划改动分离，禁止覆盖用户已有修改。

验收：

- 当前全部测试通过。
- fixture 不含私钥、RPC Key、真实钱包或大体积 MaleCNS 数据。
- 能证明默认 Profile 的目标值与当前硬编码值一一对应。

### WP-01：统一 Registry 与 System Policy 配置

**依赖**：WP-00。
**目标**：消除主网 Registry 地址不一致，为 Profile 安全合并建立唯一入口。
**新增建议**：`src/policy/system-policy.mjs`、`src/chain/registry-config.mjs`。
**修改**：`src/config.mjs`、`src/cartridge/deck.mjs`、README 与相关测试。

执行：

1. 把 chainId、v3 registry 地址、类型、最大 manifest/总字节限制集中到冻结对象。
2. 用显式名称区分 Direct/Image/Auto 变体，不再使用含糊的单个常量。
3. 核对当前实际读取器与地址的合约类型；文档只保留经测试确认的地址。
4. 建立 `SYSTEM_POLICY`，包含交易硬上限、监听边界和 Profile 可配置上限。
5. 导出 `resolveEffectiveRisk(profileRisk, systemPolicy)`，返回值和限制原因。

验收：

- `rg` 不再发现散落的主网卡带合约地址。
- v3 链读取测试继续通过。
- 用户 Profile 无法让 `maxBuyBnb` 超过 0.2 或放宽其他硬限制。

### WP-02：Profile Schema、规范化与哈希

**依赖**：WP-01。
**目标**：实现不依赖 UI 的通用 Profile v1 库。
**新增建议**：

```text
schemas/fly-profile-v1.schema.json
src/profile/defaults.mjs
src/profile/canonical.mjs
src/profile/validate.mjs
src/profile/effective-profile.mjs
src/profile/presets/*.json
test/fly-profile.test.mjs
```

执行：

1. 按第 3 节实现 JSON Schema，根对象和所有子对象均 `additionalProperties:false`。
2. 使用成熟 JSON Schema 校验器；若新增依赖，固定版本并更新 lockfile。
3. 先校验原始输入，再填默认值，再次校验；禁止因 JS 类型转换接受字符串数字。
4. 实现 canonical JSON 和 `sha256:` Profile Hash。
5. 实现字段路径到 activation mode 的静态映射。
6. 实现默认、保守、活跃研究、冻结评估四个预设。
7. 实现 Effective Profile；所有 runtime 只接收该对象，不直接接收未验证 JSON。

验收：

- 键顺序不同的相同 spec 得到相同 hash。
- 数值、字符串数值、未知字段、非有限数、错误地址均有明确测试。
- 默认 Profile 与当前运行时固定值一致。
- System Policy 收紧结果有逐字段 reason。

### WP-03：FlyRepository 与原子 revision 存储

**依赖**：WP-02。
**目标**：提供多果蝇文件存储和乐观锁。
**新增建议**：`src/flies/fly-repository.mjs`、`src/flies/fly-errors.mjs`、`test/fly-repository.test.mjs`。

执行：

1. 实现 create/list/get/updateMetadata/updateProfile/listRevisions/rollback/clone/archive。
2. 所有变更先写唯一临时文件，flush/close 后 rename；revision 文件不可覆盖。
3. `expectedRevision` 不匹配返回 `PROFILE_REVISION_CONFLICT`。
4. 同一进程内对单 fly 加写锁；不同 fly 可并行读。
5. 启动时检查 active marker、fly.json 和 revision 是否一致；损坏时只读报告，不自动猜测修复。
6. clone 默认不复制 checkpoint；复制 checkpoint 时使用新 checkpointId，并记录来源。

验收：

- 两个并发更新只有一个成功。
- 人为中断临时写入后，最后一个有效 revision 仍可读。
- 路径穿越和伪造 ID 被拒绝。
- A/B 果蝇的 Profile、历史和 checkpoint 路径完全隔离。

### WP-04：SQLite 版本化迁移与审计绑定

**依赖**：WP-02，可与 WP-03 在文件不冲突时顺序实施。
**目标**：让每个运行事件能追溯到果蝇和 Profile。
**修改**：`src/persistence/sqlite-store.mjs`；可新增 `src/persistence/migrations.mjs`。

执行：

1. 建立 schema version 和从现状到 v2 的事务迁移。
2. 增加第 4.2 节表与索引。
3. 更新 `commitCycle`、`updateSession` 和查询，绑定 fly/profile/training run。
4. 添加分页和 limit 上限，防止 UI 一次读取全部审计数据。
5. 用旧版 SQLite fixture 执行迁移，验证原始行数和 JSON 未改变。

验收：

- 空库、旧库、已迁移库重复启动均成功。
- 迁移失败会 rollback，不产生半迁移状态。
- 旧 session 可读，新 session 四个标识齐全。

### WP-05：FlyManager 与安全切换状态机

**依赖**：WP-03、WP-04。
**目标**：把单例协调从 `server.mjs` 移到可测试服务。
**新增建议**：`src/flies/fly-manager.mjs`、`test/fly-manager.test.mjs`。

状态机：

```text
inactive -> activating -> ready -> running -> stopping -> ready
                          |                    |
                          +------ error <-----+
ready -> switching -> ready(other fly)
```

执行：

1. FlyManager 持有 repository、brain client、simulation、deck 的协调引用。
2. 激活时解析当前 revision 为 Effective Profile，并固定到 activation context。
3. 切换严格执行停止、保存、park、marker 更新、checkpoint 激活的顺序。
4. 如果新 checkpoint 激活失败，恢复旧 context 和 marker。
5. 启动恢复只恢复“活动选择”，不自动恢复正在交易或训练的 session。
6. 创建首次使用的 `legacy-default` fly：仅在没有 flies 且发现旧 checkpoint/active v3 run 时迁移。

验收：

- running 时直接切换被拒绝。
- pending neural request 结束前不会切 checkpoint。
- 故障注入下 marker 与实际 checkpoint 始终一致。
- 旧安装首次升级不会丢失现有 `service.npz`。

### WP-06：Profile 驱动的脑与 Hybrid 运行时

**依赖**：WP-05。
**目标**：去除运行时硬编码，且不破坏原版 V2 来源文件。
**新增建议**：`src/strategy/profiled-hybrid-v2.mjs`、`src/reward/profiled-reward.mjs`。
**修改**：`src/agent/simulation.mjs`、`src/brain/full-brain-client.mjs`、`server/full-brain/worker.py`。

执行：

1. `SimulationRuntime.start()` 改为接收 `activationContext`，包括 flyId、固定 revision/hash、Effective Profile、checkpoint。
2. 市场刷新、神经决策间隔、history、健康样本和数据时效改由 Profile 提供。
3. 用 `HybridV2Lab` 的 options 注入已有可配置策略字段。
4. 新建 profiled subclass/adapter 覆盖奖励结算；不要直接修改原版 `hybrid-v2.mjs` 的来源语义。
5. worker 请求增加 `flyId`、`modelVersion`、checkpointEverySeconds；controller 身份不再由 tokenAddress 单独决定。
6. worker 严格验证白名单与范围，收到未知字段直接失败。
7. `learning.enabled=false` 时冻结权重；保存前后验证状态没有意外变化。
8. checkpoint 相邻 metadata 写入 flyId、profileRevision、profileHash、modelVersion、token context 和保存时间。
9. live proposal 携带 activation context；Profile 切换后旧 proposal 自动失效。

验收：

- 默认 Profile 和当前代码对同一确定性输入产生相同 decisions/utilities。
- 两个不同 reward Profile 对同一 outcome 产生预期不同 utility。
- 切换 token 不会把 A 的 checkpoint 错当 B；同一 fly 可按 universe 规则改变 token context。
- worker 仍不继承敏感环境变量。
- 原版源码哈希测试继续通过。

### WP-07：训练轮次与评估服务

**依赖**：WP-06。
**目标**：把“运行一次”变成可追溯的训练实验。
**新增建议**：`src/training/training-service.mjs`、`src/training/evaluation-service.mjs`。

执行：

1. 启动训练时固定 Profile revision/hash、checkpointBefore、token 和数据源。
2. `live-observation` 复用现有实时观察，但显式创建 trainingRunId。
3. `deterministic-replay` 只读取明确选择的本地数据集，记录数据文件 SHA-256。
4. 停止时先保存全脑 checkpoint，校验文件存在和 metadata，再把 run 标为完成。
5. 评估强制 `learning=false`，不得改变被测 checkpoint；使用临时副本或加载后不保存。
6. 首批指标：观察数、BUY/SELL/HOLD 提案数、Hybrid 放行数、阻断原因、模拟净值、最大回撤、动作频率、平均 utility、神经计算耗时和峰值 RSS。
7. 比较结果必须标明样本、费用、滑点、Gas 和模拟假设。

验收：

- run 结束后能从数据库和文件目录重建完整来源链。
- 评估前后 checkpoint SHA-256 完全相同。
- 相同 checkpoint/Profile/dataset 的确定性评估摘要相同。
- 崩溃遗留的 `running` 轮次下次启动标为 `interrupted`，不会伪装成 completed。

### WP-08：HTTP API 与错误模型

**依赖**：WP-05、WP-07。
**目标**：实现第 5 节 API，同时保留旧页面可运行。
**修改**：`src/server.mjs`；建议新增 `src/http/fly-routes.mjs` 与通用响应辅助。

执行：

1. 把 `/api/flies` 路由拆到独立模块，避免继续扩大单文件 server。
2. 对 route 参数、body 大小、Content-Type、UUID、revision 做服务端校验。
3. 所有 mutation 先进行同源/本机检查；保持 CSP 和安全 header。
4. Profile schema 可公开读取，但 system policy 只返回公开硬限制，不返回环境细节。
5. 旧 `/api/simulation/*` 通过 FlyManager 调用，避免两套状态源。
6. 为 API 增加端到端测试，包括 201/400/404/409/423 状态。

建议状态码：校验错误 400，不存在 404，revision 冲突 409，运行中不可切换 423，未知错误 500。

验收：

- API 测试覆盖所有 mutation 和至少一个错误路径。
- 非本机 Host/Origin 的 mutation 被拒绝。
- 错误响应不包含绝对磁盘路径、堆栈、私钥或密码。

### WP-09：控制台“果蝇管理中心”

**依赖**：WP-08。
**目标**：让非技术用户安全管理多果蝇和 Profile。
**新增建议**：`public/flies.html`、`public/flies.js`；修改 `public/styles.css`、`public/index.html`、static routes 和 UI contract 测试。

页面结构：

1. 果蝇列表：名称、状态、revision、Profile hash 前缀、上次训练、活动标识。
2. 创建/克隆向导：预设、名称、是否复制 checkpoint。
3. Profile 编辑器七个页签：市场范围、感知、学习、奖励、策略、风控、运行。
4. 基础模式：常用字段和预设。
5. 高级模式：全部允许字段，但继续使用结构化表单；不把任意 JSON 编辑器作为默认入口。
6. 变更摘要：保存前显示 changedPaths、生效方式、是否需要停止运行、Effective Risk。
7. 历史页：revision diff、回滚（实际创建新 revision）、训练与评估记录。
8. 卡带页：v3/v4 格式、导入来源、可发布性检查和限制原因。

交互规则：

- 所有 input 有可见 label、范围、单位、默认值和错误信息。
- 风险值显示“用户设置 / 系统最终值”，不能只显示用户输入。
- 正在运行时保存 next-start 值可以成功，但必须显示未生效状态。
- 离开有未保存修改的页面前提示。
- revision 冲突时不覆盖；显示服务端版本和本地修改，允许用户重新应用。
- 遵守 reduced motion，键盘可操作，状态不只依赖颜色。

验收：

- 1366×768、1920×1080 和 125% Windows 缩放下主要操作无截断。
- 键盘完成创建、编辑、激活、开始/停止训练、回滚。
- UI contract 测试检查 label、CSP、无内联脚本和风险提示。
- 旧运行台的钱包与交易流程没有视觉或功能回归。

### WP-10：Fly Cartridge v4 本地格式

**依赖**：WP-02、WP-06、WP-07。
**目标**：把 Profile 与学习状态组成可独立验证的卡带，同时保留 v3。
**新增建议**：`scripts/fly_cartridge_v4.py`、`docs/FLY_CARTRIDGE_V4.md`、`test/test_fly_cartridge_v4.py`。

建议 v4 manifest 顶层固定字段：

```json
{
  "format": "fly-cartridge",
  "formatVersion": 4,
  "semantics": "profile-and-learned-trait;fresh-neural-boot",
  "fly": {
    "flyId": "UUID",
    "profileSchemaVersion": 1,
    "profileRevision": 7,
    "profileHash": "sha256:..."
  },
  "profile": {},
  "model": "stonkfly-dual-compartment-v1",
  "locks": {},
  "traitKey": "...",
  "fieldSha256": {},
  "state": {"bytes": 0, "sha256": "..."},
  "training": {
    "runId": "UUID",
    "completedAt": "RFC3339",
    "datasetHash": null
  },
  "lineage": {
    "parentRegistry": null,
    "parentCardId": null
  },
  "fixedBootProbe": {}
}
```

执行：

1. v4 使用独立 verifier，不放宽 v3 verifier 的精确字段检查。
2. `profile` 存放 canonical spec；校验其 hash、Schema、model compatibility 和禁用字段。
3. state 编码继续复用已经验证的 v3 三字段 trait 编码；不要重复发明神经状态格式。
4. 定义 `cardId = sha256(canonical manifest)`；`traitKey/stateSha256/profileHash` 各自保留不同语义。
5. 导入 v3 时创建默认 Profile，并在 provenance 标记 `sourceFormatVersion:3`；不能声称 v3 原本包含该 Profile。
6. 导出前执行 publishability report：字节限制、V3 重复 state 限制、父卡兼容、Profile 完整性。
7. deck API 的 active 状态移入具体 fly，旧 `active.json` 只用于一次性迁移。

验收：

- v3 测试逐项保持通过。
- v4 在 Windows/Linux 对同一输入产生相同 canonical manifest、cardId 和 state。
- 修改一个 Profile 行为字段会改变 profileHash 和 cardId，但不伪造 stateHash。
- 修改任意 manifest/state 字节都会验证失败。

### WP-11：桌面升级、迁移与恢复

**依赖**：WP-05、WP-09、WP-10。
**目标**：Windows 用户升级后不丢旧数据。
**修改**：`desktop/`、安装/构建测试、README。

执行：

1. 桌面启动时先运行只读 preflight：磁盘空间、旧数据发现、数据库版本、活动 checkpoint。
2. 首次 v1 升级创建迁移备份清单，只复制小型 metadata/SQLite；不重复复制 1.58GiB 共享 MaleCNS 数据。
3. 旧 `data/full-brain/service.npz` 迁为 legacy-default fly 的首个 checkpoint；验证 SHA-256 后再更新 pointer。
4. 迁移使用 journal，重启可恢复；成功后保留完成标记。
5. loading/setup 页面增加“正在迁移旧果蝇数据”阶段和可读错误。
6. 保持 Electron 用户数据目录和安装目录分离。

验收：

- 干净安装、旧单实例安装、迁移中断后三类 smoke test 通过。
- 卸载/升级应用不会删除 `data/flies`、SQLite 或钱包密文。
- 失败时用户看到窗口和日志位置，不出现静默退出。

### WP-12：文档、运维与发布门槛

**依赖**：WP-00 至 WP-11。
**目标**：冻结本地 v1 发布候选。

执行：

1. 更新 README 的多果蝇流程、数据目录、备份、恢复、风险和卡带版本说明。
2. 增加 Profile 字段手册和“默认值不代表盈利”的说明。
3. 增加数据备份清单：Profile、checkpoints、SQLite、cartridges、钱包密文分别说明。
4. 生成 Windows 安装器并完成干净机/升级机手工验收。
5. 记录构建产物 SHA-256；正式公开前配置代码签名。

验收：

- 新用户只按 README 即可创建、训练、切换、评估、导出一只果蝇。
- 文档中的 API、路径、默认值与代码测试一致。
- 发布说明明确 v3/V4 卡带和 Registry V3/V4 的区别。

## 7. Registry V4 决策与可选实施

### 7.1 现在不部署新合约

本地 Profile v1 和 Cartridge v4 不要求立即重新部署合约。现有 Registry V3 将 manifest/state 当作字节存储，不解析 Profile，但它有两个限制：

1. 同一个 `stateKey` 或 `stateSha256` 不能再次发布，因此“同一神经状态、只修改 Profile”会被判为重复状态。
2. 合约不能直接按 `profileHash`、Schema 版本、flyId 或跨 Registry 父卡查询。

过渡期策略：

- 本地完整支持 v4。
- 只有满足 V3 字节限制、唯一 state 规则和父卡规则的 v4 候选才允许通过兼容发布路径；否则 UI 明确显示不可发布原因。
- 不伪装成 V3 manifest；是否让 V3 合约承载 v4 bytes 必须先由现有读取器和官网发布端完成兼容测试。

### 7.2 V4 启动门槛

同时满足以下条件后才能进入合约编码：

- Profile v1 Schema 已冻结并发布版本说明。
- 至少 5 种明显不同的 Profile 完成训练。
- 至少 20 个训练轮次完成且可追溯。
- v4 canonical/hash 在 Windows 与 Linux 一致。
- 产品已经决定“同 state 不同 Profile”是否允许各自铸造。
- 已决定 lineage 是否允许跨 Registry。
- 已完成 gas/交易大小测量、测试网演练和第三方安全审查安排。

### 7.3 WP-13：Registry V4 规格与威胁建模（仅门槛满足后）

**目标**：先冻结规格，不部署。
**产物**：`docs/FLY_CARTRIDGE_REGISTRY_V4_SPEC.md`、威胁模型、接口测试向量。

至少决定：

- 唯一键是 `cardId`、`stateSha256`、`traitKey`、`profileHash + stateSha256` 中哪一种组合。
- `profileHash` 是否由合约重新计算，或只从 manifest 提取后由客户端验证。
- parent 使用 `(registryAddress, cardId)` 还是仅 cardId。
- manifest/state 是完整 calldata、事件数据、分块存储还是外部内容寻址。
- NFT 元数据和实际卡带内容的绑定方式。
- 费用、重入、交易大小、DOS、重复铸造、错误父卡和链重组威胁。

### 7.4 WP-14：Registry V4 合约与测试网（需要用户单独授权）

建议 Card 至少包含：

```solidity
struct Card {
    address creator;
    bytes32 profileHash;
    bytes32 stateKey;
    bytes32 stateSha256;
    address parentRegistry;
    bytes32 parentCardId;
    uint16 profileSchemaVersion;
    uint32 profileRevision;
    uint32 manifestLength;
    uint32 stateLength;
    uint64 publishBlock;
    uint256 tokenId;
}
```

实施规则：

- 新部署独立不可变 V4；不修改 V3，不把 V3 替换成代理。
- 单元测试、fuzz、invariant、字节码可复现、测试网发布/读取/启动闭环完成后才讨论主网。
- 主网部署必须由用户另行明确确认，并在部署前给出地址、chainId、bytecode hash、构造参数、Gas 预算和回滚说明。

## 8. 测试矩阵

### 8.1 单元测试

- Profile Schema 所有边界、未知字段、地址条件、交叉字段规则。
- canonical JSON 与固定测试向量。
- Profile hash 对象键序无关、对行为值敏感。
- Effective Risk 永远不超过 System Policy。
- reward 默认等价和自定义系数计算。
- FlyRepository 原子写、revision 冲突、clone/rollback。
- SQLite 从旧 schema 迁移。
- v3/v4 manifest tamper detection。

### 8.2 集成测试

- A/B 果蝇交替激活，checkpoint 和 Profile 不串线。
- worker 关闭/保存/切换顺序。
- 训练中修改 Profile，当前 run 仍绑定旧 revision。
- Profile rollback 创建新 revision。
- v3 导入生成 legacy provenance，v4 round trip。
- proposal 与 fly/profile/session 绑定，切换后旧授权失败。
- 无全脑数据时 API/UI 正确提示 setup-required。

### 8.3 故障与恢复测试

- Profile 临时文件写完但 rename 前崩溃。
- SQLite migration 中断。
- checkpoint 保存失败。
- Python worker 超时或异常退出。
- 磁盘不足。
- active marker 指向不存在 revision/checkpoint。
- 桌面迁移中断并重启。

### 8.4 安全测试

- Profile/卡带中注入 privateKey、mnemonic、password、RPC URL 字段被拒绝。
- 路径穿越、超长名称、大 JSON、重复键和非有限数被拒绝。
- 非 localhost Host/Origin mutation 被拒绝。
- worker 环境秘密隔离继续通过。
- 用户 Profile 不能扩大交易硬上限。
- 卡带内容篡改、hash 替换和错误 model lock 被拒绝。

### 8.5 UI 与桌面测试

- 所有控件 label、错误关联、键盘焦点和 reduced motion。
- 运行中/停止/切换/冲突/迁移/初始化失败的可见状态。
- Windows 安装器可见、应用启动窗口可见、日志可定位。
- 老版本数据升级后 Profile、checkpoint、SQLite、钱包密文仍存在。

## 9. 推荐执行顺序与里程碑

### 里程碑 A：标准和基础设施（WP-00～WP-04）

交付：Schema、Hash、System Policy、FlyRepository、数据库迁移。
预计：5–8 个开发日。
退出条件：尚未接 UI，也能通过测试创建多只果蝇并保存独立 revision。

### 里程碑 B：真实多果蝇运行（WP-05～WP-07）

交付：安全切换、Profile 驱动运行、训练轮次、冻结评估。
预计：6–9 个开发日。
退出条件：默认行为等价，A/B checkpoint 不串线，训练可追溯。

### 里程碑 C：用户控制台（WP-08～WP-09）

交付：完整 API 和果蝇管理中心。
预计：4–6 个开发日。
退出条件：非技术用户无需编辑 JSON 即可管理 Profile 和训练。

### 里程碑 D：卡带与 Windows 发布（WP-10～WP-12）

交付：Cartridge v4、v3 兼容、桌面升级、文档和安装器。
预计：5–8 个开发日。
退出条件：干净安装/升级安装通过，v3/v4 round trip 通过。

### 里程碑 E：合约决策（WP-13～WP-14）

仅在第 7.2 节门槛满足后启动。时间与审计范围另行估算，不计入本地版本承诺。

## 10. Agent 执行协议

每次只领取一个 WP；若 WP 太大，可按“库/测试/API/UI”拆为子任务，但不能跨越依赖提前实现。

### 10.1 开始任务前

1. 阅读根 `AGENTS.md` 和本计划。
2. 执行 `git status --short`，记录并保护已有未提交改动。
3. 只读检查目标文件与现有测试。
4. 写出本次任务的文件白名单、验收命令和不做事项。
5. 不连接生产服务器，不读取生产数据，不输出秘密。

### 10.2 实施中

1. 先写失败测试，再写最小实现。
2. 不把 UI 校验当作安全校验。
3. 不静默兼容未知字段或无效数值。
4. 新格式与旧格式使用明确版本分派，不用“猜格式”。
5. 数据变更使用迁移和原子写，不直接批量移动用户目录。
6. 如果必须改变本计划中的公开字段/API，先更新 ADR 并说明兼容影响。

### 10.3 结束任务时

至少执行：

```powershell
npm test
npm run brain:verify
```

涉及 Python 卡带时追加对应 `unittest`；涉及桌面时追加 smoke test 和 `npm run desktop:make:win`；涉及合约时追加 compile、unit、fuzz 和独立读取测试。

Agent 最终报告模板：

```text
工作包：WP-XX
结果：完成 / 部分完成 / 阻塞
修改：按文件列出
数据迁移：无 / 版本与回滚方式
兼容性：v3、旧 SQLite、旧 checkpoint、桌面升级分别说明
安全影响：说明 Effective Policy、秘密边界、交易边界是否变化
测试：命令、通过数量、跳过数量
未完成：明确列出，禁止用“基本完成”掩盖
下一步：只指向依赖图中的后继 WP
```

## 11. 最终发布检查表

- [ ] Profile v1 Schema、默认值和 canonical hash 已冻结。
- [ ] 所有行为字段都有范围、单位、生效方式和 UI 说明。
- [ ] System Policy 独立且运行时二次执行。
- [ ] 多果蝇文件、SQLite、checkpoint、训练和评估完全隔离。
- [ ] 默认 Profile 与旧版行为等价。
- [ ] v3 导入/读取/验证未回归。
- [ ] v4 导出/验证/安装跨平台一致。
- [ ] 钱包和逐笔交易确认边界未放宽。
- [ ] Windows 干净安装与升级安装均通过。
- [ ] 没有生产部署、主网部署或生产数据修改。
- [ ] Registry V4 是否需要部署由独立决策记录确认。
