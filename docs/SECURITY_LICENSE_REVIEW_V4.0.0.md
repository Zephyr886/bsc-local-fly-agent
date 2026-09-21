# 4.0.0 安全、依赖、秘密与许可证审查

审查日期：2026-09-21（Asia/Shanghai）。范围为 `bsc-local-fly-agent` 源码、锁文件、
Windows 打包配置及将进入安装器的资源；不包含生产服务器或用户钱包。

## 已完成检查

- `npm audit --omit=dev --audit-level=low`：0 漏洞。
- `npm audit --audit-level=low`：0 漏洞。
- `npm ls --all`：依赖树解析成功；可选原生依赖缺失不影响当前平台。
- `npm test`：107/107；Python：28/28（另 5 个 subtests）；MaleCNS 锁校验为
  166,700 个神经元、25,582,938 条边、全部数组通过。
- 常见 PEM 私钥、AWS、GitHub、OpenAI 和 Slack 令牌特征的仓库路径扫描：0 个文件。
- Electron 使用 context isolation、禁用 Node integration、启用 renderer sandbox，并
  拒绝全部权限请求；导航边界已收紧为内置页面、本机后端和严格 BscScan 交易链接。
- 服务默认只监听 loopback；修改 API 校验远端地址、Host 和 Origin；未知敏感字段被拒绝。
- Python 安装器使用固定版本和 SHA-256；MaleCNS 下载由上游锁文件记录 URL、大小和
  SHA-256。npm 依赖由 `package-lock.json` 固定完整性。

## 许可证清点

- npm 锁文件共 337 个传递包；声明以 MIT/ISC/BSD/Apache/BlueOak 等宽松许可证为主。
  `memorystream@0.3.1` 在 lockfile 未写 `license`，但其随包 `package.json` 和 `LICENSE`
  均声明 MIT。
- Python 直接依赖：NumPy（BSD-3-Clause 及随包第三方通知）、pandas（BSD-3-Clause）、
  Pillow（MIT-CMU）、PyArrow（Apache-2.0）、psutil（BSD-3-Clause）、pytest（MIT）、
  Windows ziglang 包（MIT）。
- `vendor/stonkfly` 保留 MIT 许可证和第三方归属。下载的 MaleCNS v1.0 数据采用
  CC BY 4.0，发布研究结果时须遵守署名要求。`UPSTREAM.json` 明确本仓库只包含神经
  模拟子集，不包含 Coinbase broker/AgentKit 部分。
- `LICENSE-FLY-CARTRIDGE-V3` 只覆盖其列出的 v3 文件，不是整个仓库许可证。

## 发布阻塞项

1. 仓库没有覆盖整体应用的顶层 `LICENSE`。在所有者明确选择许可证及版权主体前，
   不应把 4.0.0 描述为开放源码正式发行版，也不能假定 v3 的局部 MIT 自动扩展到全仓库。
2. 当前用户证书库没有可用代码签名证书。正式安装器必须由受信任 Authenticode
   证书签名；证书私钥和密码不得写入仓库、命令日志或 CI 明文变量。
3. 仍需在签名后安装器上完成干净 Windows VM 的首次安装、覆盖升级、卸载保留数据验收。
4. GitHub CLI 保存的两个账号令牌均已失效；在创建 tag/Release 前必须重新执行
   `gh auth login -h github.com`，但不得把令牌粘贴到仓库文件或聊天记录。

## 剩余风险

这不是第三方渗透测试或智能合约审计。实盘签名瞬间本机进程会接触解密私钥；恶意
主机、依赖供应链、RPC 欺骗、代币黑名单/税费、MEV 和合约升级仍可能造成损失。
只应使用隔离钱包和可承受全部损失的小额资金。
