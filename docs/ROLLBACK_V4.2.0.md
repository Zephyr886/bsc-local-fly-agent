# FLAP Fly Agent 4.2.0 回滚指引

1. 退出 FLAP Fly Agent。
2. 使用 v4.1.3 安装器覆盖安装，或先卸载 4.2.0 后再安装 v4.1.3。
3. 安装器配置保留用户数据；不要手工删除 `%LOCALAPPDATA%/FLAP Fly Agent/data/`。
4. 语言偏好可能仍保留在本地浏览器存储中，但 v4.1.3 会忽略它。

回滚只移除双语界面资源，不会回滚或删除 Profile、checkpoint、卡带、钱包密文、
链上 Registry 或已经发布的 NFT。
