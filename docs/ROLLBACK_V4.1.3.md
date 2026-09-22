# FLAP Fly Agent 4.1.3 回滚指引

1. 在新 Registry 部署前，可以停止使用 4.1.3 部署台并删除该 HTML；不会改变链上状态。
2. 新 Registry 一旦部署就不能删除、升级或暂停；若验证失败，不要把其地址设为官网活动地址。
3. 官网尚未切换前仍读取旧 Registry；App 用户数据和 Fly Cartridge v4 文件不受影响。
4. 官网切换后若发现问题，可以把活动读取地址回退到旧 Registry，但新地址及测试 NFT
   仍永久留在链上。

旧 Registry 的无图片 NFT 无法通过回滚或重新安装 App 修复。
