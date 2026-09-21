# Fly Cartridge v4 本地格式

状态：WP-10 本地格式，2026-09-20。v4 已可在本机导出、验证、安装和作为逐果蝇历史保存；它不是 Registry V4，也不表示现有 Registry V3 已获准承载 v4 字节。

## 文件与语义

每张卡带仍由两个文件组成：

- `cartridge.json`：UTF-8 canonical JSON，末尾一个换行；本地上限 32,768 字节。
- `state.bin`：沿用 v3 已验证的 `weight`、`memory_u`、`memory_w` 三字段 trait 编码；本地上限 262,144 字节。

本地 HTTP 卡带请求有独立的 420,000 字节上限，可容纳上述两份文件的 Base64 封装；普通 Profile API 仍保持 32KB 边界。

manifest 顶层字段集合固定为：

```text
format, formatVersion, semantics, fly, profile, model, locks,
traitKey, fieldSha256, state, training, lineage, provenance,
fixedBootProbe
```

固定身份为 `format=fly-cartridge`、`formatVersion=4`、`semantics=profile-and-learned-trait;fresh-neural-boot` 和 `model=stonkfly-dual-compartment-v1`。未知、缺失或重复 JSON 字段均拒绝。

`profile` 保存 Fly Profile v1 的 canonical `spec`，不包含可变显示 metadata。`fly` 绑定 `flyId`、Profile schema/revision 和 `profileHash`。Profile 必须完整通过本地 Schema、跨字段约束以及 `malecns-v1 + hybrid-v2-profiled` 兼容检查；私钥、助记词、密码、keystore、RPC URL、授权 ID 和 calldata 字段均拒绝。

## 四类身份

- `profileHash`：`sha256:` 加 canonical Profile spec 的 SHA-256；行为字段变化必然改变它。
- `state.sha256`：`state.bin` 原始字节的 SHA-256；只描述编码后的学习状态。
- `traitKey`：v3 身份域内三字段状态与共享锁的语义去重键。
- `cardId`：canonical `cartridge.json` 完整字节的 SHA-256；Profile、lineage、provenance 或状态承诺变化都会改变它。

这些值语义不同，不能相互替代。修改 Profile 不会伪造新的 `state.sha256`；修改 manifest 或 state 任意字节会使独立验证失败。

## 验证、导出和安装

Windows 示例：

```powershell
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_v4.py export `
  --checkpoint data/flies/<fly-id>/checkpoints/<checkpoint-id>/service.npz `
  --profile data/flies/<fly-id>/profiles/000001.json `
  --out work/my-v4-cartridge

& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_v4.py verify work/my-v4-cartridge
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_v4.py publishability work/my-v4-cartridge
& work/full-brain-venv/Scripts/python.exe scripts/fly_cartridge_v4.py install work/my-v4-cartridge --out work/my-v4-checkpoint
```

Linux 将 Python 路径换为 `work/full-brain-venv/bin/python`。所有输出目录都必须事先不存在，工具不会覆盖已有卡带或 checkpoint。

`verify` 会独立执行 canonical bytes、Profile、model、共享锁、state commitment、逐字段 SHA-256、trait key 和固定启动探针检查。`install` 从共享 MaleCNS 底座 fresh boot，只恢复三字段学习特质，并生成新的 `service.npz`、`service.json` 与 `profile.json`；不会恢复运行游标、市场历史、SQLite、钱包或交易状态。

## v3 导入

本地 API 和卡带页面继续接受 v3。导入顺序为：

1. 使用未放宽的 `fly_cartridge_v3.py` 精确验证原始 v3 manifest/state。
2. 创建一只新果蝇并套用 `balanced-v1` 默认 Profile。
3. 生成 v4 包装，写入 `provenance.sourceFormatVersion=3` 和原始 v3 Card ID。
4. 重新执行 v4 verifier 并创建该果蝇的独立 checkpoint。

该 provenance 只说明本地包装来源，绝不声称 v3 原本携带 Profile。v3 verifier、v3 manifest 字段合同和链上读取器均未修改。

## 逐果蝇目录

```text
data/flies/<fly-id>/
  profiles/<revision>.json
  checkpoints/<checkpoint-id>/
  cartridges/
    active.json
    last-export.json
    imports/<import-id>/{cartridge.json,state.bin}
    exports/<export-id>/{cartridge.json,state.bin}
```

新的 active/last-export 状态属于具体 fly。旧 `data/cartridge-console/active.json` 仅在没有任何 fly 的首次升级中作为迁移输入；成功复制到 `legacy-default` 后归档为 `legacy-active-migrated.json`，不会继续充当运行时真相。

## 发布前报告

`publishability` 返回本地验证结果、manifest/state 字节数、Profile 完整性、V3 重复 state、父卡兼容和限制原因。即使字节长度满足 Registry V3，当前也返回 `publishableToRegistryV3=false` 和 `V3_CARRIER_NOT_APPROVED`：v4 尚未完成 Registry V3 reader/publisher 兼容测试，不能直接送往现有发布页或钱包签名流程。

## 验证记录

- Python v4 单元测试覆盖 canonical/Profile hash、round trip、v3 state 字节复用、Profile 行为变化、篡改、Schema/model/秘密字段、v3 provenance 与发布报告。
- Node 测试覆盖逐果蝇 import/export marker、v3 包装创建新 fly、旧全局 marker 一次迁移，以及原有 v3 Registry 边界。
- 同一输入的 canonical JSON 使用排序键、无多余空白、UTF-8 和固定末尾换行；Windows 与 Linux 不使用平台换行或本地编码参与 hash。

本工作包不部署合约、不发布主网交易、不读取钱包材料，也不更改生产服务器。
