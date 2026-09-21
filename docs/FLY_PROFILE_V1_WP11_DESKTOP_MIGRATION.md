# WP-11 Windows 桌面升级、迁移与恢复

状态：2026-09-20 完成本地实现与自动 smoke test。该工作包不生成发布安装器；安装器
产物与哈希属于 WP-12，小范围未签名测试可先发布，干净 VM 人工验收作为后续推荐覆盖。

## 启动顺序

Electron 获得单实例锁并显示 loading 窗口后，按以下顺序运行：

1. 只读 preflight；
2. 可恢复的 Fly Profile v1 数据迁移；
3. 启动本地 HTTP 后端；
4. 已有 MaleCNS 环境则进入控制台，否则进入 setup 页面。

因此 SQLite schema 升级和 FlyManager 恢复活动选择之前，旧数据已经备份并完成 checkpoint 迁移。命令行启动仍保留 FlyManager 的 legacy migration 作为非桌面兼容兜底。

## 只读 preflight

`desktop/migration.mjs` 在不创建、覆盖或删除用户文件的情况下检查：

- 用户数据卷可用空间与本次迁移所需空间；
- 活动 v3 run、旧 `data/full-brain/service.npz` 及相邻 metadata；
- SQLite 是否存在、字节数和 schema 版本；
- 已有 fly 数量；
- `active-fly.json` 指向的 checkpoint 是否存在。

活动 v3 run 优先于旧 full-brain checkpoint，与非桌面兼容迁移的选择规则一致。未知或高于当前程序的 SQLite schema、损坏的活动 pointer、空间明确不足都会 fail closed；后端不会在此后继续启动。

## 备份范围

首次迁移在以下目录建立不可变来源清单：

```text
data/migration-backups/fly-profile-v1/<migration-id>/manifest.json
```

存在时复制并逐文件核对 SHA-256：

- `bsc-fly-agent.sqlite`、`-wal`、`-shm`；
- `local-wallet.vault.json`（仍是原有认证加密密文）；
- `active-fly.json`；
- `full-brain/service.json`；
- 旧卡带 `active.json` 与 `last-export.json`。

清单明确排除共享 `graph.npz`、annotations、normalized 数据和旧 `service.npz` 备份副本。共享 MaleCNS 数据可由锁定安装流程重建，不重复复制约 1.58GiB。旧 checkpoint 本身不是备份副本，而是作为迁移源复制到新 fly；原文件保持原位。

## checkpoint 提交顺序

旧状态迁为固定名称 `legacy-default`：

1. 创建 fly 和目标 checkpoint 目录；
2. 流式计算源 checkpoint SHA-256；
3. 原子复制 `service.npz`；
4. 计算目标 SHA-256；
5. 只有两个哈希相同才写 checkpoint metadata 和 `fly.json.activeCheckpointId`；
6. 最后写 `active-fly.json`。

`migration-source.json` 只记录来源类型、迁移时间和 SHA-256，不记录源磁盘绝对路径。活动 v3 marker 成功迁移后归档为 `legacy-active-migrated.json`；原卡带文件与 run checkpoint 不删除。

## journal 与恢复

迁移 journal 位于：

```text
data/migrations/fly-profile-v1/journal.json
```

阶段依次为 `started → backed-up → fly-created → checkpoint-adopted → pointer-updated → complete`。journal 在每个副作用后原子更新并持久化固定的 migration/fly ID。进程在任意阶段中断后：

- 已复制的备份按 SHA-256 复用；
- 已创建的 legacy fly 按 journal ID 识别，不重复创建；
- 已复制的 checkpoint 再次与源文件核对；
- pointer 写入可安全重试；
- 完成后永久保留 `complete.json`，后续启动不会重复迁移。

如果启动前已经存在其他 flies，则保留旧源数据但不猜测合并目标，完成标记记录 `existing-flies`。

## 用户可见故障

loading 页面会显示 preflight、迁移、恢复和完成阶段。失败时窗口不会静默消失：错误对话框给出可读消息及 `%LOCALAPPDATA%/FLAP Fly Agent/logs/desktop.log` 的完整位置。setup 页面同样说明 checkpoint 哈希校验、journal 恢复和 MaleCNS 不重复备份。

## 安装与卸载边界

Electron `userData` 与 `process.resourcesPath` 保持分离。NSIS 配置固定 `deleteAppDataOnUninstall: false`，所以升级或卸载应用文件不会主动删除：

- `data/flies`；
- SQLite/WAL；
- 钱包密文；
- checkpoints 与 cartridges；
- 迁移 journal、备份与完成标记；
- MaleCNS 数据及 Python venv。

## 自动验收

`test/desktop-bootstrap.test.mjs` 覆盖：

- 干净安装只写完成标记，不虚构 fly；
- 旧单实例 SQLite、metadata、钱包密文备份与 checkpoint SHA-256 迁移；
- 在 `fly-created` 后注入中断，重启后只生成一个 fly 并完成 pointer；
- 活动 v3 run 优先并归档旧全局 marker；
- 安装器不删除 app data，启动错误包含日志位置。

共享 MaleCNS 数据内容继续由 `npm run brain:verify` 验证。本工作包没有读取钱包明文、没有网络/链上写入，也没有修改生产服务器。
