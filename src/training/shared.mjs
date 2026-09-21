import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { parseJsonStrict } from "../profile/index.mjs";

const TOKEN_PATTERN = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATASET_FIELDS = new Set(["format", "version", "tokenAddress", "symbol", "observations", "assumptions"]);
const OBSERVATION_FIELDS = new Set(["at", "history", "market", "flow", "token"]);
const MARKET_FIELDS = new Set(["positionPercentile", "position", "activity", "priceActivity", "volumeActivity", "minIntervalSeconds", "volumeRatio", "priceSamples", "updatedAt"]);
const FLOW_FIELDS = new Set(["scannedAt", "error", "windows"]);
const TOKEN_FIELDS = new Set(["quotePrice", "buyTaxPercent", "liquidity"]);
const ASSUMPTION_FIELDS = new Set(["feePercent", "slippagePercent", "gasBnb", "initialQuote", "initialToken", "initialBnb"]);

export class TrainingDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TrainingDataError";
    this.code = code;
  }
}

export function assertUuid(value, label = "id") {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TrainingDataError("INVALID_ID", `${label} 必须是 UUID`);
  }
  return value;
}

function exactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrainingDataError("INVALID_REPLAY_DATASET", `${label} 必须是对象`);
  }
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    throw new TrainingDataError("INVALID_REPLAY_DATASET", `${label} 字段不完整或包含未知字段`);
  }
}

function finite(value, low = -Infinity, high = Infinity) {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
}

function validateObservation(item, index) {
  const label = `observations[${index}]`;
  exactFields(item, OBSERVATION_FIELDS, label);
  const at = Date.parse(item.at);
  if (!Number.isFinite(at) || !Array.isArray(item.history) || item.history.length < 1 || item.history.length > 360
      || item.history.some((value) => !finite(value, Number.MIN_VALUE))) {
    throw new TrainingDataError("INVALID_REPLAY_DATASET", `${label} 的时间或 history 无效`);
  }
  exactFields(item.market, MARKET_FIELDS, `${label}.market`);
  exactFields(item.flow, FLOW_FIELDS, `${label}.flow`);
  exactFields(item.token, TOKEN_FIELDS, `${label}.token`);
  if (!item.flow.windows || typeof item.flow.windows !== "object"
      || !item.flow.windows.m5 || Object.keys(item.flow.windows).join(",") !== "m5"
      || Object.keys(item.flow.windows.m5).sort().join(",") !== "buyVolume,sellVolume") {
    throw new TrainingDataError("INVALID_REPLAY_DATASET", `${label}.flow.windows 无效`);
  }
  if (!item.token.liquidity || typeof item.token.liquidity !== "object"
      || Object.keys(item.token.liquidity).sort().join(",") !== "quote,token") {
    throw new TrainingDataError("INVALID_REPLAY_DATASET", `${label}.token.liquidity 无效`);
  }
  const numbers = [
    item.market.positionPercentile, item.market.position, item.market.activity,
    item.market.priceActivity, item.market.minIntervalSeconds, item.market.priceSamples,
    item.flow.windows.m5.buyVolume, item.flow.windows.m5.sellVolume,
    item.token.quotePrice, item.token.buyTaxPercent,
    item.token.liquidity.quote, item.token.liquidity.token,
  ];
  if (numbers.some((value) => !finite(value, 0))
      || (item.market.volumeActivity !== null && !finite(item.market.volumeActivity, 0))
      || (item.market.volumeRatio !== null && !finite(item.market.volumeRatio, 0))
      || typeof item.market.updatedAt !== "string" || typeof item.flow.scannedAt !== "string"
      || (item.flow.error !== null && typeof item.flow.error !== "string")) {
    throw new TrainingDataError("INVALID_REPLAY_DATASET", `${label} 包含非法市场值`);
  }
  return at;
}

export function validateReplayDataset(dataset) {
  exactFields(dataset, DATASET_FIELDS, "dataset");
  if (dataset.format !== "flap-deterministic-replay" || dataset.version !== 1
      || !TOKEN_PATTERN.test(dataset.tokenAddress) || typeof dataset.symbol !== "string"
      || dataset.symbol.length < 1 || dataset.symbol.length > 32
      || !Array.isArray(dataset.observations) || dataset.observations.length < 1) {
    throw new TrainingDataError("INVALID_REPLAY_DATASET", "回放数据集头部无效");
  }
  exactFields(dataset.assumptions, ASSUMPTION_FIELDS, "dataset.assumptions");
  for (const value of Object.values(dataset.assumptions)) {
    if (!finite(value, 0)) throw new TrainingDataError("INVALID_REPLAY_DATASET", "回放假设必须是非负有限数");
  }
  let previous = -Infinity;
  dataset.observations.forEach((item, index) => {
    const at = validateObservation(item, index);
    if (at <= previous) throw new TrainingDataError("INVALID_REPLAY_DATASET", "观察时间必须严格递增");
    previous = at;
  });
  return dataset;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function loadReplayDataset(datasetPath, replayRoot, { maxBytes = 16 * 1024 * 1024 } = {}) {
  if (typeof datasetPath !== "string" || typeof replayRoot !== "string") {
    throw new TrainingDataError("INVALID_DATASET_PATH", "必须明确选择本地回放数据集");
  }
  const root = await realpath(resolve(replayRoot));
  const requestedPath = resolve(root, datasetPath);
  const requestedRelative = relative(root, requestedPath);
  if (requestedRelative === "" || requestedRelative === ".." || requestedRelative.startsWith(`..${sep}`)) {
    throw new TrainingDataError("DATASET_OUTSIDE_ROOT", "回放数据集必须位于允许的数据目录内");
  }
  const path = await realpath(requestedPath);
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new TrainingDataError("DATASET_OUTSIDE_ROOT", "回放数据集必须位于允许的数据目录内");
  }
  const info = await stat(path);
  if (!info.isFile() || info.size < 2 || info.size > maxBytes) {
    throw new TrainingDataError("INVALID_DATASET_FILE", "回放数据集大小或类型无效");
  }
  const bytes = await readFile(path);
  const dataset = validateReplayDataset(parseJsonStrict(bytes.toString("utf8")));
  return {
    path,
    relativePath: rel.split(sep).join("/"),
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: info.size,
    dataset,
  };
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.partial`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function readJson(path) {
  return parseJsonStrict(await readFile(path, "utf8"));
}

export async function checkpointDescriptor(repository, context, { required = false } = {}) {
  const checkpointPath = repository.checkpointFilePath(context.flyId, context.checkpointId);
  const metadataPath = repository.checkpointMetadataPath(context.flyId, context.checkpointId);
  let checkpointInfo;
  try {
    checkpointInfo = await stat(checkpointPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (required) throw new TrainingDataError("CHECKPOINT_NOT_SAVED", "训练结束时没有生成 checkpoint");
    return { checkpointId: context.checkpointId, exists: false, fileSha256: null, metadata: null };
  }
  if (!checkpointInfo.isFile()) throw new TrainingDataError("INVALID_CHECKPOINT", "Checkpoint 不是普通文件");
  let metadata;
  try {
    metadata = await readJson(metadataPath);
  } catch (error) {
    if (error.code === "ENOENT" && !required) metadata = null;
    else throw new TrainingDataError("CHECKPOINT_METADATA_INVALID", "Checkpoint metadata 缺失或损坏");
  }
  if (required && (metadata?.flyId !== context.flyId
      || metadata?.profileRevision !== context.revision
      || metadata?.profileHash !== context.profileHash
      || metadata?.modelVersion !== "malecns-v1")) {
    throw new TrainingDataError("CHECKPOINT_PROVENANCE_MISMATCH", "Checkpoint metadata 与训练来源不一致");
  }
  return {
    checkpointId: context.checkpointId,
    exists: true,
    fileSha256: `sha256:${await sha256File(checkpointPath)}`,
    metadata,
  };
}
