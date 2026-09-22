# FLAP Fly Agent 4.1.2 发布说明

状态：未签名 DIY 小范围测试发行版。4.1.2 修复 Windows 安装版的 V4 卡带导入。

## 修正结果

- 安装包新增 `schemas/fly-profile-v1.schema.json`，V4 Python 工具可以在安装版中完成
  Profile 校验，不再因资源缺失抛出 `FileNotFoundError`。
- 安装包新增 `src/profile/presets`，V3→V4 包装路径可以读取锁定的 balanced Profile。
- 新增资源清单回归测试；本地数据、卡带格式、Registry V4 合约和主网地址均未改变。

## 升级

可以直接覆盖安装 4.1.2。安装器不会删除 `%LOCALAPPDATA%/FLAP Fly Agent/` 下的果蝇、
checkpoint、SQLite、钱包密文、回放数据和下载缓存。升级后重新选择 `cartridge.json`
与 `state.bin` 并执行“验证并导入文件”。

## 已知限制

- 没有 Authenticode 签名、第三方合约审计或人工干净 VM 验收。
- 这是 4.1.1 的兼容修复；独立部署台和链上合约没有重新部署。
