# FLAP Fly Agent 4.0.0 发布说明

状态：发布资料已冻结；正式 tag 和 GitHub Release 等待代码签名、干净 Windows VM
三阶段验收、仓库总体许可证选择及 GitHub CLI 重新认证完成。

## 发布范围

4.0.0 是从全脑单实例版本升级到 Profile v1 多果蝇桌面应用的首个正式版本。
它包含 Profile 编辑、独立 checkpoint、训练/评估、确定性回放、Fly Cartridge v4
本地工作流、Windows 首次初始化及旧数据迁移。不包含 Registry V4、合约部署、官网
部署、自动支付或任何生产服务器变更。

## 用户升级摘要

1. 完全退出旧程序，并按 `BACKUP_AND_RECOVERY.md` 备份 `data/`、SQLite/WAL/SHM
   和钱包密文。
2. 运行签名的 `FLAP-Fly-Agent-Setup-4.0.0.exe` 覆盖安装。不要手工移动或删除
   `%LOCALAPPDATA%/FLAP Fly Agent/`。
3. 首次启动会先执行 preflight 和可恢复迁移；旧 checkpoint 会成为
   `legacy-default`，原始文件仍保留。
4. 在“果蝇管理”核对活动果蝇、Profile hash、checkpoint 和历史记录；先运行确定性
   评估，再考虑模拟或实盘。

## 发布物

最终 GitHub Release 必须同时上传：

- `FLAP-Fly-Agent-Setup-4.0.0.exe`（受信任 Authenticode 签名）；
- `SHA256SUMS.txt`；
- 本发布说明；
- `ROLLBACK_V4.0.0.md`；
- 对应 `v4.0.0` 源码归档（由 GitHub 从 tag 生成）。

安装器签名后文件哈希才是最终哈希。禁止复用旧的未签名 1.0.0 候选哈希。
签名证书就绪后，在不打印证书密码的当前 PowerShell 会话设置
`FLAP_RELEASE_CSC_LINK` 和 `FLAP_RELEASE_CSC_KEY_PASSWORD`，运行
`npm run release:build:win`。脚本只在安装器和主程序 Authenticode 均为 `Valid`
时生成 `SHA256SUMS.txt` 与 `release-manifest.json`。

## 已知限制

- 首次 MaleCNS 初始化约下载 1.03 GiB，并占用约 1.8 GiB 本地空间。
- 当前只生成 Windows x64 安装器。
- v4 卡带只支持本地工作流，不能写入 Registry V3。
- 量化、神经输出和历史评估都不构成盈利保证；实盘仍可能损失全部资金。
