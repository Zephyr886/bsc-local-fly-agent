# FLAP Registry V4 独立部署台

`FLAP-Registry-V4-Deployer.html` 是构建生成、可单独下载和打开的官方合约部署与测试工具。
它不属于 FLAP App，也不调用 App 的本机 API 或钱包文件。

重新生成：

```text
npm run registry:v4:deployer:build
```

使用安装了兼容 EIP-1193 钱包扩展的 Chrome 或 Edge 打开 HTML。若钱包默认禁止
`file://` 页面，请为该扩展开启“允许访问文件网址”，或用可信本地静态服务器提供此文件。
