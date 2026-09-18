# FlyCartridge v3 钱包直付候选

此分支将旧版浏览器临时账户上传替换为一笔 `publish(manifest, state, stateKey, parentCardId)` 交易。交易由发布者的钱包签名并支付 Gas，成功时同笔铸造 NFT。合约不接收预存 BNB、不创建或保管临时私钥。旧测试网 NFT 仍由 `v3.0.0-rc.2` 的历史读取器读取；新合约已在测试网试发，主网仍需独立审阅。

## 固定产物与边界

- 源码：`contracts/FlyCartridgeRegistryV3Direct.sol`，SHA-256 `b9b8d4b00e076d3aabe9bfcfad5a9eb282ccd088bedd80589a51680c87256055`。
- 产物：`artifacts/fly-cartridge-v3-direct-candidate.json`，SHA-256 `49eb4f94e8a068efd11ba58ee8bb9a8fd38e0c08d3d3d27600047f93aed901cb`。用锁定的 Solidity 0.8.37、OpenZeppelin 5.6.1、优化器 200 runs、`viaIR` 执行 `npm ci && npm run cartridge:v3:direct-build-check` 可重现。
- 清单最长 16,384 字节；清单与状态合计最长 **120,000 字节**。当前 85,942 字节状态的 v3 样本符合此限制。更大的 v3 卡带仍可在本地验证与运行，但此候选合约拒绝其一笔发布；若未来需要发布，应另行设计钱包直付的分块协议。
- BSC 节点的普通交易池单笔大小限制是 [128 KiB](https://github.com/bnb-chain/bsc/blob/master/core/txpool/legacypool/legacypool.go)，另有 [16,777,216 Gas 的单笔上限](https://docs.bnbchain.org/announce/mendel-bsc/)。120,000 字节给 ABI 与交易信封留出余量。实际钱包及 RPC 兼容性仍须在测试网验证。
- 合约只验证长度、Card ID、状态 SHA-256、特质键去重和父卡带存在；它无法证明神经语义。独立 Python `verify` 仍是发布前条件。链上状态字节来自成功 `publish` 交易的 calldata，独立读取器核验链、合约运行代码、NFT 关系、交易回执与字节哈希。

## 已执行的本地验收

在 Hardhat Chain ID 31337 上，使用新内容锁 v3 样本一次发布、独立读取两份文件、核验 NFT 归属与转让均通过。86 KB 样本交易使用 **3,517,090 Gas**。最大边界（清单 16,384 字节、状态 103,616 字节）编码后 calldata **120,196 字节**，本地使用 **4,824,250 Gas**；均低于 BSC 上述上限。空文件、未知父卡带、零特质键、重复 Card 与重复状态键、超长输入按预期拒绝。运行 `node scripts/fly-cartridge-v3-direct-local-smoke.mjs --local` 可复验。Node 测试和固定编译通过。

## 未通过的放行门槛

测试网合约 `0x3e4b783ad01519fbf0a8dbda6a6334e6b4a49898` 已由 OKX 钱包在交易 `0x3e835fd0411b1346229e8a7360c4af744256a36bc0d13fcaf0ab08b4868cf692` 成功发布旧历史卡带 `0x5755e83461ef601b5a5e51677c768288334391369c06bcc048966f354ea43809`，NFT #1，3,515,750 Gas，单价 0.12 gwei，费用 0.00042189 tBNB。两个官方测试网 RPC 逐字节取回相同文件；清单 1,470 字节、状态 85,942 字节，状态 SHA-256 `9bfc048f7a5633b0695033f01f520fbd35a3806e670d03f55a462ffe65c57614`。全新 Windows 克隆中的公开数据底座运行 Python `verify` 及固定 10 ms 探针通过。

最大边界的本地数据只是长度与 Gas 压力样本，不是有效神经卡带；真实钱包对最大边界的兼容性、拒签、断线、重复提交和失败处理仍需测试。独立安全审阅者仍未指定；测试网发布不构成主网审计。新内容锁清单 `733eeebd382d1f23b4f1650634abdb9f825f0e016ae82074734fecdb658b4450` 与此次旧清单状态 SHA-256 相同，按合约去重规则不能在同一合约内再次发布。

测试网部署后，用 `node scripts/verify-fly-cartridge-v3-direct-deployment.mjs --address <合约地址> --deployment-tx <部署交易哈希>` 从独立 RPC 核对链、创世区块、部署回执和完整运行字节码；发布后再用 `node scripts/fly_cartridge_v3_direct_chain_read.mjs --address <合约地址> --card-id <Card ID> --out <新目录>` 逐字节恢复。
