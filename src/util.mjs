import { createHash } from "node:crypto";

export function seedFromText(text) {
  return Number.parseInt(createHash("sha256").update(String(text)).digest("hex").slice(0, 8), 16) >>> 0;
}

export function createPrng(seed) {
  let state = seed || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toJsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
}

export function assertPlainObject(value, label = "请求") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  const forbidden = ["privateKey", "private_key", "mnemonic", "seedPhrase", "seed_phrase", "keystore"];
  for (const key of forbidden) {
    if (key in value) throw new Error("安全拒绝：本服务不接收私钥、助记词或密钥库内容");
  }
  return value;
}
