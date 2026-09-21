import { assertEffectiveProfile } from "../profile/index.mjs";
import { computeProfiledUtility, feedbackPulse } from "../reward/profiled-reward.mjs";
import { deriveHybridFeatures, HybridV2Lab } from "./hybrid-v2.mjs";

const STANDARD_HORIZONS = new Map([[300, "m5"], [900, "m15"], [3_600, "m60"]]);

function horizonName(seconds) {
  return STANDARD_HORIZONS.get(seconds) || `s${seconds}`;
}

function block(account, reason) {
  account.blocked[reason] = (account.blocked[reason] || 0) + 1;
  return { status: "blocked", reason };
}

export function deriveProfiledFeatures(input, effectiveProfile) {
  assertEffectiveProfile(effectiveProfile);
  const features = deriveHybridFeatures(input);
  const perception = effectiveProfile.spec.perception;
  const risk = effectiveProfile.spec.risk;
  const values = input.candles
    .map((item) => Number(item.close))
    .filter((value) => Number.isFinite(value) && value > 0);
  const updatedMs = typeof input.updatedAt === "string"
    ? Date.parse(input.updatedAt) : Number(input.updatedAt);
  const flowMs = typeof input.flow?.scannedAt === "string"
    ? Date.parse(input.flow.scannedAt) : NaN;
  const dataAgeMs = Number.isFinite(updatedMs) ? Math.max(0, input.now - updatedMs) : Infinity;
  const flowAgeMs = Number.isFinite(flowMs) ? Math.max(0, input.now - flowMs) : Infinity;
  const liquidityQuote = Number(input.token?.liquidity?.quote);
  const dataHealthy = features.price > 0
    && values.length >= perception.minimumHealthySamples
    && Number(input.market?.priceSamples) >= perception.minimumHealthySamples
    && Number.isFinite(features.positionPercentile)
    && Number.isFinite(liquidityQuote) && liquidityQuote > 0
    && dataAgeMs <= perception.marketMaxAgeSeconds * 1_000
    && flowAgeMs <= perception.flowMaxAgeSeconds * 1_000
    && !input.flow?.error;
  return {
    ...features,
    dataAgeMs,
    flowAgeMs,
    dataHealthy,
    minIntervalSeconds: Math.max(
      Number(features.minIntervalSeconds) || 0,
      risk.minimumActionIntervalSeconds,
    ),
  };
}

export class ProfiledHybridV2 extends HybridV2Lab {
  constructor(saved = null, { effectiveProfile, ...options } = {}) {
    assertEffectiveProfile(effectiveProfile);
    const { strategy, risk } = effectiveProfile.spec;
    super(saved, {
      ...strategy,
      capitalBudgetPercent: risk.capitalBudgetPercent,
      maxPoolParticipationPercent: risk.maxPoolParticipationPercent,
      ...options,
    });
    this.effectiveProfile = effectiveProfile;
    this.reward = effectiveProfile.spec.reward;
    this.runtime = effectiveProfile.spec.runtime;
    this.risk = risk;
  }

  observe(input) {
    const overflow = this.runtime.retainDecisionCount > 500 && this.state.decisions.length >= 500
      ? this.state.decisions.slice(0, this.state.decisions.length - 499)
      : [];
    const event = super.observe(input);
    if (overflow.length) this.state.decisions.unshift(...overflow);
    if (this.state.decisions.length > this.runtime.retainDecisionCount) {
      this.state.decisions.splice(0, this.state.decisions.length - this.runtime.retainDecisionCount);
    }
    return event;
  }

  execute(model, action, confidence, features, market, config, intervalOverride = null) {
    const account = this.state.accounts[model];
    if (action !== "HOLD") {
      const day = new Date(market.at).toISOString().slice(0, 10);
      const actions = account.day === day ? Number(account.dayActions || 0) : 0;
      if (actions >= this.risk.dailyActionLimit) return block(account, "daily-action-limit");
    }
    return super.execute(model, action, confidence, features, market, config, intervalOverride);
  }

  reserveLive(input) {
    if (!this.risk.liveTradingEnabled) {
      if (!this.state.live) return { status: "blocked", reason: "live-trading-disabled" };
      return block(this.state.live, "live-trading-disabled");
    }
    const day = new Date(input.market.at).toISOString().slice(0, 10);
    const actions = this.state.live?.day === day ? Number(this.state.live.dayActions || 0) : 0;
    if (actions >= this.risk.dailyActionLimit) {
      return block(this.state.live, "daily-action-limit");
    }
    return super.reserveLive(input);
  }

  settle(at, price) {
    const keep = [];
    const horizons = this.reward.settlementHorizonsSeconds;
    const finalHorizon = Math.max(...horizons);
    const primaryName = horizonName(this.reward.primaryHorizonSeconds);
    for (const item of this.state.pending) {
      item.maxPrice = Math.max(item.maxPrice, price);
      item.minPrice = Math.min(item.minPrice, price);
      item.checkpoints ||= {};
      const age = at - item.at;
      for (const seconds of horizons) {
        const name = horizonName(seconds);
        if (age >= seconds * 1_000 && !item.checkpoints[name]) {
          item.checkpoints[name] = {
            at: new Date(at).toISOString(),
            ageSeconds: age / 1_000,
            return: price / item.price - 1,
            mfe: item.maxPrice / item.price - 1,
            mae: item.minPrice / item.price - 1,
          };
        }
      }
      if (age < finalHorizon * 1_000) {
        keep.push(item);
        continue;
      }
      const outcomes = {};
      const primaryCheckpoint = item.checkpoints[primaryName];
      for (const model of Object.keys(item.actions)) {
        const action = item.actions[model].action;
        const execution = item.executions[model];
        const effectivePriceReference = execution.effectivePrice && item.quotePrice > 0
          ? execution.effectivePrice * item.price / item.quotePrice : item.price;
        const primaryPrice = item.price * (1 + primaryCheckpoint.return);
        outcomes[model] = {
          action,
          checkpoints: structuredClone(item.checkpoints),
          executed: execution.status === "simulated",
          effectivePrice: execution.effectivePrice || null,
          effectivePriceReference: execution.effectivePrice ? effectivePriceReference : null,
          afterCostReturn60m: action === "BUY" && execution.status === "simulated"
            ? primaryPrice / effectivePriceReference - 1 : null,
        };
      }
      const hybrid = outcomes.hybrid;
      const primaryExecution = item.executions.live || item.executions.hybrid;
      const primaryExecuted = primaryExecution.status === "simulated"
        || primaryExecution.status === "confirmed";
      if (primaryExecuted && (hybrid.action === "BUY" || hybrid.action === "BURN")) {
        const liveReference = primaryExecution.effectivePrice && item.quotePrice > 0
          ? primaryExecution.effectivePrice * item.price / item.quotePrice : item.price;
        const primaryPrice = item.price * (1 + primaryCheckpoint.return);
        const followReturn = hybrid.action === "BUY"
          ? primaryPrice / liveReference - 1 : primaryCheckpoint.return;
        const utility = computeProfiledUtility({
          action: hybrid.action,
          followReturn,
          positionPercentile: item.features.positionPercentile,
          mfe: primaryCheckpoint.mfe,
          mae: primaryCheckpoint.mae,
        }, this.reward);
        this.state.feedbackQueue.push({
          at: new Date(item.at).toISOString(),
          settledAt: new Date(at).toISOString(),
          action: hybrid.action,
          utility,
          positionPercentile: item.features.positionPercentile,
          followReturn60m: followReturn,
          primaryHorizonSeconds: this.reward.primaryHorizonSeconds,
          source: "hybrid-v2-profiled-executed",
        });
      }
      this.state.outcomes.push({
        at: new Date(item.at).toISOString(),
        entryPrice: item.price,
        positionPercentile: item.features.positionPercentile,
        checkpoints: structuredClone(item.checkpoints),
        outcomes,
      });
    }
    this.state.pending = keep;
    if (this.state.outcomes.length > this.runtime.retainOutcomeCount) {
      this.state.outcomes.splice(0, this.state.outcomes.length - this.runtime.retainOutcomeCount);
    }
    if (this.state.feedbackQueue.length > this.runtime.retainFeedbackCount) {
      this.state.feedbackQueue.splice(0, this.state.feedbackQueue.length - this.runtime.retainFeedbackCount);
    }
  }

  pulse() {
    return feedbackPulse(this.state.feedbackQueue, this.reward).pulse;
  }

  pulseStrength() {
    return feedbackPulse(this.state.feedbackQueue, this.reward).strength;
  }
}

export { computeProfiledUtility } from "../reward/profiled-reward.mjs";
