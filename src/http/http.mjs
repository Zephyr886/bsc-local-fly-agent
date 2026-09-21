import { toJsonSafe } from "../util.mjs";

const LOOPBACKS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const SECRET_KEYS = new Set(["privateKey", "private_key", "mnemonic", "seedPhrase", "seed_phrase", "keystore", "password"]);

export class ApiError extends Error {
  constructor(code, message, { status = 400, fields = [], cause } = {}) {
    super(message, { cause });
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

export function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(toJsonSafe(body)));
}

function inspectSecrets(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(inspectSecrets);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) throw new ApiError("SECRET_FIELD_REJECTED", "请求不得包含私钥、助记词、密码或密钥库字段");
    inspectSecrets(child);
  }
}

export async function readApiJson(request, { maxBytes = 32_768 } = {}) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new ApiError("JSON_CONTENT_TYPE_REQUIRED", "请求必须使用 application/json", { status: 400 });
  }
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) {
      throw new ApiError("REQUEST_TOO_LARGE", `请求体不得超过 ${maxBytes} 字节`, { status: 400 });
    }
  }
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch {
    throw new ApiError("INVALID_JSON", "JSON 格式无效", { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_BODY", "请求体必须是 JSON 对象", { status: 400 });
  }
  inspectSecrets(body);
  return body;
}

export function exactBody(body, allowed, required = []) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(body).filter((key) => !allowedSet.has(key));
  const missing = required.filter((key) => !Object.hasOwn(body, key));
  if (unknown.length || missing.length) {
    const fields = [
      ...unknown.map((key) => ({ path: `/${key}`, reason: "未知字段" })),
      ...missing.map((key) => ({ path: `/${key}`, reason: "缺少字段" })),
    ];
    throw new ApiError("INVALID_REQUEST_FIELDS", "请求字段无效", { fields });
  }
  return body;
}

export function assertLocalMutation(request) {
  if (!LOOPBACKS.has(request.socket.remoteAddress)) {
    throw new ApiError("LOCAL_REQUEST_REQUIRED", "修改操作只接受本机请求", { status: 403 });
  }
  const localPort = request.socket.localPort;
  const allowedHosts = new Set([
    `127.0.0.1:${localPort}`,
    `localhost:${localPort}`,
    `[::1]:${localPort}`,
  ]);
  const host = String(request.headers.host || "").toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new ApiError("LOCAL_HOST_REQUIRED", "修改操作只接受本机 Host", { status: 403 });
  }
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) {
    throw new ApiError("SAME_ORIGIN_REQUIRED", "修改操作拒绝跨站 Origin", { status: 403 });
  }
}

function statusForCode(code) {
  if (code === "PROFILE_REVISION_CONFLICT" || code.endsWith("_CONFLICT")
      || code.includes("ALREADY_EXISTS") || code === "FLY_ARCHIVED"
      || code === "TRAINING_NOT_RUNNING") return 409;
  if (code.endsWith("_NOT_FOUND") || code === "FLY_NOT_FOUND") return 404;
  if (["FLY_SWITCH_WHILE_RUNNING", "FLY_MANAGER_BUSY", "TRAINING_ALREADY_RUNNING",
    "INVALID_FLY_MANAGER_STATE", "FLY_NOT_READY", "NO_ACTIVE_FLY"].includes(code)) return 423;
  if (code.startsWith("INVALID_") || code.includes("VALIDATION") || code.includes("OUTSIDE_PROFILE")
      || code.includes("DATASET") || code === "SECRET_FIELD_REJECTED") return 400;
  return 500;
}

function safeText(value, fallback) {
  if (typeof value !== "string" || !value) return fallback;
  return value
    .replace(/https?:\/\/[^\s；，。]+/gi, "[外部地址已隐藏]")
    .replace(/[A-Za-z]:[\\/][^\s；，。]+/g, "[路径已隐藏]")
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "[路径已隐藏]")
    .replace(/(?:0x)?[0-9a-fA-F]{64}/g, "[敏感值已隐藏]")
    .replace(/private[_ -]?key|mnemonic|password|seed[_ -]?phrase|keystore/gi, "[敏感字段]");
}

export function safeLegacyMessage(error) {
  return safeText(error instanceof Error ? error.message : String(error), "请求处理失败");
}

export function sendApiError(response, error, respondJson = sendJson) {
  const known = error instanceof ApiError || (typeof error?.code === "string" && error.code !== "ERR_ASSERTION");
  const code = known ? error.code : "INTERNAL_ERROR";
  const status = error instanceof ApiError ? error.status : known ? statusForCode(code) : 500;
  const message = known
    ? safeText(error.message, "请求处理失败")
    : "本地服务发生内部错误";
  const fields = Array.isArray(error?.fields)
    ? error.fields.map((field) => ({
      path: typeof field.path === "string" && field.path.startsWith("/") ? field.path : "/",
      reason: safeText(field.reason, "字段无效"),
    })) : [];
  return respondJson(response, status, { error: { code, message, fields } });
}

export function positiveInteger(value, name, { min = 1, max = 999_999 } = {}) {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError("INVALID_INTEGER", `${name} 必须是 ${min} 到 ${max} 的整数`, {
      fields: [{ path: `/${name}`, reason: "整数超出范围" }],
    });
  }
  return parsed;
}
