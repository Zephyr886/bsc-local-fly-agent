# Fly Profile v1 WP-01 Registry 与 System Policy

日期：2026-09-19
工作包：WP-01

## Registry V3 唯一来源

应用代码只从 `src/chain/registry-config.mjs` 读取 BSC 主网 Registry 配置：

| ID | 类型 | 主网状态 | 地址 | 读取方式 |
| --- | --- | --- | --- | --- |
| `v3-auto` | Auto / 分块上传 | 仅保留历史测试网兼容；不声明主网部署 | 无 | `begin` + `upload` calldata |
| `v3-direct` | Direct / 钱包单笔发布 | 历史主网 | `0x8a318b90ae7ce6c3c55dd5f596e16c1623c2c46a` | `publish` calldata |
| `v3-image` | Image / 图像元数据单笔发布 | 当前活动读取器 | `0x7c35e97e8f89eeb2586db4031c13c63d4bd6ca21` | `publish` calldata，Image 字节码锁 |

配置中的 `contractName` 会在测试中与各自锁定 artifact 核对。当前活动读取器固定使用 Image artifact，不会仅凭地址猜测合约类型。v3 的服务端权威限制为：manifest 最多 16,384 字节，manifest 与 state 合计最多 120,000 字节。

## System Policy

`src/policy/system-policy.mjs` 冻结以下发行版边界：

- 仅允许 `127.0.0.1`、`localhost`、`::1` 作为监听配置；默认绑定 `127.0.0.1`。
- 单笔买入最多 `0.2 BNB`，滑点 `0.1%–15%`，deadline 300 秒。
- 有效资金预算最多 10%，池参与率最多 0.5%，每日动作最多 24 次。
- 最小动作间隔至少 60 秒。
- 普通 Profile 请求 32 KiB；卡带请求使用独立 180,000 字节边界。

`resolveEffectiveRisk()` 对完整的 Profile risk 对象执行严格字段和范围校验。用户值只可能被保留或收紧；响应包含 `effectiveRisk` 和逐字段 `restrictions`。未知字段、非有限数值、科学计数法金额、越界滑点与非整数计数都会被拒绝。

## 兼容性

- `src/config.mjs` 继续导出 `BSC_CHAIN_ID` 与 `SAFETY_LIMITS`，但值由统一配置派生，现有交易构建器无需维护第二份硬限制。
- 卡带状态响应继续保留旧 `contract` 字段，并新增显式的 `registry.id/type/chainId/address`。
- v3 manifest、state、Python verifier、旧 checkpoint、SQLite 和钱包格式均未改变。
- 本工作包没有进行网络写入、合约部署、生产部署或数据迁移。

## 验收结果

- `npm test`：39 个测试、39 个通过、0 个失败、0 个跳过。
- Python 单元测试：15 个通过。
- Auto、Direct、Image 三套 v3 artifact 可复现构建检查全部通过。
- `npm run brain:verify`：当前机器缺少全脑 Python 环境，仍需先运行 `npm run brain:setup`；本工作包没有自动下载 MaleCNS 数据。
