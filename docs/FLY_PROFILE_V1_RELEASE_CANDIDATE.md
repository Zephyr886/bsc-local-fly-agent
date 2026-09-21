# Fly Profile 本地 v1 RC 冻结记录

冻结日期：2026-09-20（Asia/Shanghai）
范围：`bsc-local-fly-agent` 本地/Windows 桌面发行候选；不包含生产网站部署、合约部署或主网写交易。

## 冻结边界

- Fly Profile v1 Schema、canonical hash、revision、System Policy 与四种生效模式冻结为本地 v1 合同。
- 多果蝇创建、编辑、克隆、切换、训练、停止、确定性评估和审计绑定进入 RC。
- Fly Cartridge v4 可在本机导出、验证、安装和保存历史；它包含 canonical Profile 与 v3 三字段学习特质。
- 桌面升级迁移在启动后端前执行，保留旧源文件、SHA-256 备份清单与可恢复 journal。
- 默认值、预设和测试结果均不构成盈利、低风险或实盘适用性声明。

## v3/v4 与 Registry 的明确区分

| 名称 | 携带内容 | 当前能力 | 当前限制 |
|---|---|---|---|
| Fly Cartridge v3 | `weight`、`memory_u`、`memory_w` 学习特质及共享锁；不携带 Profile | 原 verifier、本地文件导入、现有 Registry V3 读取/既有发布路径 | 导入本地后才由设备赋予默认 Profile；不能声称原卡带包含 Profile |
| Fly Cartridge v4 | canonical Profile + v3 三字段学习特质 + lineage/provenance | 本地导出、验证、安装、逐果蝇历史和 publishability report | **不可直接发布到 Registry V3**；不包含 SQLite、钱包、市场进度或交易记录 |
| Registry V3 | 已部署的 v3 链上字节载体与去重/父卡规则 | 读取和验证 v3 Card ID；活动 Image registry 由本地配置固定 | 未获准承载 v4，不能因字节长度可能容纳就视作兼容 |
| Registry V4 | 未来可选的 Profile-aware 链上协议 | 无 | **当前未设计冻结、未部署、无地址，也不是本 RC 的组成部分** |

## 发行验收

- `npm test`：107/107 通过（2026-09-21）。
- MaleCNS Python 测试：28/28 通过；`npm run brain:verify` 验证 166,700 个神经元、25,582,938 条有向边和全部锁定数组（2026-09-20）。
- 打包目录隔离 smoke test：启动迁移、后端和 `/api/health`，HTTP 200（2026-09-20）。
- Windows 干净安装与覆盖升级：程序文件和快捷方式创建成功；修正版完成页不再自动运行快捷方式。干净安装和覆盖升级后的程序都以各自隔离数据目录启动迁移、后端和 `/api/health`，HTTP 200。开始菜单快捷方式目标核对为实际存在的 `D:\fly\FLAPFlyAgent\FLAPFlyAgent.exe`（2026-09-20）。
- 旧未签名候选安装包：`out/windows/FLAP-Fly-Agent-Setup-1.0.0.exe`（仅作为 2026-09-20 的测试证据，不得发布为正式版）
- 文件大小：117,991,482 bytes。
- SHA-256：`0A1F382B2DBAE9D379A59BA768C3056E268E4D3DC6E0763D4A4C9676BF44FB37`。
- 4.0.0 未签名 QA 候选：`out/windows/FLAP-Fly-Agent-Setup-4.0.0.exe`（2026-09-21）；
  117,991,612 bytes；SHA-256
  `0C46DCDC34EE0D9B9FAD447FC74123BE9FB48A50E013BDD6D9736E97F51B41EE`；
  打包目录以隔离用户数据启动，应用版本 4.0.0 且 `/api/health` HTTP 200。
- 代码签名：未签名测试候选。**公开下载发布前必须使用受信任的 Windows 代码签名证书签名并重新记录签名后文件的 SHA-256；当前未签名文件不得标成公开正式发行版。**

## 操作文档

- 新用户完整流程：仓库 `README.md` 的“快速启动”。
- 字段、默认值、范围与生效时机：`docs/FLY_PROFILE_V1_FIELD_REFERENCE.md`。
- K 线转换与回放文件合同：`docs/DETERMINISTIC_REPLAY_DATASET_V1.md`。
- 备份与恢复：`docs/BACKUP_AND_RECOVERY.md`。
- v4 格式和本地发布前报告：`docs/FLY_CARTRIDGE_V4.md`。

WP-13/14 的 Registry V4、支付、授权和官网发布工作属于可选后续阶段，不因本地 v1 RC 完成而自动开始。
