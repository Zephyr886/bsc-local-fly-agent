# BSC 本地 Hybrid V2 果蝇 Agent

这是一个完全位于 `bsc-local-fly-agent/` 的隔离实现，不修改原项目文件。它沿用原项目的运行骨架：市场观察、完整果蝇脑、Hybrid V2 量化调控、四账户影子对照、持久化审计，以及受人工确认约束的 BSC 实盘执行边界。

完整的原项目分析见 [docs/ORIGINAL_PROJECT_ANALYSIS.md](docs/ORIGINAL_PROJECT_ANALYSIS.md)。

## 版本选择

| GitHub Release | 神经提案来源 | 本地准备 | 适用场景 |
|---|---|---|---|
| `v1.0.0-simplified`（简化版） | 原版 `fly-brain.mjs`，仍经过完整 Hybrid V2 量化闸门 | Node.js 与 `npm install` | 低资源本地体验；不运行 MaleCNS 全连接组 |
| `v2.0.0-full-brain`（全脑版） | MaleCNS Python worker 的真实 DNp20/DNpe017 神经输出，仍经过完整 Hybrid V2 量化闸门 | Node.js、Python 3.12+、`npm run brain:setup`；约 1.58GiB 数据与约 840MB 峰值内存 | 完整本地连接组运行与真实采样脉冲点图 |
| `v4.2.0`（当前 `main`） | MaleCNS 全脑 + Profile v1 + 多果蝇隔离训练/评估 | Windows 安装器可自助初始化；源码模式要求 Node.js 22.13+ 与 Python 3.12+ | 桌面版、多果蝇管理、Fly Cartridge v4；中文/English 界面切换 |

这些版本是同一仓库的独立历史快照，不是运行时切换开关。要使用旧版，请在 GitHub Releases 下载对应源码；当前 `main` 与下文启动步骤针对 4.2.0。所有版本的模拟交易与主网交易都存在资金风险，全脑神经输出不等于盈利保证。升级范围和不兼容项见 [CHANGELOG](CHANGELOG.md)。

## 快速启动

要求 Node.js 22.13 或更高版本、Python 3.12+，建议至少 4GB 可用内存和 2GB 可用磁盘。首次运行安装 Node 依赖并准备全连接组：

```powershell
cd bsc-local-fly-agent
npm install
npm run brain:setup
npm run brain:verify
npm start
```

打开 <http://127.0.0.1:8788/flies> 管理多只果蝇，或进入 <http://127.0.0.1:8788/cartridge> 使用本地卡带游戏机。第一次完整走通一只果蝇：

1. 在“果蝇管理”点击“创建果蝇”，输入名称并选择 `balanced-v1`；预设只是可复现起点，不代表收益或安全保证。
2. 打开该果蝇的 Profile。基础模式可改常用参数，高级模式可改全部字段；先查看“保存影响”，再保存为新的不可变 revision。
3. 点击“设为活动”。正在运行时不能切换；先在主控制台或管理页停止当前运行。
4. 在“训练”选择链上观察并填写 BSC Token CA，或选择确定性回放并填写本机数据集路径。链上观察需手动停止，停止时保存 checkpoint；回放会运行到完成。
5. 在“评估”填写同一份回放数据集。评估强制冻结学习，产生可比较指标，不会改写 checkpoint。
6. 确认运行已停止，转到“卡带游戏机”，点击“从当前大脑导出卡带”，分别下载 `cartridge.json` 和 `state.bin`，并保留在同一备份目录。

文件导入支持 v3 和 v4；BSC 主网 Card ID 仍从 Registry V3 独立取回。v3 会先由原 verifier 完整验证，再包装为带默认 Profile 和真实来源声明的新果蝇；v4 会同时验证 canonical Profile、三字段学习状态、共享锁和启动探针。每只果蝇的 Profile、checkpoint、训练/评估记录与卡带历史分别保存在 `data/flies/<fly-id>/`。

全部 Profile 字段、范围、默认值和生效时机见 [Profile v1 字段手册](docs/FLY_PROFILE_V1_FIELD_REFERENCE.md)。需要把自行获取的 K 线交给 Agent 转换时，必须同时提供 [确定性回放数据集 v1 规范](docs/DETERMINISTIC_REPLAY_DATASET_V1.md)；普通 OHLCV 不能未经转换直接回放。开始实盘前必须阅读 [数据备份与恢复](docs/BACKUP_AND_RECOVERY.md) 和本页“安全设计与风险”。

## Windows 桌面安装版

Windows x64 桌面版使用 Electron 包装同一套本地服务和网页界面。用户不需要预装 Node.js 或 Python：首次启动向导会下载经过 SHA-256 锁定的 Python 3.12 安装器，在应用用户目录建立隔离环境，再下载、编译并校验 MaleCNS v1.0。首次初始化约下载 1.03 GiB，安装后的全脑数据和 Python 环境约占 1.8 GiB。

钱包密文、SQLite、全脑数据和卡带运行检查点位于 `%LOCALAPPDATA%/FLAP Fly Agent/data/`，工作环境位于 `%LOCALAPPDATA%/FLAP Fly Agent/work/`，均不写入安装目录；更新应用不会覆盖这些数据。源码启动时对应目录是仓库内的 `data/` 和 `work/`。初始化失败或需要修复时，从桌面程序的“系统 → 安装或修复全脑环境”重新进入向导。

从旧单实例版本首次升级时，桌面程序会在启动后端前检查磁盘空间、SQLite 版本、旧 checkpoint 和活动选择。小型 metadata、SQLite/WAL 及钱包密文会写入带 SHA-256 清单的 `data/migration-backups/fly-profile-v1/`；1.58GiB 共享 MaleCNS 数据不会重复备份。旧 `data/full-brain/service.npz` 或活动 v3 run 会复制为 `legacy-default` 的 checkpoint，源/目标 SHA-256 相同后才更新活动指针。迁移进度保存在 `data/migrations/fly-profile-v1/journal.json`，中断后重新启动会继续而不会创建第二只 legacy fly。完成标记和原始旧文件都会保留；诊断日志位于 `%LOCALAPPDATA%/FLAP Fly Agent/logs/desktop.log`。

在 Windows 上生成未签名测试安装器：

```powershell
npm install
npm test
npm run desktop:make:win
```

安装器输出到 `out/windows/FLAP-Fly-Agent-Setup-4.2.0.exe`。它使用可见的 Windows 安装向导，可以选择安装目录；完成后从桌面或开始菜单的“FLAP Fly Agent”快捷方式启动。安装器不在完成页自动运行，避免 Windows 尚未完成快捷方式解析时出现错误提示。构建脚本会自动兼容包含中文的仓库路径。

4.2.0 定位为未签名的小范围测试版。安装前必须从同一 GitHub Release 下载
`SHA256SUMS.txt` 并核对 SHA-256；Windows 可能显示“未知发布者”或 SmartScreen
提示，Smart App Control 或组织安全策略也可能直接阻止安装。不要为了安装而关闭系统
安全功能；被策略阻止的设备不在本测试版支持范围内。

安装器配置明确使用 `deleteAppDataOnUninstall: false`；升级或卸载程序文件不会主动删除 `data/flies`、SQLite、钱包密文、迁移备份或 MaleCNS 数据。需要删除用户数据时必须由用户在退出程序后自行备份并明确处理。

本次双语界面范围见 [4.2.0 发布说明](docs/RELEASE_NOTES_V4.2.0.md) 和
[回滚指引](docs/ROLLBACK_V4.2.0.md)。4.1.3 的 NFT 图片修复和部署台继续保留。

导入后新果蝇成为活动选择。暂停运行后，在卡带游戏机点击“从当前大脑导出卡带”，会生成 v4 `cartridge.json` 与 `state.bin`。v4 包含 canonical Profile 以及学习到的 `weight`、`memory_u`、`memory_w`；市场进度、Hybrid 记录、SQLite、钱包及交易记录留在本机。v4 **不可发布到 Registry V3**。Registry V4 官方合约部署和链上测试使用同一 Release 中单独提供的 `FLAP-Registry-V4-Deployer.html`；该文件连接浏览器钱包，不在 App 内运行，也不读取 App 钱包。完整格式与链上边界见 [Fly Cartridge v4](docs/FLY_CARTRIDGE_V4.md) 和 [Registry V4 规格](docs/FLY_CARTRIDGE_REGISTRY_V4_SPEC.md)。

独立部署台可由 `npm run registry:v4:deployer:build` 确定性生成。它只允许部署仓库固定的 Registry V4 artifact，并发布一次性测试卡带完成 Card、NFT、calldata 和重复拒绝验证。先在 BSC Testnet 使用；主网部署和测试均不可回滚。

## 实验性卡带状态对照

`scripts/fly_cartridge_state_ref.py` 可在**本仓库**的已验证 MaleCNS 底座上，将本地 `service.npz` 编成无损差分二进制并逐数组校验。它是供 FlyCartridge v2 研发使用的内部参考格式，尚未冻结公开清单、card ID 或链上发布协议。命令只读取本地检查点和共用数据，不读取 SQLite 设置库或钱包。

```powershell
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_state_ref.py data/full-brain/service.npz --continue-ms 10 --write-bin work/my-fly.ref.bin
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_state_ref.py --read-bin work/my-fly.ref.bin --compare-checkpoint data/full-brain/service.npz
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_state_ref.py --read-bin work/my-fly.ref.bin --continue-ms 10
& work/full-brain-venv/Scripts/python.exe -m unittest test/test_fly_cartridge_state_ref.py -q
```

Linux 使用 `work/full-brain-venv/bin/python`。运行前先完成 `npm run brain:setup`，并保持图、标注、神经元数据及源码版本匹配。实验格式的报告会明确指出不兼容的内核版本；未经继续运行验证的状态不能标成完整恢复。

`scripts/fly_cartridge_v2.py` 是下一阶段的**候选**导出/验证器。它从本机检查点和显式提供的公开设置 JSON 生成 `cartridge.json`、`state.bin`，在本机验证全部共享文件锁、24 个字段与固定探针；不会打开设置数据库、钱包或 RPC。公开设置只接受 v1 白名单里的字段，拒绝私钥及未知项。先复制示例 JSON 到 `work/my-public-settings.json`，将其中的占位代币地址改为检查点旁 `service.json` 的 `tokenAddress`，并填入导出时有效的公开设置。工具会核对代币地址；清单只声称导出时设置，不证明训练期间设置。

```powershell
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_v2.py export --checkpoint data/full-brain/service.npz --settings-json work/my-public-settings.json --out work/my-candidate-cartridge
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_v2.py verify work/my-candidate-cartridge
```

Windows/Linux 已用同一真实训练状态独立得到逐字节相同的候选 `state.bin` 与相同的神经状态去重键；清单因导出时间不同会有不同 card ID。该格式仍待固定 GitHub 版本、公开测试网和客户端验收，不能当成已经发布的卡带标准。

### v3 学习特质卡带

v3 候选规格、MIT 授权范围、原始数据 SHA-256 与合约重编译记录见
[v3 release candidate record](docs/FLY_CARTRIDGE_V3_RC.md)。运行
`npm run cartridge:v3:build-check` 可核对候选合约产物；历史测试网合约仍使用
`artifacts/fly-cartridge-v3-auto.json`，两者字节码不可混用。

`scripts/fly_cartridge_v3.py` 只导出 `weight`、`memory_u`、`memory_w`。载入后神经运行现场和游标重置，并允许继续学习；运行进度、交易记录和部署设置由本机保存。v3 与 v2 完整检查点使用不同身份域和格式版本。格式已通过 Windows、Linux、BSC 测试网与主网独立取回和启动验收。当前本地游戏机读取经逐字节验证的 **Image** 主网 Registry `0x7c35e97e8f89eeb2586db4031c13c63d4bd6ca21`；历史 **Direct** 主网 Registry `0x8a318b90ae7ce6c3c55dd5f596e16c1623c2c46a` 不会被冒充为 Image。Auto 变体只有历史测试网用途，没有在配置中声明主网地址。三种类型、活动读取器和字节限制统一定义在 `src/chain/registry-config.mjs`。合约及前端尚无第三方安全审计。

```powershell
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_v3.py export --checkpoint data/full-brain/service.npz --out work/my-trait-cartridge
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_v3.py verify work/my-trait-cartridge --boot-checkpoint work/my-boot.npz
```

`my-boot.npz` 是本机运行检查点，不是要上传的卡带。发布文件只有 `my-trait-cartridge/cartridge.json` 和 `state.bin`。

从 BSC 测试网独立取回并安装一只已发布卡带：

```powershell
node scripts/fly_cartridge_v3_chain_read.mjs --address 0x362faa317abac7dd3bc1ce0e4b8d98f8f2125fd3 --card-id 0x5755e83461ef601b5a5e51677c768288334391369c06bcc048966f354ea43809 --out work/recovered-v3
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_v3.py verify work/recovered-v3
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_v3.py install work/recovered-v3 --out work/my-device-run --token-address <本机选择的代币地址>
```

读取器只访问公开链上交易，不需要钱包。`install` 不启动交易或监控服务，且拒绝覆盖已有运行目录。它在设备目录内生成 `service.npz` 和 `service.json`；后者记录本机选择的代币地址，并不写入卡带。要让本地全脑 worker 使用这个新运行，启动前将 `FULL_BRAIN_CHECKPOINT` 指向该目录的 `service.npz`，并保持相邻的 `service.json`。后续游戏/交易记录由设备自己的存储管理。Linux 将示例中的 Python 路径换为 `work/full-brain-venv/bin/python`。

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
6. 决策和 Hybrid 执行结果写入 `data/bsc-fly-agent.sqlite`；每只果蝇的 Profile、checkpoint、训练、评估与卡带文件写入 `data/flies/<fly-id>/`。服务停止后审计数据仍保留；活动果蝇和 checkpoint 由 `data/active-fly.json` 绑定。

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
- **System Policy**：`src/policy/system-policy.mjs` 是 Profile 风控的只读上限来源。用户 Profile 可以降低资金比例、池参与率、单笔买入和每日动作数，或提高最小动作间隔，但不能超过 `0.2 BNB`、10% 资金预算、0.5% 池参与率、每日 24 次动作及现有滑点/deadline 硬边界。非回环 `HOST` 配置会在启动时被拒绝。
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
│  ├─ active-fly.json                    当前活动果蝇、revision 与 checkpoint 指针
│  ├─ flies/<fly-id>/
│  │  ├─ profiles/                       不可变 Profile revision JSON
│  │  ├─ checkpoints/                    逐果蝇 MaleCNS 学习检查点
│  │  ├─ training-runs/                  训练轮次记录
│  │  ├─ evaluations/                    冻结学习的评估记录
│  │  └─ cartridges/{imports,exports}/   逐果蝇 v3/v4 导入与 v4 导出历史
│  ├─ migration-backups/                 桌面升级迁移的小型文件 SHA-256 备份
│  ├─ migrations/                        可恢复的迁移 journal 与完成标记
│  ├─ replay-datasets/                   允许访问的确定性回放数据集
│  └─ full-brain/                        下载并编译的共享 MaleCNS 数据（忽略，不进 Git）
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
| `GET` | `/api/fly-profile/schema` | Profile v1 Schema、生效模式和公开 System Policy |
| `GET` | `/api/fly-profile/presets` | 内置预设摘要；预设不代表收益承诺 |
| `GET/POST` | `/api/flies` | 列出或创建果蝇 |
| `GET/PATCH` | `/api/flies/:flyId` | 读取详情，或按 expectedRevision 修改 metadata/归档状态 |
| `PUT` | `/api/flies/:flyId/profile` | 按 expectedRevision 创建新 Profile revision |
| `GET` | `/api/flies/:flyId/revisions` | 列出不可变 revision |
| `GET` | `/api/flies/:flyId/revisions/:revision` | 读取指定 revision |
| `POST` | `/api/flies/:flyId/rollback` | 从旧内容创建新 revision，不倒退计数器 |
| `POST` | `/api/flies/:flyId/clone` | 克隆 Profile；可选复制 checkpoint |
| `POST` | `/api/flies/:flyId/activate` | 运行停止时切换活动果蝇 |
| `GET/POST` | `/api/flies/:flyId/training-runs` | 列出或启动训练轮次 |
| `GET` | `/api/training-runs/:runId` | 读取冻结的训练绑定与摘要 |
| `POST` | `/api/training-runs/:runId/stop` | 保存 checkpoint 并停止链上观察训练 |
| `GET/POST` | `/api/flies/:flyId/evaluations` | 列出或创建冻结学习评估 |
| `GET` | `/api/cartridge/status` | 当前果蝇的卡带、导出和可发布性状态 |
| `POST` | `/api/cartridge/import-file` | 本地验证并导入 v3/v4 文件 |
| `POST` | `/api/cartridge/import-chain` | 从 Registry V3 读取并导入 v3 Card ID |
| `POST` | `/api/cartridge/export` | 从已停止的活动大脑导出本地 v4 |
| `GET` | `/api/cartridge/export/:id/:name` | 下载 `cartridge.json` 或 `state.bin` |
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

## FlyCartridge v3 钱包直付候选

一笔交易发布候选与已知限制见 [钱包直付候选说明](docs/FLY_CARTRIDGE_V3_DIRECT_CANDIDATE.md)。测试网 NFT #1 已独立复验；尚未部署到主网。
