# Fly Cartridge Registry V4 规格

状态：WP-13 冻结规格，2026-09-21。项目所有者已明确接受 DIY/迭代式发布，跳过
“5 种 Profile、20 个训练轮次和人工真机验收”作为编码前置门槛；这些项目保留为后续
质量证据，不改变合约的安全边界。Registry V3 保持不变。

## 目标与非目标

Registry V4 为 Fly Cartridge v4 提供不可变的链上身份、NFT 所有权和从发布交易恢复
原始 `cartridge.json`/`state.bin` 的能力。合约不解析 JSON、不运行神经网络、不接触
钱包密码，也不承诺收益。完整神经语义仍由固定版本的离线 verifier 验证。

## 身份与唯一性

- `cardId = SHA-256(canonical cartridge.json bytes)`。
- `stateSha256 = SHA-256(state.bin bytes)`。
- `stateKey` 等于 manifest 的 `traitKey`，表示共享运行时锁定下的学习特质身份。
- `profileHash` 等于 canonical Fly Profile v1 spec 的 SHA-256。
- `contentKey = SHA-256(profileHash || stateSha256)`，其中两个输入都是原始 32 字节。
- `cardId` 和 `contentKey` 均唯一。同一神经状态可在不同 Profile 下分别发布；相同
  Profile 与相同 state 不能通过修改 provenance、training 或 lineage 重复铸造。

合约只校验调用者提供的 `profileHash` 非零并保存承诺；客户端必须从 canonical manifest
重新计算并核对。Solidity 不承担 JSON canonicalization。

## 父卡

父身份使用 `(parentRegistry, parentCardId)`。两者必须同时为空或同时非空；当
`parentRegistry == address(this)` 时，父卡必须已存在。跨 Registry 父卡允许保存，但
由客户端根据受信任 Registry 配置验证，不把任意外部地址自动视为有效语义来源。

## 数据承载

- 原始 manifest/state 放在一次 `publish` 调用的 calldata 中，不写入合约 storage。
- 合约 storage 保存 Card 承诺、长度、发布区块、创建者和 NFT 关系。
- 客户端用 `publishBlock + creator + cardId` 找到唯一成功交易并恢复 calldata。
- manifest 上限 32,768 bytes；manifest + state 上限 120,000 bytes，以兼容 BSC
  传统交易池 128 KiB 边界。大于此限制的本地 v4 卡带仍可文件导入，但不可上链。

这种设计依赖可返回历史完整交易体的 RPC/archive provider；这是公开限制，不把 NFT
元数据当作卡带内容的替代品。

## Card 与接口

```solidity
struct Card {
    address creator;
    bytes32 profileHash;
    bytes32 stateKey;
    bytes32 stateSha256;
    address parentRegistry;
    bytes32 parentCardId;
    uint16 profileSchemaVersion;
    uint32 profileRevision;
    uint32 manifestLength;
    uint32 stateLength;
    uint64 publishBlock;
    uint256 tokenId;
}

function publish(
    bytes manifest,
    bytes state,
    bytes32 profileHash,
    bytes32 stateKey,
    address parentRegistry,
    bytes32 parentCardId,
    uint16 profileSchemaVersion,
    uint32 profileRevision
) external returns (bytes32 cardId, uint256 tokenId);
```

合约还公开 `card`、`tokenByCardId`、`tokenByContentKey`、`cardIdByToken`、ERC-721
标准接口和不可变 `deploymentChainId`。V4 不收协议费，仅消耗链上 Gas。

## NFT 元数据

`tokenURI` 是链上 percent-encoded JSON data URI，包含 `cardId`、`profileHash`、
`stateSha256` 和 `contentKey`。它不依赖外部服务器或 Cancun-only Base64 实现；元数据
只展示承诺，不声称包含或渲染真实神经状态。

## 兼容与部署

- V4 是新部署的独立不可升级合约；不修改、不代理、不替换 Registry V3。
- 构造函数绑定预期 chain ID，运行时每次发布再次检查。
- BSC testnet chain ID 为 97，mainnet 为 56；地址必须分别登记，不能跨链复用。
- 测试网部署、字节码核对和发布/恢复/安装闭环完成后，主网部署仍需单独确认地址、
  chainId、构造参数、bytecode hash 和 Gas 预算。

## 测试向量

机器可读向量位于 `test/fixtures/registry-v4-vectors.json`。构建必须固定 solc 0.8.37、
optimizer 200 runs、`viaIR=true`、`evmVersion=cancun`，并逐字节比较 tracked artifact。
BSC 主网配置已在 2024-06-20 启用 Cancun，BEP-342（EIP-5656/MCOPY）为 Enabled；
本地 EVM 测试器也必须显式支持 Cancun，不能用仅支持 Shanghai 的旧节点冒充失败证据。
