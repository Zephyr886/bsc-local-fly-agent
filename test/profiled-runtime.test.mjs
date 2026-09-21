import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SimulationRuntime } from "../src/agent/simulation.mjs";
import { buildEffectiveProfile, createProfileDocument } from "../src/profile/index.mjs";
import { HybridV2Lab } from "../src/strategy/hybrid-v2.mjs";
import {
  computeProfiledUtility,
  deriveProfiledFeatures,
  ProfiledHybridV2,
} from "../src/strategy/profiled-hybrid-v2.mjs";

const FLY_A = "11111111-1111-4111-8111-111111111111";
const FLY_B = "22222222-2222-4222-8222-222222222222";

function activationContext({ flyId = FLY_A, revision = 1, spec = {}, name = "Test" } = {}) {
  const document = createProfileDocument({ flyId, revision, name, spec, now: "2026-09-19T00:00:00.000Z" });
  const effectiveProfile = buildEffectiveProfile(document);
  return Object.freeze({
    flyId,
    revision,
    profileHash: document.metadata.profileHash,
    checkpointId: "33333333-3333-4333-8333-333333333333",
    checkpointPath: `C:\\flies\\${flyId}\\service.npz`,
    effectiveProfile,
    activatedAt: "2026-09-19T00:00:00.000Z",
  });
}

test("profiled defaults preserve the current Simulation Hybrid settings and reward samples", async () => {
  const context = activationContext();
  const profiled = new ProfiledHybridV2(null, {
    effectiveProfile: context.effectiveProfile,
    initialQuote: 1,
    initialToken: 1_000_000,
    initialBnb: 0.05,
  });
  const legacy = new HybridV2Lab(null, {
    ...context.effectiveProfile.spec.strategy,
    capitalBudgetPercent: 10,
    maxPoolParticipationPercent: 0.5,
    initialQuote: 1,
    initialToken: 1_000_000,
    initialBnb: 0.05,
  });
  assert.deepEqual(profiled.settings, legacy.settings);
  const observation = {
    neural: { side: "HOLD", difference_hz: 0, gate_spikes: 0 },
    features: {
      price: 1, quotePrice: 1, tokenReserve: 1_000_000, liquidityQuote: 100,
      positionPercentile: 0.5, activity: 0.5, dataHealthy: false,
      minIntervalSeconds: 60, buyTaxPercent: 0,
    },
    market: { at: Date.parse("2026-09-19T00:00:00.000Z") },
    config: { fullThresholdHz: 2, buyPercent: 10, burnPercent: 10, gasBnb: 0 },
  };
  const legacyDecision = legacy.observe(structuredClone(observation));
  const profiledDecision = profiled.observe(structuredClone(observation));
  assert.deepEqual(profiledDecision.scores, legacyDecision.scores);
  assert.deepEqual(profiledDecision.actions, legacyDecision.actions);
  assert.deepEqual(profiledDecision.executions, legacyDecision.executions);

  const fixture = JSON.parse(await readFile(new URL("./fixtures/fly-profile-v1-baseline.json", import.meta.url), "utf8"));
  for (const sample of fixture.rewardSamples) {
    const followReturn = sample.settlementPrice / sample.entryPrice - 1;
    const utility = computeProfiledUtility({
      action: sample.action,
      followReturn,
      positionPercentile: sample.positionPercentile,
      mfe: Math.max(0, followReturn),
      mae: Math.min(0, followReturn),
    }, context.effectiveProfile.spec.reward);
    assert.ok(Math.abs(utility - sample.expectedUtility) < 1e-12, sample.name);
  }
});

test("two reward Profiles produce different utility for the same outcome", () => {
  const conservative = activationContext({ spec: { reward: {
    followWeight: 0.2,
    positionWeight: 0.7,
    favorableWeight: 0.05,
    drawdownWeight: -0.05,
  } } });
  const trend = activationContext({ flyId: FLY_B, spec: { reward: {
    followWeight: 0.9,
    positionWeight: 0.05,
    favorableWeight: 0.05,
    drawdownWeight: 0,
  } } });
  const outcome = { action: "BUY", followReturn: 0.08, positionPercentile: 0.8, mfe: 0.1, mae: -0.02 };
  const a = computeProfiledUtility(outcome, conservative.effectiveProfile.spec.reward);
  const b = computeProfiledUtility(outcome, trend.effectiveProfile.spec.reward);
  assert.notEqual(a, b);
  assert.ok(b > a);
});

test("Profile perception controls health thresholds and minimum action interval", () => {
  const context = activationContext({ spec: {
    perception: { minimumHealthySamples: 80, marketMaxAgeSeconds: 9, flowMaxAgeSeconds: 11 },
    risk: { minimumActionIntervalSeconds: 120 },
  } });
  const now = Date.parse("2026-09-19T00:10:00.000Z");
  const candles = Array.from({ length: 79 }, (_, index) => ({
    time: now - (78 - index) * 1_000, close: 1 + index / 10_000, low: 1, high: 1.1, open: 1, volume: 1,
  }));
  const market = { positionPercentile: 0.5, position: 0, activity: 0.4, priceActivity: 0.4,
    volumeActivity: 0.4, minIntervalSeconds: 5, volumeRatio: 1, priceSamples: 79 };
  const flow = { scannedAt: new Date(now).toISOString(), windows: { m5: { buyVolume: 1, sellVolume: 1 } } };
  const token = { liquidity: { quote: 100, token: 100 }, quotePrice: 1 };
  const unhealthy = deriveProfiledFeatures({ candles, market, flow, token, now,
    updatedAt: new Date(now).toISOString() }, context.effectiveProfile);
  assert.equal(unhealthy.dataHealthy, false);
  assert.equal(unhealthy.minIntervalSeconds, 120);

  candles.push({ ...candles.at(-1), time: now, close: 1.01 });
  market.priceSamples = 80;
  const healthy = deriveProfiledFeatures({ candles, market, flow, token, now,
    updatedAt: new Date(now).toISOString() }, context.effectiveProfile);
  assert.equal(healthy.dataHealthy, true);
});

test("SimulationRuntime sends a fixed Profile identity and Profile parameters to the worker", async () => {
  const context = activationContext({ spec: {
    perception: { marketRefreshMs: 2_000, neuralDecisionIntervalSeconds: 20, historyCandles: 40 },
    learning: { enabled: false, neuralMs: 750, decoderThresholdHz: 3, checkpointEverySeconds: 90 },
  } });
  const requests = [];
  const client = {
    status: "ready", error: null, graph: {}, checkpoint: context.checkpointPath,
    start() {},
    observe(request) { requests.push(request); return null; },
    snapshot() { return { status: this.status }; },
    async stop() {},
  };
  const runtime = new SimulationRuntime({ neuralClient: client });
  await runtime.start({
    activationContext: context,
    tokenAddress: "0x0000000000000000000000000000000000000001",
  });
  clearInterval(runtime.timer);
  runtime.timer = null;
  clearInterval(runtime.marketTimer);
  runtime.marketTimer = null;

  assert.equal(runtime.marketRefreshMs, 2_000);
  assert.equal(runtime.snapshot().market.candles.length, 40);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].flyId, FLY_A);
  assert.equal(requests[0].profileRevision, 1);
  assert.equal(requests[0].profileHash, context.profileHash);
  assert.equal(requests[0].modelVersion, "malecns-v1");
  assert.equal(requests[0].learning, false);
  assert.equal(requests[0].neuralMs, 750);
  assert.equal(requests[0].thresholdHz, 3);
  assert.equal(requests[0].checkpointEverySeconds, 90);
  assert.equal(requests[0].history.length, 40);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.flyId, FLY_A);
  assert.equal(snapshot.profileRevision, 1);
  assert.equal(snapshot.profileHash, context.profileHash);
  assert.equal(snapshot.trainingRunId, null);
  assert.equal(snapshot.effectiveProfileSummary.learning.neuralMs, 750);
  await runtime.close();
});

test("fixed token Profile rejects another token while device-selected permits token changes", async () => {
  const fixedAddress = "0x0000000000000000000000000000000000000001";
  const fixed = activationContext({ spec: { universe: { tokenBinding: "fixed", tokenAddress: fixedAddress } } });
  const runtime = new SimulationRuntime();
  await assert.rejects(runtime.start({
    activationContext: fixed,
    tokenAddress: "0x0000000000000000000000000000000000000002",
  }), /固定代币/);

  const selected = activationContext();
  await runtime.start({ activationContext: selected, tokenAddress: fixedAddress });
  runtime.stop();
  await runtime.start({
    activationContext: selected,
    tokenAddress: "0x0000000000000000000000000000000000000002",
  });
  runtime.stop();
});

test("Profile changes invalidate old live proposals", () => {
  const runtime = new SimulationRuntime();
  const first = activationContext();
  const second = activationContext({ flyId: FLY_B });
  runtime.setActivationContext(first);
  runtime.state.liveProposals = [{
    decisionAt: "2026-09-19T00:00:00.000Z",
    tokenAddress: "0x0000000000000000000000000000000000000001",
    side: "buy",
    amount: 1,
    status: "approved",
    expiresAt: Date.now() + 60_000,
    activation: { flyId: first.flyId, revision: first.revision, profileHash: first.profileHash },
  }];
  runtime.setActivationContext(second);
  assert.equal(runtime.state.liveProposals[0].status, "profile-changed");
  assert.throws(() => runtime.validateLiveProposal({
    decisionAt: "2026-09-19T00:00:00.000Z",
    tokenAddress: "0x0000000000000000000000000000000000000001",
    side: "buy",
    amount: 1,
  }), /已经使用或失效/);
});
