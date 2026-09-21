function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const DEFAULT_PROFILE_SPEC = deepFreeze({
  compatibility: {
    brainModel: "malecns-v1",
    strategyEngine: "hybrid-v2-profiled",
    profileSchemaVersion: 1,
  },
  universe: {
    chainId: 56,
    tokenBinding: "device-selected",
    tokenAddress: null,
    quotePreference: "USDT",
  },
  perception: {
    marketRefreshMs: 1_000,
    neuralDecisionIntervalSeconds: 10,
    historyCandles: 36,
    minimumHealthySamples: 60,
    marketMaxAgeSeconds: 15,
    flowMaxAgeSeconds: 20,
  },
  learning: {
    enabled: true,
    neuralMs: 500,
    decoderThresholdHz: 2,
    checkpointEverySeconds: 60,
  },
  reward: {
    settlementHorizonsSeconds: [300, 900, 3_600],
    primaryHorizonSeconds: 3_600,
    returnScale: 0.05,
    followWeight: 0.65,
    positionWeight: 0.2,
    favorableWeight: 0.1,
    drawdownWeight: -0.05,
    pulseDeadband: 0,
    minimumPulseStrength: 0.05,
  },
  strategy: {
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
    quietWindowSeconds: 3_600,
    quietMinActions: 1,
    quietMaxActions: 5,
    twapIntervalSeconds: 300,
    buyPercent: 2,
    burnPercent: 1,
  },
  risk: {
    liveTradingEnabled: false,
    capitalBudgetPercent: 10,
    maxPoolParticipationPercent: 0.5,
    maxBuyBnb: "0.2",
    slippagePercent: 0.5,
    dailyActionLimit: 24,
    minimumActionIntervalSeconds: 60,
  },
  runtime: {
    autoSave: true,
    retainDecisionCount: 500,
    retainOutcomeCount: 1_000,
    retainFeedbackCount: 100,
  },
});

export function cloneDefaultProfileSpec() {
  return structuredClone(DEFAULT_PROFILE_SPEC);
}
