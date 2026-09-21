import { readFileSync } from "node:fs";
import { parseJsonStrict } from "./canonical.mjs";
import { validateProfileSpec } from "./validate.mjs";

const ORDER = ["balanced-v1", "conservative-v1", "active-research-v1", "frozen-evaluation-v1"];

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function merge(base, override) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    Object.defineProperty(result, key, {
      value: isPlainObject(value) && isPlainObject(result[key])
        ? merge(result[key], value) : structuredClone(value),
      enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

function readDefinition(id) {
  return parseJsonStrict(readFileSync(new URL(`./presets/${id}.json`, import.meta.url), "utf8"));
}

const definitions = new Map(ORDER.map((id) => [id, readDefinition(id)]));
const balanced = definitions.get("balanced-v1");
if (!balanced || balanced.id !== "balanced-v1" || balanced.schemaVersion !== 1 ||
    !isPlainObject(balanced.spec)) throw new Error("balanced-v1 预设定义无效");
validateProfileSpec(balanced.spec);

export const PROFILE_PRESETS = deepFreeze(ORDER.map((id) => {
  const definition = definitions.get(id);
  if (!definition || definition.id !== id || definition.schemaVersion !== 1 ||
      typeof definition.name !== "string" || typeof definition.description !== "string") {
    throw new Error(`${id} 预设定义无效`);
  }
  const allowed = id === "balanced-v1"
    ? new Set(["id", "schemaVersion", "name", "description", "spec"])
    : new Set(["id", "schemaVersion", "name", "description", "extends", "overrides"]);
  const unknown = Object.keys(definition).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${id} 预设包含未知字段：${unknown.join(", ")}`);
  let spec;
  if (id === "balanced-v1") spec = structuredClone(definition.spec);
  else {
    if (definition.extends !== "balanced-v1" || !isPlainObject(definition.overrides)) {
      throw new Error(`${id} 必须从 balanced-v1 派生`);
    }
    spec = merge(balanced.spec, definition.overrides);
  }
  validateProfileSpec(spec);
  return { id, schemaVersion: 1, name: definition.name,
    description: definition.description, spec };
}));

const byId = new Map(PROFILE_PRESETS.map((preset) => [preset.id, preset]));

export function getProfilePreset(id) {
  const preset = byId.get(id);
  if (!preset) throw new Error(`未知 Profile 预设：${id}`);
  return preset;
}
