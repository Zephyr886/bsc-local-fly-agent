# FLAP Fly Agent 4.0.0 发布说明

状态：未签名小范围测试发行版。证书和干净 Windows VM 不作为 4.0.0 测试发布的
硬门禁；最终 tag 和 GitHub Release 等待最终重建、哈希确认及 GitHub CLI 重新认证。

## 发布范围

4.0.0 是从全脑单实例版本升级到 Profile v1 多果蝇桌面应用的首个 Windows 小范围测试版本。
它包含 Profile 编辑、独立 checkpoint、训练/评估、确定性回放、Fly Cartridge v4
本地工作流、Windows 首次初始化及旧数据迁移。不包含 Registry V4、合约部署、官网
部署、自动支付或任何生产服务器变更。

## 用户升级摘要

1. 完全退出旧程序，并按 `BACKUP_AND_RECOVERY.md` 备份 `data/`、SQLite/WAL/SHM
   和钱包密文。
2. 从项目 GitHub Release 下载未签名的 `FLAP-Fly-Agent-Setup-4.0.0.exe` 和
   `SHA256SUMS.txt`，核对 SHA-256 后覆盖安装。不要手工移动或删除
   `%LOCALAPPDATA%/FLAP Fly Agent/`。
3. 首次启动会先执行 preflight 和可恢复迁移；旧 checkpoint 会成为
   `legacy-default`，原始文件仍保留。
4. 在“果蝇管理”核对活动果蝇、Profile hash、checkpoint 和历史记录；先运行确定性
   评估，再考虑模拟或实盘。

## 发布物

最终 GitHub Release 必须同时上传：

- `FLAP-Fly-Agent-Setup-4.0.0.exe`（未签名测试安装器）；
- `SHA256SUMS.txt`；
- 本发布说明；
- `ROLLBACK_V4.0.0.md`；
- 对应 `v4.0.0` 源码归档（由 GitHub 从 tag 生成）。

运行 `npm run release:build:win:unsigned` 生成测试安装器。脚本会禁用自动证书发现，
要求安装器和主程序 Authenticode 均为 `NotSigned`，再生成 `SHA256SUMS.txt` 与
`release-manifest.json`。禁止复用旧的 1.0.0 候选哈希。

## 已知限制

- 首次 MaleCNS 初始化约下载 1.03 GiB，并占用约 1.8 GiB 本地空间。
- 当前只生成 Windows x64 安装器。
- 安装器没有 Authenticode 签名，会显示“未知发布者”并可能触发 SmartScreen；
  Smart App Control 或组织策略可能禁止安装，用户不应为此关闭系统安全功能。
- 尚未在真正干净的 Windows VM 完成首次安装、覆盖升级和卸载保留数据三阶段验收；
  当前证据来自开发主机安装与隔离数据目录 smoke test。
- 仓库没有覆盖全仓库的顶层 `LICENSE`，因此本测试版不是开放源码授权发行版。
- v4 卡带只支持本地工作流，不能写入 Registry V3。
- 量化、神经输出和历史评估都不构成盈利保证；实盘仍可能损失全部资金。
