import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { bsc } from "viem/chains";
import {
  BSC_CHAIN_HEX,
  BSC_RPC_URL,
  PANCAKE_V2_FACTORY,
  PANCAKE_V2_ROUTER,
  FLAP_PORTAL,
  SAFETY_LIMITS,
  USDT,
  WBNB,
} from "../config.mjs";
import { toJsonSafe } from "../util.mjs";
import { flapMarketFields, inspectFlapToken, prepareFlapSwap } from "./flap.mjs";

const erc20Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];

const factoryAbi = [{
  type: "function", name: "getPair", stateMutability: "view",
  inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
  outputs: [{ name: "pair", type: "address" }],
}];

const pairAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ name: "reserve0", type: "uint112" }, { name: "reserve1", type: "uint112" }, { name: "blockTimestampLast", type: "uint32" }] },
];

const routerAbi = [
  { type: "function", name: "getAmountsOut", stateMutability: "view", inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }], outputs: [{ name: "amounts", type: "uint256[]" }] },
  { type: "function", name: "swapExactETHForTokensSupportingFeeOnTransferTokens", stateMutability: "payable", inputs: [{ name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }], outputs: [] },
  { type: "function", name: "swapExactTokensForETHSupportingFeeOnTransferTokens", stateMutability: "nonpayable", inputs: [{ name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }], outputs: [] },
];

const ZERO = "0x0000000000000000000000000000000000000000";
const publicClient = createPublicClient({ chain: bsc, transport: http(BSC_RPC_URL, { timeout: 8_000, retryCount: 1 }) });

export function normalizeAddress(value, label = "代币地址") {
  if (!isAddress(value, { strict: false })) throw new Error(`${label}不是有效的 EVM 地址`);
  return getAddress(value);
}

async function safeRead(request, fallback) {
  try { return await publicClient.readContract(request); } catch { return fallback; }
}

export async function readTokenMetadata(address) {
  const token = normalizeAddress(address);
  const code = await publicClient.getCode({ address: token });
  if (!code || code === "0x") throw new Error("该地址在 BSC 主网上没有合约代码");
  const [name, symbol, decimals] = await Promise.all([
    safeRead({ address: token, abi: erc20Abi, functionName: "name" }, "Unknown Token"),
    safeRead({ address: token, abi: erc20Abi, functionName: "symbol" }, "TOKEN"),
    safeRead({ address: token, abi: erc20Abi, functionName: "decimals" }, 18),
  ]);
  const flapState = await inspectFlapToken(publicClient, token);
  const market = flapState ? { ...(await discoverMarket(token, Number(decimals))), ...flapMarketFields(flapState) } : await discoverMarket(token, Number(decimals));
  return { address: token, name: String(name).slice(0, 80), symbol: String(symbol).slice(0, 24), decimals: Number(decimals), ...market };
}

async function getPair(tokenA, tokenB) {
  const pair = await publicClient.readContract({ address: PANCAKE_V2_FACTORY, abi: factoryAbi, functionName: "getPair", args: [tokenA, tokenB] });
  return String(pair).toLowerCase() === ZERO ? null : getAddress(pair);
}

async function pairPrice(pair, token, tokenDecimals, quote, quoteDecimals) {
  const [token0, reserves] = await Promise.all([
    publicClient.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
    publicClient.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
  ]);
  const tokenIs0 = String(token0).toLowerCase() === token.toLowerCase();
  const rawToken = tokenIs0 ? reserves[0] : reserves[1];
  const rawQuote = tokenIs0 ? reserves[1] : reserves[0];
  const tokenReserve = Number(formatUnits(rawToken, tokenDecimals));
  const quoteReserve = Number(formatUnits(rawQuote, quoteDecimals));
  return {
    pair,
    quoteAddress: quote,
    quoteSymbol: quote.toLowerCase() === WBNB.toLowerCase() ? "WBNB" : "USDT",
    price: tokenReserve > 0 ? quoteReserve / tokenReserve : null,
    liquidityQuote: quoteReserve,
  };
}

export async function discoverMarket(tokenAddress, tokenDecimals = 18) {
  const token = normalizeAddress(tokenAddress);
  const [wbnbPair, usdtPair] = await Promise.all([getPair(token, WBNB), getPair(token, USDT)]);
  const candidates = [];
  if (wbnbPair) candidates.push(await pairPrice(wbnbPair, token, tokenDecimals, WBNB, 18));
  if (usdtPair) candidates.push(await pairPrice(usdtPair, token, tokenDecimals, USDT, 18));
  candidates.sort((a, b) => b.liquidityQuote - a.liquidityQuote);
  if (!candidates.length) return { pair: null, quoteAddress: null, quoteSymbol: null, price: null, liquidityQuote: 0, routeAvailable: false };
  return { ...candidates[0], routeAvailable: true };
}

async function quotePath(amountIn, paths) {
  const viable = [];
  for (const path of paths) {
    if (new Set(path.map((item) => item.toLowerCase())).size !== path.length) continue;
    try {
      const amounts = await publicClient.readContract({ address: PANCAKE_V2_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, path] });
      viable.push({ path, amounts, output: amounts.at(-1) });
    } catch { /* no viable route */ }
  }
  viable.sort((a, b) => a.output === b.output ? 0 : a.output > b.output ? -1 : 1);
  if (!viable.length) throw new Error("PancakeSwap V2 未找到可用的 WBNB 路由");
  return viable[0];
}

function commonPreview({ token, side, amountInput, amountOutput, path, slippagePercent }) {
  return {
    side,
    token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    router: PANCAKE_V2_ROUTER,
    route: path,
    amountInput,
    quotedOutput: amountOutput,
    slippagePercent,
    deadlineSeconds: SAFETY_LIMITS.transactionDeadlineSeconds,
    warnings: [
      "报价来自 PancakeSwap V2 当前储备，不保证成交；抢跑、价格变化和代币税可能导致失败或更差结果。",
      "本工具不检测蜜罐、黑名单、暂停交易、动态税或恶意合约；真实交易可能损失全部投入。",
    ],
  };
}

export async function prepareSwap(input) {
  const account = normalizeAddress(input.account, "钱包地址");
  const tokenAddress = normalizeAddress(input.tokenAddress);
  if ([WBNB, USDT].some((item) => item.toLowerCase() === tokenAddress.toLowerCase())) throw new Error("基础路由资产不作为目标代币交易");
  const side = input.side === "sell" ? "sell" : input.side === "buy" ? "buy" : null;
  if (!side) throw new Error("交易方向必须是 buy 或 sell");
  const slippagePercent = Number(input.slippagePercent);
  if (!Number.isFinite(slippagePercent) || slippagePercent < SAFETY_LIMITS.minSlippagePercent || slippagePercent > SAFETY_LIMITS.maxSlippagePercent) {
    throw new Error(`滑点必须在 ${SAFETY_LIMITS.minSlippagePercent}%–${SAFETY_LIMITS.maxSlippagePercent}% 之间`);
  }
  const token = await readTokenMetadata(tokenAddress);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SAFETY_LIMITS.transactionDeadlineSeconds);

  if (side === "buy") {
    const amountIn = parseEther(String(input.amount));
    if (amountIn <= 0n) throw new Error("买入 BNB 数量必须大于 0");
    if (amountIn > parseEther(String(SAFETY_LIMITS.maxBuyBnb))) throw new Error(`单笔买入安全上限为 ${SAFETY_LIMITS.maxBuyBnb} BNB`);
    const balance = await publicClient.getBalance({ address: account });
    if (balance <= amountIn) throw new Error("BNB 余额不足：还需预留 Gas");
    if (token.flap) {
      const state = await inspectFlapToken(publicClient, token.address);
      return prepareFlapSwap({ publicClient, account, token, state, side, amountIn, slippagePercent });
    }
    const quote = await quotePath(amountIn, [[WBNB, token.address], [WBNB, USDT, token.address]]);
    const minOut = quote.output * BigInt(Math.floor((100 - slippagePercent) * 100)) / 10_000n;
    const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [minOut, quote.path, account, deadline] });
    return toJsonSafe({
      chainId: BSC_CHAIN_HEX,
      phase: "swap",
      transaction: { from: account, to: PANCAKE_V2_ROUTER, value: toHex(amountIn), data },
      preview: commonPreview({ token, side, amountInput: `${formatEther(amountIn)} BNB`, amountOutput: `${formatUnits(quote.output, token.decimals)} ${token.symbol}`, path: quote.path, slippagePercent }),
    });
  }

  const amountIn = parseUnits(String(input.amount), token.decimals);
  if (amountIn <= 0n) throw new Error(`卖出 ${token.symbol} 数量必须大于 0`);
  const [balance, allowance] = await Promise.all([
    publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "allowance", args: [account, token.flap ? FLAP_PORTAL : PANCAKE_V2_ROUTER] }),
  ]);
  if (token.flap) {
    const state = await inspectFlapToken(publicClient, token.address);
    return prepareFlapSwap({ publicClient, account, token, state, side, amountIn, slippagePercent, allowance, balance });
  }
  if (balance < amountIn) throw new Error(`${token.symbol} 余额不足`);
  if (allowance < amountIn) {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PANCAKE_V2_ROUTER, amountIn] });
    return toJsonSafe({
      chainId: BSC_CHAIN_HEX,
      phase: "approval",
      transaction: { from: account, to: token.address, value: "0x0", data },
      preview: {
        side, token: { address: token.address, symbol: token.symbol, decimals: token.decimals }, router: PANCAKE_V2_ROUTER,
        permission: `仅授权本次计划卖出的 ${formatUnits(amountIn, token.decimals)} ${token.symbol}，不是无限授权`,
        exactAllowance: amountIn.toString(),
        next: "授权确认后会重新读取报价，并再次要求你在钱包中确认交换交易。",
      },
    });
  }
  const quote = await quotePath(amountIn, [[token.address, WBNB], [token.address, USDT, WBNB]]);
  const minOut = quote.output * BigInt(Math.floor((100 - slippagePercent) * 100)) / 10_000n;
  const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [amountIn, minOut, quote.path, account, deadline] });
  return toJsonSafe({
    chainId: BSC_CHAIN_HEX,
    phase: "swap",
    transaction: { from: account, to: PANCAKE_V2_ROUTER, value: "0x0", data },
    preview: commonPreview({ token, side, amountInput: `${formatUnits(amountIn, token.decimals)} ${token.symbol}`, amountOutput: `${formatEther(quote.output)} BNB`, path: quote.path, slippagePercent }),
  });
}

export async function readReceipt(hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw new Error("交易哈希无效");
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return toJsonSafe({ found: true, status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed });
  } catch {
    return { found: false, status: "pending" };
  }
}

export function chainSafetySummary() {
  return {
    chainId: BSC_CHAIN_HEX,
    rpc: BSC_RPC_URL.replace(/([?&](?:key|token|apikey)=)[^&]+/gi, "$1***"),
    router: PANCAKE_V2_ROUTER,
    flapPortal: FLAP_PORTAL,
    exactApprovalOnly: true,
    maxBuyBnb: SAFETY_LIMITS.maxBuyBnb,
    maxSlippagePercent: SAFETY_LIMITS.maxSlippagePercent,
  };
}
