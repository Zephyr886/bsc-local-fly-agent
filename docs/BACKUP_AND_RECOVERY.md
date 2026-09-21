# 数据备份与恢复

状态：本地 v1 RC，2026-09-20。备份前先停止训练、模拟和桌面程序，确认任务管理器中没有 `FLAPFlyAgent`、随附 Node 后端或 MaleCNS Python worker。运行中直接复制 SQLite/WAL 或 checkpoint 可能得到彼此不一致的快照。

## 数据根目录

- Windows 桌面版：`%LOCALAPPDATA%/FLAP Fly Agent/data/`
- 源码运行：仓库内 `data/`
- 桌面版共享 Python/MaleCNS 工作环境：`%LOCALAPPDATA%/FLAP Fly Agent/work/`
- 源码运行共享工作环境：仓库内 `work/`

不要把安装目录当作数据备份。升级和卸载配置不会主动删除应用数据，但这不等于已有独立备份。

## 每次备份检查单

为同一个时间点建立一个只读备份目录，并分别保留以下内容：

- [ ] **Profile 与活动指针**：整个 `data/flies/<fly-id>/profiles/`、`data/flies/<fly-id>/fly.json` 和 `data/active-fly.json`。
- [ ] **Checkpoint**：整个 `data/flies/<fly-id>/checkpoints/`；必须同时复制相邻的 `service.npz`、`service.json` 及任何 Profile/来源文件。
- [ ] **SQLite**：`data/bsc-fly-agent.sqlite`、存在时的 `-wal` 和 `-shm` 三个文件一起复制。不要只复制主库。
- [ ] **卡带**：整个 `data/flies/<fly-id>/cartridges/`；对外备份时至少让 `cartridge.json` 与 `state.bin` 成对保存。
- [ ] **钱包密文**：把 `data/local-wallet.vault.json` 单独放入访问受限、加密的备份；它不是 Profile/卡带的一部分。钱包密码和创建时一次性显示的私钥备份必须用另一个安全通道保存，不能和密文放在一起。
- [ ] **训练与评估证据**：`training-runs/`、`evaluations/` 以及需要复现实验的 `data/replay-datasets/`。
- [ ] **完整性清单**：对备份文件生成 SHA-256 清单，记录应用版本、备份时间、Profile revision、profileHash、活动 checkpoint ID 和离线保存位置。

`data/full-brain/` 和 `work/full-brain-venv/` 体积大，可通过锁定的 `npm run brain:setup` 重建，不替代上述用户状态备份。如果选择不备份它们，恢复后必须重新运行 setup/verify。

`data/migration-backups/fly-profile-v1/` 是桌面升级迁移的安全网，不是持续备份系统；不要依赖它覆盖后续训练或钱包变化。

## 恢复步骤

1. 保持应用完全退出，在新目录完成相同版本的安装或源码依赖安装。
2. 先备份目标端现有 `data/`，不要覆盖一个仍有唯一数据的目录。
3. 将同一时间点的 `flies/`、`active-fly.json`、SQLite/WAL/SHM 和需要的卡带整体恢复；不要拼接不同时间点的 Profile 与 checkpoint。
4. 只有确实需要恢复该钱包时，才单独复制 `local-wallet.vault.json`。不要把私钥或密码写进 Profile、卡带、日志或工单。
5. 若未备份共享 MaleCNS 环境，运行 `npm run brain:setup`，再运行 `npm run brain:verify`。
6. 启动后先在 `/flies` 核对 flyId、revision、profileHash、活动 checkpoint 和训练/评估数量；在 `/cartridge` 重新执行本地验证。
7. 先用确定性回放/评估做只读验收。确认数据和 Effective Risk 正确前，不启用实盘，不向恢复的钱包充值。

恢复失败时保留原备份和失败副本，不在唯一副本上反复试错。Profile revision、checkpoint 或 SQLite 若不匹配，应回退为同一时间点的整套快照，而不是手工编辑 JSON 或数据库。

## 钱包特别说明

钱包文件是 scrypt + AES-256-GCM 密文，但弱密码、本机恶意软件、密文与密码共同泄露仍会危及资金。备份前后都不要打印、上传或提交钱包文件；不要截图私钥；只使用隔离钱包和可承受全部损失的小额资金。忘记密码无法通过应用找回。
