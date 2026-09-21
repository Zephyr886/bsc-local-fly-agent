# 更新日志

本项目遵循语义化版本。正式发布物只有在 Git tag、签名安装器和 SHA-256
校验文件一致时才构成一次发布。

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
- 4.0.0 正式 Windows 发布必须使用受信任代码签名证书；未签名候选不属于正式发布物。
