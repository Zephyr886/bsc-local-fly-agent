# FlyCartridge v3 图像版主网记录

- 合约：`0x7c35e97e8f89eeb2586db4031c13c63d4bd6ca21`，BSC 主网 Chain ID 56。
- 首枚 NFT：`#1`；Card ID `0x733eeebd382d1f23b4f1650634abdb9f825f0e016ae82074734fecdb658b4450`；发布交易 `0x8f7babea04d2fa27da77314118f8023e434a09d5341d0fd129b8d618e5466e51`。
- 合约源码 `contracts/FlyCartridgeRegistryV3Image.sol`；用 `npm run cartridge:v3:image-build-check` 逐字节重建并验证 `artifacts/fly-cartridge-v3-image-candidate.json`。原钱包直连版合约和 NFT 仍在链上，二者不会迁移到新合约。
- `tokenURI` 的 `image` 是 `https://flaptofly.com/nft/fly-cartridge-v3-0ec7c8477b27.png`。图片 SHA-256 是 `0ec7c8477b27bba1441466c67140bf9e0aadeec06bfa26b1194466b64ca2b9f1`，114,178 字节。合约还以 `COVER_SHA256` 常量与元数据属性锁定这个哈希。图片仍依赖官网 HTTPS 可用；哈希锁能发现内容变化，但不能替代可用性保障。

## 图像来源与署名

封面由 [MaleCNS v1.0](https://male-cns.janelia.org/download/) 的细胞体位置样本绘成，共投影 9,355 个点，使用本仓库 `public/malecns-points.json` 的类别与坐标。数据由 FlyEM／HHMI Janelia、University of Cambridge、MRC Laboratory of Molecular Biology 和 Google Research 合作发布，源数据按 [CC BY](https://creativecommons.org/licenses/by/4.0/) 授权。封面是共用的解剖点图，不表示单个 NFT 的神经活动或当前运行状态。合约元数据 description 也包含来源和授权署名。

## 只读复验

```powershell
node scripts/inspect-fly-cartridge-v3-image-mainnet.mjs --address 0x7c35e97e8f89eeb2586db4031c13c63d4bd6ca21
node scripts/fly_cartridge_v3_direct_chain_read.mjs --chain mainnet --image --address 0x7c35e97e8f89eeb2586db4031c13c63d4bd6ca21 --card-id 0x733eeebd382d1f23b4f1650634abdb9f825f0e016ae82074734fecdb658b4450 --out <empty-directory>
python scripts/fly_cartridge_v3.py verify <empty-directory>
```

两条独立 BSC RPC 都核对了链 ID、创世块、合约运行代码、`tokenURI.image`、网页图片字节哈希、NFT #1 与发布交易。恢复的 `cartridge.json` 和 `state.bin` 分别为 1,504 和 85,942 字节，与离线 rc.2 候选逐字节一致；Python v3 神经验证通过。
