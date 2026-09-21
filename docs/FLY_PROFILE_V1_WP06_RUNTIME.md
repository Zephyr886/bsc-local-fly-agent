# Fly Profile v1 WP-06 运行时记录

日期：2026-09-19
仓库：`bsc-local-fly-agent`
工作包：WP-06（Profile 驱动的脑与 Hybrid 运行时）

## 固定 activation context

`FlyManager` 在激活、切换和回滚后把不可变 activation context 注入 `SimulationRuntime`。启动时再次校验 Effective Profile、固定 token 规则和 checkpoint 一致性；运行中的 worker 请求固定携带：

- `flyId`、`profileRevision`、`profileHash`、`modelVersion`
- `learning`、`neuralMs`、`thresholdHz`、`checkpointEverySeconds`
- Profile 限制后的 history、token context 与强化脉冲

市场刷新、神经决策间隔、history 长度、健康样本数、市场/流数据时效和最小动作间隔均从当前 Effective Profile 读取。simulation snapshot 和 session audit descriptor 同步公开固定的果蝇来源字段。

## Profiled Hybrid V2 与奖励

原版 `src/strategy/hybrid-v2.mjs` 保持不变。新增 `ProfiledHybridV2` adapter：

- 通过原有 options 注入 Profile strategy 和被 System Policy 收紧的 risk 参数。
- 覆盖可配置结算窗口、主奖励窗口、奖励权重、反馈阈值与保留数量。
- 增加 Profile 日动作上限和 live trading 开关。
- 默认 Profile 与原版使用相同 settings；确定性输入的 scores、actions、executions 和奖励 fixture 保持一致。

不同 reward Profile 对同一 outcome 会产生不同 utility，且反馈脉冲只从已执行的 Hybrid 结果生成。

## MaleCNS worker 协议

Node client 和 Python worker 都执行 exact-field 白名单与类型、范围校验。未知字段、缺失字段、非法身份、神经参数和市场参数在进入计算前失败。worker 会保留可解析请求的 ID 回传校验错误，避免客户端把协议错误误报成超时。

controller 身份改为 `(flyId, modelVersion)`；token 只是该果蝇的当前训练上下文。同一果蝇切换允许的 token 不会重建或错误恢复另一果蝇的 checkpoint。100–199ms 的 Profile 神经窗口会把默认 200ms 强化脉冲裁剪到窗口长度；200ms 以上保持原版行为。

`learning.enabled=false` 时：

- MaleCNS 权重进入 frozen 状态；
- 每次观察前后比较 weight SHA-256；
- checkpoint 保存前后再次验证；
- 响应报告 `weightsFrozenVerified`。

相邻 `service.json` 元数据原子写入 `flyId`、Profile revision/hash、modelVersion、token context、learning 状态、保存时间与 weight SHA-256。恢复身份只比较 flyId 与 modelVersion，因此 token 可变但果蝇间严格隔离。

## 实盘提案边界

每个 live proposal 携带 `flyId + revision + profileHash`，并记录 Profile slippage 与被限制后的最大买入量。Profile 切换会立即把已有 approved proposal 标记为 `profile-changed`；准备和签名前都会重新验证 activation、状态、有效期、token、方向、数量和 slippage。

## 验收结果

- Node 全量测试：77 个通过（最终数量以工作包结束报告为准）。
- Python protocol/unittest：21 个通过。
- `npm run brain:verify`：MaleCNS v1.0 的 166,700 个神经元、25,582,938 条有向边及锁定数组校验通过。
- 真实 worker 探针：同一 fly 连续处理两个不同 token；两次均验证 `learning=false` 权重冻结，第二次未重建 controller，最终 metadata 完整且 token context 更新为第二个 token。
- worker 子进程敏感环境变量过滤测试继续通过；原版 Hybrid V2、受控 MaleCNS 来源和点云哈希测试继续通过。
- 未连接生产服务、未发起链上交易、未写入真实钱包或生产 checkpoint。

WP-06 只负责 Profile 驱动的运行时与脑协议。训练轮次、确定性 replay 和评估生命周期属于 WP-07。
