const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const SECTION_LABELS = Object.freeze({
  universe: "交易范围", perception: "感知", learning: "学习", reward: "奖励",
  strategy: "策略", risk: "风险", runtime: "运行",
});

const FIELD_META = Object.freeze({
  "universe.chainId": ["链 ID", "chain", "固定为 BSC Mainnet。"],
  "universe.tokenBinding": ["代币绑定方式", "", "设备选择允许每次运行选择代币；固定绑定只允许指定合约。"],
  "universe.tokenAddress": ["固定代币合约", "address", "仅在固定绑定时填写非零 BSC 合约地址。"],
  "universe.quotePreference": ["报价资产", "asset", "当前策略固定使用 USDT 链上现货口径。"],
  "perception.marketRefreshMs": ["行情刷新间隔", "ms", "从市场观察器刷新价格、K 线和成交流的频率。"],
  "perception.neuralDecisionIntervalSeconds": ["神经决策间隔", "秒", "两次完整 MaleCNS 决策之间的最短时间。"],
  "perception.historyCandles": ["历史 K 线数量", "根", "用于趋势、位置与量能特征的滚动窗口。"],
  "perception.minimumHealthySamples": ["最低健康样本", "条", "达到该样本量前策略保持保守。"],
  "perception.marketMaxAgeSeconds": ["行情最大陈旧时间", "秒", "超过此时间的市场快照不会用于放行。"],
  "perception.flowMaxAgeSeconds": ["成交流最大陈旧时间", "秒", "超过此时间的买卖流不会用于评分。"],
  "learning.enabled": ["允许学习", "", "关闭时仍可决策，但不会写回神经可塑性。"],
  "learning.neuralMs": ["单次神经模拟时长", "ms", "MaleCNS 每次观察推进的生物时间。"],
  "learning.decoderThresholdHz": ["解码阈值", "Hz", "动作神经元达到此频率后才形成方向提案。"],
  "learning.checkpointEverySeconds": ["Checkpoint 间隔", "秒", "运行中周期性保存学习状态的间隔。"],
  "reward.settlementHorizonsSeconds": ["结算时间窗", "秒列表", "用逗号分隔，必须严格递增并包含主要时间窗。"],
  "reward.primaryHorizonSeconds": ["主要结算时间窗", "秒", "训练摘要与主要奖励采用的时间窗。"],
  "reward.returnScale": ["收益缩放", "比例", "把市场收益映射为奖励脉冲强度的尺度。"],
  "reward.followWeight": ["跟随方向权重", "0–1", "动作与后续方向一致时的奖励权重。"],
  "reward.positionWeight": ["位置权重", "0–1", "价格位置对奖励的影响。"],
  "reward.favorableWeight": ["有利变动权重", "0–1", "有利价格运动的额外奖励。"],
  "reward.drawdownWeight": ["回撤权重", "-1–0", "不利回撤产生的惩罚权重。"],
  "reward.pulseDeadband": ["奖励脉冲死区", "0–0.5", "绝对值低于死区的反馈不产生脉冲。"],
  "reward.minimumPulseStrength": ["最低脉冲强度", "0–1", "有效反馈脉冲的最低强度。"],
  "strategy.quantThreshold": ["量化放行阈值", "0–1", "机会评分达到此值后才进入共识闸门。"],
  "strategy.positionBuyCeiling": ["买入位置上限", "分位", "价格位置高于此分位时不允许 BUY。"],
  "strategy.positionBurnFloor": ["卖出位置下限", "分位", "价格位置低于此分位时不允许 SELL/BURN。"],
  "strategy.buyMaxReturn60s": ["BUY 允许的 1m 最大收益", "比例", "约束追涨；负数表示要求短线下跌。"],
  "strategy.buyMaxReturn300s": ["BUY 允许的 5m 最大收益", "比例", "约束五分钟趋势。"],
  "strategy.buyMaxDistanceFromLow300s": ["BUY 距 5m 低点上限", "比例", "限制买入点偏离近期低点。"],
  "strategy.burnMinReturn60s": ["SELL 需要的 1m 最低收益", "比例", "快速上涨达到该值才允许卖出路径。"],
  "strategy.burnMinReboundFromLow300s": ["SELL 最低反弹幅度", "比例", "相对五分钟低点的最低反弹。"],
  "strategy.frequencyActiveThreshold": ["活跃市场阈值", "0–1", "综合活度达到此值后使用活跃频率窗。"],
  "strategy.activeWindowSeconds": ["活跃频率窗口", "秒", "活跃市场动作配额的滚动窗口。"],
  "strategy.activeMinActions": ["活跃窗口最低动作", "次", "动态预算的活跃窗口下界。"],
  "strategy.activeMaxActions": ["活跃窗口最高动作", "次", "动态预算的活跃窗口上界。"],
  "strategy.quietWindowSeconds": ["安静频率窗口", "秒", "安静市场动作配额的滚动窗口。"],
  "strategy.quietMinActions": ["安静窗口最低动作", "次", "动态预算的安静窗口下界。"],
  "strategy.quietMaxActions": ["安静窗口最高动作", "次", "动态预算的安静窗口上界。"],
  "strategy.twapIntervalSeconds": ["TWAP 最小间隔", "秒", "策略层连续动作之间的基本间隔。"],
  "strategy.buyPercent": ["单次买入比例", "%", "每次 BUY 使用可用报价资产的比例。"],
  "strategy.burnPercent": ["单次卖出比例", "%", "每次 SELL/BURN 使用持有代币的比例。"],
  "risk.liveTradingEnabled": ["允许实盘提案", "", "只允许生成需人工确认的实盘提案；不会自动签名。"],
  "risk.capitalBudgetPercent": ["资金预算上限", "%", "Profile 请求值仍会被 System Policy 进一步限制。"],
  "risk.maxPoolParticipationPercent": ["池参与率上限", "%", "单次交易相对池储备的最大比例。"],
  "risk.maxBuyBnb": ["单次买入上限", "BNB", "以十进制字符串保存，避免浮点金额序列化误差。"],
  "risk.slippagePercent": ["最大滑点", "%", "构建交易时允许的最大报价偏差。"],
  "risk.dailyActionLimit": ["每日动作上限", "次", "24 小时窗口内最多允许的真实动作数。"],
  "risk.minimumActionIntervalSeconds": ["真实动作最小间隔", "秒", "System Policy 可能把此值向上收紧。"],
  "runtime.autoSave": ["自动保存", "", "运行时固定开启 checkpoint 自动保存。"],
  "runtime.retainDecisionCount": ["保留决策数量", "条", "内存与 checkpoint 中保留的最近决策数。"],
  "runtime.retainOutcomeCount": ["保留结算结果数量", "条", "保留的最近奖励结算结果数。"],
  "runtime.retainFeedbackCount": ["保留反馈数量", "条", "保留的最近神经反馈记录数。"],
});

const BASIC_FIELDS = new Set([
  "universe.tokenBinding", "universe.tokenAddress", "perception.neuralDecisionIntervalSeconds",
  "perception.historyCandles", "learning.enabled", "learning.neuralMs", "learning.decoderThresholdHz",
  "reward.primaryHorizonSeconds", "reward.returnScale", "reward.minimumPulseStrength",
  "strategy.quantThreshold", "strategy.twapIntervalSeconds", "strategy.buyPercent", "strategy.burnPercent",
  "risk.liveTradingEnabled", "risk.capitalBudgetPercent", "risk.maxPoolParticipationPercent",
  "risk.maxBuyBnb", "risk.slippagePercent", "risk.dailyActionLimit",
  "risk.minimumActionIntervalSeconds", "runtime.autoSave", "runtime.retainDecisionCount",
]);

const state = {
  schema: null, activationModes: {}, systemPolicy: null, presets: [], flies: [], selectedId: null,
  detail: null, baseline: null, draft: null, editorMode: "basic", profileSection: "universe",
  workspace: "profile", inputErrors: new Map(), dirtyInputs: new Set(), lastSave: null,
  revisions: [], training: [], evaluations: [], cartridge: null, conflict: null, toastTimer: null,
};

class ApiRequestError extends Error {
  constructor(response, payload) {
    const error = payload?.error;
    super(typeof error === "string" ? error : error?.message || `HTTP ${response.status}`);
    this.name = "ApiRequestError";
    this.status = response.status;
    this.code = typeof error === "object" ? error.code : null;
    this.fields = typeof error === "object" && Array.isArray(error.fields) ? error.fields : [];
  }
}

async function api(path, options = {}) {
  const headers = options.body ? { "content-type": "application/json", ...options.headers } : options.headers;
  const response = await fetch(path, { ...options, headers });
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new ApiRequestError(response, payload);
  return payload;
}

function clone(value) { return structuredClone(value); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function same(left, right) { return canonical(left) === canonical(right); }
function formatDate(value) {
  if (!value) return "从未";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date);
}
function shortHash(value) { return value ? `${value.slice(0, 15)}…${value.slice(-6)}` : "—"; }
function humanState(value) {
  return ({ inactive: "未激活", ready: "已激活 · 就绪", running: "运行中", stopping: "停止中", faulted: "异常", completed: "已完成", failed: "失败", interrupted: "已中断" })[value] || value || "未训练";
}
function showMessage(message, error = false) {
  const node = $("#global-message");
  node.textContent = message;
  node.classList.toggle("error", error);
}
function toast(message, error = false) {
  const node = $("#fly-toast");
  clearTimeout(state.toastTimer);
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = false;
  state.toastTimer = setTimeout(() => { node.hidden = true; }, 5_000);
}
function buttonBusy(button, busy, label = "处理中…") {
  if (busy) {
    button.dataset.oldLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.oldLabel || button.textContent;
    button.disabled = false;
  }
}
function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function pathParts(path) { return path.replace(/^\/spec\//, "").split("/").filter(Boolean); }
function getPath(object, path) { return pathParts(path).reduce((value, key) => value?.[key], object); }
function setPath(object, path, value) {
  const parts = pathParts(path);
  let target = object;
  for (const key of parts.slice(0, -1)) target = target[key];
  target[parts.at(-1)] = clone(value);
}
function diffPaths(before, after, path = "/spec") {
  if (same(before, after)) return [];
  if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) || Array.isArray(after)) return [path];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => diffPaths(before[key], after[key], `${path}/${key}`));
}
function currentChanges() { return state.baseline && state.draft ? diffPaths(state.baseline, state.draft) : []; }
function hasUnsaved() { return currentChanges().length > 0 || state.dirtyInputs.size > 0; }

function highestActivation(paths) {
  const ranks = { hot: 0, "next-start": 1, "next-training-run": 2, "fork-required": 3 };
  return paths.map((path) => state.activationModes[path] || "hot").sort((a, b) => ranks[b] - ranks[a])[0] || "hot";
}
function activationCopy(mode) {
  return ({
    hot: ["立即生效", "保存后可直接使用，不要求停止当前运行。"],
    "next-start": ["下次启动生效", "活动果蝇运行中会保留旧 revision；停止后自动采用新配置。"],
    "next-training-run": ["下次训练生效", "当前训练保持冻结配置，新训练轮次采用此修改。"],
    "fork-required": ["需要分叉", "兼容性边界变化不能原地应用，应克隆为新个体。"],
  })[mode] || [mode, "由服务端决定生效时机。"];
}

function effectiveRisk(requested) {
  if (!requested || !state.systemPolicy) return requested;
  const policy = state.systemPolicy.risk;
  return {
    liveTradingEnabled: requested.liveTradingEnabled && policy.liveTradingAllowed,
    capitalBudgetPercent: Math.min(requested.capitalBudgetPercent, policy.maxCapitalBudgetPercent),
    maxPoolParticipationPercent: Math.min(requested.maxPoolParticipationPercent, policy.maxPoolParticipationPercent),
    maxBuyBnb: Number(requested.maxBuyBnb) <= Number(policy.maxBuyBnb) ? requested.maxBuyBnb : policy.maxBuyBnb,
    slippagePercent: requested.slippagePercent,
    dailyActionLimit: Math.min(requested.dailyActionLimit, policy.maxDailyActionLimit),
    minimumActionIntervalSeconds: Math.max(requested.minimumActionIntervalSeconds, policy.minActionIntervalSeconds),
  };
}

function renderRisk() {
  const root = $("#effective-risk");
  root.replaceChildren();
  const requested = state.draft?.risk;
  if (!requested) {
    root.append(create("p", "empty", "选择一只果蝇后显示。"));
    return;
  }
  const effective = effectiveRisk(requested);
  for (const [key, value] of Object.entries(requested)) {
    const row = create("div", "risk-row");
    row.append(create("span", "", FIELD_META[`risk.${key}`]?.[0] || key));
    row.append(create("code", "", String(value)));
    row.append(create("span", "risk-arrow", "→"));
    const output = create("code", same(value, effective[key]) ? "" : "restricted", String(effective[key]));
    output.title = same(value, effective[key]) ? "请求值等于生效值" : "已被 System Policy 收紧";
    row.append(output);
    root.append(row);
  }
}

function renderChangeSummary() {
  const changes = currentChanges();
  const shown = changes.length ? changes : state.lastSave?.changedPaths || [];
  const root = $("#change-paths");
  root.replaceChildren();
  if (!shown.length) root.append(create("p", "empty", "没有字段变更。"));
  else for (const path of shown) root.append(create("code", "", path));
  const card = $("#activation-summary");
  card.replaceChildren();
  const mode = changes.length ? highestActivation(changes) : state.lastSave?.activationMode;
  if (!mode) {
    card.append(create("strong", "", "无待保存修改"), create("p", "", "编辑字段后显示生效时机和停止要求。"));
  } else {
    const [title, copy] = activationCopy(mode);
    card.append(create("strong", "", `${changes.length ? "预计" : "上次保存"}：${title}`), create("p", "", copy));
    if (state.lastSave?.pendingActivation) card.append(create("p", "", "已排队：当前运行停止并保存 checkpoint 后自动采用。"));
  }
  const unsaved = hasUnsaved();
  $("#save-profile").disabled = !unsaved || state.inputErrors.size > 0;
  $("#reset-profile").disabled = !unsaved;
  const status = $("#unsaved-state");
  status.textContent = state.inputErrors.size ? `有 ${state.inputErrors.size} 个字段需要修正` : changes.length ? `${changes.length} 项修改尚未保存` : "没有未保存修改";
  status.classList.toggle("changed", unsaved);
  renderRisk();
}

function renderRoster() {
  const root = $("#fly-list");
  const query = $("#fly-search").value.trim().toLowerCase();
  const flies = state.flies.filter((fly) => !query || `${fly.name} ${fly.tags.join(" ")}`.toLowerCase().includes(query));
  root.replaceChildren();
  root.setAttribute("aria-busy", "false");
  $("#fly-count").textContent = `${state.flies.length} 只`;
  $("#fly-empty").hidden = state.flies.length !== 0;
  root.hidden = state.flies.length === 0;
  for (const fly of flies) {
    const button = create("button", `fly-list-item${fly.id === state.selectedId ? " active" : ""}`);
    button.type = "button";
    button.dataset.flyId = fly.id;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(fly.id === state.selectedId));
    const top = create("div", "fly-item-top");
    top.append(create("strong", "", fly.name), create("span", `state-badge ${fly.active ? "" : "neutral"}`, fly.active ? humanState(fly.runtimeState) : "未激活"));
    const meta = create("div", "fly-item-meta");
    meta.append(create("span", "", `REV ${fly.currentRevision}`), create("small", "", shortHash(fly.profileHash)));
    const foot = create("div", "fly-item-foot");
    foot.append(create("span", "", fly.trainingStatus ? `训练：${humanState(fly.trainingStatus)}` : "尚无训练"), create("small", "", formatDate(fly.latestTrainingAt)));
    button.append(top, meta, foot);
    button.addEventListener("click", () => selectFly(fly.id));
    root.append(button);
  }
  if (state.flies.length && flies.length === 0) root.append(create("p", "empty", "没有匹配的果蝇。"));
}

function currentSummary() { return state.flies.find((fly) => fly.id === state.selectedId) || null; }
function renderDetailHeader() {
  const detail = state.detail;
  const summary = currentSummary();
  if (!detail) return;
  const fly = detail.fly;
  $("#selected-fly-name").textContent = fly.name;
  $("#selected-fly-description").textContent = fly.description || "暂无说明";
  const status = $("#selected-fly-status");
  status.textContent = summary?.active ? humanState(summary.runtimeState) : "未激活";
  status.className = `state-badge ${summary?.active ? "" : "neutral"}`;
  const training = summary?.trainingStatus || detail.stats.latestTraining?.status;
  $("#selected-fly-training").textContent = training ? `训练 · ${humanState(training)}` : "未训练";
  $("#stat-revision").textContent = String(fly.currentRevision);
  $("#stat-hash").textContent = shortHash(fly.profile.metadata.profileHash);
  $("#stat-hash").title = fly.profile.metadata.profileHash;
  $("#stat-checkpoint").textContent = fly.activeCheckpointId || "尚无";
  $("#stat-training").textContent = formatDate(summary?.latestTrainingAt || detail.stats.latestTraining?.startedAt);
  $("#activate-fly").disabled = Boolean(summary?.active);
  $("#activate-fly").textContent = summary?.active ? "当前活动果蝇" : "设为活动果蝇";
  $("#archive-fly").disabled = Boolean(summary?.active);
}

function fieldSchema(section, key) { return state.schema.$defs.spec.properties[section].properties[key]; }
function schemaType(schema, value) {
  if (schema.type) return schema.type;
  if (schema.anyOf) return value === null ? "string" : schema.anyOf.find((item) => item.type !== "null")?.type || "string";
  return "string";
}
function fieldRange(schema) {
  const parts = [];
  if (schema.minimum !== undefined) parts.push(`最小 ${schema.minimum}`);
  if (schema.maximum !== undefined) parts.push(`最大 ${schema.maximum}`);
  if (schema.minItems !== undefined || schema.maxItems !== undefined) parts.push(`${schema.minItems || 0}–${schema.maxItems || "∞"} 项`);
  parts.push(`默认 ${Array.isArray(schema.default) ? schema.default.join(", ") : String(schema.default)}`);
  return parts.join(" · ");
}
function parseField(schema, raw, path) {
  const type = schemaType(schema, getPath(state.draft, path));
  let value;
  if (type === "boolean") value = raw === "true";
  else if (type === "integer" || type === "number") {
    if (raw.trim() === "") throw new Error("该字段不能为空");
    value = Number(raw);
    if (!Number.isFinite(value)) throw new Error("必须是有效数字");
    if (type === "integer" && !Number.isInteger(value)) throw new Error("必须是整数");
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`不得小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`不得大于 ${schema.maximum}`);
  } else if (type === "array") {
    value = raw.split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item));
    if (value.length < schema.minItems || value.length > schema.maxItems) throw new Error(`需要 ${schema.minItems}–${schema.maxItems} 个数字`);
    if (new Set(value).size !== value.length || value.some((item, index) => index && item <= value[index - 1])) throw new Error("必须是严格递增且不重复的数字");
    if (value.some((item) => !Number.isInteger(item) || item < schema.items.minimum || item > schema.items.maximum)) throw new Error(`每项必须是 ${schema.items.minimum}–${schema.items.maximum} 的整数`);
  } else {
    value = raw.trim();
    if (path === "/spec/universe/tokenAddress" && value === "") value = null;
    if (schema.pattern && value !== null && !new RegExp(schema.pattern).test(value)) throw new Error("格式不符合要求");
  }
  return value;
}

function renderProfileFields() {
  const root = $("#profile-fields");
  root.replaceChildren();
  if (!state.draft || !state.schema) return;
  const section = state.profileSection;
  const properties = state.schema.$defs.spec.properties[section].properties;
  const visible = Object.keys(properties).filter((key) => state.editorMode === "advanced" || BASIC_FIELDS.has(`${section}.${key}`));
  if (!visible.length) {
    const note = create("p", "panel-intro", `${SECTION_LABELS[section]}的详细字段只在高级模式显示。`);
    root.append(note);
  }
  for (const key of visible) {
    const schema = properties[key];
    const path = `/spec/${section}/${key}`;
    const [labelText, unit, help] = FIELD_META[`${section}.${key}`] || [key, "", "结构化 Profile 字段。"];
    const wrapper = create("div", `profile-field${schema.type === "array" ? " field-wide" : ""}${state.inputErrors.has(path) ? " invalid" : ""}`);
    wrapper.dataset.path = path;
    const id = `field-${section}-${key}`;
    const helpId = `${id}-help`;
    const errorId = `${id}-error`;
    const label = create("label"); label.htmlFor = id;
    label.append(create("strong", "", labelText), create("span", "", unit));
    const value = state.draft[section][key];
    let input;
    if (schema.enum || schema.type === "boolean") {
      input = create("select");
      const choices = schema.enum || [true, false];
      for (const choice of choices) {
        const option = create("option", "", typeof choice === "boolean" ? (choice ? "开启" : "关闭") : choice === "device-selected" ? "每次由设备选择" : choice === "fixed" ? "固定代币" : String(choice));
        option.value = String(choice); option.selected = same(choice, value); input.append(option);
      }
    } else {
      input = create("input");
      const type = schemaType(schema, value);
      input.type = type === "number" || type === "integer" || key === "maxBuyBnb" ? "number" : "text";
      if (input.type === "number") {
        if (schema.minimum !== undefined) input.min = String(schema.minimum);
        if (schema.maximum !== undefined) input.max = String(schema.maximum);
        input.step = type === "integer" ? "1" : String(schema.multipleOf || "any");
      }
      input.value = Array.isArray(value) ? value.join(", ") : value ?? "";
    }
    input.id = id;
    input.name = key;
    input.dataset.profilePath = path;
    input.setAttribute("aria-describedby", `${helpId} ${errorId}`);
    if (schema.const !== undefined) input.readOnly = true;
    if (path === "/spec/universe/tokenAddress" && state.draft.universe.tokenBinding !== "fixed") input.disabled = true;
    const helpNode = create("p", "field-help"); helpNode.id = helpId;
    helpNode.append(document.createTextNode(`${help} `), create("code", "", fieldRange(schema)));
    const errorNode = create("p", "input-error", state.inputErrors.get(path) || ""); errorNode.id = errorId;
    input.addEventListener("input", handleProfileInput);
    input.addEventListener("change", handleProfileInput);
    wrapper.append(label, input, helpNode, errorNode);
    root.append(wrapper);
  }
  root.setAttribute("aria-labelledby", `profile-tab-${section}`);
}

function handleProfileInput(event) {
  const input = event.currentTarget;
  const path = input.dataset.profilePath;
  const [, , section, key] = path.split("/");
  const schema = fieldSchema(section, key);
  try {
    const value = parseField(schema, input.value, path);
    setPath(state.draft, path, value);
    state.inputErrors.delete(path);
    state.dirtyInputs.delete(path);
    input.setAttribute("aria-invalid", "false");
    input.closest(".profile-field").classList.remove("invalid");
    $(`#${input.id}-error`).textContent = "";
    if (path === "/spec/universe/tokenBinding") renderProfileFields();
  } catch (error) {
    state.inputErrors.set(path, error.message);
    state.dirtyInputs.add(path);
    input.setAttribute("aria-invalid", "true");
    input.closest(".profile-field").classList.add("invalid");
    $(`#${input.id}-error`).textContent = error.message;
  }
  state.lastSave = null;
  renderChangeSummary();
}

function renderWorkspace() {
  for (const button of $$(".workspace-tab")) {
    const active = button.dataset.workspace === state.workspace;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    $(`#workspace-${button.dataset.workspace}`).hidden = !active;
  }
}

async function loadRoster(preferredId = state.selectedId) {
  const payload = await api("/api/flies");
  state.flies = payload.items;
  renderRoster();
  if (preferredId && state.flies.some((fly) => fly.id === preferredId)) await loadFly(preferredId, { preserveWorkspace: true });
  else if (!state.selectedId && state.flies[0]) await loadFly(state.flies[0].id);
}

async function selectFly(id) {
  if (id === state.selectedId) return;
  if (hasUnsaved() && !window.confirm("当前 Profile 有未保存修改。放弃修改并切换果蝇吗？")) return;
  await loadFly(id);
}

async function loadFly(id, { preserveWorkspace = false } = {}) {
  showMessage("正在读取果蝇 Profile…");
  try {
    const detail = await api(`/api/flies/${id}`);
    state.selectedId = id;
    state.detail = detail;
    state.baseline = clone(detail.fly.profile.spec);
    state.draft = clone(detail.fly.profile.spec);
    state.inputErrors.clear(); state.dirtyInputs.clear(); state.lastSave = null;
    state.revisions = []; state.training = []; state.evaluations = [];
    if (!preserveWorkspace) state.workspace = "profile";
    $("#fly-placeholder").hidden = true;
    $("#fly-detail").hidden = false;
    renderRoster(); renderDetailHeader(); renderWorkspace(); renderProfileFields(); renderChangeSummary();
    showMessage(`已载入 ${detail.fly.name} · revision ${detail.fly.currentRevision}`);
    if (state.workspace !== "profile") await loadWorkspaceData(state.workspace);
  } catch (error) { showMessage(`读取失败：${error.message}`, true); toast(error.message, true); }
}

function renderPresetOptions() {
  const select = $("#create-preset");
  select.replaceChildren();
  for (const preset of state.presets) {
    const option = create("option", "", preset.name);
    option.value = preset.id;
    select.append(option);
  }
  renderPresetHelp();
}
function renderPresetHelp() {
  const preset = state.presets.find((item) => item.id === $("#create-preset").value);
  $("#create-preset-help").textContent = preset?.description || "选择一个 Profile 起点。";
}
function openCreate() {
  $("#create-form").reset(); renderPresetOptions(); $("#create-error").textContent = "";
  $("#create-dialog").showModal(); setTimeout(() => $("#create-name").focus(), 0);
}
function openClone() {
  if (!state.detail) return;
  $("#clone-form").reset();
  $("#clone-name").value = `${state.detail.fly.name}（克隆）`;
  $("#clone-checkpoint").disabled = !state.detail.fly.activeCheckpointId;
  $("#clone-error").textContent = "";
  $("#clone-dialog").showModal(); setTimeout(() => $("#clone-name").focus(), 0);
}
function parseTags(value) { return [...new Set(value.split(/[,，]/).map((item) => item.trim()).filter(Boolean))]; }

async function createFly(event) {
  event.preventDefault();
  const button = $("#submit-create"); buttonBusy(button, true, "正在创建…");
  try {
    const form = new FormData(event.currentTarget);
    const result = await api("/api/flies", { method: "POST", body: JSON.stringify({
      name: String(form.get("name") || "").trim(), description: String(form.get("description") || "").trim(),
      tags: parseTags(String(form.get("tags") || "")), presetId: String(form.get("presetId") || "balanced-v1"),
    }) });
    $("#create-dialog").close();
    state.selectedId = null;
    await loadRoster(result.fly.id);
    toast(`已创建 ${result.fly.name}`);
  } catch (error) { $("#create-error").textContent = error.message; }
  finally { buttonBusy(button, false); }
}

async function cloneFly(event) {
  event.preventDefault();
  const button = $("#submit-clone"); buttonBusy(button, true, "正在克隆…");
  try {
    const form = new FormData(event.currentTarget);
    const result = await api(`/api/flies/${state.selectedId}/clone`, { method: "POST", body: JSON.stringify({
      name: String(form.get("name") || "").trim(), copyCheckpoint: form.get("copyCheckpoint") === "on",
    }) });
    $("#clone-dialog").close(); state.selectedId = null;
    await loadRoster(result.fly.id); toast(`克隆已创建：${result.fly.name}`);
  } catch (error) { $("#clone-error").textContent = error.message; }
  finally { buttonBusy(button, false); }
}

async function activateFly() {
  if (!state.detail || hasUnsaved()) { toast("请先保存或放弃 Profile 修改。", true); return; }
  const button = $("#activate-fly"); buttonBusy(button, true, "正在激活…");
  try {
    await api(`/api/flies/${state.selectedId}/activate`, { method: "POST", body: JSON.stringify({ expectedRevision: state.detail.fly.currentRevision }) });
    await loadRoster(state.selectedId); toast("已设为活动果蝇。现在可以启动训练或返回运行台。");
  } catch (error) { toast(error.message, true); }
  finally { buttonBusy(button, false); renderDetailHeader(); }
}

async function archiveFly() {
  if (!state.detail || !window.confirm(`归档“${state.detail.fly.name}”？历史和 checkpoint 会保留。`)) return;
  try {
    await api(`/api/flies/${state.selectedId}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: state.detail.fly.currentRevision, archived: true }) });
    state.selectedId = null; state.detail = null; state.baseline = null; state.draft = null;
    $("#fly-detail").hidden = true; $("#fly-placeholder").hidden = false;
    await loadRoster(); toast("果蝇已归档。数据仍保留在本机。");
  } catch (error) { toast(error.message, true); }
}

function applyServerErrors(error) {
  state.inputErrors.clear();
  for (const field of error.fields || []) {
    const path = field.path.startsWith("/spec/") ? field.path : `/spec${field.path}`;
    state.inputErrors.set(path, field.reason);
  }
  renderProfileFields(); renderChangeSummary();
}
function showConflict() {
  const dialog = $("#conflict-dialog");
  $("#conflict-server-revision").textContent = state.conflict?.serverRevision ? `revision ${state.conflict.serverRevision}` : "更新的 revision";
  const root = $("#conflict-paths"); root.replaceChildren();
  for (const path of state.conflict?.paths || []) root.append(create("code", "", path));
  dialog.showModal();
}

async function saveProfile(event) {
  event.preventDefault();
  if (state.inputErrors.size || !state.detail || !hasUnsaved()) return;
  const button = $("#save-profile"); buttonBusy(button, true, "正在保存…");
  $("#profile-form-error").textContent = "";
  try {
    const result = await api(`/api/flies/${state.selectedId}/profile`, { method: "PUT", body: JSON.stringify({
      expectedRevision: state.detail.fly.currentRevision, spec: state.draft,
    }) });
    state.lastSave = result;
    state.detail.fly = result.fly;
    state.baseline = clone(result.fly.profile.spec); state.draft = clone(result.fly.profile.spec);
    state.inputErrors.clear(); state.dirtyInputs.clear();
    const payload = await api("/api/flies"); state.flies = payload.items;
    renderRoster(); renderDetailHeader(); renderProfileFields(); renderChangeSummary();
    toast(result.pendingActivation ? "已保存新 revision；当前运行停止后自动生效。" : "Profile 新 revision 已保存。");
  } catch (error) {
    if (error.code === "PROFILE_REVISION_CONFLICT") {
      state.conflict = { paths: currentChanges(), draft: clone(state.draft), baseline: clone(state.baseline), serverRevision: Number(error.fields?.[0]?.reason?.match(/\d+/)?.[0]) || null };
      showConflict();
    } else {
      applyServerErrors(error);
      $("#profile-form-error").textContent = error.message;
      toast(error.message, true);
    }
  } finally { buttonBusy(button, false); renderChangeSummary(); }
}

async function reapplyConflict() {
  const button = $("#reapply-conflict"); buttonBusy(button, true, "正在重新应用…");
  try {
    const latest = await api(`/api/flies/${state.selectedId}`);
    const draft = clone(latest.fly.profile.spec);
    for (const path of state.conflict.paths) setPath(draft, path, getPath(state.conflict.draft, path));
    state.detail = latest; state.baseline = clone(latest.fly.profile.spec); state.draft = draft;
    state.conflict = null; state.inputErrors.clear(); state.dirtyInputs.clear();
    $("#conflict-dialog").close();
    renderDetailHeader(); renderProfileFields(); renderChangeSummary();
    toast("已把本地修改重新应用到服务器新版本；请检查后再次保存。");
  } catch (error) { toast(error.message, true); }
  finally { buttonBusy(button, false); }
}

function resetProfile() {
  if (!state.baseline) return;
  state.draft = clone(state.baseline); state.inputErrors.clear(); state.dirtyInputs.clear(); state.lastSave = null;
  renderProfileFields(); renderChangeSummary(); toast("已放弃未保存修改。");
}

function renderRevisions() {
  const body = $("#revision-body"); body.replaceChildren();
  if (!state.revisions.length) {
    const row = create("tr"); const cell = create("td", "empty", "暂无 revision"); cell.colSpan = 4; row.append(cell); body.append(row); return;
  }
  for (const revision of state.revisions) {
    const row = create("tr");
    row.append(create("td", "", `REV ${revision.revision}`), create("td", "", formatDate(revision.updatedAt)), create("td", "", shortHash(revision.profileHash)));
    const action = create("td");
    const inspect = create("button", "button ghost", "查看差异"); inspect.type = "button"; inspect.addEventListener("click", () => inspectRevision(revision.revision));
    action.append(inspect);
    if (revision.revision !== state.detail.fly.currentRevision) {
      const rollback = create("button", "button secondary", "回滚到此版"); rollback.type = "button"; rollback.addEventListener("click", () => rollbackRevision(revision.revision)); action.append(rollback);
    }
    row.append(action); body.append(row);
  }
}
async function loadHistory() {
  const payload = await api(`/api/flies/${state.selectedId}/revisions`);
  state.revisions = payload.items; renderRevisions();
}
async function inspectRevision(revision) {
  try {
    const document = await api(`/api/flies/${state.selectedId}/revisions/${revision}`);
    const paths = diffPaths(document.spec, state.baseline);
    const root = $("#revision-diff"); root.replaceChildren(create("strong", "", `REV ${revision} 与当前版本`));
    root.append(create("p", "", paths.length ? `${paths.length} 个字段不同` : "内容与当前版本一致"));
    if (paths.length) { const list = create("ul"); for (const path of paths) list.append(create("li", "", path)); root.append(list); }
  } catch (error) { toast(error.message, true); }
}
async function rollbackRevision(revision) {
  if (!window.confirm(`回滚到 revision ${revision}？系统会把其内容复制成新的 revision。`)) return;
  try {
    const result = await api(`/api/flies/${state.selectedId}/rollback`, { method: "POST", body: JSON.stringify({ expectedRevision: state.detail.fly.currentRevision, revision }) });
    state.lastSave = result; await loadRoster(state.selectedId); await loadHistory(); toast(`已创建回滚 revision ${result.revision}。`);
  } catch (error) { toast(error.message, true); }
}

function briefMetrics(value) {
  if (!value || typeof value !== "object") return "—";
  const entries = Object.entries(value).filter(([, item]) => ["string", "number", "boolean"].includes(typeof item)).slice(0, 3);
  return entries.length ? entries.map(([key, item]) => `${key}: ${item}`).join(" · ") : "记录已保存";
}
function renderTraining() {
  const summary = currentSummary();
  const ready = summary?.active && summary.runtimeState === "ready";
  const badge = $("#training-readiness"); badge.textContent = ready ? "已激活 · 可训练" : summary?.active ? `当前 ${humanState(summary.runtimeState)}` : "请先激活"; badge.className = `state-badge ${ready ? "" : "warn"}`;
  const body = $("#training-body"); body.replaceChildren();
  if (!state.training.length) { const row = create("tr"); const cell = create("td", "empty", "尚无训练记录"); cell.colSpan = 5; row.append(cell); body.append(row); }
  for (const run of state.training) {
    const row = create("tr"); row.append(create("td", "", run.mode), create("td", "", humanState(run.status)), create("td", "", formatDate(run.startedAt)), create("td", "", `REV ${run.profileRevision}`), create("td", "", briefMetrics(run.summary?.metrics || run.summary)));
    body.append(row);
  }
  const running = state.training.find((run) => run.status === "running" && run.mode === "live-observation");
  $("#stop-training").disabled = !running;
  $("#stop-training").dataset.runId = running?.id || "";
  const evaluationBody = $("#evaluation-body"); evaluationBody.replaceChildren();
  if (!state.evaluations.length) { const row = create("tr"); const cell = create("td", "empty", "尚无评估记录"); cell.colSpan = 4; row.append(cell); evaluationBody.append(row); }
  for (const evaluation of state.evaluations) {
    const row = create("tr"); row.append(create("td", "", formatDate(evaluation.createdAt || evaluation.startedAt)), create("td", "", evaluation.dataset?.relativePath || evaluation.datasetPath || "本地数据集"), create("td", "", `REV ${evaluation.profileRevision}`), create("td", "", briefMetrics(evaluation.metrics || evaluation.summary)));
    evaluationBody.append(row);
  }
}
async function loadTraining() {
  const [training, evaluations] = await Promise.all([api(`/api/flies/${state.selectedId}/training-runs?limit=50&offset=0`), api(`/api/flies/${state.selectedId}/evaluations?limit=50&offset=0`)]);
  state.training = training.items; state.evaluations = evaluations.items; renderTraining();
}
async function submitOperation(form, path, body, button, label) {
  buttonBusy(button, true, label); $("#training-error").textContent = "";
  try { await api(path, { method: "POST", body: JSON.stringify(body) }); await loadRoster(state.selectedId); await loadTraining(); toast("操作已完成并写入本机审计记录。"); form.reset(); }
  catch (error) { $("#training-error").textContent = error.message; toast(error.message, true); }
  finally { buttonBusy(button, false); }
}
async function stopTraining() {
  const button = $("#stop-training"); const runId = button.dataset.runId; if (!runId) return;
  buttonBusy(button, true, "正在停止…");
  try { await api(`/api/training-runs/${runId}/stop`, { method: "POST", body: "{}" }); await loadRoster(state.selectedId); await loadTraining(); toast("训练已停止，checkpoint 已保存。"); }
  catch (error) { toast(error.message, true); }
  finally { buttonBusy(button, false); renderTraining(); }
}

function renderCartridge() {
  const status = state.cartridge;
  if (!status) return;
  $("#cartridge-format").textContent = `FlyCartridge v${status.localFormatVersion || 3}（本地）`;
  $("#cartridge-source").textContent = status.active?.source || "默认本地大脑";
  $("#cartridge-card-id").textContent = status.active?.cardId || "尚未安装卡带";
  $("#cartridge-v4").textContent = status.localFormatVersion === 4
    ? "已接入 · Profile 与学习特质独立校验"
    : "未接入 · 拒绝未知格式";
  const reasons = [];
  if (status.simulation === "running") reasons.push("运行时正在工作：导出前必须暂停并保存 checkpoint。");
  if (!status.lastExport) reasons.push("尚无已验证的最新导出产物。");
  if (status.busy) reasons.push("另一项卡带操作正在进行。");
  for (const item of status.lastExport?.publishability?.reasons || []) {
    reasons.push(`${item.code}：${item.message}`);
  }
  if (status.lastExport && !status.lastExport.publishability?.publishableToRegistryV3) {
    reasons.push("v4 尚未获准直接写入 Registry V3；本机不会发起钱包签名。");
  }
  reasons.push("钱包、交易历史和本机运行记录不会进入卡带。");
  $("#publishability-title").textContent = status.lastExport?.publishability?.localValid
    ? "本地验证通过 · 链上发布受限" : "当前不可直接发布";
  const list = $("#publishability-reasons"); list.replaceChildren(); for (const reason of reasons) list.append(create("li", "", reason));
}
async function loadCartridge() { state.cartridge = await api("/api/cartridge/status"); renderCartridge(); }
async function loadWorkspaceData(workspace) {
  if (!state.selectedId) return;
  try {
    if (workspace === "history") await loadHistory();
    if (workspace === "training") await loadTraining();
    if (workspace === "cartridge") await loadCartridge();
  } catch (error) { toast(error.message, true); }
}

function bindRovingTabs(selector, callback) {
  const tabs = $$(selector);
  for (const tab of tabs) tab.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(tab);
    let next = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault(); tabs[next].focus(); callback(tabs[next]);
  });
}

function bindEvents() {
  $("#create-fly").addEventListener("click", openCreate); $("#empty-create-fly").addEventListener("click", openCreate);
  $("#clone-fly").addEventListener("click", openClone); $("#activate-fly").addEventListener("click", activateFly); $("#archive-fly").addEventListener("click", archiveFly);
  $("#create-form").addEventListener("submit", createFly); $("#clone-form").addEventListener("submit", cloneFly); $("#profile-form").addEventListener("submit", saveProfile);
  $("#create-preset").addEventListener("change", renderPresetHelp); $("#reset-profile").addEventListener("click", resetProfile);
  $("#reapply-conflict").addEventListener("click", reapplyConflict); $("#fly-search").addEventListener("input", renderRoster);
  $("#refresh-flies").addEventListener("click", async () => {
    if (hasUnsaved()) { toast("存在未保存修改，刷新已取消。", true); return; }
    try { await loadRoster(state.selectedId); toast("状态已刷新。"); } catch (error) { toast(error.message, true); }
  });
  for (const button of $$('[data-close-dialog]')) button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close());
  for (const button of $$(".workspace-tab")) button.addEventListener("click", async () => { state.workspace = button.dataset.workspace; renderWorkspace(); await loadWorkspaceData(state.workspace); });
  for (const button of $$("#profile-tabs button")) button.addEventListener("click", () => {
    state.profileSection = button.dataset.section;
    for (const tab of $$("#profile-tabs button")) { const active = tab === button; tab.classList.toggle("active", active); tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; }
    renderProfileFields();
  });
  for (const button of $$(".mode-switch button")) button.addEventListener("click", () => {
    state.editorMode = button.id === "mode-basic" ? "basic" : "advanced";
    for (const mode of $$(".mode-switch button")) { const active = mode === button; mode.classList.toggle("active", active); mode.setAttribute("aria-pressed", String(active)); }
    renderProfileFields();
  });
  bindRovingTabs("#profile-tabs button", (tab) => tab.click());
  bindRovingTabs(".workspace-tab", (tab) => tab.click());
  $("#refresh-history").addEventListener("click", loadHistory);
  $("#live-training-form").addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); submitOperation(event.currentTarget, `/api/flies/${state.selectedId}/training-runs`, { mode: "live-observation", tokenAddress: String(form.get("tokenAddress") || "").trim(), initialQuote: Number(form.get("initialQuote")), initialToken: Number(form.get("initialToken")) }, $("#start-live-training"), "正在启动…"); });
  $("#replay-training-form").addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); submitOperation(event.currentTarget, `/api/flies/${state.selectedId}/training-runs`, { mode: "deterministic-replay", datasetPath: String(form.get("datasetPath") || "").trim() }, $("#start-replay-training"), "正在回放…"); });
  $("#evaluation-form").addEventListener("submit", (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); submitOperation(event.currentTarget, `/api/flies/${state.selectedId}/evaluations`, { datasetPath: String(form.get("datasetPath") || "").trim() }, $("#start-evaluation"), "正在评估…"); });
  $("#stop-training").addEventListener("click", stopTraining);
  window.addEventListener("beforeunload", (event) => { if (hasUnsaved()) event.preventDefault(); });
}

async function init() {
  bindEvents();
  try {
    const [schemaInfo, presets, flies] = await Promise.all([api("/api/fly-profile/schema"), api("/api/fly-profile/presets"), api("/api/flies")]);
    state.schema = schemaInfo.schema; state.activationModes = schemaInfo.activationModes; state.systemPolicy = schemaInfo.systemPolicy;
    state.presets = presets.items; state.flies = flies.items;
    renderPresetOptions(); renderRoster();
    if (state.flies[0]) await loadFly(state.flies[0].id);
    else showMessage("本机还没有果蝇。创建第一只个体后即可编辑 Profile。");
  } catch (error) {
    $("#fly-list").setAttribute("aria-busy", "false");
    showMessage(`管理中心初始化失败：${error.message}`, true); toast(error.message, true);
  }
}

init();
