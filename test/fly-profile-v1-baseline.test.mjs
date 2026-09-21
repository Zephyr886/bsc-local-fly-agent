import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { windowsRuntimePaths } from "../desktop/bootstrap.mjs";
import { SimulationRuntime } from "../src/agent/simulation.mjs";
import { SAFETY_LIMITS, SIMULATION_DEFAULTS } from "../src/config.mjs";
import { deriveHybridFeatures, HYBRID_V2_DEFAULTS, HybridV2Lab } from "../src/strategy/hybrid-v2.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "fly-profile-v1-baseline.json");
const fixtureText = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureText);
const profile = fixture.profileSpec;

test("Fly Profile v1 baseline fixture contains no secret-bearing fields or large state", () => {
  assert.ok(Buffer.byteLength(fixtureText) < 16_384);
  assert.equal(fixture.v3Fixture.containsRealCheckpoint, false);
  assert.doesNotMatch(fixtureText, /privateKey|mnemonic|password|rpcUrl|apiKey|calldata/i);
});

test("balanced Profile target maps to the current effective simulation defaults", async () => {
  assert.equal(profile.universe.chainId, 56);
  assert.equal(profile.perception.marketRefreshMs, 1_000);
  assert.equal(profile.learning.neuralMs, 500);
  assert.equal(profile.learning.decoderThresholdHz, 2);
  assert.deepEqual(profile.reward.settlementHorizonsSeconds, [300, 900, 3_600]);
  assert.equal(profile.reward.primaryHorizonSeconds, 3_600);
  assert.equal(profile.risk.maxBuyBnb, String(SAFETY_LIMITS.maxBuyBnb));
  assert.equal(profile.risk.slippagePercent, SIMULATION_DEFAULTS.slippagePercent);

  const runtime = new SimulationRuntime();
  try {
    await runtime.start({
      tokenAddress: "0x0000000000000000000000000000000000000001",
      initialQuote: fixture.legacyEffectiveOverrides.initialQuote,
      initialToken: fixture.legacyEffectiveOverrides.initialToken,
    });
    clearInterval(runtime.timer);
    runtime.timer = null;

    const effectiveStrategy = {
      ...HYBRID_V2_DEFAULTS,
      initialQuote: fixture.legacyEffectiveOverrides.initialQuote,
      initialToken: fixture.legacyEffectiveOverrides.initialToken,
      initialBnb: fixture.legacyEffectiveOverrides.initialBnb,
      buyPercent: SIMULATION_DEFAULTS.buyPercent,
      burnPercent: SIMULATION_DEFAULTS.burnPercent,
      twapIntervalSeconds: 300,
    };
    for (const [key, value] of Object.entries(profile.strategy)) {
      assert.equal(runtime.hybrid.settings[key], value, `strategy.${key}`);
      assert.equal(effectiveStrategy[key], value, `legacy mapping for strategy.${key}`);
    }
    assert.equal(runtime.config.buyPercent, profile.strategy.buyPercent);
    assert.equal(runtime.config.burnPercent, profile.strategy.burnPercent);
    assert.equal(runtime.config.fullFeePercent, fixture.legacyEffectiveOverrides.feePercent);
    assert.equal(runtime.config.fullGasBnb, fixture.legacyEffectiveOverrides.gasBnb);
    assert.equal(runtime.config.fullThresholdHz, profile.learning.decoderThresholdHz);
    assert.equal(runtime.marketRefreshMs, profile.perception.marketRefreshMs);
    assert.equal(runtime.snapshot().market.candles.length, profile.perception.historyCandles);
  } finally {
    runtime.reset();
  }
});

test("Profile health thresholds reproduce the current market-data boundary", () => {
  const now = Date.parse("2026-09-19T00:00:00.000Z");
  const candles = Array.from({ length: profile.perception.minimumHealthySamples }, (_, index) => ({
    time: now - (profile.perception.minimumHealthySamples - index) * 1_000,
    close: 1 + index / 10_000,
    low: 1 + index / 10_000,
  }));
  const market = { positionPercentile: 0.5, position: 0, activity: 0.5, priceActivity: 0.5,
    volumeActivity: 0.5, minIntervalSeconds: 60, volumeRatio: 1,
    priceSamples: profile.perception.minimumHealthySamples };
  const flow = { scannedAt: new Date(now - profile.perception.flowMaxAgeSeconds * 1_000).toISOString(),
    error: null, windows: { m5: { buyVolume: 1, sellVolume: 1 } } };
  const token = { quotePrice: 1, buyTaxPercent: 0, liquidity: { quote: 100, token: 100 } };
  const healthy = deriveHybridFeatures({ candles, market, flow, token, now,
    updatedAt: new Date(now - profile.perception.marketMaxAgeSeconds * 1_000).toISOString() });
  assert.equal(healthy.dataHealthy, true);

  const stale = deriveHybridFeatures({ candles, market, flow, token, now,
    updatedAt: new Date(now - (profile.perception.marketMaxAgeSeconds * 1_000 + 1)).toISOString() });
  assert.equal(stale.dataHealthy, false);
});

test("default Profile reward samples match the legacy Hybrid V2 utility formula", () => {
  for (const sample of fixture.rewardSamples) {
    const hybrid = new HybridV2Lab();
    hybrid.state.pending = [{
      at: 0,
      price: sample.entryPrice,
      quotePrice: sample.entryPrice,
      features: { positionPercentile: sample.positionPercentile },
      actions: { hybrid: { action: sample.action } },
      executions: { hybrid: { status: "simulated", effectivePrice: null } },
      maxPrice: sample.entryPrice,
      minPrice: sample.entryPrice,
      checkpoints: {},
    }];
    hybrid.settle(profile.reward.primaryHorizonSeconds * 1_000, sample.settlementPrice);
    assert.ok(Math.abs(hybrid.state.feedbackQueue[0].utility - sample.expectedUtility) < 1e-12, sample.name);
  }
});

test("Windows mutable Profile data stays under LOCALAPPDATA/FLAP Fly Agent", () => {
  const localAppData = "C:\\Users\\Alice\\AppData\\Local";
  const userData = win32.join(localAppData, "FLAP Fly Agent");
  const runtimeRoot = "C:\\Program Files\\FLAP Fly Agent\\resources";
  const paths = windowsRuntimePaths({ userData, runtimeRoot });
  assert.equal(win32.normalize(paths.dataRoot), win32.join(userData, "data"));
  assert.equal(win32.normalize(paths.workRoot), win32.join(userData, "work"));
  assert.ok(win32.normalize(paths.dataRoot).startsWith(`${win32.normalize(userData)}\\`));
  assert.ok(!win32.normalize(paths.dataRoot).startsWith(`${win32.normalize(runtimeRoot)}\\`));
});
