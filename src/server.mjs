import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, HOST, PORT } from "./config.mjs";
import { chainSafetySummary, normalizeAddress, prepareSwap, readReceipt, readTokenMetadata } from "./chain/bsc.mjs";
import { SimulationRuntime } from "./agent/simulation.mjs";
import { FullBrainClient } from "./brain/full-brain-client.mjs";
import { SqliteStore } from "./persistence/sqlite-store.mjs";
import { assertPlainObject, toJsonSafe } from "./util.mjs";
import { LocalWalletVault } from "./wallet/local-vault.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const store = new SqliteStore(join(here, "..", "data", "bsc-fly-agent.sqlite"));
const fullBrain = new FullBrainClient();
const simulation = new SimulationRuntime({ store, marketReader: readTokenMetadata, neuralClient: fullBrain });
const localWallet = new LocalWalletVault(join(here, "..", "data", "local-wallet.vault.json"));
const prepareAttempts = new Map();
const secretAttempts = new Map();
const preparedLiveTransactions = new Map();

const securityHeaders = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function respond(response, status, body, headers = {}) {
  response.writeHead(status, { ...securityHeaders, "cache-control": "no-store", ...headers });
  response.end(body);
}

function json(response, status, body) {
  respond(response, status, JSON.stringify(toJsonSafe(body)), { "content-type": "application/json; charset=utf-8" });
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 32_768) throw new Error("请求体超过 32KB 限制");
  }
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { throw new Error("JSON 格式无效"); }
  return assertPlainObject(parsed);
}

async function readSecretJson(request, allowedKeys) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 8_192) throw new Error("敏感请求体超过 8KB 限制");
  }
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { throw new Error("JSON 格式无效"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("敏感请求格式无效");
  for (const key of Object.keys(parsed)) if (!allowedKeys.includes(key)) throw new Error(`敏感请求包含未允许字段：${key}`);
  return parsed;
}

function rateLimit(request) {
  const key = request.socket.remoteAddress || "local";
  const now = Date.now();
  const recent = (prepareAttempts.get(key) || []).filter((at) => now - at < 60_000);
  if (recent.length >= 20) throw new Error("交易预构建请求过于频繁，请一分钟后重试");
  recent.push(now);
  prepareAttempts.set(key, recent);
}

function secretRateLimit(request) {
  const key = request.socket.remoteAddress || "local";
  const now = Date.now();
  const recent = (secretAttempts.get(key) || []).filter((at) => now - at < 60_000);
  if (recent.length >= 5) throw new Error("钱包解密/创建尝试过于频繁，请一分钟后重试");
  recent.push(now);
  secretAttempts.set(key, recent);
}

function registerPreparedTransaction(requestBody, prepared) {
  const now = Date.now();
  for (const [id, item] of preparedLiveTransactions) if (item.expiresAt <= now || item.state === "used") preparedLiveTransactions.delete(id);
  if (preparedLiveTransactions.size >= 100) preparedLiveTransactions.delete(preparedLiveTransactions.keys().next().value);
  const authorizationId = randomUUID();
  const expiresAt = Math.min(now + 2 * 60_000, Number(simulation.latestApprovedProposal()?.expiresAt || now));
  preparedLiveTransactions.set(authorizationId, {
    request: { ...requestBody }, account: prepared.transaction.from, transaction: prepared.transaction,
    phase: prepared.phase, state: "ready", expiresAt,
  });
  return { ...prepared, authorizationId, authorizationExpiresAt: new Date(expiresAt).toISOString() };
}

async function serveStatic(pathname, response) {
  const routes = {
    "/": { root: publicDir, file: "index.html" },
    "/index.html": { root: publicDir, file: "index.html" },
    "/styles.css": { root: publicDir, file: "styles.css" },
    "/app.js": { root: publicDir, file: "app.js" },
    "/scene.js": { root: publicDir, file: "scene.js" },
    "/malecns-points.json": { root: publicDir, file: "malecns-points.json" },
    "/vendor/three.module.js": { root: join(here, "..", "node_modules", "three", "build"), file: "three.module.js" },
    "/vendor/three.core.js": { root: join(here, "..", "node_modules", "three", "build"), file: "three.core.js" },
  };
  const asset = routes[pathname];
  if (!asset) return false;
  const type = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" }[extname(asset.file)];
  const data = await readFile(join(asset.root, asset.file));
  const heavyStaticAsset = asset.file === "malecns-points.json" || asset.file.startsWith("three.");
  respond(response, 200, data, { "content-type": type, "cache-control": heavyStaticAsset ? "public, max-age=300" : "no-store" });
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (request.method === "GET" && await serveStatic(url.pathname, response)) return;
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, app: APP_NAME, simulation: simulation.state.status, safety: chainSafetySummary() });
    }
    if (request.method === "GET" && url.pathname === "/api/simulation") return json(response, 200, simulation.snapshot());
    if (request.method === "GET" && url.pathname === "/api/wallet/status") {
      return json(response, 200, await localWallet.status());
    }
    if (request.method === "POST" && url.pathname === "/api/wallet/create") {
      secretRateLimit(request);
      const body = await readSecretJson(request, ["password"]);
      return json(response, 201, { ...(await localWallet.create(body.password)), backupRequired: true });
    }
    if (request.method === "POST" && url.pathname === "/api/wallet/import") {
      secretRateLimit(request);
      const body = await readSecretJson(request, ["privateKey", "password"]);
      return json(response, 201, await localWallet.import(body.privateKey, body.password));
    }
    if (request.method === "POST" && url.pathname === "/api/simulation/start") {
      const body = await readJson(request);
      const tokenAddress = normalizeAddress(body.tokenAddress);
      const metadata = await readTokenMetadata(tokenAddress);
      if (metadata.marketMode !== "live" || !(Number(metadata.price) > 0)) throw new Error("没有取得可验证的链上现货价格，已拒绝启动以避免显示伪造 K 线");
      const state = await simulation.start({ ...body, tokenAddress, metadata });
      return json(response, 200, simulation.snapshot());
    }
    if (request.method === "POST" && url.pathname === "/api/simulation/stop") return json(response, 200, simulation.stop());
    if (request.method === "POST" && url.pathname === "/api/simulation/reset") return json(response, 200, simulation.reset());
    if (request.method === "GET" && url.pathname === "/api/token") {
      return json(response, 200, await readTokenMetadata(url.searchParams.get("address")));
    }
    if (request.method === "POST" && url.pathname === "/api/transaction/prepare") {
      rateLimit(request);
      const body = await readJson(request);
      simulation.validateLiveProposal(body);
      const status = await localWallet.status();
      if (!status.exists || status.address.toLowerCase() !== String(body.account).toLowerCase()) throw new Error("交易账户与本地加密钱包不一致");
      return json(response, 200, registerPreparedTransaction(body, await prepareSwap(body)));
    }
    if (request.method === "POST" && url.pathname === "/api/transaction/sign-send") {
      secretRateLimit(request);
      const body = await readSecretJson(request, ["authorizationId", "password", "confirmationPhrase"]);
      if (body.confirmationPhrase !== "确认主网交易") throw new Error("主网确认短语不正确");
      const authorization = preparedLiveTransactions.get(body.authorizationId);
      if (!authorization || authorization.state !== "ready") throw new Error("签名授权不存在、已使用或正在执行");
      if (Date.now() > authorization.expiresAt) { preparedLiveTransactions.delete(body.authorizationId); throw new Error("签名授权已过期，请重新核验报价"); }
      simulation.validateLiveProposal(authorization.request);
      const status = await localWallet.status();
      if (!status.exists || status.address.toLowerCase() !== authorization.account.toLowerCase()) throw new Error("本地钱包与交易授权账户不一致");
      authorization.state = "signing";
      try {
        const hash = await localWallet.sendTransaction(body.password, authorization.transaction);
        authorization.state = "used";
        authorization.hash = hash;
        return json(response, 200, { hash, phase: authorization.phase });
      } catch (error) {
        authorization.state = "ready";
        throw error;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/transaction/receipt") {
      return json(response, 200, await readReceipt(url.searchParams.get("hash")));
    }
    if (request.method === "POST" && url.pathname === "/api/live/complete") {
      const body = await readJson(request);
      const receipt = await readReceipt(body.hash);
      if (!receipt.found || receipt.status !== "success") throw new Error("只有已确认成功的链上回执才能完成 Hybrid 提案");
      return json(response, 200, simulation.completeLiveProposal(body.decisionAt, body.hash));
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(response, 400, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`${APP_NAME}: http://${HOST}:${PORT}`);
  console.log("安全模式：只监听回环地址；本地钱包使用 scrypt + AES-256-GCM 加密，密码不保存，主网交易逐笔确认。");
});

async function shutdown() {
  await simulation.close();
  server.close(() => { store.close(); process.exit(0); });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
