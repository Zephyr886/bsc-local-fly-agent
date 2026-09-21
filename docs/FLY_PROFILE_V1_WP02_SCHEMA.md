# Fly Profile v1 WP-02 Schema、规范化与哈希

日期：2026-09-19
工作包：WP-02

## 标准入口

- JSON Schema：`schemas/fly-profile-v1.schema.json`
- 通用导出：`src/profile/index.mjs`
- 默认 spec：`src/profile/defaults.mjs`
- 严格 JSON、canonical JSON 与 SHA-256：`src/profile/canonical.mjs`
- Schema、交叉字段校验与文档创建：`src/profile/validate.mjs`
- Effective Profile：`src/profile/effective-profile.mjs`
- 生效分类：`src/profile/activation.mjs`
- 版本化预设：`src/profile/presets/*.json`

校验器固定为 `ajv@8.20.0`，关闭类型转换。原始 partial spec 先使用同一字段定义校验，随后与默认值合并并按完整 Schema 再次校验。根对象、metadata、spec 及所有 spec 子对象均设置 `additionalProperties:false`。

## Canonical 与身份规则

`profileHash` 只计算 `spec`：

```text
sha256(JCS(spec))
```

实现使用 UTF-8、UTF-16 键排序和 ECMAScript JSON 数字序列化，拒绝非有限数字、稀疏数组、非 JSON 类型、非普通对象及无效 Unicode 代理项。`parseJsonStrict()` 在对象构建前检查重复键，因此不会接受 JSON.parse 默认的“后值覆盖前值”。

默认 `balanced-v1` 的固定测试向量为：

```text
sha256:d87557af0d8babf6828f1b8ba9154410a83a7335d3644ddc727a90420f49e132
```

名称、说明、标签、时间和 revision 不参与该哈希；任何行为字段变化都会改变哈希。

## 交叉字段规则

除 Schema 范围外，库还强制执行：

- reward horizons 严格递增，primary horizon 必须属于 horizons。
- 四个 reward weight 绝对值总和不超过 1.5，且至少一个正向 weight。
- active/quiet 的 max actions 不得小于对应 min actions。
- `fixed` token binding 必须提供非零 EVM 地址；`device-selected` 必须为 null。
- metadata 时间必须是实际存在的 UTC RFC3339 时间，且 updatedAt 不早于 createdAt。
- Profile 文档载入时重新计算并验证 `profileHash`。

## 预设

| ID | 意图 |
| --- | --- |
| `balanced-v1` | 与 WP-00 固定的旧运行时有效参数一致 |
| `conservative-v1` | 更高阈值、更小额度、更低频率，禁止实盘 |
| `active-research-v1` | v1 允许的最高观察频率、更大历史窗口，仍受硬风控 |
| `frozen-evaluation-v1` | `learning.enabled=false` 的对照评估 |

预设文件为只读、版本化 JSON；加载时同样执行完整 Profile spec 校验。

## Effective Profile

`buildEffectiveProfile()` 只接收 hash 校验通过的完整 Profile 文档，将 System Policy 收紧后的 risk 写入不可变 effective spec，并保留 flyId、revision、profileHash、原始 risk 和逐字段 restrictions。`assertEffectiveProfile()` 使用实例身份检查，结构相同的普通对象或反序列化副本不会被当作运行时授权对象。

本工作包不修改 SQLite、checkpoint、钱包、v3 卡带格式或运行时启动行为，也不执行生产或主网写入。

## 验收结果

- `npm test`：49 个测试、49 个通过、0 个失败、0 个跳过。
- Python 单元测试：15 个通过。
- Windows desktop bootstrap smoke：3 个通过。
- `npm run desktop:make:win`：通过；生成测试安装器，并确认打包后的 `app.asar` 包含 `schemas/fly-profile-v1.schema.json`。
- `npm run brain:verify`：当前机器仍缺少全脑 Python 环境；未自动下载 MaleCNS 数据。
