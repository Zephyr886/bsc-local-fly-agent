import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { profileHash } from "./canonical.mjs";
import { DEFAULT_PROFILE_SPEC } from "./defaults.mjs";

const PROFILE_SCHEMA = JSON.parse(readFileSync(new URL(
  "../../schemas/fly-profile-v1.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  multipleOfPrecision: 12,
});
const validateDocumentSchema = ajv.compile(PROFILE_SCHEMA);
const validateSpecSchema = ajv.compile({
  $schema: PROFILE_SCHEMA.$schema,
  ...PROFILE_SCHEMA.$defs.spec,
});

function withoutRequired(value) {
  if (Array.isArray(value)) return value.map(withoutRequired);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "required" && key !== "default")
    .map(([key, child]) => [key, withoutRequired(child)]));
}

const validatePartialSpecSchema = ajv.compile({
  $schema: PROFILE_SCHEMA.$schema,
  ...withoutRequired(PROFILE_SCHEMA.$defs.spec),
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function merge(base, override) {
  if (!isPlainObject(override)) return structuredClone(override);
  const result = isPlainObject(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(override)) {
    Object.defineProperty(result, key, {
      value: isPlainObject(value) && isPlainObject(result[key])
        ? merge(result[key], value) : structuredClone(value),
      enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

function fieldPath(error) {
  if (error.keyword === "required") return `${error.instancePath}/${error.params.missingProperty}`;
  if (error.keyword === "additionalProperties") {
    return `${error.instancePath}/${error.params.additionalProperty}`;
  }
  return error.instancePath || "/";
}

function schemaFields(errors = []) {
  return errors.map((error) => ({
    path: fieldPath(error),
    reason: error.keyword === "additionalProperties"
      ? `未知字段 ${error.params.additionalProperty}`
      : error.message || error.keyword,
    keyword: error.keyword,
  }));
}

export class ProfileValidationError extends Error {
  constructor(fields, message = "Fly Profile 校验失败") {
    const normalized = fields.length ? fields : [{ path: "/", reason: message, keyword: "validation" }];
    super(`${message}：${normalized.map((field) => `${field.path} ${field.reason}`).join("；")}`);
    this.name = "ProfileValidationError";
    this.code = "PROFILE_VALIDATION_FAILED";
    this.fields = normalized;
  }
}

function schemaAssert(validator, value, label) {
  if (!validator(value)) throw new ProfileValidationError(schemaFields(validator.errors), `${label} Schema 校验失败`);
}

function crossAssert(spec, prefix = "") {
  const fields = [];
  const at = (path) => `${prefix}${path}`;
  const horizons = spec.reward.settlementHorizonsSeconds;
  if (horizons.some((value, index) => index > 0 && value <= horizons[index - 1])) {
    fields.push({ path: at("/reward/settlementHorizonsSeconds"), reason: "必须为严格递增整数", keyword: "increasing" });
  }
  if (!horizons.includes(spec.reward.primaryHorizonSeconds)) {
    fields.push({ path: at("/reward/primaryHorizonSeconds"), reason: "primaryHorizonSeconds 必须包含在 settlementHorizonsSeconds 中", keyword: "contains" });
  }
  const weights = [spec.reward.followWeight, spec.reward.positionWeight,
    spec.reward.favorableWeight, spec.reward.drawdownWeight];
  if (weights.reduce((sum, value) => sum + Math.abs(value), 0) > 1.5 + Number.EPSILON) {
    fields.push({ path: at("/reward"), reason: "四个 weight 的绝对值总和不得大于 1.5", keyword: "weightTotal" });
  }
  if (!weights.some((value) => value > 0)) {
    fields.push({ path: at("/reward"), reason: "至少需要一个正向 weight", keyword: "positiveWeight" });
  }
  if (spec.strategy.activeMaxActions < spec.strategy.activeMinActions) {
    fields.push({ path: at("/strategy/activeMaxActions"), reason: "activeMaxActions 不得小于 activeMinActions", keyword: "minimumPeer" });
  }
  if (spec.strategy.quietMaxActions < spec.strategy.quietMinActions) {
    fields.push({ path: at("/strategy/quietMaxActions"), reason: "quietMaxActions 不得小于 quietMinActions", keyword: "minimumPeer" });
  }
  if (fields.length) throw new ProfileValidationError(fields);
}

export function validateProfileSpec(spec) {
  schemaAssert(validateSpecSchema, spec, "Profile spec");
  crossAssert(spec);
  return true;
}

export function normalizeProfileSpec(input = {}) {
  if (!isPlainObject(input)) throw new ProfileValidationError([
    { path: "/", reason: "spec 必须是普通对象", keyword: "type" },
  ]);
  schemaAssert(validatePartialSpecSchema, input, "原始 Profile spec");
  const normalized = merge(DEFAULT_PROFILE_SPEC, input);
  validateProfileSpec(normalized);
  return deepFreeze(normalized);
}

export function validateProfileDocument(document, { verifyHash = true } = {}) {
  schemaAssert(validateDocumentSchema, document, "Profile document");
  crossAssert(document.spec, "/spec");
  for (const field of ["createdAt", "updatedAt"]) {
    const value = document.metadata[field];
    const normalized = value.length === 20 ? value.replace(/Z$/, ".000Z") : value;
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== normalized) {
      throw new ProfileValidationError([{
        path: `/metadata/${field}`, reason: `${field} 必须是有效 UTC RFC3339 时间`, keyword: "date-time",
      }]);
    }
  }
  if (Date.parse(document.metadata.updatedAt) < Date.parse(document.metadata.createdAt)) {
    throw new ProfileValidationError([{
      path: "/metadata/updatedAt", reason: "updatedAt 不得早于 createdAt", keyword: "minimumPeer",
    }]);
  }
  if (verifyHash) {
    const expected = profileHash(document.spec);
    if (document.metadata.profileHash !== expected) throw new ProfileValidationError([{
      path: "/metadata/profileHash",
      reason: `profileHash 与 canonical spec 不匹配；应为 ${expected}`,
      keyword: "profileHash",
    }]);
  }
  return true;
}

export function createProfileDocument({
  flyId,
  revision = 1,
  name,
  description = "",
  tags = [],
  spec = {},
  createdAt,
  updatedAt,
  now = new Date().toISOString(),
} = {}) {
  const normalizedSpec = normalizeProfileSpec(spec);
  const created = createdAt || now;
  const updated = updatedAt || now;
  const document = {
    apiVersion: "flap.ai/v1",
    kind: "FlyProfile",
    metadata: {
      flyId,
      revision,
      name,
      description,
      tags: structuredClone(tags),
      createdAt: created,
      updatedAt: updated,
      profileHash: profileHash(normalizedSpec),
    },
    spec: structuredClone(normalizedSpec),
  };
  validateProfileDocument(document);
  return deepFreeze(document);
}

export { PROFILE_SCHEMA };
