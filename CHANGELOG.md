# 更新日志

本项目遵循语义化版本。4.1.0 按未签名、小范围测试版发布；Git tag、安装器和
`SHA256SUMS.txt` 必须一致。未签名状态和 Windows 安全提示属于已知限制。

## [4.1.0] - 2026-09-21

### 新增

- 冻结 Registry V4 身份、去重、lineage、calldata 恢复和 NFT 承诺规格及威胁模型。
- 独立不可升级 `FlyCartridgeRegistryV4` 合约、固定 Cancun 构建产物、reader、部署及发布工具。
- 本机 `/registry-v4` HTML 部署台，可预览并执行主网/测试网固定合约部署，以及发布上次导出的 v4 卡带。
- 部署后精确运行字节码核验；发布后逐字节回读并执行新鲜安装验证。

### 安全

- HTML 页面不能提交任意地址、bytecode、ABI 或 calldata；服务端只使用仓库锁定产物。
- 主网执行必须核对预计地址、chainId、artifact/runtime hash、Gas/费用预算，并输入固定确认短语和本地钱包密码。
- 部署地址和公开交易记录只保存在本机数据目录；钱包密码、私钥和助记词不进入卡带、Git 或日志。

### 限制

- 本版本不预置 Registry V4 主网或测试网地址；首次部署仍需钱包有对应网络 Gas。
- 未完成第三方合约审计和人工干净 VM 验收；按项目所有者要求不作为 DIY 测试版硬门禁。
- 合约不可升级、不可暂停、不可删除；发现问题只能停止使用旧地址并部署新版本。

## [4.0.0] - 2026-09-21

### 新增

- Fly Profile v1：Schema、canonical hash、不可变 revision、预设和 System Policy 上限。
- 多果蝇管理：创建、克隆、归档、活动切换以及逐果蝇 checkpoint、训练、评估和卡带历史。
- 链上观察训练与确定性回放/评估；评估期间冻结学习，保存可复查指标。
- Fly Cartridge v4 本地导出、验证和安装，携带 canonical Profile 与三字段学习特质。
- Windows x64 Electron 安装器、首次启动 MaleCNS 初始化向导和可恢复的旧数据迁移。
- 确定性回放数据集 v1、Profile 字段、备份恢复和升级回滚文档。

### 变更

- 桌面应用、npm 包和安装器统一采用 `4.0.0`；它与 Fly Cartridge/Registry
  的格式版本不是同一个版本命名空间。
- 旧单实例 checkpoint 在首次桌面启动时迁移为 `legacy-default` 果蝇；源文件、
  SHA-256 备份清单和迁移 journal 均保留。
- 本地可变数据固定在 `%LOCALAPPDATA%/FLAP Fly Agent/`，不再依赖安装目录。

### 安全

- Electron renderer 保持 `contextIsolation: true`、`nodeIntegration: false`、
  `sandbox: true`，拒绝全部权限请求。
- 桌面导航只允许内置 setup/loading 页面、本机后端和严格格式的 BscScan
  交易链接；不再放行任意 `file:` 或 HTTPS 目标。
- 保留本机 Host/Origin 校验、敏感字段拒绝、钱包逐笔解密和只读 System Policy 上限。

### 不兼容与限制

- v4 卡带不能发布到 Registry V3；Registry V4 尚未设计冻结或部署。
- Profile revision 已激活后不可原地修改；修改会创建新 revision。
- 运行中不能切换活动果蝇。
- 4.0.0 是未签名的小范围测试发行版，可能显示“未知发布者”或 SmartScreen 提示；
  Smart App Control 或组织策略可能直接阻止安装。
- 仓库尚无覆盖全仓库的顶层开源许可证，4.0.0 不应被描述为开放源码发行版。
