# Fly Profile v1 WP-03 文件仓库记录

日期：2026-09-19
仓库：`bsc-local-fly-agent`
工作包：WP-03（FlyRepository 与原子 revision 存储）

## 实现边界

本工作包只实现文件仓库，不接入 HTTP API、SQLite、运行时切换或 UI。新增的 `FlyRepository` 提供：

- `create`、`list`、`get`
- `updateMetadata`、`updateProfile`
- `listRevisions`、`rollback`
- `clone`、`archive`
- checkpoint 指针写入和启动一致性检查

果蝇 ID 和 checkpoint ID 必须是规范 UUID，客户端路径永远不会直接参与路径拼接。Profile revision 使用六位递增文件名，已有 revision 不允许覆盖。

## 持久化与并发语义

- JSON 先以 `wx` 打开同目录唯一临时文件，写完后执行 `sync`、关闭文件，再原子 `rename`。
- 同一进程内，每个 fly 有独立写锁；不同 fly 不共享锁。
- Profile 更新、metadata 更新和 rollback 都要求 `expectedRevision`，冲突返回 `PROFILE_REVISION_CONFLICT`。
- rollback 不移动旧指针，而是从目标历史复制 spec 并生成一个新的不可变 revision。
- 启动时检查每个 `fly.json`、当前 Profile、revision 尾部、活动 checkpoint，以及可选 `active-fly.json` 的一致性。
- 一致性损坏会生成只读健康报告；仓库不会猜测修复，所有写操作返回 `FLY_REPOSITORY_READ_ONLY`。
- 唯一临时文件不是 revision，重新打开仓库时不会把残留临时文件当成历史。

## 克隆语义

默认克隆只复制当前 Profile spec，不复制 checkpoint。显式复制 checkpoint 时：

- 只从源 fly 的 checkpoint 目录读取。
- 目标 fly 使用新的 checkpoint UUID。
- 目标 checkpoint 内写入 `clone-source.json`，记录源 `flyId` 和源 `checkpointId`。
- `fly.json` 记录源 fly、源 revision 和是否复制 checkpoint。

钱包保险库仍位于独立文件，不属于 clone 范围。

## 兼容性和迁移

- 无数据迁移。当前代码尚未把现有运行路径切换到 `data/flies/`。
- Fly Cartridge v3、旧 SQLite、旧 checkpoint 内容格式、桌面启动流程均未修改。
- 文件仓库是 WP-04 SQLite 元数据和后续 API/运行时工作的底座。

## 验收结果

- `node --test test/fly-repository.test.mjs`：7 个通过。
- `npm test`：56 个通过，0 个失败，0 个跳过。
- `python -m unittest discover -s test -p "test_*.py"`：15 个通过。
- `npm run brain:verify`：MaleCNS v1.0 数据和数组校验通过。
- `npm run brain:self-test`：完整连接组加载和 7 次神经观察通过，峰值 RSS 约 812.4 MiB。
- `node --check`：新增仓库与错误模块通过。
- `git diff --check`：通过；仅报告已有文件的 CRLF 转换提示。

首次对仓库根直接执行 `pytest` 时，pytest 同时收集了两个 `out/` 安装包副本，因相同模块名产生 collection mismatch；按项目基线使用 `unittest discover -s test` 后 15/15 通过。该现象与 WP-03 代码无关，未删除用户的构建产物。
