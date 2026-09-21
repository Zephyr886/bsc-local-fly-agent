# Registry V4 威胁模型

状态：WP-13，2026-09-21。范围是 V4 合约、发布交易恢复器和本地发布入口；不构成
第三方审计结论。

| 威胁 | 处理方式 | 剩余风险 |
|---|---|---|
| 重入与恶意 ERC-721 receiver | `publish` 使用 `nonReentrant`，状态先写后 `_safeMint` | receiver 可让自己的铸造回滚，但不能影响已有卡 |
| 超大 calldata / Gas DOS | 32 KiB manifest、120,000 bytes 总量硬上限 | 接近上限仍可能昂贵，发布者自行承担 Gas |
| 重复铸造 | `cardId` 与 `contentKey(profileHash,stateSha256)` 双重去重 | 不同 Profile 可有意复用同一 state |
| 伪造 Profile hash | 合约保存承诺；固定客户端从 canonical manifest 重算 | 非官方客户端可能展示未经验证的数据 |
| 伪造 state/trait | 合约重算 state SHA-256；客户端核对 traitKey 并运行 Python verifier | 合约本身不理解神经语义 |
| 错误父卡 | 同 Registry 父卡必须存在；外部父卡保存 address+cardId | 跨 Registry 语义依赖客户端 allowlist 和目标链历史 |
| 链重组 | 只接受成功回执；恢复时重读发布区块和 NFT/Card 映射 | 未达足够确认数时 UI 可能短暂显示待确认结果 |
| RPC 欺骗/裁剪历史 | 校验 chain ID、genesis、精确 runtime bytecode 和全部 commitment | 非 archive RPC 可能无法恢复旧 calldata |
| 合约升级/管理员滥用 | 无 owner、无代理、无升级、无提款和协议费 | 缺陷只能部署新 Registry，旧卡保持不可变 |
| 私钥泄漏 | 密钥不进入 Profile/卡带/合约；应用逐笔解密和确认 | 被攻陷的本机仍可在解密瞬间窃取私钥 |
| UI 任意 calldata | 服务端从已验证导出文件和固定 ABI 构造交易 | 恶意本机进程可绕过 UI，属于主机信任边界 |
| Registry V3 回归 | 新地址、新 ABI、新 reader；V3 配置和 reader 不修改 | 用户仍需辨认 V3/V4 地址和网络 |

## 失败与恢复

- 发布交易失败：不写本地“已发布”状态，可重新估算后重试。
- 发布成功但 UI 中断：用交易哈希、Card ID 和链上事件恢复，不重复铸造。
- RPC 不提供历史交易体：切换可信 archive RPC；不能仅凭事件构造原始卡带。
- 发现合约缺陷：停止在客户端暴露该 Registry，部署新版本；V4 合约没有暂停或升级后门。

## 发布结论

DIY 测试版可以在自动化测试通过后部署测试网。主网仍属于真实不可逆交易，部署前必须
输出最终 artifact SHA-256、runtime bytecode hash、构造参数、预计 Gas 和部署钱包公开地址，
并由用户明确确认。私钥、助记词和钱包密码不得出现在命令参数、日志、Git 或聊天中。
