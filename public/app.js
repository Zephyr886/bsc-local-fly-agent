const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const ui = { poller: null, wallet: null, chainId: null, prepared: null, proposalId: null, toastTimer: null };

function setText(selector, value) { const node = $(selector); if (node) node.textContent = value; }
function errorMessage(error) { return error?.message || String(error || "发生未知错误"); }
function short(value, head = 8, tail = 6) { return value ? `${value.slice(0, head)}…${value.slice(-tail)}` : "—"; }
function number(value, digits = 6) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(Number(value)) : "—"; }
function percent(value, digits = 2) { return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : ""}${(Number(value) * 100).toFixed(digits)}%` : "—"; }
function price(value) { const n = Number(value); return Number.isFinite(n) ? (n >= .001 ? number(n, 8) : n.toExponential(5)) : "—"; }

function toast(message) {
  const node = $("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => node.classList.remove("show"), 4_000);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
  return body;
}

function switchTab(id) {
  const map = { "tab-sim": "panel-sim", "tab-live": "panel-live", "tab-security": "panel-security" };
  for (const [tabId, panelId] of Object.entries(map)) {
    const selected = tabId === id;
    $(`#${tabId}`).classList.toggle("active", selected);
    $(`#${tabId}`).setAttribute("aria-selected", String(selected));
    $(`#${panelId}`).hidden = !selected;
    $(`#${panelId}`).classList.toggle("hidden", !selected);
  }
}
for (const tab of $$(".tab")) tab.addEventListener("click", () => switchTab(tab.id));

function badge(selector, action) {
  const node = $(selector); const normalized = action || "HOLD";
  node.textContent = normalized;
  node.className = `mode-badge ${normalized === "BUY" ? "buy" : ["SELL", "BURN"].includes(normalized) ? "sell" : "neutral"}`;
}

function renderGate(gate) {
  const list = $("#gate-list"); list.replaceChildren();
  if (!gate) { const item = document.createElement("li"); item.className = "empty"; item.textContent = "启动运行时后显示逐层放行状态。"; list.append(item); return; }
  badge("#hybrid-action", gate.finalAction);
  for (const layer of gate.layers) {
    const item = document.createElement("li"); item.className = layer.pass ? "pass" : "block";
    const state = document.createElement("span"); state.className = "gate-state"; state.textContent = layer.pass ? "✓" : "×";
    const label = document.createElement("strong"); label.textContent = layer.label;
    const detail = document.createElement("div"); detail.className = "gate-detail";
    const value = document.createElement("span"); value.textContent = layer.value;
    detail.append(value);
    if (layer.reasonText) { const reason = document.createElement("small"); reason.textContent = layer.reasonText; detail.append(reason); }
    item.append(state, label, detail); list.append(item);
  }
}

function renderAccounts(data) {
  const body = $("#account-body"); body.replaceChildren();
  if (!data.accounts) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 9; cell.className = "empty"; cell.textContent = "尚未启动"; row.append(cell); body.append(row); return; }
  const labels = { twap: "TWAP", quant: "纯量化", brain: "纯果蝇脑", hybrid: "HYBRID V2" };
  for (const name of ["twap", "quant", "brain", "hybrid"]) {
    const account = data.accounts[name]; const row = document.createElement("tr");
    const blockers = Object.entries(account.blocked || {}).sort((a, b) => b[1] - a[1]);
    const cells = [labels[name], number(account.netAssetValue, 6), number(account.quote, 6), number(account.token, 2), account.actions, account.buys, account.burns, price(account.averageBuyPrice), blockers.length ? `${blockers[0][0]} · ${blockers[0][1]}` : "—"];
    cells.forEach((value, index) => { const cell = document.createElement("td"); cell.textContent = value; if (index === 0) cell.className = `model-name ${name === "hybrid" ? "primary-model" : ""}`; row.append(cell); });
    body.append(row);
  }
  const edge = data.hybridV2?.comparison?.buyEdgeVsTwap;
  setText("#comparison-edge", edge === null || edge === undefined ? "等待有效回购对" : `Hybrid vs TWAP ${percent(edge)}`);
}

function renderTrades(trades = []) {
  setText("#trade-count", `${trades.length} 笔`); const body = $("#trade-body"); body.replaceChildren();
  if (!trades.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 7; cell.className = "empty"; cell.textContent = "只有七级闸门最终放行的交易才会出现。"; row.append(cell); body.append(row); return; }
  for (const trade of trades.slice(0, 40)) {
    const row = document.createElement("tr");
    const values = [new Date(trade.at).toLocaleTimeString("zh-CN", { hour12: false }), trade.side.toUpperCase(), `${number(trade.amountIn, 7)} ${trade.inputSymbol}`, `${number(trade.amountOut, 7)} ${trade.outputSymbol}`, Number(trade.quantScore).toFixed(3), Number(trade.confidence).toFixed(3), `${trade.frequency?.used || 0}/${trade.frequency?.maxActions || 0}`];
    values.forEach((value, index) => { const cell = document.createElement("td"); cell.textContent = value; if (index === 1) cell.className = `side ${trade.side}`; row.append(cell); }); row.append(); body.append(row);
  }
}

function renderEvents(events = []) {
  const list = $("#event-list"); list.replaceChildren();
  if (!events.length) { const item = document.createElement("li"); item.className = "empty"; item.textContent = "暂无事件"; list.append(item); return; }
  for (const event of events.slice(0, 20)) {
    const item = document.createElement("li"); item.className = event.kind;
    const title = document.createElement("strong"); title.textContent = event.title;
    const at = document.createElement("span"); at.textContent = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
    const detail = document.createElement("p"); detail.textContent = event.detail;
    item.append(title, at, detail); list.append(item);
  }
}

function renderProposal(proposal) {
  const summary = $("#proposal-summary");
  if (!proposal) {
    summary.className = "proposal-empty"; summary.textContent = "当前没有可执行提案。保持模拟运行，直到脑与量化同向且所有风控通过。";
    badge("#proposal-state", "HOLD"); ui.proposalId = null;
    $("#live-decision-at").value = ""; $("#live-ca").value = ""; $("#live-amount").value = "";
  } else if (ui.proposalId !== proposal.decisionAt) {
    ui.proposalId = proposal.decisionAt;
    summary.className = "proposal-ready"; summary.textContent = `${proposal.side.toUpperCase()} · 量化分 ${Number(proposal.quantScore).toFixed(3)} · 共识置信度 ${Number(proposal.confidence).toFixed(3)} · 5 分钟有效`;
    badge("#proposal-state", proposal.side.toUpperCase());
    $("#live-decision-at").value = proposal.decisionAt; $("#live-ca").value = proposal.tokenAddress;
    $("#live-side").value = proposal.side; $("#live-amount").value = proposal.amount;
  }
  updateWalletUi();
}

function renderSimulation(data) {
  setText("#top-runtime", data.status === "running" ? "RUNTIME ACTIVE" : data.status === "stopped" ? "RUNTIME PAUSED" : "RUNTIME IDLE");
  setText("#observation-count", `${data.hybridV2?.observations || 0} observations`);
  const market = data.market;
  setText("#metric-price", price(market?.price)); setText("#metric-regime", market?.regime?.label || "—");
  setText("#metric-activity", market ? `${(market.activity * 100).toFixed(1)}%` : "—"); setText("#metric-position", market ? `${(market.positionPercentile * 100).toFixed(1)}%` : "—");
  const m5 = market?.flow?.windows?.m5; setText("#metric-flow", m5 ? `${number(m5.buyVolume, 2)} / ${number(m5.sellVolume, 2)}` : "—");
  const frequency = data.hybridV2?.currentFrequency; setText("#metric-frequency", frequency ? `${frequency.used}/${frequency.maxActions}` : "—"); setText("#metric-next-eligible", frequency ? `${frequency.regime} · ${number(frequency.remainingSeconds, 0)}s wait` : "动态窗口");

  const brain = data.brain; const decision = data.latestDecision;
  const membrane = Number(brain?.membrane || 0); setText("#brain-membrane", membrane.toFixed(4));
  $("#membrane-cursor").style.left = `${Math.max(3, Math.min(97, 50 + membrane / 1.2))}%`;
  badge("#brain-action", decision?.actions?.brain?.action || "HOLD");
  setText("#brain-kc", brain ? `${brain.kc.activeCount} / ${brain.kc.count}` : "—"); setText("#brain-apl", brain ? number(brain.apl.level, 4) : "—");
  setText("#brain-arousal", brain ? `${(brain.arousal.level * 100).toFixed(1)}%` : "—"); setText("#brain-dopamine", brain ? `${number(brain.dopamine.plus, 3)} / ${number(brain.dopamine.minus, 3)}` : "—");
  setText("#brain-buy-threshold", decision?.flyBrain ? number(decision.flyBrain.threshold.buy, 2) : "—"); setText("#brain-sell-threshold", decision?.flyBrain ? number(decision.flyBrain.threshold.burn, 2) : "—");

  const scores = decision?.scores; setText("#quant-buy-score", scores ? scores.buy.toFixed(3) : "0.000"); setText("#quant-sell-score", scores ? scores.burn.toFixed(3) : "0.000");
  $("#quant-buy-bar").style.width = `${(scores?.buy || 0) * 100}%`; $("#quant-sell-bar").style.width = `${(scores?.burn || 0) * 100}%`;
  badge("#quant-action", decision?.actions?.quant?.action === "BURN" ? "SELL" : decision?.actions?.quant?.action || "HOLD");
  const f = decision?.features; setText("#feature-r60", percent(f?.return60s)); setText("#feature-r300", percent(f?.return300s)); setText("#feature-low", percent(f?.distanceFromLow300s));
  setText("#feature-buy-share", f?.buyShare === null || f?.buyShare === undefined ? "—" : `${(f.buyShare * 100).toFixed(1)}%`); setText("#feature-volume", f ? number(f.volumeRatio, 3) : "—"); setText("#feature-liquidity", f ? number(f.liquidityQuote, 3) : "—");
  renderGate(data.gate); renderAccounts(data); renderTrades(data.trades); renderEvents(data.events); renderProposal(data.latestApprovedProposal);
}

async function pollSimulation() { try { renderSimulation(await api("/api/simulation")); } catch (error) { console.warn(error); } }
function ensurePoller() { if (!ui.poller) ui.poller = setInterval(pollSimulation, 1_000); }

$("#sim-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const error = $("#sim-error"); error.textContent = ""; const button = $("#sim-start"); button.disabled = true; button.textContent = "初始化…";
  const form = new FormData(event.currentTarget);
  try { const data = await api("/api/simulation/start", { method: "POST", body: JSON.stringify({ tokenAddress: form.get("tokenAddress"), initialQuote: form.get("initialQuote"), initialToken: form.get("initialToken") }) }); renderSimulation(data); ensurePoller(); toast("Hybrid V2 运行时已启动"); }
  catch (caught) { error.textContent = errorMessage(caught); $("#sim-ca").focus(); }
  finally { button.disabled = false; button.textContent = "启动运行时"; }
});
$("#sim-stop").addEventListener("click", async () => { try { renderSimulation(await api("/api/simulation/stop", { method: "POST", body: "{}" })); toast("运行时已暂停"); } catch (e) { $("#sim-error").textContent = errorMessage(e); } });
$("#sim-reset").addEventListener("click", async () => { try { renderSimulation(await api("/api/simulation/reset", { method: "POST", body: "{}" })); toast("当前内存运行时已重置，SQLite 审计记录保留"); } catch (e) { $("#sim-error").textContent = errorMessage(e); } });

// Wallet boundary
function updateWalletUi() {
  setText("#wallet-address", short(ui.wallet)); setText("#wallet-network", ui.chainId === "0x38" ? "BSC Mainnet（56）" : ui.chainId ? `错误网络（${ui.chainId}）` : "—");
  setText("#wallet-state", ui.wallet ? (ui.chainId === "0x38" ? "已连接" : "网络错误") : "未连接");
  $("#wallet-state").className = `mode-badge ${ui.wallet && ui.chainId === "0x38" ? "safe" : ui.wallet ? "danger" : "neutral"}`;
  $("#prepare-trade").disabled = !(ui.wallet && ui.chainId === "0x38" && $("#risk-consent").checked && ui.proposalId);
}
$("#risk-consent").addEventListener("change", (event) => { $("#connect-wallet").disabled = !event.target.checked; updateWalletUi(); });
async function ensureBsc() {
  let chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId !== "0x38") {
    try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] }); }
    catch (error) {
      if (error.code !== 4902) throw error;
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x38", chainName: "BNB Smart Chain Mainnet", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: ["https://bsc-dataseed.binance.org"], blockExplorerUrls: ["https://bscscan.com"] }] });
    }
    chainId = await window.ethereum.request({ method: "eth_chainId" });
  }
  ui.chainId = chainId; return chainId;
}
$("#connect-wallet").addEventListener("click", async () => {
  const error = $("#live-error"); error.textContent = "";
  if (!window.ethereum) { error.textContent = "未检测到 MetaMask / Rabby。请只在钱包扩展中导入隔离账户。"; return; }
  try { const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }); ui.wallet = accounts[0] || null; await ensureBsc(); updateWalletUi(); toast("钱包已连接；尚未授权或交易"); }
  catch (caught) { error.textContent = `连接失败：${errorMessage(caught)}`; }
});
if (window.ethereum?.on) { window.ethereum.on("accountsChanged", (accounts) => { ui.wallet = accounts[0] || null; updateWalletUi(); }); window.ethereum.on("chainChanged", (chainId) => { ui.chainId = chainId; updateWalletUi(); }); }

function fillConfirm(prepared) {
  const content = $("#confirm-content"); content.replaceChildren(); const list = document.createElement("dl");
  const proposal = `Hybrid · ${short($("#live-decision-at").value, 12, 5)}`;
  const entries = prepared.phase === "approval" ? [["来源", proposal], ["步骤", "1 / 2 · 精确额度授权"], ["代币", `${prepared.preview.token.symbol} · ${short(prepared.preview.token.address)}`], ["授权对象", `PancakeSwap V2 · ${short(prepared.preview.router)}`], ["权限", prepared.preview.permission]] : [["来源", proposal], ["步骤", prepared.preview.side === "sell" ? "2 / 2 · 交换" : "1 / 1 · 交换"], ["方向", prepared.preview.side.toUpperCase()], ["输入", prepared.preview.amountInput], ["当前报价输出", prepared.preview.quotedOutput], ["最大滑点", `${prepared.preview.slippagePercent}%`], ["路由", prepared.preview.route.map((item) => short(item)).join(" → ")], ["有效期", `${prepared.preview.deadlineSeconds} 秒`]];
  for (const [term, value] of entries) { const row = document.createElement("div"); const dt = document.createElement("dt"); const dd = document.createElement("dd"); dt.textContent = term; dd.textContent = value; row.append(dt, dd); list.append(row); }
  content.append(list); const warning = document.createElement("p"); warning.className = "confirm-warning"; warning.textContent = prepared.phase === "approval" ? "授权后还需重新报价并再次确认交换。请核对钱包显示的合约和精确额度。" : "Hybrid 共识不能排除蜜罐、动态税、MEV 或恶意合约；仍可能损失全部资金。"; content.append(warning);
}
function openConfirm(prepared) { ui.prepared = prepared; fillConfirm(prepared); $("#confirm-phrase").value = ""; $("#send-transaction").disabled = true; $("#confirm-dialog").showModal(); setTimeout(() => $("#confirm-phrase").focus(), 30); }
$("#confirm-phrase").addEventListener("input", (event) => { $("#send-transaction").disabled = event.target.value.trim() !== "确认主网交易"; });
async function prepareFromForm() {
  return api("/api/transaction/prepare", { method: "POST", body: JSON.stringify({ account: ui.wallet, decisionAt: $("#live-decision-at").value, tokenAddress: $("#live-ca").value, side: $("#live-side").value, amount: $("#live-amount").value, slippagePercent: $("#live-slippage").value }) });
}
$("#live-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const error = $("#live-error"); error.textContent = ""; const button = $("#prepare-trade"); button.disabled = true; button.textContent = "核验闸门与路由…";
  try { if (!ui.wallet || ui.chainId !== "0x38") throw new Error("请先连接钱包并切换到 BSC 主网"); openConfirm(await prepareFromForm()); }
  catch (caught) { error.textContent = errorMessage(caught); }
  finally { button.textContent = "核验提案并构建交易"; updateWalletUi(); }
});
function addLiveLog({ hash, phase, status }) {
  const list = $("#live-log"); if (list.querySelector(".empty")) list.replaceChildren(); const item = document.createElement("li"); const time = document.createElement("span"); const message = document.createElement("span"); const link = document.createElement("a");
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false }); message.textContent = `${phase === "approval" ? "精确授权" : "Hybrid 交换"} · ${status}`; link.href = `https://bscscan.com/tx/${hash}`; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = short(hash); item.append(time, message, link); list.prepend(item); return message;
}
async function waitReceipt(hash, node) {
  for (let attempt = 0; attempt < 90; attempt += 1) { const receipt = await api(`/api/transaction/receipt?hash=${encodeURIComponent(hash)}`); if (receipt.found) { node.textContent = `${node.textContent.split(" · ")[0]} · ${receipt.status === "success" ? "已确认" : "失败"} · block ${receipt.blockNumber}`; return receipt; } await new Promise((resolve) => setTimeout(resolve, 2_000)); }
  throw new Error("等待回执超时，请在 BscScan 核对");
}
$("#send-transaction").addEventListener("click", async () => {
  const button = $("#send-transaction"); const prepared = ui.prepared; if (!prepared || !window.ethereum) return; button.disabled = true; button.textContent = "等待钱包…";
  try {
    await ensureBsc(); const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [prepared.transaction] }); $("#confirm-dialog").close(); const log = addLiveLog({ hash, phase: prepared.phase, status: "已广播" }); toast("已广播，等待 BSC 回执");
    const receipt = await waitReceipt(hash, log); if (receipt.status !== "success") throw new Error("链上执行失败，Gas 可能已消耗");
    if (prepared.phase === "approval") { toast("精确授权已确认，重新读取报价"); openConfirm(await prepareFromForm()); }
    else { await api("/api/live/complete", { method: "POST", body: JSON.stringify({ decisionAt: $("#live-decision-at").value, hash }) }); ui.prepared = null; await pollSimulation(); toast("Hybrid 实盘交易已确认并写入运行时"); }
  } catch (caught) { $("#live-error").textContent = `交易未完成：${errorMessage(caught)}`; if ($("#confirm-dialog").open) $("#confirm-dialog").close(); toast("交易未完成，请检查错误"); }
  finally { button.textContent = "在钱包中确认"; button.disabled = true; }
});

pollSimulation(); ensurePoller(); updateWalletUi();
