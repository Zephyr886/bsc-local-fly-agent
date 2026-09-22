const STORAGE_KEY = "flap-agent-language";
const originals = new WeakMap();
const attributeOriginals = new WeakMap();
let language = localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "zh";

const ENGLISH = Object.freeze({
  "跳到主要内容": "Skip to main content", "跳到果蝇工作区": "Skip to fly workspace",
  "果蝇管理中心 ↗": "Fly Manager ↗", "卡带游戏机 ↗": "Cartridge Deck ↗",
  "运行台": "Runtime", "卡带游戏机": "Cartridge Deck", "仅限本机": "Local only",
  "返回运行台 ↗": "Back to Runtime ↗", "返回 FlyNode 运行台": "Back to FlyNode Runtime",
  "运行监控": "Runtime Monitor", "实盘队列": "Live Queue", "架构与安全": "Architecture & Security",
  "Hybrid V2 果蝇量化控制台": "Hybrid V2 Fly Quant Console",
  "保留原版果蝇脑与 Hybrid V2，恢复完整的量化调控、模型共识、频率预算和执行审计链路。": "Preserves the original fly brain and Hybrid V2 with complete quant controls, model consensus, frequency budgets, and execution audit trails.",
  "实验性高风险系统。": "Experimental high-risk system.",
  "Hybrid 放行不代表代币安全或交易必然盈利。真实执行仅允许来自当前 Hybrid 提案，并仍需隔离钱包逐笔确认。": "Hybrid approval does not make a token safe or a trade profitable. Live execution accepts only the current Hybrid proposal and still requires per-transaction confirmation from an isolated wallet.",
  "BSC 代币合约地址": "BSC token contract address", "初始 BNB": "Initial BNB", "初始代币": "Initial tokens",
  "启动运行时": "Start runtime", "暂停": "Pause", "重置": "Reset",
  "拖动观察 · 双击复位": "Drag to inspect · Double-click to reset", "K 线正在等待行情数据": "Candles are waiting for market data",
  "果蝇脑神经元场": "Fly Brain Neural Field",
  "全脑决策直接驱动上方果蝇左右前足按下 BUY 或 BURN；量化共识、频率预算与资金风控仍在下方独立决定是否真正成交。": "Full-brain decisions drive the fly's front legs to press BUY or BURN; quant consensus, frequency budgets, and capital controls independently decide whether a trade may execute.",
  "细胞类型": "Cell types", "策略状态": "Strategy state", "复位": "Reset",
  "实际运行链路": "Runtime pipeline", "价格 · K线 · 成交流 · 池储备": "Price · Candles · Trades · Pool reserves",
  "趋势 · 位置 · 活度 · 订单流": "Trend · Position · Activity · Order flow", "脑与量化必须方向一致": "Brain and quant must agree",
  "频率 · 间隔 · 资金 · Gas · 流动性": "Frequency · Interval · Capital · Gas · Liquidity", "四影子账户 · SQLite 审计": "Four shadow accounts · SQLite audit",
  "链上现价": "On-chain price", "市场状态": "Market regime", "综合活度": "Composite activity", "位置分位": "Position percentile",
  "5m 买卖流": "5m order flow", "频率容量": "Frequency capacity", "等待原生报价": "Waiting for native quote", "等待链上行情": "Waiting for on-chain market data", "动态窗口": "Dynamic window",
  "果蝇大脑": "Fly brain", "量化机会评分": "Quant opportunity score", "Hybrid V2 调控闸门": "Hybrid V2 control gates",
  "固定放行线 ": "Fixed approval line ", "采样活跃胞体": "Sampled active somas", "KC 脉冲": "KC spikes", "总脉冲": "Total spikes",
  "计算 / 内存": "Compute / memory", "距 5m 低点": "Distance from 5m low", "买单占比": "Buy share", "量能比": "Volume ratio", "池报价储备": "Pool quote reserves",
  "启动运行时后显示逐层放行状态。": "Start the runtime to see every gate decision.",
  "四账户影子对照": "Four-account shadow comparison", "等待有效回购对": "Waiting for a valid buyback pair",
  "模型": "Model", "净资产": "Net assets", "动作": "Action", "买入": "Buy", "卖出/销毁": "Sell/Burn", "平均买价": "Average buy price", "主要阻断": "Primary blocker",
  "尚未启动": "Not started", "Hybrid 放行成交": "Hybrid-approved trades", "决策时间": "Decision time", "方向": "Direction", "输入": "Input", "输出": "Output", "量化分": "Quant score", "共识置信度": "Consensus confidence",
  "只有七级闸门最终放行的交易才会出现。": "Only trades approved by all seven gates appear here.", "决策审计": "Decision audit", "暂无事件": "No events yet",
  "实盘不接受手工方向": "Live trading does not accept manual directions",
  "只有当前运行时被 Hybrid V2 七级闸门放行、未过期且未使用的提案可以进入交易预览。": "Only unused, unexpired proposals approved by all seven Hybrid V2 gates may enter trade preview.",
  "我理解 Hybrid 放行不代表合约安全，并将只使用隔离钱包和可承受全部损失的小额资金。": "I understand Hybrid approval does not make a contract safe, and I will use only an isolated wallet with a small amount I can afford to lose.",
  "本地加密钱包": "Local encrypted wallet", "未创建": "Not created", "生成或导入本地钱包": "Create or import local wallet",
  "地址": "Address", "网络": "Network", "存储": "Storage", "尚未创建": "Not created",
  "Hybrid 实盘提案": "Hybrid live proposal", "等待放行": "Waiting for approval",
  "当前没有可执行提案。保持模拟运行，直到脑与量化同向且所有风控通过。": "There is no executable proposal. Keep the simulation running until brain and quant agree and every risk control passes.",
  "代币 CA（由提案锁定）": "Token CA (locked by proposal)", "方向（由提案锁定）": "Direction (locked by proposal)", "最大输入数量": "Maximum input amount", "最大滑点（0.1%–15%）": "Maximum slippage (0.1%–15%)",
  "核验提案并构建交易": "Validate proposal and build transaction", "真实执行回执": "Live execution receipts", "尚未发送真实交易。": "No live transaction has been sent.",
  "与原项目一致的运行分层": "Runtime layers matching the original project", "采集层": "Collection layer", "神经层": "Neural layer", "策略层": "Strategy layer", "状态层": "State layer", "执行层": "Execution layer",
  "双模型共识": "Dual-model consensus", "量化调控": "Quant controls", "运行风控": "Runtime risk controls", "审计一致性": "Audit consistency", "本地密钥边界": "Local key boundary", "剩余风险": "Residual risks",
  "生成或导入本地钱包": "Create or import local wallet", "本地钱包账户": "Local wallet account", "生成新钱包": "Create new wallet", "导入私钥": "Import private key", "私钥": "Private key",
  "保险库密码（至少 12 个字符）": "Vault password (at least 12 characters)", "再次输入密码": "Enter password again", "取消": "Cancel", "生成并加密": "Create and encrypt",
  "立即备份生成的私钥": "Back up the generated private key now", "复制私钥": "Copy private key", "已完成离线备份": "Offline backup complete",
  "确认 Hybrid 主网交易": "Confirm Hybrid Mainnet transaction", "保险库密码": "Vault password", "解密、签名并广播": "Decrypt, sign, and broadcast",
  "果蝇管理中心": "Fly Manager", "创建果蝇": "Create fly", "刷新状态": "Refresh status", "果蝇个体": "Fly roster", "搜索名称或标签": "Search name or tag", "输入关键词": "Enter a keyword",
  "还没有果蝇": "No flies yet", "从平衡预设创建第一只个体，再按需编辑 Profile。": "Create the first fly from the balanced preset, then edit its Profile as needed.", "创建第一只": "Create first fly",
  "选择一只果蝇开始": "Select a fly to begin", "左侧显示本机个体、运行状态、revision 与最近训练。": "The left side shows local flies, runtime state, revisions, and recent training.",
  "未激活": "Inactive", "未训练": "Untrained", "设为活动果蝇": "Set as active fly", "克隆": "Clone", "归档": "Archive", "最近训练": "Latest training",
  "Profile 编辑器": "Profile Editor", "版本历史": "Version History", "训练与评估": "Training & Evaluation", "卡带": "Cartridge",
  "行为与风险配置": "Behavior and risk configuration", "基础模式": "Basic mode", "高级模式": "Advanced mode", "编辑器复杂度": "Editor complexity",
  "Profile 不存放私钥。": "Profiles never store private keys.", "所有字段都有固定类型和边界；高级模式仍是结构化表单，不接受任意 JSON。": "Every field has a fixed type and bounds. Advanced mode remains a structured form and does not accept arbitrary JSON.",
  "交易范围": "Trading universe", "感知": "Perception", "学习": "Learning", "奖励": "Reward", "策略": "Strategy", "风险": "Risk", "运行": "Runtime",
  "没有未保存修改": "No unsaved changes", "放弃修改": "Discard changes", "保存新 Revision": "Save new revision",
  "版本历史与回滚": "Revision history and rollback", "刷新历史": "Refresh history", "更新时间": "Updated", "操作": "Action", "选择一个历史版本": "Select a historical revision",
  "这里会列出与当前 Profile 不同的字段路径。": "Differences from the current Profile will appear here.", "训练与离线评估": "Training and offline evaluation", "检查中": "Checking",
  "链上观察训练": "On-chain observation training", "BSC 代币地址": "BSC token address", "开始训练": "Start training", "停止训练": "Stop training", "确定性回放训练": "Deterministic replay training", "数据集路径": "Dataset path", "开始回放": "Start replay", "离线评估": "Offline evaluation", "开始评估": "Start evaluation",
  "一只卡带，一只独立果蝇": "One cartridge, one independent fly",
  "v4 同时保存 canonical Profile 与学习特质；游戏进度、Hybrid 记录、钱包和交易记录仍留在设备，不随卡带导出。": "V4 stores the canonical Profile and learned traits together. Gameplay progress, Hybrid records, wallets, and transaction history stay on the device.",
  "当前设备": "Current device", "读取中…": "Loading…", "运行状态": "Runtime status", "链上合约": "On-chain contract",
  "导入学习特质": "Import learned traits", "BSC 代币地址（v3/链上导入必填，v4 可选）": "BSC token address (required for V3/on-chain imports; optional for V4)",
  "从本地文件导入": "Import from local files", "验证并导入文件": "Validate and import files", "或从主网取回": "or recover from Mainnet", "链上取回并导入": "Recover and import from chain",
  "导出当前学到的特质": "Export current learned traits", "暂停当前运行": "Pause current runtime", "从当前大脑导出卡带": "Export cartridge from current brain", "上次导出 Card ID": "Last exported Card ID",
  "下载 cartridge.json": "Download cartridge.json", "下载 state.bin": "Download state.bin", "回到运行台继续学习": "Return to the runtime and continue learning", "打开运行台 ↗": "Open Runtime ↗",
  "已载入学习特质": "Learned traits loaded", "默认本地大脑": "Default local brain", "尚未安装卡带": "No cartridge installed", "运行中": "Running", "已暂停 / 未启动": "Paused / not started", "设备环境尚未绑定": "Device environment not bound",
  "正在验证并安装…": "Validating and installing…", "正在链上取回并验证…": "Recovering and validating on-chain data…", "正在暂停…": "Pausing…", "正在保存并导出…": "Saving and exporting…",
  "可发布": "Publishable", "当前不可直接发布到 Registry V3": "Not directly publishable to Registry V3",
  "感觉": "Sensory", "上行": "Ascending", "下行": "Descending", "中枢": "Central", "运动": "Motor", "内分泌": "Endocrine",
  "决策脉冲": "Decision pulse", "滚动价格分布": "Rolling price distribution", "MaleCNS 全连接组": "MaleCNS full connectome",
  "运行 166,700 个神经元 / 25,582,938 条边 · CC BY 4.0": "166,700 neurons / 25,582,938 edges · CC BY 4.0",
  "166,700 神经元、25,582,938 条边与可塑性运行时": "166,700 neurons, 25,582,938 edges, and a plastic runtime",
  "［MALECNS_V1 · 12,781 个显示采样点］": "[MALECNS_V1 · 12,781 rendered samples]",
  "原版 Hybrid V2": "Original Hybrid V2", "DAN 奖励 / 厌恶": "DAN reward / aversion", "DNp20 阈值": "DNp20 threshold",
  "价格 70% + 量能 30%": "Price 70% + volume 30%", "K线、成交、流动性、数据新鲜度": "Candles, trades, liquidity, and data freshness",
  "量化评分、共识、频率和风控": "Quant score, consensus, frequency, and risk controls",
  "决策、阻断原因、交易与检查点": "Decisions, blockers, trades, and checkpoints",
  "一次性授权、逐笔解密签名、链上回执": "One-time approval, per-transaction signing, and on-chain receipts",
  "网络": "Network", "指标": "Metrics", "状态": "Status", "模式": "Mode", "时间": "Time", "开始时间": "Started",
  "动态活度决定安静/活跃频率窗，同时锁定最小间隔、Gas、余额、单次比例和池参与率。": "Dynamic activity selects quiet or active frequency windows while enforcing minimum intervals, gas, balance, per-trade size, and pool participation limits.",
  "量化机会分达到 0.62 仍不够；果蝇脑必须在同一观察点提出相同方向，否则固定 HOLD。": "A 0.62 quant score is not enough: the fly brain must choose the same direction at the same observation, or the result stays HOLD.",
  "BUY 检查持续下跌、低位和低点距离；SELL/BURN 检查快速上涨、反弹和高位，并纳入订单流与流动性。": "BUY checks sustained decline, low positioning, and distance from the low; SELL/BURN checks rapid rise, rebound, and high positioning, with order flow and liquidity included.",
  "原 Hybrid V2 影子账户仍按 BUY/BURN 记账；BSC 执行边界把最终 BURN 提案适配为 Token → BNB 的 SELL。两层数据分别展示，不篡改原策略模块。": "Original Hybrid V2 shadow accounts still record BUY/BURN. The BSC execution boundary maps an approved BURN proposal to a Token → BNB SELL. Both layers remain visible without altering the original strategy module.",
  "决策、执行结果与 Hybrid/脑检查点在同一 SQLite 事务提交，避免只写成交不写决策上下文。": "Decisions, execution results, and Hybrid/brain checkpoints commit in one SQLite transaction so a trade cannot be recorded without its decision context.",
  "私钥使用 scrypt N=131072 与 AES-256-GCM 加密落盘；密码不保存。解密只发生在逐笔签名请求内，不提供长期解锁会话。": "Private keys are encrypted at rest with scrypt N=131072 and AES-256-GCM. Passwords are never stored; decryption occurs only for each signing request, with no persistent unlock session.",
  "恶意本机进程、浏览器脚本、弱密码、未备份或主机失窃仍可能造成永久损失；系统也不能排除蜜罐、动态税、MEV 与 RPC 风险。": "Malicious local processes, browser scripts, weak passwords, missing backups, or device theft may still cause permanent loss. The system also cannot eliminate honeypot, dynamic-tax, MEV, or RPC risks.",
  "本功能会让本地 Node 进程接触解密后的私钥。请只使用专用小额钱包，不要导入主钱包或长期资产钱包。": "This feature exposes the decrypted key to the local Node process. Use only a dedicated low-value wallet; never import a primary or long-term asset wallet.",
  "私钥仅以 scrypt 派生密钥 + AES-256-GCM 密文保存在本项目 data 目录。密码不保存、不写日志；每笔交易都要重新输入。": "The private key is stored only as scrypt-derived AES-256-GCM ciphertext in this project's data directory. The password is neither stored nor logged and must be re-entered for every transaction.",
  "私钥只提交到 127.0.0.1 的专用导入接口，并立即加密落盘。": "The private key is sent only to the dedicated 127.0.0.1 import endpoint and immediately encrypted at rest.",
  "此私钥只显示这一次。密码遗失或保险库文件损坏时，没有找回机制。": "This private key is shown only once. There is no recovery if the password is lost or the vault file is damaged.",
  "我已将私钥离线保存，并理解任何获得它的人都能转走全部资产。": "I saved the private key offline and understand that anyone who obtains it can transfer all assets.",
  "密码只用于本次解密签名，不会保存为解锁状态。": "The password is used only for this signature and is never kept as an unlocked session.",
  "可以降低数量，不能超过 Hybrid 放行额度；提案 5 分钟过期。卖出使用精确额度授权。": "You may reduce the amount but cannot exceed the Hybrid-approved limit. Proposals expire after five minutes; sells use exact-amount approval.",
  "WAITING · 等待全脑判断": "WAITING · Awaiting full-brain decision",
  "名称": "Name", "说明": "Description", "标签": "Tags", "Profile 预设": "Profile preset", "创建并打开": "Create and open",
  "克隆当前果蝇": "Clone current fly", "新果蝇名称": "New fly name", "创建克隆": "Create clone",
  "复制当前 checkpoint": "Copy current checkpoint", "复制学习状态；不会复制钱包、交易历史或运行会话。": "Copy learned state without copying the wallet, transaction history, or runtime session.",
  "本机注册表与导入器能力": "Local registry and importer capabilities", "当前格式": "Current format", "导入来源": "Import source",
  "v3 保持兼容；v4 独立验证": "V3 remains compatible; V4 is validated independently", "v4 状态": "V4 status",
  "卡带兼容状态": "Cartridge compatibility", "打开卡带游戏机": "Open Cartridge Deck",
  "字段变更": "Field changes", "变更检查": "Change review", "生效方式": "Activation mode", "无待保存修改": "No pending changes",
  "字段修改会标明立即生效、下次启动、下次训练或需要分叉。": "Field changes identify whether they apply immediately, on next start, on next training run, or require a fork.",
  "左侧是 Profile 请求值，右侧是 System Policy 限制后真正生效的值。": "The left side shows requested Profile values; the right side shows the effective values after System Policy limits.",
  "选择并编辑 Profile 后显示。": "Shown after selecting and editing a Profile.",
  "查看任意 revision 与当前版本的字段差异。回滚会创建新的 revision，不会覆盖或删除历史。": "Compare any revision with the current version. Rollback creates a new revision and never overwrites or deletes history.",
  "训练记录": "Training history", "评估记录": "Evaluation history", "数据集": "Dataset", "结果摘要": "Result summary",
  "启动观察训练": "Start observation training", "停止当前训练": "Stop current training", "确定性回放": "Deterministic replay",
  "数据集相对路径": "Dataset relative path", "运行回放训练": "Run replay training",
  "需要先激活当前果蝇。使用服务端读取的链上价格，停止时保存 checkpoint。": "Activate the current fly first. It uses server-read on-chain prices and saves a checkpoint when stopped.",
  "数据集必须位于允许的本地 replay 目录；相同输入可复现相同结果。": "The dataset must be inside the allowed local replay directory; identical inputs reproduce identical results.",
  "只评估当前 Profile 与 checkpoint，不把评估过程写回学习状态。": "Evaluate the current Profile and checkpoint without writing evaluation activity back to learned state.",
  "选择一只果蝇后显示。": "Shown after selecting a fly.", "预设说明将在这里显示。": "Preset details will appear here.",
  "服务器已有更新": "The server has a newer revision", "本地修改路径": "Local change paths", "继续检查本地草稿": "Keep reviewing local draft", "载入服务器并重新应用": "Load server revision and reapply",
  "为避免覆盖别处的修改，本次保存已停止。服务器当前为": "Saving stopped to avoid overwriting another update. The server is currently at",
  "“重新应用”会先载入服务器新版本，再把这些本地字段修改叠加到新草稿；仍需你再次检查并保存。": "Reapply first loads the new server revision, then layers these local field changes onto a new draft. Review and save again.",
  "选择本地 v3/v4 两份卡带文件，或填写 Registry V3 主网 Card ID。系统会用对应的独立 verifier 检查格式、哈希和启动探针，再创建新的果蝇。": "Select the two local V3/V4 cartridge files or enter a Registry V3 Mainnet Card ID. The matching verifier checks format, hashes, and the boot probe before creating a new fly.",
  "先暂停运行时。游戏机会从当前果蝇抽取": "Pause the runtime first. The deck extracts",
  "，连同 canonical Profile 生成可独立验证的 v4 文件。": ", then combines them with the canonical Profile into independently verifiable V4 files.",
  "v4 新卡带不自动发布。当前 Registry V3 carrier 尚未通过 v4 reader/publisher 兼容测试，因此本机报告会明确标为不可直接发布；不会发起钱包签名或链上写入。": "New V4 cartridges are not published automatically. The current Registry V3 carrier has not passed V4 reader/publisher compatibility testing, so the local report marks it as not directly publishable and never requests a wallet signature or on-chain write.",
  "导入后新果蝇会成为活动选择。全脑 worker 从该果蝇的独立 checkpoint 恢复；Hybrid、市场观察与本地钱包记录仍由本机管理。": "After import, the new fly becomes active. The full-brain worker resumes from that fly's isolated checkpoint, while Hybrid state, market observations, and wallet records remain local.",
});

const PATTERNS = [
  [/^(\d+) 只$/, (_, count) => `${count} flies`], [/^(\d+) 笔$/, (_, count) => `${count} trades`],
  [/^有 (\d+) 个字段需要修正$/, (_, count) => `${count} fields need correction`],
  [/^(\d+) 项修改尚未保存$/, (_, count) => `${count} unsaved changes`],
  [/^导入成功：(.+)$/, (_, detail) => `Import succeeded: ${detail}`],
  [/^v4 导出完成：(.+)$/, (_, detail) => `V4 export complete: ${detail}`],
];

function translated(value) {
  const leading = value.match(/^\s*/)?.[0] || "";
  const trailing = value.match(/\s*$/)?.[0] || "";
  const core = value.trim();
  if (!core) return value;
  if (ENGLISH[core]) return `${leading}${ENGLISH[core]}${trailing}`;
  for (const [pattern, replacement] of PATTERNS) if (pattern.test(core)) return `${leading}${core.replace(pattern, replacement)}${trailing}`;
  return value;
}

function apply(root = document.body) {
  const nodes = [root];
  if (root.querySelectorAll) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
  }
  for (const node of nodes) {
    if (node.nodeType !== Node.TEXT_NODE || node.parentElement?.closest("script,style,code,pre,[data-no-translate],[data-language-switch]")) continue;
    const current = node.nodeValue ?? "";
    let original = originals.get(node);
    if (original === undefined || (language === "en" && current !== translated(original))) original = current;
    originals.set(node, original);
    node.nodeValue = language === "en" ? translated(original) : original;
  }
  if (root.querySelectorAll) for (const element of [root, ...root.querySelectorAll("*")]) {
    if (!(element instanceof Element) || element.closest("[data-no-translate],[data-language-switch]")) continue;
    const saved = attributeOriginals.get(element) ?? new Map();
    for (const name of ["placeholder", "title", "aria-label"]) {
      const current = element.getAttribute(name);
      const original = saved.get(name);
      if (current !== null && (original === undefined || (language === "en" && current !== translated(original)))) saved.set(name, current);
      if (saved.has(name)) element.setAttribute(name, language === "en" ? translated(saved.get(name)) : saved.get(name));
    }
    attributeOriginals.set(element, saved);
  }
}

function setLanguage(next) {
  language = next;
  localStorage.setItem(STORAGE_KEY, language);
  document.documentElement.lang = language === "en" ? "en" : "zh-CN";
  document.querySelectorAll("[data-language-switch] button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.language === language));
  });
  observer.disconnect();
  apply(document.body);
  observe();
}

function addSwitch() {
  const host = document.querySelector(".top-status");
  if (!host || host.querySelector("[data-language-switch]")) return;
  const group = document.createElement("div");
  group.className = "local-language-switch";
  group.dataset.languageSwitch = "";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", language === "en" ? "Language" : "语言");
  for (const [value, label] of [["zh", "中文"], ["en", "EN"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.language = value;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(value === language));
    button.addEventListener("click", () => setLanguage(value));
    group.append(button);
  }
  host.append(group);
}

const observer = new MutationObserver((records) => {
  observer.disconnect();
  for (const record of records) {
    if (record.type === "characterData") apply(record.target);
    for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) apply(node);
  }
  observe();
});
function observe() { observer.observe(document.body, { childList: true, characterData: true, subtree: true }); }

addSwitch();
setLanguage(language);
window.FLAP_LANGUAGE = Object.freeze({ get: () => language, set: setLanguage, translate: translated });
