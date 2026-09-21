const clamp = (value, low = -1, high = 1) => Math.max(low, Math.min(high, value));

export function computeProfiledUtility({
  action,
  followReturn,
  positionPercentile,
  mfe,
  mae,
}, reward) {
  const position = Number.isFinite(positionPercentile) ? positionPercentile : 0.5;
  const positionQuality = action === "BUY" ? (0.5 - position) * 2 : (position - 0.5) * 2;
  const scale = reward.returnScale;
  const follow = Math.tanh(followReturn / scale);
  const favorable = Math.tanh(Math.max(0, mfe) / scale);
  const drawdown = Math.tanh(Math.abs(Math.min(0, mae)) / scale);
  return clamp(
    reward.followWeight * follow
      + reward.positionWeight * positionQuality
      + reward.favorableWeight * favorable
      + reward.drawdownWeight * drawdown,
  );
}

export function feedbackPulse(feedback, reward) {
  if (!feedback.length) return { pulse: "none", strength: 0, meanUtility: 0 };
  const meanUtility = feedback.reduce((sum, item) => sum + Number(item.utility || 0), 0)
    / feedback.length;
  if (Math.abs(meanUtility) <= reward.pulseDeadband) {
    return { pulse: "none", strength: 0, meanUtility };
  }
  return {
    pulse: meanUtility > 0 ? "reward" : "aversive",
    strength: Math.min(1, Math.max(reward.minimumPulseStrength, Math.abs(meanUtility))),
    meanUtility,
  };
}
