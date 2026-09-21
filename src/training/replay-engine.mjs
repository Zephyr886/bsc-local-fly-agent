import { createHash } from "node:crypto";

import { canonicalJson } from "../profile/index.mjs";
import { deriveProfiledFeatures, ProfiledHybridV2 } from "../strategy/profiled-hybrid-v2.mjs";

function round(value, digits = 8) {
  return Number(Number(value || 0).toFixed(digits));
}

async function waitForReady(client, timeoutMs = 60_000) {
  client.start();
  const deadline = Date.now() + timeoutMs;
  while (client.status !== "ready") {
    if (["error", "setup-required"].includes(client.status)) throw new Error(client.error || "MaleCNS worker 未就绪");
    if (Date.now() >= deadline) throw new Error("等待 MaleCNS worker 就绪超时");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function finalizeMetrics({ events, neuralResults, hybrid, assumptions, dataset }) {
  const actionCounts = { BUY: 0, SELL: 0, HOLD: 0 };
  const blockedReasons = {};
  let hybridAllowed = 0;
  const nav = [];
  for (const event of events) {
    const action = event.actions.hybrid.action === "BURN" ? "SELL" : event.actions.hybrid.action;
    actionCounts[action] += 1;
    const execution = event.executions.hybrid;
    if (execution.status === "simulated") hybridAllowed += 1;
    if (execution.reason) blockedReasons[execution.reason] = (blockedReasons[execution.reason] || 0) + 1;
    const account = event.account;
    nav.push(account.quote + account.token * event.price + account.bnb);
  }
  let peak = nav[0] ?? 0;
  let maxDrawdown = 0;
  for (const value of nav) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }
  const feedback = hybrid.state.feedbackQueue || [];
  const durationSeconds = dataset.observations.length > 1
    ? (Date.parse(dataset.observations.at(-1).at) - Date.parse(dataset.observations[0].at)) / 1_000 : 0;
  const deterministic = {
    observations: events.length,
    actionCounts,
    hybridAllowed,
    blockedReasons,
    simulatedNetAssetValue: round(nav.at(-1)),
    maxDrawdown: round(maxDrawdown),
    actionFrequencyPerHour: durationSeconds > 0 ? round(hybridAllowed * 3_600 / durationSeconds) : 0,
    averageUtility: feedback.length
      ? round(feedback.reduce((sum, item) => sum + Number(item.utility || 0), 0) / feedback.length) : 0,
    assumptions: {
      samples: dataset.observations.length,
      feePercent: assumptions.feePercent,
      slippagePercent: assumptions.slippagePercent,
      gasBnb: assumptions.gasBnb,
      simulationOnly: true,
    },
  };
  return {
    ...deterministic,
    deterministicSummaryHash: `sha256:${createHash("sha256").update(canonicalJson(deterministic)).digest("hex")}`,
    performance: {
      averageNeuralComputeSeconds: neuralResults.length
        ? round(neuralResults.reduce((sum, item) => sum + Number(item.compute_seconds || 0), 0) / neuralResults.length) : 0,
      peakRssMb: round(Math.max(0, ...neuralResults.map((item) => Number(item.rssMb || 0))), 3),
    },
  };
}

export async function runDeterministicReplay({
  client, effectiveProfile, identity, dataset, learning, readyTimeoutMs,
}) {
  await waitForReady(client, readyTimeoutMs);
  const assumptions = dataset.assumptions;
  const hybrid = new ProfiledHybridV2(null, {
    effectiveProfile,
    initialQuote: assumptions.initialQuote,
    initialToken: assumptions.initialToken,
    initialBnb: assumptions.initialBnb,
  });
  const events = [];
  const neuralResults = [];
  for (const observation of dataset.observations) {
    const at = Date.parse(observation.at);
    const candles = observation.history.map((close, index, values) => ({
      time: at - (values.length - 1 - index) * 1_000,
      open: close, high: close, low: close, close, volume: 1,
    }));
    const features = deriveProfiledFeatures({
      candles,
      market: observation.market,
      flow: observation.flow,
      token: observation.token,
      now: at,
      updatedAt: observation.market.updatedAt,
    }, effectiveProfile);
    const neural = await client.observe({
      tokenAddress: dataset.tokenAddress,
      symbol: dataset.symbol,
      history: observation.history,
      price: observation.history.at(-1),
      pulse: hybrid.pulse(),
      pulseStrength: hybrid.pulseStrength(),
      learning,
      neuralMs: effectiveProfile.spec.learning.neuralMs,
      thresholdHz: effectiveProfile.spec.learning.decoderThresholdHz,
      checkpointEverySeconds: effectiveProfile.spec.learning.checkpointEverySeconds,
      flyId: identity.flyId,
      profileRevision: identity.profileRevision,
      profileHash: identity.profileHash,
      modelVersion: identity.modelVersion,
    });
    if (!neural) throw new Error("MaleCNS worker 在回放期间未返回观察结果");
    neuralResults.push(neural);
    const event = hybrid.observe({
      neural,
      features,
      market: { at },
      config: {
        buyPercent: effectiveProfile.spec.strategy.buyPercent,
        burnPercent: effectiveProfile.spec.strategy.burnPercent,
        fullFeePercent: assumptions.feePercent,
        fullGasBnb: assumptions.gasBnb,
        fullThresholdHz: effectiveProfile.spec.learning.decoderThresholdHz,
      },
    });
    const account = hybrid.state.accounts.hybrid;
    events.push({ ...event, price: features.price, account: {
      quote: account.quote, token: account.token, bnb: account.bnb,
    } });
  }
  return {
    metrics: finalizeMetrics({ events, neuralResults, hybrid, assumptions, dataset }),
    hybrid: hybrid.snapshot(),
  };
}
