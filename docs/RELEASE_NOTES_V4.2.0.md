# FLAP Fly Agent 4.2.0 发布说明

状态：未签名 DIY 小范围测试发行版。

## 新功能

- 运行台、果蝇管理中心与卡带游戏机右上角新增“中文 / EN”切换按钮。
- 静态说明、主要操作、动态状态和表单辅助文字支持英文显示。
- 语言选择仅保存在当前电脑的本地浏览器存储中，不会写入 Profile、卡带或链上。
- 切换按钮提供 `aria-pressed` 状态、键盘焦点样式与移动端 44px 触控区域。

## 升级范围

4.1.3 用户可以直接覆盖安装 4.2.0。升级不迁移或删除 `%LOCALAPPDATA%/FLAP Fly Agent/data/`
下的果蝇、checkpoint、SQLite、钱包密文或 MaleCNS 数据。Fly Cartridge v4 卡带格式、
Registry V4 合约地址和发布协议均未改变。

安装器仍未进行商业代码签名。请从同一 GitHub Release 下载 `SHA256SUMS.txt` 并核对
`FLAP-Fly-Agent-Setup-4.2.0.exe`。
