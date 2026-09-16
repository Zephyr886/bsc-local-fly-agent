import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { FLAP_PORTAL } from "../src/config.mjs";
import { assertFlapTradeable, flapTradeAbi, FLAP_STATUS } from "../src/chain/flap.mjs";

test("Flap mainnet Portal and status mapping are pinned", () => {
  assert.equal(FLAP_PORTAL, "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0");
  assert.equal(FLAP_STATUS[1], "Tradable");
  assert.equal(FLAP_STATUS[4], "DEX");
});

test("Flap queue allows curve and migrated DEX states", () => {
  const base = { extensionID: `0x${"00".repeat(32)}` };
  assert.doesNotThrow(() => assertFlapTradeable({ ...base, status: 1, statusName: "Tradable" }, "sell"));
  assert.doesNotThrow(() => assertFlapTradeable({ ...base, status: 4, statusName: "DEX" }, "buy"));
  assert.throws(() => assertFlapTradeable({ ...base, status: 3, statusName: "Killed" }, "buy"), /Killed/);
  assert.throws(() => assertFlapTradeable({ ...base, status: 5, statusName: "Staged" }, "sell"), /Staged/);
});

test("official unified swap ABI round-trips exact input parameters", async () => {
  const { encodeFunctionData } = await import("viem");
  const params = {
    inputToken: "0x0000000000000000000000000000000000000000",
    outputToken: "0x1111111111111111111111111111111111111111",
    inputAmount: 123n,
    minOutputAmount: 100n,
    permitData: "0x",
  };
  const data = encodeFunctionData({ abi: flapTradeAbi, functionName: "swapExactInput", args: [params] });
  const decoded = decodeFunctionData({ abi: flapTradeAbi, data });
  assert.equal(decoded.functionName, "swapExactInput");
  assert.deepEqual(decoded.args[0], params);
});
