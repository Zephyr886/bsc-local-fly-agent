import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalJson,
  parseJsonStrict,
  profileHash,
} from "../src/profile/canonical.mjs";
import { DEFAULT_PROFILE_SPEC } from "../src/profile/defaults.mjs";
import {
  ACTIVATION_MODES_BY_PATH,
  activationModeForPath,
} from "../src/profile/activation.mjs";
import {
  ProfileValidationError,
  createProfileDocument,
  normalizeProfileSpec,
  validateProfileDocument,
  validateProfileSpec,
  PROFILE_SCHEMA,
} from "../src/profile/validate.mjs";
import {
  PROFILE_PRESETS,
  getProfilePreset,
} from "../src/profile/presets.mjs";
import {
  assertEffectiveProfile,
  buildEffectiveProfile,
} from "../src/profile/effective-profile.mjs";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname,
  "fixtures", "fly-profile-v1-baseline.json"), "utf8"));
const flyId = "123e4567-e89b-42d3-a456-426614174000";
const now = "2026-09-19T00:00:00.000Z";

test("balanced defaults are the WP-00 legacy-equivalent target", () => {
  assert.deepEqual(DEFAULT_PROFILE_SPEC, fixture.profileSpec);
  assert.deepEqual(getProfilePreset("balanced-v1").spec, DEFAULT_PROFILE_SPEC);
  assert.ok(Object.isFrozen(DEFAULT_PROFILE_SPEC));
  assert.ok(Object.isFrozen(DEFAULT_PROFILE_SPEC.reward.settlementHorizonsSeconds));
});

test("root and every declared object schema reject additional properties", () => {
  const visit = (node, path = "#") => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") assert.equal(node.additionalProperties, false, path);
    for (const [key, child] of Object.entries(node)) visit(child, `${path}/${key}`);
  };
  visit(PROFILE_SCHEMA);
  const desktopConfig = readFileSync(join(import.meta.dirname, "..", "electron-builder.yml"), "utf8");
  assert.match(desktopConfig, /^\s*- schemas\/\*\*\/\*\s*$/m);
});

test("normalization validates raw types before applying defaults", () => {
  const normalized = normalizeProfileSpec({ risk: { liveTradingEnabled: false } });
  assert.equal(normalized.risk.liveTradingEnabled, false);
  assert.equal(normalized.risk.maxBuyBnb, "0.2");
  assert.throws(() => normalizeProfileSpec({ perception: { marketRefreshMs: "1000" } }),
    (error) => error instanceof ProfileValidationError &&
      error.fields.some((field) => field.path === "/perception/marketRefreshMs"));
  assert.throws(() => normalizeProfileSpec({ perception: { marketRefreshMs: NaN } }),
    ProfileValidationError);
  assert.throws(() => normalizeProfileSpec({ learning: { decoderThresholdHz: Infinity } }),
    ProfileValidationError);
  assert.throws(() => normalizeProfileSpec({ strategy: { surprise: 1 } }), /未知字段|additionalProperties/);
});

test("Profile cross-field constraints and fixed token addresses fail clearly", () => {
  assert.throws(() => normalizeProfileSpec({ universe: {
    tokenBinding: "fixed", tokenAddress: null,
  } }), ProfileValidationError);
  assert.throws(() => normalizeProfileSpec({ universe: {
    tokenBinding: "fixed", tokenAddress: "0x0000000000000000000000000000000000000000",
  } }), ProfileValidationError);
  assert.throws(() => normalizeProfileSpec({ universe: {
    tokenBinding: "fixed", tokenAddress: "not-an-address",
  } }), ProfileValidationError);
  assert.throws(() => normalizeProfileSpec({ reward: {
    settlementHorizonsSeconds: [900, 300], primaryHorizonSeconds: 300,
  } }), /递增/);
  assert.throws(() => normalizeProfileSpec({ reward: {
    settlementHorizonsSeconds: [300, 900], primaryHorizonSeconds: 3600,
  } }), /primaryHorizonSeconds/);
  assert.throws(() => normalizeProfileSpec({ strategy: {
    activeMinActions: 8, activeMaxActions: 4,
  } }), /activeMaxActions/);
  assert.throws(() => normalizeProfileSpec({ reward: {
    followWeight: 1, positionWeight: 0.5, favorableWeight: 0.1, drawdownWeight: -0.1,
  } }), /不得大于 1.5/);
});

test("canonical JSON and Profile hash are stable and behavior-sensitive", () => {
  assert.equal(canonicalJson({ b: 1, a: "x", n: -0 }), "{\"a\":\"x\",\"b\":1,\"n\":0}");
  const first = { ...DEFAULT_PROFILE_SPEC, perception: {
    ...DEFAULT_PROFILE_SPEC.perception, marketRefreshMs: 2_000,
  } };
  const reversed = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(profileHash(first), profileHash(reversed));
  assert.notEqual(profileHash(first), profileHash(DEFAULT_PROFILE_SPEC));
  assert.match(profileHash(first), /^sha256:[0-9a-f]{64}$/);
  assert.equal(profileHash(DEFAULT_PROFILE_SPEC),
    "sha256:d87557af0d8babf6828f1b8ba9154410a83a7335d3644ddc727a90420f49e132");
  assert.equal(canonicalJson([333333333.33333329, 1e30, 4.5, 0.002, 1e-27]),
    "[333333333.3333333,1e+30,4.5,0.002,1e-27]");
  assert.throws(() => canonicalJson({ value: Infinity }), /有限数字/);
  assert.throws(() => canonicalJson({ value: undefined }), /JSON/);
  assert.throws(() => canonicalJson({ value: "\ud800" }), /Unicode/);
});

test("strict JSON parsing rejects duplicate keys instead of silently overwriting", () => {
  assert.deepEqual(parseJsonStrict('{"a":1,"nested":{"b":2}}'), { a: 1, nested: { b: 2 } });
  assert.throws(() => parseJsonStrict('{"a":1,"a":2}'), /重复键.*a/);
  assert.throws(() => parseJsonStrict('{"nested":{"b":1,"b":2}}'), /重复键.*b/);
  assert.deepEqual(parseJsonStrict('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal({}.polluted, undefined);
});

test("Profile document hash excludes metadata and is verified on load", () => {
  const document = createProfileDocument({ flyId, name: "Balanced", spec: {}, now });
  assert.equal(document.metadata.revision, 1);
  assert.equal(document.metadata.profileHash, profileHash(document.spec));
  assert.equal(validateProfileDocument(document), true);
  const renamed = structuredClone(document);
  renamed.metadata.name = "Renamed";
  assert.equal(validateProfileDocument(renamed), true);
  const tampered = structuredClone(document);
  tampered.spec.strategy.quantThreshold = 0.8;
  assert.throws(() => validateProfileDocument(tampered), /profileHash/);
  assert.throws(() => validateProfileDocument({ ...document, extra: true }), ProfileValidationError);
  const invalidTime = structuredClone(document);
  invalidTime.metadata.updatedAt = "2026-02-30T00:00:00.000Z";
  assert.throws(() => validateProfileDocument(invalidTime), /RFC3339/);
});

test("all four repository presets are valid and preserve their intended safety posture", () => {
  assert.deepEqual(PROFILE_PRESETS.map((preset) => preset.id), [
    "balanced-v1", "conservative-v1", "active-research-v1", "frozen-evaluation-v1",
  ]);
  for (const preset of PROFILE_PRESETS) assert.equal(validateProfileSpec(preset.spec), true);
  assert.equal(getProfilePreset("conservative-v1").spec.risk.liveTradingEnabled, false);
  assert.ok(getProfilePreset("conservative-v1").spec.strategy.quantThreshold >
    DEFAULT_PROFILE_SPEC.strategy.quantThreshold);
  assert.equal(getProfilePreset("active-research-v1").spec.perception.marketRefreshMs, 1_000);
  assert.equal(getProfilePreset("frozen-evaluation-v1").spec.learning.enabled, false);
  assert.throws(() => getProfilePreset("missing"), /未知 Profile 预设/);
});

test("activation mode mapping covers every Profile leaf", () => {
  assert.equal(activationModeForPath("/spec/compatibility/brainModel"), "fork-required");
  assert.equal(activationModeForPath("/spec/learning/enabled"), "next-training-run");
  assert.equal(activationModeForPath("/spec/reward/followWeight"), "next-training-run");
  assert.equal(activationModeForPath("/spec/strategy/quantThreshold"), "next-start");
  assert.equal(activationModeForPath("/metadata/name"), "hot");
  assert.throws(() => activationModeForPath("/spec/unknown/value"), /未知 Profile 字段/);
  const leaves = [];
  const collect = (value, path) => {
    for (const [key, child] of Object.entries(value)) {
      const next = `${path}/${key}`;
      if (child && typeof child === "object" && !Array.isArray(child)) collect(child, next);
      else leaves.push(next);
    }
  };
  collect(DEFAULT_PROFILE_SPEC, "/spec");
  leaves.push("/metadata/name", "/metadata/description", "/metadata/tags");
  assert.deepEqual(Object.keys(ACTIVATION_MODES_BY_PATH).sort(), leaves.sort());
});

test("Effective Profile contains immutable policy-tightened risk and provenance", () => {
  const spec = structuredClone(DEFAULT_PROFILE_SPEC);
  spec.risk.capitalBudgetPercent = 25;
  spec.risk.maxPoolParticipationPercent = 2;
  spec.risk.maxBuyBnb = "1";
  spec.risk.dailyActionLimit = 100;
  const document = createProfileDocument({ flyId, name: "Permissive request", spec, now });
  const effective = buildEffectiveProfile(document);
  assert.equal(assertEffectiveProfile(effective), effective);
  assert.deepEqual(effective.source, {
    flyId,
    revision: 1,
    profileHash: document.metadata.profileHash,
  });
  assert.equal(effective.spec.risk.capitalBudgetPercent, 10);
  assert.equal(effective.spec.risk.maxPoolParticipationPercent, 0.5);
  assert.equal(effective.spec.risk.maxBuyBnb, "0.2");
  assert.equal(effective.spec.risk.dailyActionLimit, 24);
  assert.equal(effective.restrictions.length, 4);
  assert.ok(Object.isFrozen(effective));
  assert.ok(Object.isFrozen(effective.spec.risk));
  assert.throws(() => assertEffectiveProfile(structuredClone(effective)), /Effective Profile/);
});
