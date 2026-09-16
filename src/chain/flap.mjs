import { encodeFunctionData, formatEther, formatUnits, toHex } from "viem";
import { FLAP_PORTAL, SAFETY_LIMITS } from "../config.mjs";
import { toJsonSafe } from "../util.mjs";

export const FLAP_STATUS = Object.freeze({
  0: "Invalid",
  1: "Tradable",
  2: "InDuel",
  3: "Killed",
  4: "DEX",
  5: "Staged",
});

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

const stateComponents = [
  { name: "status", type: "uint8" },
  { name: "reserve", type: "uint256" },
  { name: "circulatingSupply", type: "uint256" },
  { name: "price", type: "uint256" },
  { name: "tokenVersion", type: "uint8" },
  { name: "r", type: "uint256" },
  { name: "h", type: "uint256" },
  { name: "k", type: "uint256" },
  { name: "dexSupplyThresh", type: "uint256" },
  { name: "quoteTokenAddress", type: "address" },
  { name: "nativeToQuoteSwapEnabled", type: "bool" },
  { name: "extensionID", type: "bytes32" },
  { name: "buyTaxRate", type: "uint256" },
  { name: "sellTaxRate", type: "uint256" },
  { name: "pool", type: "address" },
  { name: "progress", type: "uint256" },
  { name: "lpFeeProfile", type: "uint8" },
  { name: "dexId", type: "uint8" },
];

export const flapInspectAbi = [{
  type: "function",
  name: "getTokenV8Safe",
  stateMutability: "view",
  inputs: [{ name: "token", type: "address" }],
  outputs: [{ name: "state", type: "tuple", components: stateComponents }],
}];

const quoteComponents = [
  { name: "inputToken", type: "address" },
  { name: "outputToken", type: "address" },
  { name: "inputAmount", type: "uint256" },
];

const swapComponents = [
  ...quoteComponents,
  { name: "minOutputAmount", type: "uint256" },
  { name: "permitData", type: "bytes" },
];

// The deployed method is intentionally called with eth_call for a no-state quote.
// Marking it view locally changes neither its selector nor encoded arguments.
export const flapQuoteAbi = [{
  type: "function",
  name: "quoteExactInput",
  stateMutability: "view",
  inputs: [{ name: "params", type: "tuple", components: quoteComponents }],
  outputs: [{ name: "outputAmount", type: "uint256" }],
}];

export const flapTradeAbi = [{
  type: "function",
  name: "swapExactInput",
  stateMutability: "payable",
  inputs: [{ name: "params", type: "tuple", components: swapComponents }],
  outputs: [{ name: "outputAmount", type: "uint256" }],
}];

function asFlapState(raw) {
  const status = Number(raw.status ?? raw[0]);
  if (status === 0) return null;
  const value = (name, index) => raw[name] ?? raw[index];
  return {
    status,
    statusName: FLAP_STATUS[status] || `Unknown(${status})`,
    reserve: value("reserve", 1),
    circulatingSupply: value("circulatingSupply", 2),
    price: value("price", 3),
    tokenVersion: Number(value("tokenVersion", 4)),
    dexSupplyThresh: value("dexSupplyThresh", 8),
    quoteTokenAddress: value("quoteTokenAddress", 9),
    nativeToQuoteSwapEnabled: Boolean(value("nativeToQuoteSwapEnabled", 10)),
    extensionID: value("extensionID", 11),
    buyTaxRate: value("buyTaxRate", 12),
    sellTaxRate: value("sellTaxRate", 13),
    pool: value("pool", 14),
    progress: value("progress", 15),
  };
}

export async function inspectFlapToken(publicClient, token) {
  try {
    const raw = await publicClient.readContract({
      address: FLAP_PORTAL,
      abi: flapInspectAbi,
      functionName: "getTokenV8Safe",
      args: [token],
    });
    return asFlapState(raw);
  } catch {
    return null;
  }
}

export function assertFlapTradeable(state, side) {
  if (!state) throw new Error("不是 Flap Portal 登记的代币");
  if (state.extensionID && state.extensionID.toLowerCase() !== ZERO_BYTES32) {
    throw new Error("该 Flap 代币带有自定义扩展；当前队列不会在缺少扩展参数规范时构造实盘交易");
  }
  if (state.status === 1 || state.status === 4) return;
  if (state.status === 2 && side === "buy") return;
  throw new Error(`Flap 代币当前状态为 ${state.statusName}，不允许执行 ${side === "buy" ? "买入" : "卖出"}`);
}

function minAfterSlippage(quoted, slippagePercent) {
  const retainedBps = BigInt(Math.floor((100 - slippagePercent) * 100));
  return quoted * retainedBps / 10_000n;
}

export async function quoteFlap(publicClient, { inputToken, outputToken, inputAmount }) {
  try {
    return await publicClient.readContract({
      address: FLAP_PORTAL,
      abi: flapQuoteAbi,
      functionName: "quoteExactInput",
      args: [{ inputToken, outputToken, inputAmount }],
    });
  } catch (error) {
    const reason = error?.shortMessage || error?.message || "Portal 报价失败";
    throw new Error(`Flap Portal 无法为该方向报价：${reason}`);
  }
}

function previewWarnings(state) {
  return [
    `Flap 状态：${state.statusName}；交易统一提交到官方 Portal，Portal 决定走 bonding curve 或迁移后的 DEX。`,
    `Portal 报价不保证成交；代币买税约 ${Number(state.buyTaxRate) / 100}%、卖税约 ${Number(state.sellTaxRate) / 100}%，仍可能发生价格变化或 MEV。`,
    "本工具不替代合约审计；真实交易、恶意扩展、动态规则与流动性变化可能导致部分或全部资金损失。",
  ];
}

export async function prepareFlapSwap({ publicClient, account, token, state, side, amountIn, slippagePercent, allowance, balance }) {
  assertFlapTradeable(state, side);
  const isBuy = side === "buy";
  const inputToken = isBuy ? ZERO : token.address;
  const outputToken = isBuy ? token.address : ZERO;

  if (isBuy && state.quoteTokenAddress.toLowerCase() !== ZERO && !state.nativeToQuoteSwapEnabled) {
    throw new Error("该 Flap 代币使用 ERC-20 报价资产且未开启 BNB 自动换入，当前 BNB 实盘队列不能买入");
  }

  if (!isBuy) {
    if (balance < amountIn) throw new Error(`${token.symbol} 余额不足`);
    if (allowance < amountIn) {
      const data = encodeFunctionData({
        abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }],
        functionName: "approve",
        args: [FLAP_PORTAL, amountIn],
      });
      return toJsonSafe({
        chainId: "0x38",
        phase: "approval",
        transaction: { from: account, to: token.address, value: "0x0", data },
        preview: {
          venue: "Flap Portal",
          side,
          token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
          router: FLAP_PORTAL,
          permission: `仅授权本次计划卖出的 ${formatUnits(amountIn, token.decimals)} ${token.symbol}，不是无限授权`,
          exactAllowance: amountIn.toString(),
          next: "授权确认后会重新读取 Flap 状态与报价，并再次要求确认交换交易。",
        },
      });
    }
  }

  const quoted = await quoteFlap(publicClient, { inputToken, outputToken, inputAmount: amountIn });
  if (quoted <= 0n) throw new Error("Flap Portal 返回零报价，已阻止构造交易");
  const minOutputAmount = minAfterSlippage(quoted, slippagePercent);
  const data = encodeFunctionData({
    abi: flapTradeAbi,
    functionName: "swapExactInput",
    args: [{ inputToken, outputToken, inputAmount: amountIn, minOutputAmount, permitData: "0x" }],
  });
  return toJsonSafe({
    chainId: "0x38",
    phase: "swap",
    transaction: { from: account, to: FLAP_PORTAL, value: isBuy ? toHex(amountIn) : "0x0", data },
    preview: {
      venue: "Flap Portal",
      side,
      token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
      router: FLAP_PORTAL,
      route: [inputToken, outputToken],
      flapStatus: state.statusName,
      amountInput: isBuy ? `${formatEther(amountIn)} BNB` : `${formatUnits(amountIn, token.decimals)} ${token.symbol}`,
      quotedOutput: isBuy ? `${formatUnits(quoted, token.decimals)} ${token.symbol}` : `${formatEther(quoted)} BNB`,
      slippagePercent,
      deadlineSeconds: null,
      warnings: previewWarnings(state),
    },
  });
}

export function flapMarketFields(state) {
  if (!state) return {};
  const price = Number(formatUnits(state.price, 18));
  return {
    flap: toJsonSafe({
      portal: FLAP_PORTAL,
      status: state.status,
      statusName: state.statusName,
      tokenVersion: state.tokenVersion,
      quoteTokenAddress: state.quoteTokenAddress,
      nativeToQuoteSwapEnabled: state.nativeToQuoteSwapEnabled,
      buyTaxBps: state.buyTaxRate,
      sellTaxBps: state.sellTaxRate,
      pool: state.pool,
      progress: state.progress,
    }),
    venue: "Flap Portal",
    price: Number.isFinite(price) && price > 0 ? price : null,
    routeAvailable: state.status === 1 || state.status === 4,
  };
}

export { ZERO as NATIVE_TOKEN };
