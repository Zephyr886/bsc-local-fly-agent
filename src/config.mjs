import { ACTIVE_MAINNET_V3_REGISTRY } from "./chain/registry-config.mjs";
import { SYSTEM_POLICY } from "./policy/system-policy.mjs";

export const APP_NAME = "BSC 本地果蝇 Agent";
const requestedHost = String(process.env.HOST || SYSTEM_POLICY.listener.bindHost).toLowerCase();
if (!SYSTEM_POLICY.listener.allowedHosts.includes(requestedHost)) {
  throw new Error(`HOST 仅允许本机回环地址：${SYSTEM_POLICY.listener.allowedHosts.join(", ")}`);
}
export const HOST = requestedHost;
export const PORT = Number(process.env.PORT || 8788);
export const BSC_RPC_URL = process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";

export const BSC_CHAIN_ID = ACTIVE_MAINNET_V3_REGISTRY.chainId;
export const BSC_CHAIN_HEX = `0x${BSC_CHAIN_ID.toString(16)}`;
export const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
export const PANCAKE_V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
// Flap Portal v5.14.16 (BNB Chain mainnet). It is the protocol's unified
// bonding-curve + post-migration DEX trade entry point.
export const FLAP_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
export const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const USDT = "0x55d398326f99059fF775485246999027B3197955";
export const USD1 = "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d";
export const DEAD = "0x000000000000000000000000000000000000dEaD";

export const SIMULATION_DEFAULTS = Object.freeze({
  initialQuote: 1,
  initialToken: 1_000_000,
  buyPercent: 2,
  burnPercent: 1,
  feePercent: 0.25,
  slippagePercent: 0.5,
  tickMs: 900,
  virtualSecondsPerTick: 5,
  maxEvents: 160,
});

export const SAFETY_LIMITS = Object.freeze({
  minSlippagePercent: SYSTEM_POLICY.risk.slippagePercent.min,
  maxSlippagePercent: SYSTEM_POLICY.risk.slippagePercent.max,
  maxBuyBnb: Number(SYSTEM_POLICY.risk.maxBuyBnb),
  transactionDeadlineSeconds: SYSTEM_POLICY.risk.transactionDeadlineSeconds,
});
