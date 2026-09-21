# Fly Profile v1 WP-00 基线记录

日期：2026-09-19
仓库：`bsc-local-fly-agent`
工作包：WP-00（基线保护与测试清单）

## 执行前状态

执行 `npm test` 的原始基线为 27 个测试、27 个通过、0 个失败、0 个跳过。

开始 WP-00 时工作树已经包含用户的桌面安装器和可移植运行时改动。WP-00 不修改这些业务文件，只新增基线 fixture/测试、扩展现有 v3 单元测试并修正文档中的一个默认值。执行前已有改动为：

- `.gitignore`
- `README.md`
- `package-lock.json`
- `package.json`
- `server/full-brain/main.py`
- `server/full-brain/worker.py`
- `src/brain/full-brain-client.mjs`
- `src/cartridge/deck.mjs`
- `src/server.mjs`
- `test/brain-and-simulation.test.mjs`
- `test/full-brain-integration.test.mjs`
- `desktop/`
- `electron-builder.yml`
- `scripts/make-windows-desktop.mjs`
- `src/paths.mjs`
- `test/desktop-bootstrap.test.mjs`

## 固定的基线

`test/fixtures/fly-profile-v1-baseline.json` 固定以下内容：

- 当前有效模拟参数到 `balanced-v1` Profile 字段的映射。
- 当前 Hybrid V2 奖励公式的确定性输入/输出样本。
- v3 fixture 必须在测试中动态生成，不提交真实 checkpoint。
- fixture 不包含私钥、助记词、密码、RPC URL、API Key、calldata 或 MaleCNS 大文件。

默认映射的来源如下：

| Profile 区域 | 当前来源 |
| --- | --- |
| `perception` | `SimulationRuntime` 的刷新/决策节流、快照窗口，以及 `deriveHybridFeatures` 的健康门槛 |
| `learning` | `SimulationRuntime.offerFullBrain()` 与全脑 worker 的 60 秒 checkpoint 周期 |
| `reward` | `HybridV2Lab.settle()`、`pulse()` 与 `pulseStrength()` |
| `strategy` | `HYBRID_V2_DEFAULTS` 加 `SimulationRuntime` 的有效覆盖值 |
| `risk` | `SIMULATION_DEFAULTS`、`SAFETY_LIMITS` 与现有 Hybrid 资金/池参与上限 |
| `runtime` | Hybrid 当前 decisions/outcomes/feedback 保留上限 |

## 计划校正

原计划把 `twapIntervalSeconds` 写为 3600，但当前 `SimulationRuntime` 明确以 300 秒覆盖 `HYBRID_V2_DEFAULTS`。为了履行“`balanced-v1` 完全等价当前默认值”，Profile v1 的默认值校正为 300 秒；允许范围不变。此项只修正文档和测试基线，不改变业务行为。

`liveTradingEnabled=false`、`dailyActionLimit=24`、`minimumActionIntervalSeconds=60` 是 Profile v1 新增的安全意图，并非旧运行时已有的同名开关；后续 WP-01/WP-06 必须在保存和运行时同时执行，不能把它们描述为旧实现已具备的 Profile 行为。

## 验收命令

```powershell
npm test
python -m unittest discover -s test -p "test_*.py"
npm run brain:verify
```

`brain:verify` 依赖本机已安装并准备好的 MaleCNS 数据；若环境未准备完成，应如实记录为环境前置条件，不能用虚假 fixture 代替完整数据校验。

## 本次结果

- `npm test`：32 个测试、32 个通过、0 个失败、0 个跳过。
- `python -m unittest discover -s test -p "test_*.py"`：15 个测试通过。
- `npm run brain:verify`：未执行模型校验；本机缺少全脑 Python 环境，命令以“请先运行 `npm run brain:setup`”退出。没有自动下载 MaleCNS 数据。
