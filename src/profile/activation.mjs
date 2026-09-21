const entries = [];
const add = (mode, section, fields) => {
  for (const field of fields) entries.push([`/spec/${section}/${field}`, mode]);
};

for (const field of ["name", "description", "tags"]) entries.push([`/metadata/${field}`, "hot"]);
add("fork-required", "compatibility", ["brainModel", "strategyEngine", "profileSchemaVersion"]);
add("next-start", "universe", ["chainId", "tokenBinding", "tokenAddress", "quotePreference"]);
add("next-start", "perception", ["marketRefreshMs", "neuralDecisionIntervalSeconds", "historyCandles",
  "minimumHealthySamples", "marketMaxAgeSeconds", "flowMaxAgeSeconds"]);
add("next-training-run", "learning", ["enabled"]);
add("next-start", "learning", ["neuralMs", "decoderThresholdHz", "checkpointEverySeconds"]);
add("next-training-run", "reward", ["settlementHorizonsSeconds", "primaryHorizonSeconds", "returnScale",
  "followWeight", "positionWeight", "favorableWeight", "drawdownWeight", "pulseDeadband",
  "minimumPulseStrength"]);
add("next-start", "strategy", ["quantThreshold", "positionBuyCeiling", "positionBurnFloor",
  "buyMaxReturn60s", "buyMaxReturn300s", "buyMaxDistanceFromLow300s", "burnMinReturn60s",
  "burnMinReboundFromLow300s", "frequencyActiveThreshold", "activeWindowSeconds", "activeMinActions",
  "activeMaxActions", "quietWindowSeconds", "quietMinActions", "quietMaxActions", "twapIntervalSeconds",
  "buyPercent", "burnPercent"]);
add("next-start", "risk", ["liveTradingEnabled", "capitalBudgetPercent", "maxPoolParticipationPercent",
  "maxBuyBnb", "slippagePercent", "dailyActionLimit", "minimumActionIntervalSeconds"]);
add("next-start", "runtime", ["autoSave", "retainDecisionCount", "retainOutcomeCount", "retainFeedbackCount"]);

export const ACTIVATION_MODES_BY_PATH = Object.freeze(Object.fromEntries(entries));

export function activationModeForPath(path) {
  const mode = ACTIVATION_MODES_BY_PATH[path];
  if (!mode) throw new Error(`未知 Profile 字段路径：${path}`);
  return mode;
}
