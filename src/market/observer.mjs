import { clamp, createPrng, seedFromText } from "../util.mjs";

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export class MarketObserver {
  constructor({ tokenAddress, initialPrice, liquidityQuote = 250 } = {}) {
    this.tokenAddress = tokenAddress;
    this.random = createPrng(seedFromText(`${tokenAddress}:market`));
    this.at = Date.now() - 120 * 5_000;
    this.price = initialPrice > 0 ? Number(initialPrice) : 0.000001 * (0.75 + this.random());
    this.initialPrice = this.price;
    this.liquidityQuote = Math.max(25, finite(liquidityQuote, 250));
    this.candles = [];
    this.trades = [];
    this.index = 0;
    for (let i = 0; i < 120; i += 1) this.advance({ warmup: true });
  }

  regime(index = this.index) {
    const phase = index % 180;
    if (phase < 45) return { key: "decline", label: "持续下跌", drift: -0.0075 };
    if (phase < 82) return { key: "rebound", label: "低位反弹", drift: 0.0105 };
    if (phase < 125) return { key: "distribution", label: "高位分歧", drift: -0.0035 };
    return { key: "expansion", label: "快速拉升", drift: 0.012 };
  }

  advance({ warmup = false } = {}) {
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
    };
  }

  tokenSnapshot(metadata = {}) {
    const quote = this.liquidityQuote;
    return {
      symbol: metadata.symbol || "TOKEN",
      quotePrice: this.price,
      buyTaxPercent: finite(metadata.buyTaxPercent, 0),
      liquidity: { quote, token: quote / this.price },
    };
  }
}
