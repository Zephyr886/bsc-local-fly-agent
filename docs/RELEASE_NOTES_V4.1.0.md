# FLAP Fly Agent 4.1.0 发布说明

状态：未签名 DIY 小范围测试发行版。项目所有者明确跳过人工真机/干净 VM 验收作为
本次门禁；自动化测试、固定构建、私钥隔离和主网逐笔确认仍保留。

## 新增范围

- Fly Cartridge Registry V4 冻结规格、威胁模型和测试向量。
- 独立不可升级、无管理员、无代理、无协议费的 Registry V4 合约。
- solc 0.8.37、optimizer 200、viaIR、Cancun 固定构建与逐字节 artifact 复现。
- `/registry-v4` 本机 HTML 部署台：主网/测试网部署、最近 v4 导出发布、回读及新鲜安装闭环。
- 部署记录保存到 `%LOCALAPPDATA%/FLAP Fly Agent/data/registry-v4-deployments.json`。

## 主网边界

部署台不接受浏览器提供的任意 bytecode、ABI、目标地址或 calldata。服务端仅能执行三种
固定模式：仅部署、部署并发布最近导出、向已登记合约发布最近导出。主网执行前显示
chainId、预计地址、构造参数、artifact/runtime SHA-256、Gas 与费用上限及不可回滚说明；
随后仍需输入本地钱包密码和固定确认短语。

本发行版不预置 Registry V4 地址，也不会自动部署。钱包必须自行持有对应网络 Gas。
Registry V3 地址、reader 和既有卡带不修改。

## 自动化证据

- 全仓 Node 测试 116/116 通过。
- Registry V4 固定 artifact SHA-256：
  `983f44e098638a1b08cd198ca2c443e180971e79dd385454e780a96baa0179cf`。
- Cancun 本地链已验证部署、错误链拒绝、重复 Card/内容拒绝、父卡规则、同状态不同
  Profile、NFT 元数据和成功 publish calldata 逐字节恢复。
- 开发机真实 BSC 主网 RPC 预览已验证链与余额门禁；零余额钱包被拒绝且未广播交易。

## 已知限制

- 没有第三方合约审计、Authenticode 签名或人工干净 VM 验收。
- 未持有 Gas 或没有最近一次 v4 导出时，部署台会拒绝执行。
- 合约没有升级、暂停或删除能力；缺陷只能通过停用地址和部署新版本处理。
- 未签名安装器可能显示未知发布者或被组织安全策略阻止。
