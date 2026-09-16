# BSC 本地 Hybrid V2 果蝇 Agent

这是一个完全位于 `bsc-local-fly-agent/` 的隔离实现，不修改原项目文件。它沿用原项目的运行骨架：市场观察、完整果蝇脑、Hybrid V2 量化调控、四账户影子对照、持久化审计，以及受人工确认约束的 BSC 实盘执行边界。

完整的原项目分析见 [docs/ORIGINAL_PROJECT_ANALYSIS.md](docs/ORIGINAL_PROJECT_ANALYSIS.md)。

## 版本选择

| GitHub Release | 神经提案来源 | 本地准备 | 适用场景 |
|---|---|---|---|
| `v1.0.0-simplified`（简化版） | 原版 `fly-brain.mjs`，仍经过完整 Hybrid V2 量化闸门 | Node.js 与 `npm install` | 低资源本地体验；不运行 MaleCNS 全连接组 |
| `v2.0.0-full-brain`（全脑版，当前 `main`） | MaleCNS Python worker 的真实 DNp20/DNpe017 神经输出，仍经过完整 Hybrid V2 量化闸门 | Node.js、Python 3.12+、`npm run brain:setup`；约 1.58GiB 数据与约 840MB 峰值内存 | 完整本地连接组运行与真实采样脉冲点图 |

两个版本是同一仓库的独立历史快照，不是运行时切换开关。要使用简化版，请在 GitHub Releases 下载对应源码；当前 `main` 与下文启动步骤针对全脑版。两个版本的模拟交易与主网交易都存在资金风险，全脑神经输出不等于盈利保证。

## 快速启动

要求 Node.js 22.13 或更高版本、Python 3.12+，建议至少 4GB 可用内存和 2GB 可用磁盘。首次运行安装 Node 依赖并准备全连接组：

```powershell
cd bsc-local-fly-agent
npm install
npm run brain:setup
npm run brain:verify
npm start
```

`brain:setup` 从 MaleCNS 官方发布地址下载约 1.03GiB 原始数据，以锁定的 SHA-256 逐个校验，再编译完整图；最终 `data/full-brain/` 约 1.58GiB，不进入 Git。打开 <http://127.0.0.1:8788/> 后，Python worker 会实际加载 166,700 个神经元和 25,582,938 条有向边。运行测试：

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
MaleCNS 全连接组      Hybrid 特征派生
图像刺激→全图脉冲     趋势/位置/量能/数据健康
→DNp20/DNpe017        │
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

`server/full-brain/`、`vendor/stonkfly/`、`src/brain/fly-brain.mjs` 和 `src/strategy/hybrid-v2.mjs` 均保留原项目实现；测试会逐文件比较连接组源码，并比较两个 JS 决策模块的 SHA-256。网页运行时以全连接组输出作为神经提案，轻量脑仍保留用于来源核验和独立测试，不参与当前实盘提案。原版 Hybrid 的 `BURN` 仍在影子账户中按销毁记账，BSC 买卖边界才把最终 BURN 提案映射为 Token → BNB 的 `SELL`。

## 模拟实验

1. 输入有效的 `0x...` BSC 代币地址和四账户共同的初始余额。
2. 运行时先用官方 Flap Portal `getTokenV8Safe` 识别 Flap 代币：曲线期读取 Portal 的固定 18 位 quote 价格，迁移后读取 Portal 指定池的真实储备；再按主项目相同的小额边际探针把 quote-token 换算成 USDT。普通代币读取 PancakeSwap V2 池。
3. 页面与决策管线每秒接收链上现货样本并形成 OHLC。链上模式不伪造预热 K 线，满 60 个真实样本前量化健康门保持关闭；RPC 或价格换算失败时拒绝启动，而不是静默展示合成价格。
4. 每 10 秒把最新 36 根真实 K 线渲染成 320×180 RGB 感觉输入，送入完整 MaleCNS 图；DNp20 左右放电率差与 DNpe017 门控生成 BUY/SELL/HOLD，再进入七级门控：数据、量化、全脑、共识、频率、资金/流动性/Gas、Hybrid 执行。
5. 页面展示真实全脑脉冲、采样活跃胞体、DN 差分、计算耗时/内存、量化分数和阈值、门控失败原因、四账户、成交台账与事件流。
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
- **全脑进程隔离**：Python worker 只通过 stdin 接收市场图像参数；启动时采用环境变量白名单，不继承私钥、保险库密码、RPC URL 或控制台凭据。全脑进程没有钱包、签名或网络交易能力。
- **资金上限**：单笔买入硬上限为 `0.2 BNB`，滑点限定 `0.1%–15%`，deadline 为 5 分钟；Hybrid 内部还保留累计预算、余额、Gas、池参与率与价格冲击限制。
- **剩余风险**：本地 Node 进程在签名瞬间会接触解密后的私钥；恶意本机进程、被注入的页面、弱密码、剪贴板、磁盘备份、主机失窃或供应链攻击仍可能窃取资金。Hybrid 也不能识别所有蜜罐、黑名单、动态税、代理升级、MEV 或恶意 RPC。失败交易会消耗 Gas，授权成功而交换失败时仍可能遗留额度。仅使用隔离钱包和可承受全部损失的小额资金。

## 目录结构与职责

```text
bsc-local-fly-agent/
├─ package.json                         启动、开发、测试命令与 Node 版本
├─ .env.example                         RPC、监听地址和端口示例
├─ data/
│  ├─ bsc-fly-agent.sqlite              运行后生成的 WAL SQLite 状态库
│  ├─ local-wallet.vault.json           scrypt + AES-256-GCM 本地加密钱包
│  └─ full-brain/                        下载并编译的 MaleCNS 数据（忽略，不进 Git）
├─ server/full-brain/                    原项目 Python worker、校验、回放与测试代码
├─ vendor/stonkfly/                      原版神经模拟器、连接组编译器、许可证与锁文件
├─ scripts/
│  ├─ setup-full-brain.mjs              创建隔离 venv、下载、编译并校验连接组
│  └─ run-full-brain.mjs                跨平台 verify/self-test 命令入口
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
│  │  ├─ full-brain-client.mjs           隔离启动 Python worker 与 stdin 请求队列
│  │  └─ index.mjs                      轻量大脑公共导出
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
│  ├─ full-brain-integration.test.mjs    全连接组逐文件哈希、秘密隔离与管线接入
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
- 下方 SOMA FIELD 原样使用主项目 `malecns-points.json`：显示完整运行图中 12,781 个真实胞体采样点。worker 会把这些同 ID 神经元的真实脉冲按点位索引返回，页面高亮不是随机动画。数据许可为 CC BY 4.0。
- K 线来自运行时最近 36 根链上现货 OHLC，价格统一显示为 `TOKEN / USDT`；全脑状态、采样活跃数、KC/总脉冲、DAN 奖励/厌恶脉冲、计算耗时与 RSS 均来自 Python worker 当前观察结果。
- Three.js 作为本地依赖由同源服务提供，不访问第三方 CDN；场景限制像素比、离屏暂停，并遵循系统的“减少动态效果”偏好。

## 与原项目的隔离性

所有新增代码和运行数据均位于本目录。测试在原仓库旁运行时，会对 `server/full-brain/`、`vendor/stonkfly/` 的完整文件清单和内容逐一比对，并对果蝇脑、Hybrid V2 两份副本做 SHA-256 一致性校验；单独克隆本仓库时，来源对照测试会自动跳过，锁文件校验、管线测试与全脑运行不受影响。
