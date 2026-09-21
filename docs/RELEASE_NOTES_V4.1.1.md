# FLAP Fly Agent 4.1.1 发布说明

状态：未签名 DIY 小范围测试发行版。4.1.1 修正 4.1.0 的部署边界。

## 修正结果

- Registry V4 部署台是独立的 `FLAP-Registry-V4-Deployer.html`，不在 FLAP App 内。
- App 安装器和独立 HTML 在同一个 GitHub Release 中分别下载。
- App 不再提供 `/registry-v4` 页面、部署 API 或官方合约签名能力。
- HTML 只连接浏览器注入钱包，不读取 App 的钱包密文、密码或数据目录。

## 独立部署台用途

1. 在 BSC Testnet 或 Mainnet 部署内嵌的固定官方 Registry V4 artifact。
2. 部署前校验 chainId、BSC 创世区块、账户、nonce、预计地址、余额、Gas 和费用预算。
3. 部署后逐字节核对运行 bytecode 与固定 artifact。
4. 生成并发布一次性测试卡带，回读 Card、NFT owner 和成功交易 calldata。
5. 验证相同测试卡带会被重复规则拒绝，并下载不含秘密的公开验证记录。

## 固定证据

- Registry V4 artifact SHA-256：
  `983f44e098638a1b08cd198ca2c443e180971e79dd385454e780a96baa0179cf`。
- HTML 是单文件离线资产，不引用远程 JavaScript、CSS、ABI 或 bytecode。
- Electron 打包白名单不包含 `deployment/`，因此 HTML 不进入 App 安装包。
- 自动化测试、依赖审计、Windows 安装包构建和隔离启动验证必须在发布前通过。

## 主网边界

主网部署需要逐字输入 `确认部署官方主网合约`；主网测试需要逐字输入
`确认执行主网卡带测试`。两者都需要在浏览器钱包中再次确认。合约不可升级、暂停或
删除，测试 NFT 和 calldata 也不可撤销。

## 已知限制

- 没有第三方合约审计、Authenticode 签名或人工干净 VM 验收。
- 浏览器钱包必须允许注入本地 `file://` 页面；否则应使用可信本地静态服务器。
- 本版本不预置主网 Registry V4 地址，也不会自动部署。
