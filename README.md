# BSC 本地 Hybrid V2 果蝇 Agent

这是一个完全位于 `bsc-local-fly-agent/` 的隔离实现，不修改原项目文件。它沿用原项目的运行骨架：市场观察、完整果蝇脑、Hybrid V2 量化调控、四账户影子对照、持久化审计，以及受人工确认约束的 BSC 实盘执行边界。

完整的原项目分析见 [docs/ORIGINAL_PROJECT_ANALYSIS.md](docs/ORIGINAL_PROJECT_ANALYSIS.md)。

## 快速启动

要求 Node.js 22.13 或更高版本；Node 24 LTS 更佳。首次运行先安装 `viem` 依赖。

```powershell
cd bsc-local-fly-agent
npm install
npm start
```

打开 <http://127.0.0.1:8788/>。运行测试：

```powershell
npm test
```

自定义 RPC 时，复制 `.env.example` 为 `.env.local`，编辑 `BSC_RPC_URL` 后重启。不要提交含 API Key 的 RPC URL，并保持 `HOST=127.0.0.1`。

## 运行架构

```text
CA / BSC 元数据与池信息
          │
          ▼
MarketObserver（120 个预热样本 + 5 秒行情/成交流）
          │
          ├──────────────┐
          ▼              ▼
原版 fly-brain       Hybrid 特征派生
PN→KC→APL→DAN         趋势/位置/量能/数据健康
→MBON→DN              │
          └──────┬───────┘
                 ▼
原版 Hybrid V2：量化阈值 → 脑/量化共识 → 频率预算 → 风控
                 │
          ┌──────┼────────┬────────┐
          ▼      ▼        ▼        ▼
        TWAP    Quant    Brain    Hybrid
          └───────────────┬────────┘
                          ▼
              SQLite 决策/成交/检查点事务
                          │
                          ▼
             HTML 控制台 / Hybrid 实盘提案
```

`src/brain/fly-brain.mjs` 和 `src/strategy/hybrid-v2.mjs` 都是原项目对应模块的逐字副本，测试会比较 SHA-256。业务适配全部位于副本之外：原版 Hybrid 的 `BURN` 仍在影子账户中按销毁记账，BSC 买卖边界才把最终 BURN 提案映射为 Token → BNB 的 `SELL`。

## 模拟实验

1. 输入有效的 `0x...` BSC 代币地址和四账户共同的初始余额。
2. 运行时尝试读取代币元数据与 PancakeSwap V2 池；RPC 不可用时使用由 CA 确定、可重复的合成行情，便于离线演示。
3. 果蝇脑先接收 120 个预热样本；随后每秒推进一个 5 秒市场样本。
4. 每个周期都经过七级门控：数据、量化、果蝇脑、共识、频率、资金/流动性/Gas、Hybrid 执行。
5. 页面同时展示脑内部状态、量化分数和阈值、门控失败原因、TWAP/Quant/Brain/Hybrid 四账户、成交台账与事件流。
6. 决策、Hybrid 执行结果和完整检查点在同一 SQLite 事务写入 `data/bsc-fly-agent.sqlite`；服务停止后审计数据仍保留，当前版本不会在重启时自动恢复并继续旧会话。

模拟账户不签名、不广播、不读取钱包。合成行情和影子账户只用于验证策略管线，不是历史回测，也不是收益承诺。

## 真实交易边界

真实交易不能手工选择方向。只有当前运行时被 Hybrid 七级闸门实际放行、尚未使用且不超过 5 分钟的提案，才能进入交易预览：

1. 勾选风险确认并连接 MetaMask、Rabby 等 EIP-1193 注入式钱包。
2. 页面校验钱包处于 BSC 主网（Chain ID 56），并锁定提案 CA、方向和最大数量；用户只能下调数量与设置滑点。
3. 服务端再次校验提案时间、CA、方向和额度，然后为固定 PancakeSwap V2 Router 构造未签名交易。
4. 页面展示路由、最小输出、deadline 和合约，再要求输入确认短语。
5. 每次授权、交换都必须由钱包弹窗单独确认；交换成功回执还会由服务端复核后才把提案标记为已使用。

## 安全设计与风险

- **私钥**：页面没有私钥、助记词或 keystore 输入框；后端发现敏感字段会拒绝请求。密钥存储、加密、解锁和签名完全交给钱包扩展，本项目既不实现也不声称自建加密保险库。
- **授权范围**：BNB 买入无需 `approve`；卖出只对本次精确 token 数量授权给固定 PancakeSwap V2 Router，不请求无限授权。授权和交换是两笔独立确认。
- **确认机制**：风险勾选、BSC 网络校验、Hybrid 有效提案、服务端二次校验、预览确认短语、钱包签名、链上成功回执缺一不可。钱包仍是最后签名闸门。
- **本地边界**：服务默认只监听 `127.0.0.1`，启用严格 CSP、同源 API、32KB 请求体限制和交易预构建限流。SQLite 只保存策略状态、公开地址/哈希和交易上下文，不保存密钥。
- **资金上限**：单笔买入硬上限为 `0.2 BNB`，滑点限定 `0.1%–15%`，deadline 为 5 分钟；Hybrid 内部还保留累计预算、余额、Gas、池参与率与价格冲击限制。
- **剩余风险**：Hybrid 共识不能识别所有蜜罐、黑名单、动态税、代理升级、MEV、恶意 RPC/扩展或供应链攻击。失败交易也会消耗 Gas；授权成功而交换失败时仍可能遗留额度。仅使用隔离钱包和可承受全部损失的小额资金。

## 目录结构与职责

```text
bsc-local-fly-agent/
├─ package.json                         启动、开发、测试命令与 Node 版本
├─ .env.example                         RPC、监听地址和端口示例
├─ data/
│  └─ bsc-fly-agent.sqlite              运行后生成的 WAL SQLite 状态库
├─ public/
│  ├─ index.html                        量化控制台、实盘队列、架构与安全页
│  ├─ styles.css                        响应式高密度控制台与无障碍状态
│  └─ app.js                            快照渲染、轮询、钱包签名与回执流程
├─ src/
│  ├─ server.mjs                        本地 HTTP 服务、同源 API、限流和恢复
│  ├─ config.mjs                        BSC/Pancake 地址与安全硬上限
│  ├─ util.mjs                          校验、确定性随机和敏感字段拒绝
│  ├─ brain/
│  │  ├─ fly-brain.mjs                  原版果蝇脑逐字副本
│  │  └─ index.mjs                      大脑公共导出
│  ├─ strategy/
│  │  └─ hybrid-v2.mjs                  原版 Hybrid V2 逐字副本
│  ├─ market/
│  │  └─ observer.mjs                   预热、K 线/成交流与市场快照
│  ├─ agent/
│  │  └─ simulation.mjs                 完整管线编排、四账户和实盘提案约束
│  ├─ persistence/
│  │  └─ sqlite-store.mjs               WAL 表结构、恢复与原子周期提交
│  └─ chain/
│     └─ bsc.mjs                        元数据/池、报价、未签名交易和回执
├─ test/
│  └─ brain-and-simulation.test.mjs     双模块哈希、门控、账户与安全测试
└─ docs/
   └─ ORIGINAL_PROJECT_ANALYSIS.md      原项目结构、数据流和取舍说明
```

## API 摘要

| 方法 | 路径 | 职责 |
|---|---|---|
| `GET` | `/api/health` | 服务、运行时和公开安全配置 |
| `GET` | `/api/simulation` | 当前脑、闸门、四账户、台账快照 |
| `POST` | `/api/simulation/start` | 校验 CA、加载元数据并启动完整管线 |
| `POST` | `/api/simulation/stop` | 暂停并保留检查点 |
| `POST` | `/api/simulation/reset` | 重置活动运行时；历史审计记录保留 |
| `GET` | `/api/token?address=` | 读取 ERC-20 与 PancakeSwap V2 池 |
| `POST` | `/api/transaction/prepare` | 二次校验 Hybrid 提案并构造未签名交易 |
| `GET` | `/api/transaction/receipt?hash=` | 读取公开链上回执 |
| `POST` | `/api/live/complete` | 复核成功回执并消费对应 Hybrid 提案 |

后端不提供私钥导入、托管签名或原始交易广播接口。

## 与原项目的隔离性

所有新增代码和运行数据均位于本目录。测试在原仓库旁运行时，会对果蝇脑和 Hybrid V2 两份副本分别做 SHA-256 一致性校验；单独复制本目录时，这两项来源对照测试会自动跳过，其余功能仍可运行。
