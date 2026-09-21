# Fly Profile v1 WP-08 HTTP API 记录

日期：2026-09-20
仓库：`bsc-local-fly-agent`
工作包：WP-08（HTTP API 与结构化错误模型）

## 路由拆分

多果蝇、Profile、训练和评估 API 已从 `src/server.mjs` 拆到 `src/http/fly-routes.mjs`。通用 HTTP 边界位于 `src/http/http.mjs`，负责：

- 仅允许本机 socket、Host 和同源 Origin 执行 mutation；
- 强制新 API 使用 `application/json`；
- 32 KiB 请求体上限；
- 普通对象、exact-field、UUID、revision 和分页校验；
- 递归拒绝私钥、助记词、密码、seed phrase 和 keystore 字段；
- 结构化错误及绝对路径、外部 URL、秘密字段和敏感长哈希脱敏。

生产 server 继续应用原 CSP、COOP、CORP、Referrer Policy、Permissions Policy、nosniff 和 frame deny header。旧钱包、交易、卡带和 simulation API 保留 `{ "error": "..." }` 兼容格式；新增 Fly API 使用：

```json
{
  "error": {
    "code": "PROFILE_REVISION_CONFLICT",
    "message": "用户可读说明",
    "fields": [{ "path": "/expectedRevision", "reason": "..." }]
  }
}
```

状态码采用：校验错误 400、不存在 404、方法不支持 405、revision/状态冲突 409、运行态锁定 423、未知内部错误 500。

## 已实现接口

Profile 公共信息：

- `GET /api/fly-profile/schema`
- `GET /api/fly-profile/presets`

schema 响应只公开 Profile Schema、字段生效模式和交易硬限制；不公开 bind host、文件路径、环境变量或运行环境详情。预设列表只返回 ID、版本、名称和说明。

果蝇与 revision：

- `GET/POST /api/flies`
- `GET/PATCH /api/flies/:flyId`
- `PUT /api/flies/:flyId/profile`
- `GET /api/flies/:flyId/revisions`
- `GET /api/flies/:flyId/revisions/:revision`
- `POST /api/flies/:flyId/rollback`
- `POST /api/flies/:flyId/clone`
- `POST /api/flies/:flyId/activate`

Profile 更新和 rollback 响应包含 revision、profileHash、changedPaths、activationMode、逐字段 activationModes、Effective Risk、System Policy warnings 和是否等待下次生效。活动果蝇运行中保存 Profile 时：

- 当前 session 继续使用被冻结的旧 revision；
- `active-fly.json` 立即推进到新 revision，保证崩溃恢复一致；
- FlyManager 保存 pending context；
- session 停止并保存 checkpoint 后自动采用新 Profile。

复制 checkpoint 时会把目标 `service.json` 的 flyId、revision 和 profileHash 改写为克隆果蝇来源，避免复制出的状态仍声明属于源果蝇。

训练与评估：

- `POST/GET /api/flies/:flyId/training-runs`
- `GET /api/training-runs/:runId`
- `POST /api/training-runs/:runId/stop`
- `POST/GET /api/flies/:flyId/evaluations`

Live training 的链上 metadata 只能由服务端读取器产生，客户端不能伪造 live price。确定性回放和评估只接受 WP-07 的本地 datasetPath 契约。

## 旧 simulation 兼容

`POST /api/simulation/start` 现在支持 `flyId` 和 `expectedProfileRevision`，并始终通过 FlyManager 启动：

- 指定 flyId 时验证果蝇和 revision；
- 未指定 flyId 时仅在恰好存在一个未归档果蝇时兼容；
- 多果蝇环境不再静默猜测活动对象。

`GET /api/simulation` 增加 flyId、profileRevision、profileHash、trainingRunId 和 Effective Profile 摘要，同时保留旧页面现有字段。

## 验收结果

- 真实 HTTP socket 覆盖所有 Fly/Profile/training/evaluation mutation。
- 覆盖 201、400、403、404、409、423 和未知错误 500。
- 非同源 Origin 被拒绝；生产 server 返回结构化 403 并保留 CSP。
- 非 JSON、超过 32 KiB、非法 UUID、非法 revision、未知字段和 Schema 错误均在业务写入前拒绝。
- PATCH 混合请求会在所有字段验证完成后才写入，非法 archived 不会留下半次 metadata revision。
- 错误响应测试确认不包含绝对路径、private key 或 password 文本。
- 未连接生产服务、未执行链上交易、未修改真实用户数据。

WP-08 只提供 API 和兼容层。果蝇管理中心页面、结构化编辑器和键盘操作流程属于 WP-09。
