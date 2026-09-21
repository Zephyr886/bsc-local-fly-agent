import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ACTIVE_MAINNET_V3_REGISTRY,
  CARTRIDGE_V3_LIMITS,
  MAINNET_V3_REGISTRIES,
} from "../src/chain/registry-config.mjs";
import { SAFETY_LIMITS } from "../src/config.mjs";
import { CartridgeDeck } from "../src/cartridge/deck.mjs";
import { SYSTEM_POLICY, resolveEffectiveRisk } from "../src/policy/system-policy.mjs";

const permissiveRisk = {
  liveTradingEnabled: true,
  capitalBudgetPercent: 25,
  maxPoolParticipationPercent: 2,
  maxBuyBnb: "1.5",
  slippagePercent: 15,
  dailyActionLimit: 100,
  minimumActionIntervalSeconds: 60,
};

function filesBelow(root) {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

test("Registry V3 variants have explicit types and one active mainnet reader", () => {
  assert.equal(ACTIVE_MAINNET_V3_REGISTRY.id, "v3-image");
  assert.equal(ACTIVE_MAINNET_V3_REGISTRY.contractType, "image");
  assert.equal(ACTIVE_MAINNET_V3_REGISTRY.address, "0x7c35e97e8f89eeb2586db4031c13c63d4bd6ca21");
  assert.equal(ACTIVE_MAINNET_V3_REGISTRY.reader.image, true);
  assert.equal(MAINNET_V3_REGISTRIES.direct.address, "0x8a318b90ae7ce6c3c55dd5f596e16c1623c2c46a");
  assert.equal(MAINNET_V3_REGISTRIES.direct.contractType, "direct");
  assert.equal(MAINNET_V3_REGISTRIES.auto.address, null);
  assert.equal(MAINNET_V3_REGISTRIES.auto.contractType, "auto");
  assert.deepEqual(CARTRIDGE_V3_LIMITS, {
    maxManifestBytes: 16_384,
    maxPublicationBytes: 120_000,
  });
  assert.ok(Object.isFrozen(MAINNET_V3_REGISTRIES));
  assert.ok(Object.isFrozen(MAINNET_V3_REGISTRIES.image.reader));
  for (const registry of Object.values(MAINNET_V3_REGISTRIES)) {
    const artifact = JSON.parse(readFileSync(join(import.meta.dirname, "..", registry.artifact), "utf8"));
    assert.equal(artifact.contractName, registry.contractName);
    const functions = new Set(artifact.abi.filter((item) => item.type === "function").map((item) => item.name));
    if (registry.contractType === "auto") {
      assert.ok(functions.has("begin"));
      assert.ok(functions.has("upload"));
    } else {
      assert.ok(functions.has("publish"));
    }
  }
});

test("mainnet Registry addresses have a single source in application code", () => {
  const sourceRoot = join(import.meta.dirname, "..", "src");
  const registryPath = join(sourceRoot, "chain", "registry-config.mjs");
  const otherSource = filesBelow(sourceRoot)
    .filter((path) => path !== registryPath)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
    .toLowerCase();
  for (const registry of Object.values(MAINNET_V3_REGISTRIES)) {
    if (registry.address) assert.ok(!otherSource.includes(registry.address.toLowerCase()), registry.id);
  }
});

test("CartridgeDeck reports the explicit registry and enforces central byte limits", async () => {
  const deck = new CartridgeDeck({
    root: join(tmpdir(), `flap-policy-${randomUUID()}`),
    brain: { snapshot: () => ({ status: "idle" }) },
    runtime: { state: { status: "idle" } },
  });
  assert.deepEqual(deck.status().registry, {
    id: ACTIVE_MAINNET_V3_REGISTRY.id,
    type: ACTIVE_MAINNET_V3_REGISTRY.contractType,
    chainId: ACTIVE_MAINNET_V3_REGISTRY.chainId,
    address: ACTIVE_MAINNET_V3_REGISTRY.address,
  });
  await assert.rejects(deck.importBytes({
    manifest: Buffer.alloc(CARTRIDGE_V3_LIMITS.maxManifestBytes + 1),
    state: Buffer.from([1]),
    tokenAddress: `0x${"1".repeat(40)}`,
  }), /清单最多 16,384 字节/);
});

test("Effective Risk never widens the frozen system policy", () => {
  const result = resolveEffectiveRisk(permissiveRisk);
  assert.deepEqual(result.effectiveRisk, {
    liveTradingEnabled: true,
    capitalBudgetPercent: 10,
    maxPoolParticipationPercent: 0.5,
    maxBuyBnb: "0.2",
    slippagePercent: 15,
    dailyActionLimit: 24,
    minimumActionIntervalSeconds: 60,
  });
  assert.deepEqual(result.restrictions.map((item) => item.path), [
    "/spec/risk/capitalBudgetPercent",
    "/spec/risk/maxPoolParticipationPercent",
    "/spec/risk/maxBuyBnb",
    "/spec/risk/dailyActionLimit",
  ]);
  assert.ok(Object.isFrozen(SYSTEM_POLICY));
  assert.ok(Object.isFrozen(SYSTEM_POLICY.risk));
  assert.ok(Object.isFrozen(result.effectiveRisk));
});

test("stricter user risk survives unchanged and invalid input fails closed", () => {
  const strict = {
    liveTradingEnabled: false,
    capitalBudgetPercent: 5,
    maxPoolParticipationPercent: 0.25,
    maxBuyBnb: "0.1",
    slippagePercent: 0.2,
    dailyActionLimit: 12,
    minimumActionIntervalSeconds: 120,
  };
  const result = resolveEffectiveRisk(strict);
  assert.deepEqual(result.effectiveRisk, strict);
  assert.deepEqual(result.restrictions, []);
  assert.throws(() => resolveEffectiveRisk({ ...strict, slippagePercent: 15.1 }), /slippagePercent/);
  assert.throws(() => resolveEffectiveRisk({ ...strict, maxBuyBnb: "1e-1" }), /maxBuyBnb/);
  assert.throws(() => resolveEffectiveRisk({ ...strict, extra: true }), /未知字段/);
});

test("legacy safety exports are derived from the system policy", () => {
  assert.deepEqual(SAFETY_LIMITS, {
    minSlippagePercent: SYSTEM_POLICY.risk.slippagePercent.min,
    maxSlippagePercent: SYSTEM_POLICY.risk.slippagePercent.max,
    maxBuyBnb: Number(SYSTEM_POLICY.risk.maxBuyBnb),
    transactionDeadlineSeconds: SYSTEM_POLICY.risk.transactionDeadlineSeconds,
  });
  assert.equal(SYSTEM_POLICY.listener.bindHost, "127.0.0.1");
  assert.equal(SYSTEM_POLICY.listener.profileRequestMaxBytes, 32_768);
  assert.equal(SYSTEM_POLICY.listener.cartridgeRequestMaxBytes, 420_000);
});

test("non-loopback HOST configuration fails closed", () => {
  const root = join(import.meta.dirname, "..");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    "await import('./src/config.mjs')"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOST: "0.0.0.0" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HOST.*回环地址/);
});
