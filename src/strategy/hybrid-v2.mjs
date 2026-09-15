const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export const HYBRID_V2_DEFAULTS = {
  version: 2,
  quantThreshold: 0.62,
  positionBuyCeiling: 0.55,
  positionBurnFloor: 0.55,
  buyMaxReturn60s: 0,
  buyMaxReturn300s: 0,
  buyMaxDistanceFromLow300s: 0.02,
  burnMinReturn60s: 0.02,
  burnMinReboundFromLow300s: 0.02,
  frequencyActiveThreshold: 0.5,
  activeWindowSeconds: 300,
  activeMinActions: 1,
  activeMaxActions: 10,
  quietWindowSeconds: 3600,
  quietMinActions: 1,
  quietMaxActions: 5,
  twapIntervalSeconds: 3600,
  buyPercent: 10,
  burnPercent: 10,
  capitalBudgetPercent: 10,
  maxPoolParticipationPercent: 0.5,
  initialQuote: 100,
  initialToken: 1_000_000,
  initialBnb: 1,
};

/**
 * The public buy/burn percentages are the authoritative order sizes. The
 * Hybrid confidence decides whether an action is allowed; it must not silently
 * replace the configured size with a second hidden percentage range.
 * `capitalBudgetPercent` remains a hard per-action ceiling.
 */
export function configuredActionRate(action, config = {}, settings = HYBRID_V2_DEFAULTS) {
  const key = action === 'BUY' ? 'buyPercent' : 'burnPercent';
  const configured = Number(config?.[key]);
  const requestedPercent = Number.isFinite(configured)
    ? clamp(configured, 0, 100)
    : clamp(finite(settings[key]), 0, 100);
  const ceilingPercent = clamp(finite(settings.capitalBudgetPercent, 100), 0, 100);
  return Math.min(requestedPercent, ceilingPercent)/100;
}

function priceAtOrBefore(candles, target) {
  for (let index = candles.length-1; index >= 0; index--) if (candles[index].time <= target) return candles[index].close;
  return candles[0]?.close ?? null;
}

export function deriveHybridFeatures({ candles = [], market, flow, token, now, updatedAt }) {
  const price = finite(candles.at(-1)?.close, NaN);
  const values = candles.map(item => finite(item.close, NaN)).filter(value => value > 0).sort((a, b) => a-b);
  const below = values.filter(value => value <= price).length;
  const positionPercentile = Number.isFinite(market?.positionPercentile) ? market.positionPercentile : values.length ? below/values.length : null;
  const logReturn = seconds => {
    const previous = priceAtOrBefore(candles, now-seconds*1000);
    return price > 0 && previous > 0 ? Math.log(price/previous) : null;
  };
  const pricesInWindow = seconds => candles
    .filter(item => item.time >= now-seconds*1000)
    .map(item => finite(item.low ?? item.close, NaN))
    .filter(value => value > 0);
  const window300s = pricesInWindow(300);
  const low300s = window300s.length ? Math.min(...window300s) : price;
  const distanceFromLow300s = price > 0 && low300s > 0 ? price/low300s-1 : null;
  const window = flow?.windows?.m5;
  const buyVolume = finite(window?.buyVolume);
  const sellVolume = finite(window?.sellVolume);
  const totalVolume = buyVolume+sellVolume;
  const buyShare = totalVolume > 0 ? buyVolume/totalVolume : null;
  const liquidityQuote = finite(token?.liquidity?.quote, NaN);
  const updatedMs = typeof updatedAt === 'string' ? Date.parse(updatedAt) : finite(updatedAt, NaN);
  const flowMs = flow?.scannedAt ? Date.parse(flow.scannedAt) : NaN;
  const dataAgeMs = Number.isFinite(updatedMs) ? Math.max(0, now-updatedMs) : Infinity;
  const flowAgeMs = Number.isFinite(flowMs) ? Math.max(0, now-flowMs) : Infinity;
  const dataHealthy = price > 0 && values.length >= 60 && market?.priceSamples >= 60
    && Number.isFinite(positionPercentile) && Number.isFinite(liquidityQuote) && liquidityQuote > 0
    && dataAgeMs <= 15_000 && flowAgeMs <= 20_000 && !flow?.error;
  return {
    at: now, price, positionPercentile, positionLog: finite(market?.position),
    activity: clamp(finite(market?.activity)), priceActivity: clamp(finite(market?.priceActivity)),
    volumeActivity: market?.volumeActivity === null ? null : clamp(finite(market?.volumeActivity)),
    minIntervalSeconds: finite(market?.minIntervalSeconds, 900),
    return60s: logReturn(60), return300s: logReturn(300),
    distanceFromLow300s,
    volumeRatio: market?.volumeRatio === null ? null : finite(market?.volumeRatio, null),
    buyVolume, sellVolume, totalVolume, buyShare, liquidityQuote,
    tokenReserve: finite(token?.liquidity?.token, NaN),
    quotePrice: finite(token?.quotePrice, NaN), buyTaxPercent: finite(token?.buyTaxPercent),
    dataAgeMs, flowAgeMs, dataHealthy,
  };
}

export function scoreQuantOpportunity(features, settings = HYBRID_V2_DEFAULTS) {
  if (!features.dataHealthy) return { buy: 0, burn: 0, reason: 'market-data-unhealthy' };
  const percentile = features.positionPercentile;
  const lowPosition = clamp((0.55-percentile)/0.45);
  const highPosition = clamp((percentile-0.55)/0.45);
  const shortTrend = finite(features.return60s);
  const mediumTrend = finite(features.return300s);
  const fallingShort = clamp(-shortTrend/0.04);
  const fallingMedium = clamp(-mediumTrend/0.08);
  const nearLow = 1-clamp(finite(features.distanceFromLow300s)/0.04);
  const fastRise = clamp(shortTrend/Math.max(0.001, finite(settings.burnMinReturn60s, 0.02)));
  const reboundFromLow = clamp(finite(features.distanceFromLow300s)/Math.max(0.001, finite(settings.burnMinReboundFromLow300s, 0.02)));
  const volumeSignal = features.volumeRatio === null ? features.activity : clamp((features.volumeRatio-0.5)/1.5);
  const buyFlow = features.buyShare === null ? 0.5 : features.buyShare;
  const sellFlow = 1-buyFlow;
  const buy = clamp(0.35*lowPosition+0.25*fallingShort+0.15*fallingMedium+0.10*nearLow
    +0.07*features.activity+0.04*volumeSignal+0.04*sellFlow);
  const burn = clamp(0.50*fastRise+0.30*reboundFromLow+0.08*highPosition
    +0.05*features.activity+0.04*volumeSignal+0.03*buyFlow);
  return { buy, burn, reason: null };
}

function hasFinite(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function isSustainedDecline(features, settings) {
  return hasFinite(features.return60s) && hasFinite(features.return300s)
    && Number(features.return60s) <= settings.buyMaxReturn60s
    && Number(features.return300s) <= settings.buyMaxReturn300s
    && finite(features.distanceFromLow300s, Infinity) <= settings.buyMaxDistanceFromLow300s;
}

function isBurnRebound(features, settings) {
  return (hasFinite(features.return60s) && Number(features.return60s) >= settings.burnMinReturn60s)
    || finite(features.distanceFromLow300s) >= settings.burnMinReboundFromLow300s;
}

export function chooseQuantAction(scores, features, settings = HYBRID_V2_DEFAULTS) {
  if (!features.dataHealthy) return { action: 'HOLD', reason: 'market-data-unhealthy', confidence: 0 };
  if (scores.buy >= settings.quantThreshold && scores.buy > scores.burn) {
    if (features.positionPercentile > settings.positionBuyCeiling) return { action: 'HOLD', reason: 'price-high', confidence: scores.buy };
    if (!isSustainedDecline(features, settings)) return { action: 'HOLD', reason: 'buy-trend-not-falling', confidence: scores.buy };
    return { action: 'BUY', reason: null, confidence: scores.buy };
  }
  if (scores.burn >= settings.quantThreshold && scores.burn > scores.buy) {
    if (features.positionPercentile < settings.positionBurnFloor && !isBurnRebound(features, settings)) return { action: 'HOLD', reason: 'price-low', confidence: scores.burn };
    return { action: 'BURN', reason: null, confidence: scores.burn };
  }
  return { action: 'HOLD', reason: 'quant-below-threshold', confidence: Math.max(scores.buy, scores.burn) };
}

function initialAccount(settings) {
  return { quote: settings.initialQuote, token: settings.initialToken, bnb: settings.initialBnb,
    initialQuote: settings.initialQuote, initialToken: settings.initialToken, spent: 0, burned: 0,
    depositedQuote: settings.initialQuote, depositedToken: settings.initialToken, depositedBnb: settings.initialBnb,
    tokensBought: 0, buyCost: 0, fees: 0, gas: 0, actions: 0, buys: 0, burns: 0,
    lastActionAt: null, nextEligibleAt: null, actionAts: [], day: null, dayBuy: 0, dayBurn: 0, dayActions: 0, dailyUsage: {}, blocked: {} };
}

function initialLiveAccount(holdings, at) {
  const quote = Math.max(0, finite(holdings?.quote));
  const token = Math.max(0, finite(holdings?.token));
  const bnb = Math.max(0, finite(holdings?.bnb));
  return {
    quote, token, bnb,
    initialQuote: quote, initialToken: token,
    spent: 0, burned: 0, fees: 0, gas: 0, actions: 0, buys: 0, burns: 0,
    tokensBought: 0, buyCost: 0,
    lastActionAt: null, nextEligibleAt: null, actionAts: [], day: null,
    dayBuy: 0, dayBurn: 0, dayActions: 0, dailyUsage: {}, blocked: {},
    activatedAt: new Date(at).toISOString(), reservations: {},
  };
}

export function frequencyPolicy(features, settings = HYBRID_V2_DEFAULTS) {
  const activity = clamp(finite(features.activity));
  const threshold = clamp(finite(settings.frequencyActiveThreshold, 0.5), 0.05, 0.95);
  if (activity < threshold) {
    const progress = activity/threshold;
    return { regime: 'quiet', activity, windowSeconds: settings.quietWindowSeconds,
      maxActions: Math.round(settings.quietMinActions+(settings.quietMaxActions-settings.quietMinActions)*progress) };
  }
  const progress = (activity-threshold)/(1-threshold);
  return { regime: 'active', activity, windowSeconds: settings.activeWindowSeconds,
    maxActions: Math.round(settings.activeMinActions+(settings.activeMaxActions-settings.activeMinActions)*progress) };
}

function block(account, reason) {
  account.blocked[reason] = (account.blocked[reason] || 0)+1;
  return { status: 'blocked', reason };
}

export class HybridV2Lab {
  constructor(saved = null, options = {}) {
    this.settings = { ...HYBRID_V2_DEFAULTS, ...options };
    this.state = saved?.version === this.settings.version ? saved : {
      version: this.settings.version, startedAt: new Date().toISOString(), observations: 0,
      accounts: { twap: initialAccount(this.settings), quant: initialAccount(this.settings), brain: initialAccount(this.settings), hybrid: initialAccount(this.settings) },
      decisions: [], outcomes: [], pending: [], feedbackQueue: [],
      guardrails: { frequencyPolicyEffectiveAt: new Date().toISOString() },
    };
    this.state.live ||= null;
    this.state.feedbackQueue ||= [];
    this.state.guardrails ||= {};
    this.state.guardrails.frequencyPolicyEffectiveAt ||= new Date().toISOString();
    this.state.guardrails.primaryExecutionEffectiveAt ||= new Date().toISOString();
    this.state.guardrails.trendPolicyEffectiveAt ||= new Date().toISOString();
    this.state.guardrails.intervalLockEffectiveAt ||= new Date().toISOString();
    this.state.guardrails.liveExecutionEffectiveAt ||= null;
    this.state.guardrails.actionSizingPolicy = 'configured-percent-per-action-capped';
    this.state.guardrails.actionSizingPolicyEffectiveAt ||= new Date().toISOString();
    for (const item of this.state.pending || []) {
      item.maxPrice = finite(item.maxPrice, item.price);
      item.minPrice = finite(item.minPrice, item.price);
      const matchingDecision = (this.state.decisions || []).find(event => Date.parse(event.at) === item.at);
      item.quotePrice = finite(item.quotePrice, finite(matchingDecision?.features?.quotePrice, item.price));
      item.checkpoints ||= {};
    }
    for (const [model, account] of Object.entries(this.state.accounts || {})) {
      account.depositedQuote = finite(account.depositedQuote, account.initialQuote);
      account.depositedToken = finite(account.depositedToken, account.initialToken);
      account.depositedBnb = finite(account.depositedBnb, this.settings.initialBnb);
      account.nextEligibleAt = hasFinite(account.nextEligibleAt) ? Number(account.nextEligibleAt) : null;
      const inferredDayActions = account.day ? (this.state.decisions || []).filter(event =>
        event.at?.slice(0, 10) === account.day && event.executions?.[model]?.status === 'simulated').length : 0;
      account.dayActions = Math.max(finite(account.dayActions), inferredDayActions);
      account.actionAts = (account.actionAts || (this.state.decisions || []).filter(event =>
        event.executions?.[model]?.status === 'simulated').map(event => Date.parse(event.at)))
        .map(value => finite(value, NaN)).filter(Number.isFinite).sort((a, b) => a-b).slice(-1000);
      account.dailyUsage ||= account.day ? {
        [account.day]: { buy: finite(account.dayBuy), burn: finite(account.dayBurn), actions: account.dayActions },
      } : {};
      for (const usage of Object.values(account.dailyUsage)) {
        usage.buy = finite(usage.buy);
        usage.burn = finite(usage.burn);
        usage.actions = Math.max(finite(usage.actions), account.day && usage === account.dailyUsage[account.day] ? inferredDayActions : 0);
      }
    }
    if (this.state.live) {
      const live = this.state.live;
      live.quote = Math.max(0, finite(live.quote));
      live.token = Math.max(0, finite(live.token));
      live.bnb = Math.max(0, finite(live.bnb));
      live.initialQuote = Math.max(0, finite(live.initialQuote, live.quote));
      live.initialToken = Math.max(0, finite(live.initialToken, live.token));
      live.spent = Math.max(0, finite(live.spent));
      live.burned = Math.max(0, finite(live.burned));
      live.fees = Math.max(0, finite(live.fees));
      live.gas = Math.max(0, finite(live.gas));
      live.actions = Math.max(0, finite(live.actions));
      live.buys = Math.max(0, finite(live.buys));
      live.burns = Math.max(0, finite(live.burns));
      live.tokensBought = Math.max(0, finite(live.tokensBought));
      live.buyCost = Math.max(0, finite(live.buyCost));
      live.actionAts = (live.actionAts || []).map(value => finite(value, NaN)).filter(Number.isFinite).sort((a, b) => a-b).slice(-1000);
      live.dailyUsage ||= {};
      live.blocked ||= {};
      live.reservations ||= {};
      live.nextEligibleAt = hasFinite(live.nextEligibleAt) ? Number(live.nextEligibleAt) : null;
    }
  }

  /**
   * The Hybrid account is the deployable strategy account. Other accounts remain
   * counterfactual shadows and never write the public transaction ledger.
   */
  primaryState(tokenAddress = null) {
    const account = this.state.accounts.hybrid;
    const pending = this.state.pending.filter(item => item.executions?.hybrid?.status === 'simulated');
    const settled = this.state.outcomes
      .filter(item => item.outcomes?.hybrid?.executed)
      .map(item => ({ action: item.outcomes.hybrid.action.toLowerCase(), at: Date.parse(item.at),
        mfe: item.checkpoints?.m60?.mfe ?? 0, reward: item.outcomes.hybrid.afterCostReturn60m ?? 0 }))
      .slice(-100);
    return { tokenAddress, quote: account.quote, token: account.token, bnb: account.bnb,
      spent: account.spent, burned: account.burned,
      depositedQuote: account.depositedQuote, depositedToken: account.depositedToken, depositedBnb: account.depositedBnb,
      lastActionAt: account.lastActionAt, pending, settled, actions: account.actions, observations: this.state.observations };
  }

  deposit(values) {
    for (const account of Object.values(this.state.accounts)) {
      for (const asset of ['quote', 'token', 'bnb']) {
        const amount = finite(values[asset]);
        account[asset] += amount;
        account[`deposited${asset[0].toUpperCase()}${asset.slice(1)}`] += amount;
        if (asset === 'quote') account.initialQuote += amount;
        if (asset === 'token') account.initialToken += amount;
      }
    }
  }

  /**
   * Reserve one real-wallet action before any transaction is broadcast. The
   * paper Hybrid account remains an independent counterfactual benchmark;
   * each live order is sized from the latest on-chain balances.
   */
  reserveLive({ decisionAt, decision, features, market, config, holdings, systemBlockReason = null }) {
    if (!decisionAt) throw new Error('实盘决策缺少唯一时间标识');
    if (!this.state.live) {
      this.state.live = initialLiveAccount(holdings, market.at);
      this.state.guardrails.liveExecutionEffectiveAt = new Date(market.at).toISOString();
    }
    const account = this.state.live;
    const existing = account.reservations[decisionAt];
    if (existing) return { ...existing.result, duplicate: true };

    account.quote = Math.max(0, finite(holdings?.quote));
    account.token = Math.max(0, finite(holdings?.token));
    account.bnb = Math.max(0, finite(holdings?.bnb));
    const action = decision?.action;
    if (action === 'HOLD' || !action) return { status: 'hold' };
    if (systemBlockReason) return block(account, systemBlockReason);
    if (!features.dataHealthy) return block(account, 'market-data-unhealthy');

    const frequency = frequencyPolicy(features, this.settings);
    const intervalSeconds = Math.max(0, finite(features.minIntervalSeconds));
    const nextEligibleAt = account.nextEligibleAt ?? (account.lastActionAt === null ? null : account.lastActionAt+intervalSeconds*1000);
    if (nextEligibleAt !== null && market.at < nextEligibleAt) return block(account, 'interval');
    const retentionSeconds = Math.max(this.settings.activeWindowSeconds, this.settings.quietWindowSeconds);
    account.actionAts = account.actionAts.filter(at => at > market.at-retentionSeconds*1000 && at <= market.at);
    const frequencyUsed = account.actionAts.filter(at => at > market.at-frequency.windowSeconds*1000).length;
    if (frequencyUsed >= frequency.maxActions) return block(account, 'frequency-quota');

    const day = new Date(market.at).toISOString().slice(0, 10);
    if (account.day !== day) { account.day = day; account.dayBuy = 0; account.dayBurn = 0; account.dayActions = 0; }
    account.dailyUsage[day] ||= { buy: 0, burn: 0, actions: 0 };
    const gas = finite(config.fullGasBnb);
    if (account.bnb < gas) return block(account, 'no-gas');

    const confidence = clamp(finite(decision.confidence));
    let result;
    if (action === 'BUY') {
      if (features.positionPercentile > this.settings.positionBuyCeiling) return block(account, 'price-high');
      if (!isSustainedDecline(features, this.settings)) return block(account, 'buy-trend-not-falling');
      const rate = configuredActionRate('BUY', config, this.settings, confidence);
      const amount = Math.min(account.quote*rate, features.liquidityQuote*this.settings.maxPoolParticipationPercent/100);
      if (!(amount > 1e-12)) return block(account, account.quote <= 1e-12 ? 'no-quote' : 'capital-budget');
      if (holdings?.nativeQuote && account.bnb < amount+gas) return block(account, 'no-gas');
      account.spent += amount;
      account.dayBuy += amount;
      account.dailyUsage[day].buy += amount;
      account.buys++;
      result = { status: 'reserved', action: 'buy', amount, received: null };
    } else if (action === 'BURN') {
      if (features.positionPercentile < this.settings.positionBurnFloor && !isBurnRebound(features, this.settings)) return block(account, 'price-low');
      const rate = configuredActionRate('BURN', config, this.settings, confidence);
      const amount = account.token*rate;
      if (!(amount > 1e-12)) return block(account, account.token <= 1e-12 ? 'no-token' : 'capital-budget');
      account.burned += amount;
      account.dayBurn += amount;
      account.dailyUsage[day].burn += amount;
      account.burns++;
      result = { status: 'reserved', action: 'burn', amount };
    } else {
      return block(account, 'invalid-action');
    }

    account.actions++;
    account.dayActions++;
    account.dailyUsage[day].actions++;
    account.lastActionAt = market.at;
    account.nextEligibleAt = market.at+intervalSeconds*1000;
    account.actionAts.push(market.at);
    result = { ...result, frequency: { ...frequency, used: frequencyUsed+1 }, intervalSeconds, gasBnb: gas };
    account.reservations[decisionAt] = { decisionAt, createdAt: new Date(market.at).toISOString(), status: 'reserved', result };
    return result;
  }

  completeLive(decisionAt, { status, txHash = null, received = null, gasBnb = null, error = null } = {}) {
    const account = this.state.live;
    const reservation = account?.reservations?.[decisionAt];
    if (!reservation) throw new Error(`找不到实盘预留：${decisionAt}`);
    if (['confirmed', 'failed'].includes(reservation.status)) return reservation;
    reservation.status = status;
    reservation.txHash = txHash;
    reservation.error = error;
    reservation.updatedAt = new Date().toISOString();
    const effectivePrice = reservation.result.action === 'buy' && finite(received) > 0
      ? reservation.result.amount/finite(received) : null;
    const decision = this.state.decisions.find(item => item.at === decisionAt);
    if (decision?.executions?.live) decision.executions.live = { ...decision.executions.live, status, txHash, received, effectivePrice, error };
    const pending = this.state.pending.find(item => item.at === Date.parse(decisionAt));
    if (pending?.executions?.live) pending.executions.live = { ...pending.executions.live, status, txHash, received, effectivePrice, error };
    if (status === 'confirmed') {
      if (reservation.result.action === 'buy') {
        account.tokensBought += Math.max(0, finite(received));
        account.buyCost += reservation.result.amount;
      }
      account.gas += Math.max(0, finite(gasBnb, reservation.result.gasBnb));
    } else if (status === 'failed') {
      if (reservation.result.action === 'buy') account.spent = Math.max(0, account.spent-reservation.result.amount);
      else account.burned = Math.max(0, account.burned-reservation.result.amount);
    }
    return reservation;
  }

  liveSnapshot() {
    if (!this.state.live) return null;
    const account = this.state.live;
    const reservations = Object.values(account.reservations || {});
    return {
      ...account,
      reservations: reservations.slice(-100),
      pending: reservations.filter(item => ['reserved', 'broadcasting', 'broadcast', 'unknown'].includes(item.status)).length,
      quoteBudget: account.quote*this.settings.capitalBudgetPercent/100,
      tokenBudget: account.token*this.settings.capitalBudgetPercent/100,
      budgetMode: 'per-action',
    };
  }
  execute(model, action, confidence, features, market, config, intervalOverride = null) {
    const account = this.state.accounts[model];
    if (action === 'HOLD') return { status: 'hold' };
    if (!features.dataHealthy) return block(account, 'market-data-unhealthy');
    let frequency = null;
    let frequencyUsed = 0;
    if (intervalOverride !== null) {
      if (account.lastActionAt !== null && market.at-account.lastActionAt < intervalOverride*1000) return block(account, 'interval');
    } else {
      frequency = frequencyPolicy(features, this.settings);
      const intervalSeconds = Math.max(0, finite(features.minIntervalSeconds));
      const nextEligibleAt = account.nextEligibleAt ?? (account.lastActionAt === null ? null : account.lastActionAt+intervalSeconds*1000);
      if (nextEligibleAt !== null && market.at < nextEligibleAt) return block(account, 'interval');
      const retentionSeconds = Math.max(this.settings.activeWindowSeconds, this.settings.quietWindowSeconds);
      account.actionAts = account.actionAts.filter(at => at > market.at-retentionSeconds*1000 && at <= market.at);
      frequencyUsed = account.actionAts.filter(at => at > market.at-frequency.windowSeconds*1000).length;
      if (frequencyUsed >= frequency.maxActions) return block(account, 'frequency-quota');
    }
    const day = new Date(market.at).toISOString().slice(0, 10);
    if (account.day !== day) { account.day = day; account.dayBuy = 0; account.dayBurn = 0; account.dayActions = 0; }
    account.dailyUsage[day] ||= { buy: 0, burn: 0, actions: 0 };
    const gas = finite(config.fullGasBnb);
    if (account.bnb < gas) return block(account, 'no-gas');
    if (action === 'BUY') {
      if (features.positionPercentile > this.settings.positionBuyCeiling && model !== 'twap' && model !== 'brain') return block(account, 'price-high');
      const rate = configuredActionRate('BUY', config, this.settings, confidence);
      let amount = Math.min(account.quote*rate, features.liquidityQuote*this.settings.maxPoolParticipationPercent/100);
      if (!(amount > 1e-12)) return block(account, account.quote <= 1e-12 ? 'no-quote' : 'capital-budget');
      const feeRate = finite(config.fullFeePercent)/100;
      const taxRate = features.buyTaxPercent/100;
      const tokenReserve = features.tokenReserve;
      const quoteReserve = features.liquidityQuote;
      if (!(tokenReserve > 0) || !(quoteReserve > 0)) return block(account, 'missing-liquidity');
      const net = amount*(1-feeRate);
      const receivedBeforeTax = tokenReserve*net/(quoteReserve+net);
      const received = receivedBeforeTax*(1-taxRate);
      if (!(received > 0)) return block(account, 'price-impact');
      account.quote -= amount;
      account.token += received;
      account.bnb -= gas;
      account.spent += amount;
      account.tokensBought += received;
      account.buyCost += amount;
      account.fees += amount-received*features.quotePrice;
      account.gas += gas;
      account.dayBuy += amount;
      account.dailyUsage[day].buy += amount;
      account.buys++;
      account.actions++;
      account.dayActions++;
      account.dailyUsage[day].actions++;
      account.lastActionAt = market.at;
      account.nextEligibleAt = intervalOverride === null
        ? market.at+Math.max(0, finite(features.minIntervalSeconds))*1000
        : null;
      account.actionAts.push(market.at);
      return { status: 'simulated', action: 'buy', amount, received, effectivePrice: amount/received,
        frequency: frequency ? { ...frequency, used: frequencyUsed+1 } : null,
        intervalSeconds: intervalOverride ?? Math.max(0, finite(features.minIntervalSeconds)), gasBnb: gas };
    }
    if (action === 'BURN') {
      if (features.positionPercentile < this.settings.positionBurnFloor && model !== 'brain' && !isBurnRebound(features, this.settings)) return block(account, 'price-low');
      const rate = configuredActionRate('BURN', config, this.settings, confidence);
      const amount = account.token*rate;
      if (!(amount > 1e-12)) return block(account, account.token <= 1e-12 ? 'no-token' : 'capital-budget');
      account.token -= amount;
      account.bnb -= gas;
      account.burned += amount;
      account.gas += gas;
      account.dayBurn += amount;
      account.dailyUsage[day].burn += amount;
      account.burns++;
      account.actions++;
      account.dayActions++;
      account.dailyUsage[day].actions++;
      account.lastActionAt = market.at;
      account.nextEligibleAt = intervalOverride === null
        ? market.at+Math.max(0, finite(features.minIntervalSeconds))*1000
        : null;
      account.actionAts.push(market.at);
      return { status: 'simulated', action: 'burn', amount,
        frequency: frequency ? { ...frequency, used: frequencyUsed+1 } : null,
        intervalSeconds: intervalOverride ?? Math.max(0, finite(features.minIntervalSeconds)), gasBnb: gas };
    }
    return block(account, 'invalid-action');
  }
  observe({ neural, features, market, config, systemBlockReason = null }) {
    this.settle(market.at, features.price);
    const scores = scoreQuantOpportunity(features, this.settings);
    const quant = chooseQuantAction(scores, features, this.settings);
    const brainAction = neural.side === 'BUY' ? 'BUY' : neural.side === 'SELL' ? 'BURN' : 'HOLD';
    const brainConfidence = clamp(Math.abs(finite(neural.difference_hz))/Math.max(0.1, finite(config.fullThresholdHz, 2)*4));
    const hybrid = brainAction !== 'HOLD' && brainAction === quant.action
      ? { action: brainAction, confidence: Math.sqrt(brainConfidence*quant.confidence), reason: null }
      : { action: 'HOLD', confidence: Math.sqrt(brainConfidence*quant.confidence), reason: brainAction === 'HOLD' ? 'brain-hold' : 'model-disagreement' };
    const twapDue = this.state.accounts.twap.lastActionAt === null || market.at-this.state.accounts.twap.lastActionAt >= this.settings.twapIntervalSeconds*1000;
    const actions = {
      twap: { action: twapDue ? 'BUY' : 'HOLD', confidence: 0.5, reason: twapDue ? null : 'interval' },
      quant,
      brain: { action: brainAction, confidence: brainConfidence, reason: brainAction === 'HOLD' ? 'brain-hold' : null },
      hybrid,
    };
    const executions = {};
    for (const [model, decision] of Object.entries(actions)) {
      const fixed = model === 'twap' ? this.settings.twapIntervalSeconds : null;
      executions[model] = decision.action !== 'HOLD' && systemBlockReason
        ? block(this.state.accounts[model], systemBlockReason)
        : this.execute(model, decision.action, decision.confidence, features, market, config, fixed);
    }
    const event = { at: new Date(market.at).toISOString(), price: features.price, features, scores, brain: {
      action: brainAction, confidence: brainConfidence, differenceHz: finite(neural.difference_hz), gateSpikes: finite(neural.gate_spikes),
    }, actions, executions };
    this.state.decisions.push(event);
    if (this.state.decisions.length > 500) this.state.decisions.splice(0, this.state.decisions.length-500);
    this.state.pending.push({ at: market.at, price: features.price, quotePrice: features.quotePrice,
      features: { positionPercentile: features.positionPercentile }, actions,
      executions, maxPrice: features.price, minPrice: features.price, checkpoints: {} });
    this.state.observations++;
    return event;
  }
  settle(at, price) {
    const keep = [];
    for (const item of this.state.pending) {
      item.maxPrice = Math.max(item.maxPrice, price);
      item.minPrice = Math.min(item.minPrice, price);
      item.checkpoints ||= {};
      const age = at-item.at;
      for (const [name, milliseconds] of [['m5', 300_000], ['m15', 900_000], ['m60', 3_600_000]]) {
        if (age >= milliseconds && !item.checkpoints[name]) item.checkpoints[name] = {
          at: new Date(at).toISOString(), ageSeconds: age/1000, return: price/item.price-1,
          mfe: item.maxPrice/item.price-1, mae: item.minPrice/item.price-1,
        };
      }
      if (age < 3_600_000) { keep.push(item); continue; }
      const outcomes = {};
      for (const model of Object.keys(item.actions)) {
        const action = item.actions[model].action;
        const execution = item.executions[model];
        const effectivePriceReference = execution.effectivePrice && item.quotePrice > 0
          ? execution.effectivePrice*item.price/item.quotePrice : item.price;
        outcomes[model] = { action, checkpoints: structuredClone(item.checkpoints),
          executed: execution.status === 'simulated', effectivePrice: execution.effectivePrice || null,
          effectivePriceReference: execution.effectivePrice ? effectivePriceReference : null,
          afterCostReturn60m: action === 'BUY' && execution.status === 'simulated' ? price/effectivePriceReference-1 : null };
      }
      const hybrid = outcomes.hybrid;
      const primaryExecution = item.executions.live || item.executions.hybrid;
      const primaryExecuted = primaryExecution.status === 'simulated' || primaryExecution.status === 'confirmed';
      if (primaryExecuted && (hybrid.action === 'BUY' || hybrid.action === 'BURN')) {
        const position = Number.isFinite(item.features.positionPercentile) ? item.features.positionPercentile : 0.5;
        const positionQuality = hybrid.action === 'BUY' ? (0.5-position)*2 : (position-0.5)*2;
        const liveReference = primaryExecution.effectivePrice && item.quotePrice > 0
          ? primaryExecution.effectivePrice*item.price/item.quotePrice : item.price;
        const follow = hybrid.action === 'BUY' ? price/liveReference-1 : item.checkpoints.m60.return;
        const scale = 0.05;
        const favorable = Math.tanh(Math.max(0, item.checkpoints.m60.mfe)/scale);
        const drawdown = Math.tanh(Math.abs(Math.min(0, item.checkpoints.m60.mae))/scale);
        const utility = clamp(0.65*Math.tanh(follow/scale)+0.20*positionQuality+0.10*favorable-0.05*drawdown, -1, 1);
        this.state.feedbackQueue.push({ at: new Date(item.at).toISOString(), settledAt: new Date(at).toISOString(),
          action: hybrid.action, utility, positionPercentile: position, followReturn60m: follow,
          source: 'hybrid-v2-executed' });
      }
      this.state.outcomes.push({ at: new Date(item.at).toISOString(), entryPrice: item.price,
        positionPercentile: item.features.positionPercentile, checkpoints: structuredClone(item.checkpoints), outcomes });
    }
    this.state.pending = keep;
    if (this.state.outcomes.length > 1000) this.state.outcomes.splice(0, this.state.outcomes.length-1000);
    if (this.state.feedbackQueue.length > 100) this.state.feedbackQueue.splice(0, this.state.feedbackQueue.length-100);
  }
  pulse() {
    if (!this.state.feedbackQueue.length) return 'none';
    return meanUtility(this.state.feedbackQueue) > 0 ? 'reward' : 'aversive';
  }
  pulseStrength() {
    if (!this.state.feedbackQueue.length) return 0;
    return clamp(Math.abs(meanUtility(this.state.feedbackQueue)), 0.05, 1);
  }
  consumeFeedback(count) {
    this.state.feedbackQueue.splice(0, Math.max(0, count));
  }
  snapshot() {
    const accounts = {};
    for (const [name, account] of Object.entries(this.state.accounts)) accounts[name] = { ...account,
      averageBuyPrice: account.tokensBought > 0 ? account.buyCost/account.tokensBought : null };
    const hybrid = accounts.hybrid;
    const twap = accounts.twap;
    // The order-size ceiling is applied before every simulated and live
    // reservation. Cumulative spend/burn remain accounting totals, not a
    // lifetime lock that permanently disables the strategy.
    const capitalBudgetOk = true;
    const latest = this.state.decisions.at(-1);
    const currentFrequency = latest ? frequencyPolicy(latest.features, this.settings) : null;
    const liveFrequency = latest && this.state.live ? frequencyPolicy(latest.features, this.settings) : null;
    return { version: this.state.version, startedAt: this.state.startedAt, observations: this.state.observations, settings: this.settings,
      accounts, live: this.liveSnapshot(), recent: this.state.decisions.slice(-30).reverse(), outcomes: this.state.outcomes.slice(-100),
      feedbackPending: this.state.feedbackQueue.length, latestFeedback: this.state.feedbackQueue.at(-1) || null,
      currentFrequency: currentFrequency ? { ...currentFrequency,
        used: hybrid.actionAts.filter(at => at > Date.parse(latest.at)-currentFrequency.windowSeconds*1000 && at <= Date.parse(latest.at)).length,
        nextEligibleAt: hybrid.nextEligibleAt ? new Date(hybrid.nextEligibleAt).toISOString() : null,
        remainingSeconds: hybrid.nextEligibleAt ? Math.max(0, (hybrid.nextEligibleAt-Date.parse(latest.at))/1000) : 0 } : null,
      liveFrequency: liveFrequency ? { ...liveFrequency,
        used: this.state.live.actionAts.filter(at => at > Date.parse(latest.at)-liveFrequency.windowSeconds*1000 && at <= Date.parse(latest.at)).length,
        nextEligibleAt: this.state.live.nextEligibleAt ? new Date(this.state.live.nextEligibleAt).toISOString() : null,
        remainingSeconds: this.state.live.nextEligibleAt ? Math.max(0, (this.state.live.nextEligibleAt-Date.parse(latest.at))/1000) : 0 } : null,
      guardrails: this.state.guardrails,
      comparison: { hybridBuyPrice: hybrid.averageBuyPrice, twapBuyPrice: twap.averageBuyPrice,
        buyEdgeVsTwap: hybrid.averageBuyPrice && twap.averageBuyPrice ? twap.averageBuyPrice/hybrid.averageBuyPrice-1 : null,
        hybridCapitalBudgetOk: true,
        allCapitalBudgetsOk: capitalBudgetOk } };
  }
}

function meanUtility(items) {
  return items.reduce((sum, item) => sum+finite(item.utility), 0)/Math.max(1, items.length);
}
