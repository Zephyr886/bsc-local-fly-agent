# FLAP Fly Agent 4.1.0 回滚指引

1. 完全退出应用并备份 `%LOCALAPPDATA%/FLAP Fly Agent/`。
2. 卸载 4.1.0；安装器配置不会主动删除用户数据。
3. 从正式 GitHub Release 安装 4.0.0，并核对该版本自己的 SHA-256。
4. 4.0.0 不识别 Registry V4 部署台，但 Profile、checkpoint、SQLite、钱包密文和
   卡带文件仍保留。不要删除 `registry-v4-deployments.json`，以便以后重新升级。

链上合约和成功发布的卡带不可回滚或删除。软件回滚只会移除本机 4.1.0 功能；若合约
存在问题，应停止传播旧地址，并在修复和重新确认后部署新版本。
