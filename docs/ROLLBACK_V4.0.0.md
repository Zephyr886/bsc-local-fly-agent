# FLAP Fly Agent 4.0.0 回滚指引

回滚目标是恢复程序版本，同时保留 4.0.0 创建的唯一用户数据。不要用旧安装器覆盖
或删除 `%LOCALAPPDATA%/FLAP Fly Agent/` 后再尝试恢复。

## 回滚前

1. 停止训练、模拟和桌面程序，确认没有 FLAPFlyAgent 或 MaleCNS worker 进程。
2. 完整复制 `%LOCALAPPDATA%/FLAP Fly Agent/data/`；SQLite、`-wal`、`-shm` 必须
   同时复制。另行保护钱包密文及密码/私钥备份。
3. 记录当前 4.0.0 安装器、tag、备份时间和备份 SHA-256 清单。

## 首选回滚

卸载 4.0.0 只移除程序文件，安装器配置 `deleteAppDataOnUninstall: false`，用户数据
应继续保留。随后安装上一受信任版本，但先不要启动实盘。旧版本不理解 Profile v1
多果蝇目录，因此仅应读取其原有数据；不要让旧版本改写 4.0.0 的唯一数据副本。

如果目标是撤销首次迁移，应在应用完全退出时，从迁移前独立备份恢复整套 SQLite、
WAL/SHM、旧 checkpoint 和钱包密文。`data/migration-backups/fly-profile-v1/` 可用于
诊断，但不替代独立备份。不要手工编辑 `journal.json` 或活动指针。

## 验收

- 程序版本与预期回滚 tag 一致；
- 原始备份保持只读且 SHA-256 不变；
- 先在无资金或隔离钱包环境做健康检查和只读评估；
- 未确认数据兼容前不启用实盘、不向钱包充值。

若旧版无法安全读取数据，停止回滚并重新安装 4.0.0；保留失败副本用于诊断。
