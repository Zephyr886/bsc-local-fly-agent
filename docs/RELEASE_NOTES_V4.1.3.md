# FLAP Fly Agent 4.1.3 发布说明

状态：未签名 DIY 小范围测试发行版。4.1.3 提供 Registry V4 NFT 图片修正版部署台。

## 修正结果

- 新 Registry 的 `tokenURI` 使用 `data:application/json;base64,`，包含固定 `image`。
- 合约公开 `COVER_URL` 与 `COVER_SHA256`；metadata 同时包含 `coverSha256` 属性。
- 封面为 `https://flaptofly.com/nft/fly-cartridge-v3-0ec7c8477b27.png`，SHA-256 为
  `0ec7c8477b27bba1441466c67140bf9e0aadeec06bfa26b1194466b64ca2b9f1`。
- 独立部署台会核对运行字节码、封面常量，并在测试 NFT 铸造后回读和解析 metadata。

## 主网迁移边界

旧 Registry `0xade936466C62A2925635C3FC014ff45Ce8251587` 是不可升级合约，已有 NFT
无法原地补图。请使用本 Release 的 `FLAP-Registry-V4-Deployer.html` 部署新地址并完成
一次测试 NFT；之后再将公开验证记录交给官网维护者切换地址。旧地址和 Token #1 会继续
留在链上，应标记为“无图片旧版”。

Fly Cartridge v4 文件格式、Profile/状态承诺和 `publish` 参数顺序均未改变。
