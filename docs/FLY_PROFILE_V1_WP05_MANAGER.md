# Fly Profile v1 WP-05 FlyManager 记录

日期：2026-09-19
仓库：`bsc-local-fly-agent`
工作包：WP-05（FlyManager 与安全切换状态机）

## 状态机与 activation context

新增 `FlyManager`，统一持有 `FlyRepository`、全脑 client、simulation 和 cartridge deck 引用。状态转换为：

```text
inactive -> activating -> ready -> running -> stopping -> ready
ready -> switching -> ready(other fly)
failure -> previous stable state or error
```

激活果蝇时读取当时的 Profile revision，构造经过 System Policy 收紧的 `EffectiveFlyProfile`，并冻结包含以下来源信息的 activation context：

- `flyId`
- `revision`
- `profileHash`
- `checkpointId` 和固定 checkpoint 路径
- `effectiveProfile`
- `activatedAt`

保存新 Profile revision 不会改变已经冻结的运行 context；WP-06 将让 SimulationRuntime 和 worker 实际消费该 context。

## 安全切换

- running 状态下直接切换返回 `FLY_SWITCH_WHILE_RUNNING`。
- ready 状态切换时依次停止 simulation、等待全脑 pending 请求、保存并 park worker、原子更新 marker、激活目标 checkpoint。
- 切换期间并发状态变更返回 `FLY_MANAGER_BUSY`。
- checkpoint 激活失败时恢复旧 marker、旧 context 和旧 checkpoint；回滚本身失败则进入 `error`，不会把不确定状态伪装成 ready。
- 启动恢复只解析活动选择并定位 checkpoint，绝不调用 `simulation.start()`，因此不会自动恢复交易或训练 session。
- 新 fly 首次激活时获得隔离的 checkpoint 目录；不存在 checkpoint 文件表示从干净脑状态开始，后续由 worker 保存。

## Legacy 首次升级

仅当 flies 列表为空，并且检测到以下任一来源时创建 `legacy-default`：

1. cartridge deck 的活动 v3 run checkpoint；
2. 旧版 `service.npz`。

活动 v3 run 优先。迁移采用复制而不是移动：源 `service.npz` 和相邻 metadata 保持原位；目标使用新的 checkpoint UUID，并写入不包含源磁盘路径的 `migration-source.json`。随后才写 `active-fly.json`。没有旧状态的干净安装不会凭空创建 legacy fly。

## 文件仓库扩展

`FlyRepository` 增加：

- 严格读取和原子写入 `active-fly.json`；只允许 `flyId`、`revision`、`checkpointId` 三个字段。
- 固定生成 fly checkpoint 文件路径。
- 创建隔离 checkpoint slot。
- 原子复制旧 checkpoint，并在复制文件 flush/close 后 rename。

所有 ID 继续先通过 UUID 校验；marker 必须与 `fly.json` 当前 revision/checkpoint 完全一致。

## 验收结果

- `node --test test/fly-manager.test.mjs test/fly-repository.test.mjs`：15 个通过。
- 运行中切换拒绝、pending 等待、激活故障回滚、只恢复选择、旧 checkpoint 保留、活动 v3 run 优先和干净安装不迁移均通过。
- `npm test`：最终结果见本工作包结束报告。
- 未迁移仓库中的真实用户数据，未启动交易、未连接生产环境。

本工作包提供可测试的协调服务；WP-06 负责让 simulation/worker 消费 activation context 并替换运行时硬编码，后续 API 工作再对外暴露多果蝇操作。
