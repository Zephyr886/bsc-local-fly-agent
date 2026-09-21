function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const SYSTEM_POLICY = deepFreeze({
  version: 1,
  listener: {
    bindHost: "127.0.0.1",
    allowedHosts: ["127.0.0.1", "localhost", "::1"],
    profileRequestMaxBytes: 32_768,
    cartridgeRequestMaxBytes: 420_000,
  },
  profileRiskLimits: {
    capitalBudgetPercent: { min: 0.1, max: 25 },
    maxPoolParticipationPercent: { min: 0.01, max: 2 },
    maxBuyBnb: { exclusiveMin: "0" },
    slippagePercent: { min: 0.1, max: 15 },
    dailyActionLimit: { min: 1, max: 100, integer: true },
    minimumActionIntervalSeconds: { min: 60, max: 86_400, integer: true },
  },
  risk: {
    liveTradingAllowed: true,
    maxCapitalBudgetPercent: 10,
    maxPoolParticipationPercent: 0.5,
    maxBuyBnb: "0.2",
    slippagePercent: { min: 0.1, max: 15 },
    maxDailyActionLimit: 24,
    minActionIntervalSeconds: 60,
    transactionDeadlineSeconds: 300,
  },
});

const RISK_FIELDS = Object.freeze([
  "liveTradingEnabled",
  "capitalBudgetPercent",
  "maxPoolParticipationPercent",
  "maxBuyBnb",
  "slippagePercent",
  "dailyActionLimit",
  "minimumActionIntervalSeconds",
]);

function numberInRange(value, field, limits) {
  if (typeof value !== "number" || !Number.isFinite(value) ||
      value < limits.min || value > limits.max || (limits.integer && !Number.isInteger(value))) {
    throw new TypeError(`${field} 必须在 ${limits.min}–${limits.max} 范围内${limits.integer ? "且为整数" : ""}`);
  }
  return value;
}

function positiveDecimal(value, field) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ||
      !(Number(value) > 0) || !Number.isFinite(Number(value))) {
    throw new TypeError(`${field} 必须是大于 0 的十进制字符串`);
  }
  return value;
}

function restricted(restrictions, path, requested, effective, reason) {
  if (requested === effective) return effective;
  restrictions.push(Object.freeze({ path, requested, effective, reason }));
  return effective;
}

export function resolveEffectiveRisk(profileRisk, systemPolicy = SYSTEM_POLICY) {
  if (!profileRisk || typeof profileRisk !== "object" || Array.isArray(profileRisk)) {
    throw new TypeError("risk 必须是对象");
  }
  const unknown = Object.keys(profileRisk).filter((key) => !RISK_FIELDS.includes(key));
  const missing = RISK_FIELDS.filter((key) => !Object.hasOwn(profileRisk, key));
  if (unknown.length) throw new TypeError(`risk 包含未知字段：${unknown.join(", ")}`);
  if (missing.length) throw new TypeError(`risk 缺少字段：${missing.join(", ")}`);
  if (typeof profileRisk.liveTradingEnabled !== "boolean") {
    throw new TypeError("liveTradingEnabled 必须是 boolean");
  }

  const limits = systemPolicy.profileRiskLimits;
  const requested = {
    liveTradingEnabled: profileRisk.liveTradingEnabled,
    capitalBudgetPercent: numberInRange(profileRisk.capitalBudgetPercent,
      "capitalBudgetPercent", limits.capitalBudgetPercent),
    maxPoolParticipationPercent: numberInRange(profileRisk.maxPoolParticipationPercent,
      "maxPoolParticipationPercent", limits.maxPoolParticipationPercent),
    maxBuyBnb: positiveDecimal(profileRisk.maxBuyBnb, "maxBuyBnb"),
    slippagePercent: numberInRange(profileRisk.slippagePercent,
      "slippagePercent", limits.slippagePercent),
    dailyActionLimit: numberInRange(profileRisk.dailyActionLimit,
      "dailyActionLimit", limits.dailyActionLimit),
    minimumActionIntervalSeconds: numberInRange(profileRisk.minimumActionIntervalSeconds,
      "minimumActionIntervalSeconds", limits.minimumActionIntervalSeconds),
  };
  const policy = systemPolicy.risk;
  const restrictions = [];
  const effectiveRisk = {
    liveTradingEnabled: restricted(restrictions, "/spec/risk/liveTradingEnabled",
      requested.liveTradingEnabled, requested.liveTradingEnabled && policy.liveTradingAllowed,
      "system-live-trading-disabled"),
    capitalBudgetPercent: restricted(restrictions, "/spec/risk/capitalBudgetPercent",
      requested.capitalBudgetPercent,
      Math.min(requested.capitalBudgetPercent, policy.maxCapitalBudgetPercent), "system-maximum"),
    maxPoolParticipationPercent: restricted(restrictions,
      "/spec/risk/maxPoolParticipationPercent", requested.maxPoolParticipationPercent,
      Math.min(requested.maxPoolParticipationPercent, policy.maxPoolParticipationPercent),
      "system-maximum"),
    maxBuyBnb: restricted(restrictions, "/spec/risk/maxBuyBnb", requested.maxBuyBnb,
      Number(requested.maxBuyBnb) <= Number(policy.maxBuyBnb) ? requested.maxBuyBnb : policy.maxBuyBnb,
      "system-maximum"),
    slippagePercent: requested.slippagePercent,
    dailyActionLimit: restricted(restrictions, "/spec/risk/dailyActionLimit",
      requested.dailyActionLimit,
      Math.min(requested.dailyActionLimit, policy.maxDailyActionLimit), "system-maximum"),
    minimumActionIntervalSeconds: restricted(restrictions,
      "/spec/risk/minimumActionIntervalSeconds", requested.minimumActionIntervalSeconds,
      Math.max(requested.minimumActionIntervalSeconds, policy.minActionIntervalSeconds),
      "system-minimum"),
  };
  return Object.freeze({
    effectiveRisk: Object.freeze(effectiveRisk),
    restrictions: Object.freeze(restrictions),
  });
}
