# Fly Profile v1 WP-09 果蝇管理中心记录

日期：2026-09-20
仓库：`bsc-local-fly-agent`
工作包：WP-09（控制台“果蝇管理中心”）

## 页面与导航

新增 `/flies` 管理中心，使用独立的 `public/flies.html` 与 `public/flies.js`，继续复用现有 `public/styles.css` 的深色科学控制台视觉语言。旧运行台与卡带游戏机只增加管理中心导航链接；原钱包、交易、3D 场景和卡带脚本未改写。

页面采用三层工作区：

- 左侧个体列表显示名称、活动/运行状态、revision、Profile hash 前缀、训练状态与最近训练时间；
- 中间提供 Profile、版本历史、训练与评估、卡带四个工作区；
- 右侧持续显示 changed paths、生效模式和请求值/系统最终值组成的 Effective Risk。

在窄视口与 Windows 125% 等效视口下，检查器自动移到主工作区下方，表单保持最小可用宽度且页面不产生横向滚动。

## Profile 编辑器

编辑器从 `GET /api/fly-profile/schema` 读取类型、范围和默认值，按交易范围、感知、学习、奖励、策略、风险、运行七个页签生成结构化表单。全部可配置 schema 字段都有中文标签、单位、帮助、范围、默认值和内联错误；没有任意 JSON 文本入口。

- 基础模式只显示高频字段，高级模式覆盖七个分区的全部可配置字段；
- 保存前展示本地 diff path 和预计 activation mode；
- 风险面板并排展示 Profile 请求值与 System Policy 收紧后的实际值；
- 运行中保存 next-start 字段时展示 pending activation 说明；
- 页面离开或切换个体前检查未保存修改；
- 409 revision 冲突保留本地草稿，显示冲突路径，并可把本地字段重新应用到服务器最新 revision 后再次检查；
- rollback 通过 API 创建新 revision，不覆盖历史。

## 管理操作

管理中心已接入 WP-08 的真实本机 API：

- 从四种 Profile 预设创建果蝇；
- 克隆个体，并按选择复制已存在的 checkpoint；
- 激活与归档；
- Profile 保存、revision 查看、diff 与 rollback；
- live-observation / deterministic-replay 训练、停止 live 训练与离线评估；
- v3 当前格式、导入来源、v4 未接入状态和卡带可发布性限制说明。

训练和评估数据集输入继续遵守 WP-07 的本地 replay root 契约。页面不读取、显示或接收私钥、密码、助记词和钱包材料。

## 可访问性与安全

- 页面无内联脚本和内联事件处理器，继续受生产 CSP 保护；
- 表单、对话框、状态区、tablist 和 live region 都有语义标签；
- Profile 与工作区页签支持 Left/Right/Home/End 键；所有主操作可通过 Tab/Enter 完成；
- 状态同时显示文字，不只依赖颜色；
- 动画仅使用轻量 transform/颜色变化，并在 `prefers-reduced-motion` 下关闭；
- 触控目标保持至少 44px，移动视口输入使用 16px 字号；
- 客户端不拼接用户 HTML，不使用 `innerHTML`、`eval` 或 `new Function`。

## 验收

- 浏览器一次性本地 QA：键盘完成创建、激活、基础/高级切换、七页签导航、字段编辑、越界错误、保存 revision 和历史 rollback；rollback 从 revision 2 创建 revision 3。
- Effective Risk QA：把资金预算请求值改为 20%，界面在保存前明确显示系统最终值 10%。
- 1366×768：viewport 1366，document width 1351；三列为 272 / 709 / 310px，无横向溢出。
- 1920×1080：viewport 1920，document width 1905；三列为 272 / 1190 / 310px，无横向溢出。
- 125% 等效 1536×864：viewport 1536，document width 1521；三列为 272 / 879 / 310px，无横向溢出。
- `npm test`：91/91 通过，包含 6 个新增 UI contract 测试和生产静态路由实测。
- Python：21/21 通过，另有 5 个 subtests 通过；仅 pytest cache 因沙箱写权限产生非功能性 warning。
- `npm run brain:verify`：MaleCNS v1.0 的 166,700 个神经元、25,582,938 条有向边和锁定数组校验通过。

QA 只使用系统临时数据目录与回环地址，没有连接生产服务、修改生产数据或执行链上交易。一次性 HTTP 服务在验收后已停止。

WP-09 到此完成。Fly Cartridge v4 格式、verifier 和逐果蝇 active deck 状态属于 WP-10。
