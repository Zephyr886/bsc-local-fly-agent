import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFlyBrain } from "../src/brain/index.mjs";
import { SimulationRuntime } from "../src/agent/simulation.mjs";
import { assertPlainObject } from "../src/util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const localBrain = join(here, "..", "src", "brain", "fly-brain.mjs");
const originalBrain = join(here, "..", "..", "server", "fly-brain.mjs");
const localHybrid = join(here, "..", "src", "strategy", "hybrid-v2.mjs");
const originalHybrid = join(here, "..", "..", "server", "hybrid-v2.mjs");
const localMaleCns = join(here, "..", "public", "malecns-points.json");
const originalMaleCns = join(here, "..", "..", "public", "malecns-points.json");
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("保留的大脑文件与原项目逐字一致", { skip: !existsSync(originalBrain) }, () => {
  assert.equal(hash(localBrain), hash(originalBrain));
});

test("Hybrid V2 量化闸门与原项目逐字一致", { skip: !existsSync(originalHybrid) }, () => {
  assert.equal(hash(localHybrid), hash(originalHybrid));
});

test("MaleCNS 胞体点图与主项目逐字一致", { skip: !existsSync(originalMaleCns) }, () => {
  assert.equal(hash(localMaleCns), hash(originalMaleCns));
});

test("相同 CA 与输入序列给出确定性决策", () => {
  const options = { seed: "0x0000000000000000000000000000000000000001", quietMinIntervalSeconds: 5, activeMinIntervalSeconds: 5 };
  const a = createFlyBrain(options);
  const b = createFlyBrain(options);
  const decisionsA = [];
  const decisionsB = [];
  for (let index = 0; index < 80; index += 1) {
    const input = { now: 1_700_000_000_000 + index * 5_000, price: Math.exp(Math.sin(index / 7) * .12), volumeRatio: 1.2, volume5m: 100, quoteBalance: 1, tokenBalance: 1_000_000 };
    decisionsA.push(a.step(input));
    decisionsB.push(b.step(input));
  }
  assert.deepEqual(decisionsA, decisionsB);
});

test("Hybrid 管线产生经过量化闸门的买卖记录且四账户不透支", async () => {
  const runtime = new SimulationRuntime();
  await runtime.start({ tokenAddress: "0x0000000000000000000000000000000000000001", metadata: null, initialQuote: 1, initialToken: 1_000_000 });
  clearInterval(runtime.timer);
  runtime.timer = null;
  for (let index = 0; index < 600; index += 1) runtime.tick();
  const result = runtime.snapshot();
  assert.equal(result.market.candles.length, 36, "控制台应取得最近 36 根 OHLC K 线");
  assert.ok(result.latestBrainMotorEvent, "非 HOLD 全脑输出应保留为运动按钮事件，避免轮询漏帧");
  assert.ok(["BUY", "BURN"].includes(result.latestBrainMotorEvent.action));
  assert.ok(result.trades.some((trade) => trade.side === "buy"), "应出现 Hybrid 买入");
  assert.ok(result.trades.some((trade) => trade.side === "sell"), "应出现 Hybrid 卖出适配");
  assert.equal(result.gate.layers.length, 7);
  assert.ok(result.trades.every((trade) => trade.quantScore >= .62));
  for (const account of Object.values(result.accounts)) {
    assert.ok(account.quote >= 0);
    assert.ok(account.token >= 0);
    assert.ok(account.bnb >= 0);
  }
  assert.ok(result.trades.every((trade) => trade.simulated === true));
  const proposal = result.latestApprovedProposal;
  assert.ok(proposal, "Hybrid 成交应产生受约束的实盘提案");
  assert.doesNotThrow(() => runtime.validateLiveProposal({
    decisionAt: proposal.decisionAt,
    tokenAddress: proposal.tokenAddress,
    side: proposal.side,
    amount: proposal.amount,
  }));
  assert.throws(() => runtime.validateLiveProposal({
    decisionAt: proposal.decisionAt,
    tokenAddress: proposal.tokenAddress,
    side: proposal.side === "buy" ? "sell" : "buy",
    amount: proposal.amount,
  }), /方向与 Hybrid 提案不一致/);
  assert.throws(() => runtime.validateLiveProposal({
    decisionAt: proposal.decisionAt,
    tokenAddress: proposal.tokenAddress,
    side: proposal.side,
    amount: proposal.amount * 2,
  }), /不得超过 Hybrid 放行额度/);
  runtime.stop();
});

test("请求边界拒绝私钥和助记词字段", () => {
  assert.throws(() => assertPlainObject({ privateKey: "0xsecret" }), /不接收私钥/);
  assert.throws(() => assertPlainObject({ mnemonic: "secret words" }), /不接收私钥/);
});
