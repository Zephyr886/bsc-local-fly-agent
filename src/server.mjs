import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, HOST, PORT } from "./config.mjs";
import { chainSafetySummary, normalizeAddress, prepareSwap, readReceipt, readTokenMetadata } from "./chain/bsc.mjs";
import { SimulationRuntime } from "./agent/simulation.mjs";
import { SqliteStore } from "./persistence/sqlite-store.mjs";
import { assertPlainObject, toJsonSafe } from "./util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const store = new SqliteStore(join(here, "..", "data", "bsc-fly-agent.sqlite"));
const simulation = new SimulationRuntime({ store });
const prepareAttempts = new Map();

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

function rateLimit(request) {
  const key = request.socket.remoteAddress || "local";
  const now = Date.now();
  const recent = (prepareAttempts.get(key) || []).filter((at) => now - at < 60_000);
  if (recent.length >= 20) throw new Error("交易预构建请求过于频繁，请一分钟后重试");
  recent.push(now);
  prepareAttempts.set(key, recent);
}

async function serveStatic(pathname, response) {
  const routes = { "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js" };
  const filename = routes[pathname];
  if (!filename) return false;
  const type = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" }[extname(filename)];
  const data = await readFile(join(publicDir, filename));
  respond(response, 200, data, { "content-type": type, "cache-control": filename === "index.html" ? "no-store" : "public, max-age=300" });
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
    if (request.method === "POST" && url.pathname === "/api/simulation/start") {
      const body = await readJson(request);
      const tokenAddress = normalizeAddress(body.tokenAddress);
      let metadata = null;
      let metadataWarning = null;
      try { metadata = await readTokenMetadata(tokenAddress); }
      catch (error) { metadataWarning = `链上元数据不可用，已切换离线合成行情：${error.message}`; }
      const state = await simulation.start({ ...body, tokenAddress, metadata });
      if (metadataWarning) simulation.addEvent("warning", "链上读取失败", metadataWarning);
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
      return json(response, 200, await prepareSwap(body));
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
  console.log("安全模式：只监听回环地址；私钥/助记词永不进入本服务。真实交易必须在浏览器钱包中逐笔确认。");
});

function shutdown() {
  simulation.stop();
  server.close(() => { store.close(); process.exit(0); });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
