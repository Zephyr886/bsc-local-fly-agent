# Windows 干净 VM 发布验收：4.0.0

状态：建议在后续补充，不作为 4.0.0 未签名小范围测试发布的硬门禁。当前开发主机
是 Windows Home，未提供 Windows Sandbox、Hyper-V、VirtualBox、VMware、Multipass
或 Docker，不能把同机隔离目录测试冒充成干净 VM 证据。

## 前置条件

- 使用发布用未签名测试安装器；先核对 `SHA256SUMS.txt`，再确认 Authenticode 为
  `NotSigned`，并记录系统默认 SmartScreen 行为。
- VM 至少 4 GiB 内存、4 GiB 可用磁盘并允许访问 Python/MaleCNS 锁定下载地址。
- 建立快照 A（纯净系统），不得预装 Node.js、Python 或本仓库依赖。

## A：首次初始化

1. 从快照 A 安装到默认目录，确认开始菜单和桌面快捷方式目标存在。
2. 首次启动完成私有 Python、venv、MaleCNS 下载/编译/校验。
3. 核对 `/api/health` 为 HTTP 200、166,700 个神经元和 25,582,938 条边验证通过。
4. 创建一只测试果蝇，保存 Profile revision，运行最小确定性回放与冻结评估。
5. 完全退出并重新启动，确认活动果蝇、checkpoint、SQLite 和评估记录仍在。

## B：覆盖升级

1. 从快照 A 安装上一正式版本，创建可识别的旧 checkpoint、SQLite 记录和测试钱包
   密文；不得使用真实资金或真实私钥。
2. 备份数据并安装 4.0.0 覆盖升级。
3. 确认仅创建一个 `legacy-default`，源 checkpoint 与迁移目标 SHA-256 相同，备份清单、
   journal 和完成标记存在；重复启动不重复迁移。
4. 确认健康检查和只读评估通过。

## C：卸载保留数据

1. 记录 `data/` 中测试文件 SHA-256，卸载 4.0.0。
2. 确认程序目录和快捷方式已移除，但 `%LOCALAPPDATA%/FLAP Fly Agent/data/` 及
   `work/` 仍存在，测试文件 SHA-256 不变。
3. 重新安装同一未签名版本，确认应用重新识别原果蝇和 checkpoint。

## 证据要求

每阶段保存 VM 系统版本、安装器 SHA-256、Authenticode 状态、SmartScreen 行为、
应用版本、通过/失败时间和不含秘密的日志摘要。三阶段全部通过后，在本文件顶部记录
执行日期与证据位置，作为后续扩大测试范围或签名发行的验收依据。
