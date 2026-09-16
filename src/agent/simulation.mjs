import { randomUUID } from "node:crypto";
import { createFlyBrain } from "../brain/index.mjs";
import { MarketObserver } from "../market/observer.mjs";
import { deriveHybridFeatures, HybridV2Lab } from "../strategy/hybrid-v2.mjs";
import { SIMULATION_DEFAULTS } from "../config.mjs";

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value, digits = 8) => Number(finite(value).toFixed(digits));

const REASON_ZH = {
  "market-data-unhealthy": "市场数据未达到健康标准",
  "quant-below-threshold": "量化机会分未达到 0.62",
  "buy-trend-not-falling": "回购条件要求 1/5 分钟持续下跌并靠近低点",
  "price-high": "当前价格位置过高",
  "price-low": "当前位置不足以支持卖出/销毁",
  "brain-hold": "果蝇脑未产生动作提案",
  "model-disagreement": "果蝇脑与量化方向不一致",
  interval: "动态最小间隔尚未结束",
  "frequency-quota": "当前滚动窗口动作容量已用尽",
  "no-gas": "模拟 Gas 余额不足",
  "no-quote": "报价资产余额不足",
  "no-token": "代币余额不足",
  "capital-budget": "单次资金预算不足",
  "missing-liquidity": "缺少有效池储备",
  "price-impact": "AMM 冲击后输出无效",
};

function emptyState() {
  return {
    status: "idle",
    sessionId: null,
    token: null,
    startedAt: null,
    updatedAt: null,
    latestDecision: null,
    latestBrainMotorEvent: null,
    events: [],
    trades: [],
    liveProposals: [],
  };
}

export class SimulationRuntime {
  constructor({ store = null } = {}) {
    this.store = store;
    this.state = emptyState();
    this.timer = null;
    this.brain = null;
    this.observer = null;
    this.hybrid = null;
    this.config = null;
  }

  async start({ tokenAddress, metadata = null, initialQuote, initialToken } = {}) {
    this.stop();
    const quote = Math.max(0.001, finite(initialQuote, SIMULATION_DEFAULTS.initialQuote));
    const token = Math.max(1, finite(initialToken, SIMULATION_DEFAULTS.initialToken));
    this.observer = new MarketObserver({ tokenAddress, initialPrice: metadata?.price, liquidityQuote: metadata?.liquidityQuote });
    this.brain = createFlyBrain({
      seed: tokenAddress.toLowerCase(), buyThreshold: 14, burnThreshold: 14,
      quietThresholdScale: 1, activeThresholdScale: 0.85, quietRelaxFactor: 0.8,
      quietPatienceMinutes: 1, activeMinIntervalSeconds: 5, quietMinIntervalSeconds: 30,
      refractorySeconds: 1, starveSeconds: 30, outcomeWindowSeconds: 60, positionWindowSeconds: 300,
    });
    this.hybrid = new HybridV2Lab(null, {
      initialQuote: quote, initialToken: token, initialBnb: 0.05,
      buyPercent: 2, burnPercent: 1, twapIntervalSeconds: 300,
    });
    this.config = {
      buyPercent: 2, burnPercent: 1,
      fullFeePercent: SIMULATION_DEFAULTS.feePercent,
      fullGasBnb: 0.00003, fullThresholdHz: 2,
    };

    // 原大脑先吃完同一段预热行情，但预热动作不进入任何账户台账。
    for (const candle of this.observer.candles) {
      this.brain.step({ now: candle.time, price: candle.close, volumeRatio: 1, volume5m: candle.volume * 60, quoteBalance: quote, tokenBalance: token });
    }

    this.state = {
      ...emptyState(), status: "running", sessionId: randomUUID(),
      token: {
        address: tokenAddress, symbol: metadata?.symbol || "TOKEN", name: metadata?.name || "离线模拟代币",
        decimals: metadata?.decimals ?? 18,
        marketSource: metadata?.flap ? `Flap Portal · ${metadata.flap.statusName}` : metadata?.price > 0 ? `PancakeSwap V2 ${metadata.quoteSymbol}` : "CA 确定性合成行情",
        pair: metadata?.pair || null,
      },
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this.addEvent("system", "Hybrid V2 运行时已启动", "120 个预热样本 → 果蝇脑提案 → 原版量化闸门 → 四账户影子执行 → SQLite 审计。");
    this.tick();
    this.timer = setInterval(() => this.tick(), SIMULATION_DEFAULTS.tickMs);
    return this.snapshot();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.state.status === "running") {
      this.state.status = "stopped";
      this.state.updatedAt = new Date().toISOString();
      this.addEvent("system", "运行时已暂停", "大脑、Hybrid 四账户与审计台账状态保留。");
      this.persistSession();
    }
    return this.snapshot();
  }

  reset() {
    this.stop();
    this.brain = null;
    this.observer = null;
    this.hybrid = null;
    this.config = null;
    this.state = emptyState();
    return this.snapshot();
  }

  tick() {
    if (this.state.status !== "running" || !this.brain || !this.hybrid || !this.observer) return;
    const observation = this.observer.advance();
    const market = this.observer.marketSnapshot();
    const flow = this.observer.flowSnapshot();
    const token = this.observer.tokenSnapshot(this.state.token);
    const primary = this.hybrid.state.accounts.hybrid;
    const brainDecision = this.brain.step({
      now: observation.at, price: observation.close, volumeRatio: market.volumeRatio,
      volume5m: flow.windows.m5.buyVolume + flow.windows.m5.sellVolume,
      quoteBalance: primary.quote, tokenBalance: primary.token,
    });
    const brainSide = brainDecision.action === "buy" ? "BUY" : brainDecision.action === "burn" ? "SELL" : "HOLD";
    const neural = {
      side: brainSide,
      difference_hz: brainSide === "HOLD" ? brainDecision.membrane / 2 : Math.sign(brainDecision.action === "buy" ? 1 : -1) * Math.max(2, Math.abs(brainDecision.membrane) / 2),
      gate_spikes: this.brain.snapshot().kc.activeCount,
      source: "preserved-fly-brain-adapter",
    };
    const features = deriveHybridFeatures({
      candles: this.observer.candles, market, flow, token,
      now: observation.at, updatedAt: new Date(observation.at).toISOString(),
    });
    const decision = this.hybrid.observe({ neural, features, market: { at: observation.at }, config: this.config });
    decision.flyBrain = brainDecision;
    const execution = decision.executions.hybrid;
    this.state.latestDecision = decision;
    if (decision.actions.brain.action !== "HOLD") {
      this.state.latestBrainMotorEvent = {
        key: decision.at,
        at: decision.at,
        action: decision.actions.brain.action === "SELL" ? "BURN" : decision.actions.brain.action,
        source: "brain",
      };
    }
    this.state.updatedAt = new Date().toISOString();

    if (execution.status === "simulated") this.recordHybridExecution(decision, execution);
    else if (this.hybrid.state.observations % 6 === 0) {
      const reason = decision.actions.hybrid.reason || execution.reason || decision.actions.quant.reason || "hold";
      this.addEvent("gate", "Hybrid 闸门保持 HOLD", REASON_ZH[reason] || reason);
    }
    this.store?.commitCycle({ session: this.sessionDescriptor(), decision, checkpoint: this.checkpoint() });
  }

  recordHybridExecution(decision, execution) {
    const action = execution.action === "buy" ? "buy" : "sell";
    const price = decision.features.price;
    const amountOut = action === "buy" ? finite(execution.received) : finite(execution.amount) * price * (1 - this.config.fullFeePercent / 100);
    const trade = {
      id: `${this.state.sessionId}:${decision.at}`, decisionAt: decision.at, at: decision.at,
      side: action, brainPathway: action === "sell" ? "BURN → SELL adapter" : "BUY",
      amountIn: finite(execution.amount), amountOut,
      inputSymbol: action === "buy" ? "BNB" : this.state.token.symbol,
      outputSymbol: action === "buy" ? this.state.token.symbol : "BNB",
      executionPrice: action === "buy" && amountOut > 0 ? finite(execution.amount) / amountOut : price,
      confidence: decision.actions.hybrid.confidence,
      quantScore: action === "buy" ? decision.scores.buy : decision.scores.burn,
      frequency: execution.frequency, simulated: true,
    };
    this.state.trades.unshift(trade);
    this.state.trades = this.state.trades.slice(0, 100);
    this.state.liveProposals.unshift({
      decisionAt: decision.at, createdAt: new Date().toISOString(), expiresAt: Date.now() + 5 * 60_000,
      tokenAddress: this.state.token.address, side: action, amount: finite(execution.amount), status: "approved",
      confidence: decision.actions.hybrid.confidence, quantScore: trade.quantScore,
      reason: "原版 Hybrid V2：量化与果蝇脑同向且所有模拟风控已通过",
    });
    this.state.liveProposals = this.state.liveProposals.slice(0, 20);
    this.addEvent("trade", action === "buy" ? "Hybrid 模拟回购已执行" : "Hybrid 卖出提案已执行", `量化分 ${trade.quantScore.toFixed(3)}；共识置信度 ${trade.confidence.toFixed(3)}；${execution.frequency?.used || 0}/${execution.frequency?.maxActions || 0} 窗口容量。`);
  }

  validateLiveProposal({ decisionAt, tokenAddress, side, amount }) {
    const proposal = this.state.liveProposals.find((item) => item.decisionAt === decisionAt);
    if (!proposal) throw new Error("真实交易必须来自当前运行时的 Hybrid V2 放行提案");
    if (proposal.status !== "approved") throw new Error("该 Hybrid 提案已经使用或失效");
    if (Date.now() > proposal.expiresAt) { proposal.status = "expired"; throw new Error("Hybrid 提案已超过 5 分钟，请等待新决策"); }
    if (proposal.tokenAddress.toLowerCase() !== String(tokenAddress).toLowerCase()) throw new Error("CA 与 Hybrid 提案不一致");
    if (proposal.side !== side) throw new Error("交易方向与 Hybrid 提案不一致");
    if (!(finite(amount) > 0) || finite(amount) > proposal.amount * 1.000000001) throw new Error(`输入数量不得超过 Hybrid 放行额度 ${proposal.amount}`);
    return proposal;
  }

  completeLiveProposal(decisionAt, hash) {
    const proposal = this.state.liveProposals.find((item) => item.decisionAt === decisionAt);
    if (!proposal) throw new Error("找不到 Hybrid 实盘提案");
    proposal.status = "confirmed";
    proposal.txHash = hash;
    proposal.confirmedAt = new Date().toISOString();
    this.addEvent("live", "Hybrid 实盘提案已确认", `${proposal.side.toUpperCase()} · ${hash}`);
    this.persistSession();
    return proposal;
  }

  latestApprovedProposal() {
    return this.state.liveProposals.find((item) => item.status === "approved" && Date.now() <= item.expiresAt) || null;
  }

  gateSnapshot() {
    const d = this.state.latestDecision;
    if (!d) return null;
    const hybrid = d.actions.hybrid;
    const execution = d.executions.hybrid;
    const frequency = this.hybrid.snapshot().currentFrequency;
    return {
      finalAction: hybrid.action, finalReason: hybrid.reason || execution.reason || null,
      layers: [
        { id: "data", label: "数据健康", pass: d.features.dataHealthy, value: `${d.features.dataAgeMs}ms / ${d.features.flowAgeMs}ms`, reason: d.features.dataHealthy ? null : "market-data-unhealthy" },
        { id: "quant", label: "量化机会", pass: d.actions.quant.action !== "HOLD", value: `B ${d.scores.buy.toFixed(3)} / S ${d.scores.burn.toFixed(3)}`, reason: d.actions.quant.reason },
        { id: "brain", label: "果蝇提案", pass: d.actions.brain.action !== "HOLD", value: `${d.actions.brain.action} · ${d.actions.brain.confidence.toFixed(3)}`, reason: d.actions.brain.reason },
        { id: "consensus", label: "方向共识", pass: hybrid.action !== "HOLD", value: hybrid.action, reason: hybrid.reason },
        { id: "frequency", label: "频率与间隔", pass: !["interval", "frequency-quota"].includes(execution.reason), value: frequency ? `${frequency.used}/${frequency.maxActions} · ${frequency.regime}` : "—", reason: ["interval", "frequency-quota"].includes(execution.reason) ? execution.reason : null },
        { id: "risk", label: "资金/流动性/Gas", pass: !["no-gas", "no-quote", "no-token", "capital-budget", "missing-liquidity", "price-impact", "price-high", "price-low"].includes(execution.reason), value: `${this.hybrid.settings.maxPoolParticipationPercent}% 池上限`, reason: ["no-gas", "no-quote", "no-token", "capital-budget", "missing-liquidity", "price-impact", "price-high", "price-low"].includes(execution.reason) ? execution.reason : null },
        { id: "execution", label: "Hybrid 执行", pass: execution.status === "simulated", value: execution.status, reason: execution.reason },
      ].map((layer) => ({ ...layer, reasonText: layer.reason ? REASON_ZH[layer.reason] || layer.reason : null })),
    };
  }

  accountSnapshot() {
    if (!this.hybrid || !this.observer) return null;
    const price = this.observer.price;
    const accounts = this.hybrid.snapshot().accounts;
    return Object.fromEntries(Object.entries(accounts).map(([name, account]) => [name, {
      quote: round(account.quote), token: round(account.token, 3), bnb: round(account.bnb),
      spent: round(account.spent), burned: round(account.burned, 3), actions: account.actions,
      buys: account.buys, burns: account.burns, averageBuyPrice: account.averageBuyPrice,
      netAssetValue: round(account.quote + account.token * price + account.bnb), blocked: account.blocked,
    }]));
  }

  addEvent(kind, title, detail) {
    this.state.events.unshift({ id: `${Date.now()}:${this.state.events.length}`, at: new Date().toISOString(), kind, title, detail });
    this.state.events = this.state.events.slice(0, SIMULATION_DEFAULTS.maxEvents);
  }

  sessionDescriptor() {
    return { id: this.state.sessionId, tokenAddress: this.state.token.address, startedAt: this.state.startedAt, status: this.state.status };
  }

  checkpoint() {
    return {
      token: this.state.token, brain: this.brain?.exportState() || null, hybrid: this.hybrid?.state || null,
      market: this.observer ? { at: this.observer.at, price: this.observer.price, index: this.observer.index } : null,
      latestDecisionAt: this.state.latestDecision?.at || null,
    };
  }

  persistSession() {
    if (this.store && this.state.sessionId) this.store.updateSession(this.sessionDescriptor(), this.checkpoint());
  }

  snapshot() {
    if (!this.hybrid || !this.observer || !this.brain) return { ...this.state, gate: null, market: null, brain: null, hybridV2: null, accounts: null, latestApprovedProposal: null };
    const hybridV2 = this.hybrid.snapshot();
    return {
      ...this.state,
      market: {
        price: this.observer.price,
        ...this.observer.marketSnapshot(),
        flow: this.observer.flowSnapshot(),
        candles: this.observer.candles.slice(-36).map((candle) => ({ ...candle })),
      },
      brain: this.brain.snapshot(), gate: this.gateSnapshot(),
      hybridV2: { observations: hybridV2.observations, settings: hybridV2.settings, currentFrequency: hybridV2.currentFrequency, comparison: hybridV2.comparison, feedbackPending: hybridV2.feedbackPending },
      accounts: this.accountSnapshot(), latestApprovedProposal: this.latestApprovedProposal(),
      trades: this.state.trades.map((trade) => ({ ...trade })), events: this.state.events.map((event) => ({ ...event })),
    };
  }
}
