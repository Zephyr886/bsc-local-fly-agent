# Fly Profile v1 WP-04 SQLite v2 迁移记录

日期：2026-09-19
仓库：`bsc-local-fly-agent`
工作包：WP-04（SQLite 版本化迁移与审计绑定）

## Schema v2

启动 `SqliteStore` 时先读取 `schema_meta`。无版本表但存在旧 `sessions` 表时识别为 v1；空库识别为 v0。v0/v1 到 v2 的建表、加列、索引和版本号写入在同一个 `BEGIN IMMEDIATE` 事务中完成。

新增表：

- `flies`
- `fly_profile_revisions`
- `training_runs`
- `evaluations`
- `schema_meta`

`sessions` 新增可空字段：

- `fly_id`
- `profile_revision`
- `profile_hash`
- `training_run_id`

旧 session 的这些字段保持 `NULL`；旧 `decisions` 和 `transactions` 仍通过 `session_id` 关联。迁移不会重写原 checkpoint、decision 或 transaction JSON。

## 审计绑定

新 Profile session 可以在 `commitCycle` 或 `updateSession` 中同时提供四个标识。只提供其中一部分会返回 `INCOMPLETE_AUDIT_BINDING`；格式无效会返回 `INVALID_AUDIT_BINDING`。Session 创建后绑定不可更换，旧 session 也不会被事后静默挂到某个 Profile。

现有尚未接入 Fly Profile 的运行路径仍可写入四字段为 `NULL` 的兼容 session；后续运行时接线工作包会在启动新训练 session 时提供完整绑定。已提供绑定的 session 在后续不重复传参时仍保持原绑定。

## 查询边界

`listSessions`、`recentDecisions` 和 `recentTransactions` 支持 `limit`/`offset`。默认单页硬上限为 200，可在构造测试实例时降低，但不能配置超过 1000。非整数、零/负 limit 或负 offset 会被拒绝。

## 失败与回滚

- 迁移任一步失败时执行 SQLite `ROLLBACK`；表、列、索引和版本号不会形成半迁移状态。
- schema 版本高于当前支持版本时拒绝打开。
- 已标记 v2 但缺失必需表或列时拒绝打开，不猜测修复。
- 应用回滚时，新增 session 列均可空，旧命名列和原三张表保持兼容；生产环境仍须按根 `AGENTS.md` 先创建并验证状态备份。

## Fixture 与验收

`test/fixtures/sqlite-v1.sql` 固定旧版三表、索引和三类历史行。测试迁移前后逐项比较原始行数及 JSON 字符串字节。

- `node --test test/sqlite-migration.test.mjs`：6 个通过。
- `npm test`：62 个通过，0 个失败，0 个跳过。
- 空库、旧 fixture 和已迁移库重复启动均通过。
- 注入迁移失败后，旧行仍在、v2 表/列和 `schema_meta` 均不存在。
- 新 session 四个审计标识完整保存；旧 session 四字段均为 `NULL`。
- 未读取或修改仓库中的现有 SQLite 数据文件，未连接生产环境。
