import { clamp, createPrng, seedFromText } from "../util.mjs";

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export class MarketObserver {
  constructor({ tokenAddress, initialPrice, liquidityQuote = 250, mode = "synthetic", source = null } = {}) {
    this.tokenAddress = tokenAddress;
    this.mode = mode === "live" ? "live" : "synthetic";
    this.source = source || (this.mode === "live" ? "BSC 链上现货" : "CA 确定性合成行情");
    this.random = createPrng(seedFromText(`${tokenAddress}:market`));
    this.at = this.mode === "live" ? Date.now() : Date.now() - 120 * 5_000;
    this.price = initialPrice > 0 ? Number(initialPrice) : 0.000001 * (0.75 + this.random());
    this.initialPrice = this.price;
    this.liquidityQuote = Math.max(25, finite(liquidityQuote, 250));
    this.candles = [];
    this.trades = [];
    this.index = 0;
    if (this.mode === "synthetic") for (let i = 0; i < 120; i += 1) this.advance({ warmup: true });
  }

  regime(index = this.index) {
    if (this.mode === "live") {
      const recent = this.candles.slice(-60);
      const first = recent[0]?.open;
      const last = recent.at(-1)?.close;
      const change = first > 0 && last > 0 ? last / first - 1 : 0;
      if (change <= -0.01) return { key: "decline", label: "链上持续下跌", drift: change };
      if (change >= 0.01) return { key: "expansion", label: "链上快速拉升", drift: change };
      if (change < 0) return { key: "distribution", label: "链上弱势震荡", drift: change };
      return { key: "rebound", label: "链上温和走强", drift: change };
    }
    const phase = index % 180;
    if (phase < 45) return { key: "decline", label: "持续下跌", drift: -0.0075 };
    if (phase < 82) return { key: "rebound", label: "低位反弹", drift: 0.0105 };
    if (phase < 125) return { key: "distribution", label: "高位分歧", drift: -0.0035 };
    return { key: "expansion", label: "快速拉升", drift: 0.012 };
  }

  advance({ warmup = false, spotPrice = null, now = null } = {}) {
    if (this.mode === "live") return this.observeSpot(spotPrice, now);
    this.index += 1;
    this.at += 5_000;
    const regime = this.regime();
    const open = this.price;
    const wave = Math.sin(this.index / 4.2) * 0.0045;
    const noise = (this.random() - 0.5) * 0.010;
    const shock = this.index % 29 === 0 ? (regime.drift >= 0 ? 0.028 : -0.025) : 0;
    const logReturn = clamp(regime.drift + wave + noise + shock, -0.08, 0.08);
    const close = Math.max(1e-18, open * Math.exp(logReturn));
    const wick = Math.abs(logReturn) * (0.25 + this.random() * 0.25);
    const high = Math.max(open, close) * (1 + wick);
    const low = Math.min(open, close) * (1 - Math.min(0.4, wick));
    const quoteVolume = this.liquidityQuote * clamp(0.0015 + Math.abs(logReturn) * 0.11 + this.random() * 0.002, 0.001, 0.02);
    const direction = logReturn >= 0 ? "buy" : "sell";
    this.price = close;
    this.candles.push({ time: this.at, open, high, low, close, volume: quoteVolume });
    this.trades.push({ at: this.at, direction, quoteAmount: quoteVolume, price: close });
    this.candles = this.candles.slice(-900);
    this.trades = this.trades.filter((trade) => trade.at >= this.at - 3_600_000).slice(-900);
    return { at: this.at, open, high, low, close, logReturn, quoteVolume, direction, regime, warmup };
  }

  observeSpot(spotPrice, now = null) {
    const close = finite(spotPrice, this.price);
    if (!(close > 0)) throw new Error("链上现货价格无效");
    const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const bucket = Math.floor(timestamp / 1_000) * 1_000;
    const previous = this.price;
    const last = this.candles.at(-1);
    if (last?.time === bucket) {
      last.high = Math.max(last.high, close);
      last.low = Math.min(last.low, close);
      last.close = close;
    } else {
      const open = last?.close ?? close;
      this.candles.push({ time: bucket, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 0 });
    }
    this.index += 1;
    this.at = timestamp;
    this.price = close;
    this.candles = this.candles.slice(-900);
    const logReturn = previous > 0 ? Math.log(close / previous) : 0;
    return { at: timestamp, open: last?.close ?? close, high: close, low: close, close, logReturn, quoteVolume: 0, direction: logReturn >= 0 ? "buy" : "sell", regime: this.regime(), warmup: false, live: true };
  }

  windowTrades(seconds) {
    return this.trades.filter((trade) => trade.at >= this.at - seconds * 1_000);
  }

  flowSnapshot() {
    const summarize = (seconds) => {
      const trades = this.windowTrades(seconds);
      const buy = trades.filter((trade) => trade.direction === "buy");
      const sell = trades.filter((trade) => trade.direction === "sell");
      return {
        buyCount: buy.length,
        sellCount: sell.length,
        buyVolume: buy.reduce((sum, trade) => sum + trade.quoteAmount, 0),
        sellVolume: sell.reduce((sum, trade) => sum + trade.quoteAmount, 0),
        total: trades.length,
      };
    };
    return {
      scannedAt: new Date(this.at).toISOString(),
      error: null,
      windows: { m1: summarize(60), m5: summarize(300) },
    };
  }

  marketSnapshot() {
    const prices = this.candles.map((item) => item.close);
    const current = prices.at(-1) || this.price;
    const center = median(prices.slice(-720));
    const below = prices.filter((value) => value <= current).length;
    const recent = this.candles.slice(-60);
    const returns = [];
    for (let i = 1; i < recent.length; i += 1) returns.push(Math.log(recent[i].close / recent[i - 1].close));
    const rms = returns.length ? Math.sqrt(returns.reduce((sum, value) => sum + value * value, 0) / returns.length) : 0;
    const recentVolume = recent.reduce((sum, item) => sum + item.volume, 0);
    const baselineBuckets = this.candles.slice(-360, -60);
    const baselineVolume = baselineBuckets.length ? baselineBuckets.reduce((sum, item) => sum + item.volume, 0) / baselineBuckets.length * recent.length : recentVolume;
    const volumeRatio = baselineVolume > 0 ? recentVolume / baselineVolume : 1;
    const priceActivity = clamp(rms / 0.015, 0, 1);
    const volumeActivity = clamp((volumeRatio - 0.5) / 1.5, 0, 1);
    const activity = clamp(priceActivity * 0.7 + volumeActivity * 0.3, 0, 1);
    return {
      at: this.at,
      regime: this.regime(),
      positionPercentile: prices.length ? below / prices.length : 0.5,
      position: center > 0 ? Math.log(current / center) : 0,
      activity,
      priceActivity,
      volumeActivity,
      minIntervalSeconds: Math.round(30 - activity * 25),
      volumeRatio,
      priceSamples: prices.length,
      rms,
      mode: this.mode,
      source: this.source,
    };
  }

  tokenSnapshot(metadata = {}) {
    const quote = this.liquidityQuote;
    const explicitQuotePrice = Number(metadata.quotePrice);
    const quotePrice = metadata.quotePrice !== null && metadata.quotePrice !== undefined && Number.isFinite(explicitQuotePrice) && explicitQuotePrice > 0
      ? explicitQuotePrice
      : this.price;
    const explicitTokenLiquidity = Number(metadata.liquidityToken);
    const tokenLiquidity = metadata.liquidityToken !== null && metadata.liquidityToken !== undefined && Number.isFinite(explicitTokenLiquidity) && explicitTokenLiquidity > 0
      ? explicitTokenLiquidity
      : quotePrice > 0 ? quote / quotePrice : 0;
    return {
      symbol: metadata.symbol || "TOKEN",
      // Hybrid 的资金与池冲击必须使用“报价资产 / 代币”，不能使用归一化 USDT 价。
      quotePrice,
      buyTaxPercent: finite(metadata.buyTaxPercent, 0),
      liquidity: { quote, token: tokenLiquidity },
    };
  }
}
