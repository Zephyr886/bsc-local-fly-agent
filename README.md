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

打开 <http://127.0.0.1:8788/>。控制台内置程序化 WebGL 果蝇数字孪生，并直接读取主项目同源的 MaleCNS v1.0 胞体点图，无需运行时下载外部模型或贴图。运行测试：

```powershell
npm test
```

自定义 RPC 时，复制 `.env.example` 为 `.env.local`，编辑 `BSC_RPC_URL` 后重启。不要提交含 API Key 的 RPC URL，并保持 `HOST=127.0.0.1`。

## 运行架构

```text
CA / BSC 元数据与池信息
          │
          ▼
MarketObserver（1 秒链上现货采样 + OHLC 聚合；离线测试才使用确定性样本）
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
2. 运行时先用官方 Flap Portal `getTokenV8Safe` 识别 Flap 代币：曲线期读取 Portal 的固定 18 位 quote 价格，迁移后读取 Portal 指定池的真实储备；再按主项目相同的小额边际探针把 quote-token 换算成 USDT。普通代币读取 PancakeSwap V2 池。
3. 页面与决策管线每秒接收链上现货样本并形成 OHLC。链上模式不伪造预热 K 线，满 60 个真实样本前量化健康门保持关闭；RPC 或价格换算失败时拒绝启动，而不是静默展示合成价格。
4. 每个周期都经过七级门控：数据、量化、果蝇脑、共识、频率、资金/流动性/Gas、Hybrid 执行。
5. 页面同时展示脑内部状态、量化分数和阈值、门控失败原因、TWAP/Quant/Brain/Hybrid 四账户、成交台账与事件流。
6. 决策、Hybrid 执行结果和完整检查点在同一 SQLite 事务写入 `data/bsc-fly-agent.sqlite`；服务停止后审计数据仍保留，当前版本不会在重启时自动恢复并继续旧会话。

模拟账户不签名、不广播、不读取钱包。影子账户使用真实链上价格但仍是模拟成交，不是历史回测或收益承诺；确定性合成行情只保留在自动化测试的离线运行路径中，不由网页入口启用。

## 真实交易边界

真实交易不能手工选择方向。只有当前运行时被 Hybrid 七级闸门实际放行、尚未使用且不超过 5 分钟的提案，才能进入交易预览：

1. 勾选风险确认，生成一个新的隔离钱包，或导入 `0x` 开头的 32 字节私钥。生成的钱包会将私钥仅回显一次，必须离线备份。
2. 私钥以 scrypt（N=131072、r=8、p=1）派生的 256 位密钥加密，再使用 AES-256-GCM 认证加密写入 `data/local-wallet.vault.json`；保险库密码不保存。
3. 页面锁定提案 CA、方向和最大数量；用户只能下调数量与设置滑点。服务端再次校验提案并为本次预览生成两分钟有效的一次性签名授权 ID。
4. 页面展示交易场所、路由、最小输出、状态和目标合约；用户必须重新输入保险库密码及确认短语。
5. 服务端仅在这一次请求中短暂解密并用 viem 本地账户签名、广播。授权和交换分别预览、输入密码和确认；成功回执复核后才消费 Hybrid 提案。

## 安全设计与风险

- **私钥**：只有 `/api/wallet/create`、`/api/wallet/import` 和逐笔签名接口允许处理必要的敏感字段；其余 API 继续统一拒绝私钥、助记词和 keystore。密文文件不包含明文私钥或密码。
- **加密与解锁**：随机 32 字节 salt、scrypt N=131072/r=8/p=1、随机 12 字节 IV、AES-256-GCM 和地址绑定 AAD。没有自动解锁、会话解锁、密码找回或明文导出接口；生成时仅一次性显示备份私钥。
- **授权范围**：BNB 买入无需 `approve`；卖出只对本次精确 token 数量授权给已选定的固定入口——Flap 代币授权给官方 Portal，普通 V2 代币授权给 PancakeSwap V2 Router——不请求无限授权。授权和交换是两笔独立确认。
- **Flap 路由**：状态 `Tradable` 的曲线期代币与状态 `DEX` 的已迁移代币都通过官方 Portal `swapExactInput` 构建，Portal 负责选择 bonding curve 或迁移后的 DEX。`Killed`、`Staged` 等不可交易状态会被拒绝；带自定义 extension 的代币在没有对应参数规范时默认阻止实盘。
- **确认机制**：风险勾选、Hybrid 有效提案、服务端二次校验、一次性签名授权、预览、密码、确认短语、链上成功回执缺一不可。前端不能指定任意接收方或 calldata 让保险库签名。
- **本地边界**：服务默认只监听 `127.0.0.1`，启用严格 CSP、同源 API、敏感请求 8KB 限制、每分钟 5 次解密/创建限流和每分钟 20 次预构建限流。SQLite 只保存策略状态、公开地址/哈希和交易上下文；密钥只在独立保险库文件中保存为密文。
- **资金上限**：单笔买入硬上限为 `0.2 BNB`，滑点限定 `0.1%–15%`，deadline 为 5 分钟；Hybrid 内部还保留累计预算、余额、Gas、池参与率与价格冲击限制。
- **剩余风险**：本地 Node 进程在签名瞬间会接触解密后的私钥；恶意本机进程、被注入的页面、弱密码、剪贴板、磁盘备份、主机失窃或供应链攻击仍可能窃取资金。Hybrid 也不能识别所有蜜罐、黑名单、动态税、代理升级、MEV 或恶意 RPC。失败交易会消耗 Gas，授权成功而交换失败时仍可能遗留额度。仅使用隔离钱包和可承受全部损失的小额资金。

## 目录结构与职责

```text
bsc-local-fly-agent/
├─ package.json                         启动、开发、测试命令与 Node 版本
├─ .env.example                         RPC、监听地址和端口示例
├─ data/
│  ├─ bsc-fly-agent.sqlite              运行后生成的 WAL SQLite 状态库
│  └─ local-wallet.vault.json           scrypt + AES-256-GCM 本地加密钱包
├─ public/
│  ├─ index.html                        量化控制台、实盘队列、架构与安全页
│  ├─ styles.css                        响应式高密度控制台与无障碍状态
│  ├─ app.js                            快照渲染、轮询、钱包签名与回执流程
│  ├─ scene.js                          3D 果蝇、MaleCNS 点图及运行状态实时映射
│  └─ malecns-points.json               主项目同源的 12,781 个 MaleCNS 胞体采样点
├─ src/
│  ├─ server.mjs                        本地 HTTP 服务、同源 API、限流和恢复
│  ├─ config.mjs                        BSC/Pancake/Flap 地址与安全硬上限
│  ├─ util.mjs                          校验、确定性随机和敏感字段拒绝
│  ├─ brain/
│  │  ├─ fly-brain.mjs                  原版果蝇脑逐字副本
│  │  └─ index.mjs                      大脑公共导出
│  ├─ strategy/
│  │  └─ hybrid-v2.mjs                  原版 Hybrid V2 逐字副本
│  ├─ market/
│  │  └─ observer.mjs                   链上现货 K 线、离线测试行情与市场快照
│  ├─ agent/
│  │  └─ simulation.mjs                 完整管线编排、四账户和实盘提案约束
│  ├─ persistence/
│  │  └─ sqlite-store.mjs               WAL 表结构、恢复与原子周期提交
│  ├─ wallet/
│  │  └─ local-vault.mjs                钱包生成/导入、认证加密与逐笔本地签名
│  └─ chain/
│     ├─ bsc.mjs                        BSC 元数据/池、路由分派、交易构造和回执
│     └─ flap.mjs                       Flap 状态识别、Portal 报价、精确授权与 swap 编码
├─ test/
│  ├─ brain-and-simulation.test.mjs     双模块哈希、门控、账户与安全测试
│  ├─ flap-routing.test.mjs             Portal 地址、状态门控与官方 swap ABI 测试
│  └─ local-wallet-vault.test.mjs       密文落盘、密码校验与导入一致性测试
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
| `GET` | `/api/token?address=` | 读取 ERC-20、Flap Portal 状态与 PancakeSwap V2 池 |
| `GET` | `/api/wallet/status` | 只返回本地保险库状态和公开地址 |
| `POST` | `/api/wallet/create` | 生成、加密钱包并一次性返回备份私钥 |
| `POST` | `/api/wallet/import` | 专用私钥导入并立即加密落盘 |
| `POST` | `/api/transaction/prepare` | 二次校验 Hybrid 提案并生成一次性签名授权 |
| `POST` | `/api/transaction/sign-send` | 密码和确认短语验证后逐笔解密、签名与广播 |
| `GET` | `/api/transaction/receipt?hash=` | 读取公开链上回执 |
| `POST` | `/api/live/complete` | 复核成功回执并消费对应 Hybrid 提案 |

后端不提供任意消息签名、任意交易签名、长期解锁、密码找回或明文私钥导出接口。

## 3D 数字孪生控制台

- 上方按主项目 `3D MOTOR CHAMBER` 结构组织：实时 K 线显示器、程序化果蝇和 BUY/BURN 实体按钮位于同一 WebGL 场景，可拖拽旋转、滚轮缩放和双击复位。
- BUY/BURN 按钮只订阅全脑原始非 HOLD 决策；每个决策事件只触发一次按钮下压。按钮动作不等于成交，Hybrid 量化共识、频率和风控仍独立决定模拟或实盘提案。
- 下方 SOMA FIELD 原样使用主项目 `malecns-points.json`：从 MaleCNS v1.0 的 139,662 个神经元中保留 12,781 个真实胞体坐标采样点，按主项目相同的十类语义色板和投影公式绘制；支持细胞类型和策略状态两种着色模式。数据许可为 CC BY 4.0。
- K 线来自运行时最近 36 根链上现货 OHLC，价格统一显示为 `USDT / TOKEN`；PN 输入、KC 激活、APL 抑制和多巴胺读数来自当前模拟快照，并非预渲染视频或装饰图片。
- Three.js 作为本地依赖由同源服务提供，不访问第三方 CDN；场景限制像素比、离屏暂停，并遵循系统的“减少动态效果”偏好。

## 与原项目的隔离性

所有新增代码和运行数据均位于本目录。测试在原仓库旁运行时，会对果蝇脑和 Hybrid V2 两份副本分别做 SHA-256 一致性校验；单独复制本目录时，这两项来源对照测试会自动跳过，其余功能仍可运行。
