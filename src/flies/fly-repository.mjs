import { createHash, randomUUID } from "node:crypto";
import {
  copyFile, cp, mkdir, open, readdir, readFile, rename, rm, stat, unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  createProfileDocument, normalizeProfileSpec, parseJsonStrict, validateProfileDocument,
} from "../profile/index.mjs";
import { FlyRepositoryError, invalidId, revisionConflict } from "./fly-errors.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION_FILE_PATTERN = /^(\d{6})\.json$/;
const TEMP_FILE_PATTERN = /^\..+\.[0-9a-f-]+\.tmp$/;

function assertFlyId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw invalidId("fly", value);
  return value;
}

function assertCheckpointId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw invalidId("checkpoint", value);
  return value;
}

function revisionName(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999999) {
    throw new FlyRepositoryError("INVALID_PROFILE_REVISION", "Profile revision 必须是 1 到 999999 的整数");
  }
  return `${String(revision).padStart(6, "0")}.json`;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeProfileSpec(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const result = isPlainObject(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    Object.defineProperty(result, key, {
      value: isPlainObject(value) && isPlainObject(result[key])
        ? mergeProfileSpec(result[key], value)
        : structuredClone(value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path) {
  return parseJsonStrict(await readFile(path, "utf8"));
}

async function atomicWriteJson(path, value, { immutable = false } = {}) {
  if (immutable && await exists(path)) {
    throw new FlyRepositoryError("PROFILE_REVISION_EXISTS", `不可覆盖已有 revision：${path}`);
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(jsonText(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (immutable && await exists(path)) {
      throw new FlyRepositoryError("PROFILE_REVISION_EXISTS", `不可覆盖已有 revision：${path}`);
    }
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    throw error;
  }
}

async function atomicCopy(source, destination) {
  if (await exists(destination)) {
    throw new FlyRepositoryError("CHECKPOINT_FILE_EXISTS", `不可覆盖 checkpoint 文件：${destination}`);
  }
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await exists(destination)) {
      throw new FlyRepositoryError("CHECKPOINT_FILE_EXISTS", `不可覆盖 checkpoint 文件：${destination}`);
    }
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function fileSha256(path) {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function publicFly(record, profile) {
  return structuredClone({ ...record, profile });
}

function validateFlyRecord(record, expectedId) {
  if (!isPlainObject(record) || record.id !== expectedId || !UUID_PATTERN.test(record.id)
      || !Number.isSafeInteger(record.currentRevision) || record.currentRevision < 1
      || typeof record.name !== "string" || !Array.isArray(record.tags)
      || !(record.activeCheckpointId === null || UUID_PATTERN.test(record.activeCheckpointId))) {
    throw new FlyRepositoryError("INVALID_FLY_RECORD", `fly.json 无效：${expectedId}`);
  }
}

export class FlyRepository {
  #health = { readOnly: false, issues: [] };
  #locks = new Map();
  #initialized = false;

  constructor({ dataRoot, now = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
    if (!dataRoot) throw new TypeError("FlyRepository 需要 dataRoot");
    this.dataRoot = dataRoot;
    this.fliesRoot = join(dataRoot, "flies");
    this.activeMarkerPath = join(dataRoot, "active-fly.json");
    this.now = now;
    this.idFactory = idFactory;
  }

  async init() {
    await mkdir(this.fliesRoot, { recursive: true });
    const issues = [];
    const entries = await readdir(this.fliesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (!UUID_PATTERN.test(entry.name)) {
        issues.push({ code: "INVALID_FLY_DIRECTORY", flyId: entry.name, message: "果蝇目录名不是合法 UUID" });
        continue;
      }
      try {
        const { record, profile } = await this.#readFly(entry.name);
        const revisions = await this.#listRevisionsUnchecked(entry.name);
        if (revisions.at(-1) !== record.currentRevision) {
          issues.push({ code: "FLY_REVISION_TAIL_MISMATCH", flyId: entry.name, message: "fly.json 未指向最后一个 revision" });
        }
        if (profile.metadata.flyId !== entry.name || profile.metadata.revision !== record.currentRevision
            || profile.metadata.name !== record.name) {
          issues.push({ code: "FLY_PROFILE_MISMATCH", flyId: entry.name, message: "fly.json 与当前 Profile 不一致" });
        }
        if (record.activeCheckpointId !== null
            && !await exists(this.#checkpointPath(entry.name, record.activeCheckpointId))) {
          issues.push({ code: "ACTIVE_CHECKPOINT_MISSING", flyId: entry.name, message: "活动 checkpoint 不存在" });
        }
      } catch (error) {
        issues.push({ code: error.code || "FLY_STORAGE_CORRUPT", flyId: entry.name, message: error.message });
      }
    }

    if (await exists(this.activeMarkerPath)) {
      try {
        const marker = await readJson(this.activeMarkerPath);
        if (!isPlainObject(marker)
            || Object.keys(marker).sort().join(",") !== "checkpointId,flyId,revision") {
          throw new FlyRepositoryError("ACTIVE_MARKER_CORRUPT", "active marker 字段无效");
        }
        assertFlyId(marker.flyId);
        const { record } = await this.#readFly(marker.flyId);
        if (marker.revision !== record.currentRevision) {
          issues.push({ code: "ACTIVE_REVISION_MISMATCH", flyId: marker.flyId, message: "active marker revision 与 fly.json 不一致" });
        }
        if (marker.checkpointId !== record.activeCheckpointId) {
          issues.push({ code: "ACTIVE_CHECKPOINT_MISMATCH", flyId: marker.flyId, message: "active marker checkpoint 与 fly.json 不一致" });
        }
      } catch (error) {
        issues.push({ code: error.code || "ACTIVE_MARKER_CORRUPT", message: error.message });
      }
    }

    this.#health = { readOnly: issues.length > 0, issues };
    this.#initialized = true;
    return this.getHealth();
  }

  getHealth() {
    return structuredClone(this.#health);
  }

  #assertReady({ write = false } = {}) {
    if (!this.#initialized) throw new FlyRepositoryError("FLY_REPOSITORY_NOT_INITIALIZED", "请先调用 init()");
    if (write && this.#health.readOnly) {
      throw new FlyRepositoryError("FLY_REPOSITORY_READ_ONLY", "存储一致性检查失败，仓库已进入只读模式", {
        fields: this.#health.issues.map((issue) => ({ path: "/storage", reason: issue.message })),
      });
    }
  }

  #flyRoot(flyId) {
    return join(this.fliesRoot, assertFlyId(flyId));
  }

  #profilePath(flyId, revision) {
    return join(this.#flyRoot(flyId), "profiles", revisionName(revision));
  }

  #checkpointPath(flyId, checkpointId) {
    return join(this.#flyRoot(flyId), "checkpoints", assertCheckpointId(checkpointId));
  }

  checkpointFilePath(flyId, checkpointId) {
    this.#assertReady();
    return join(this.#checkpointPath(flyId, checkpointId), "service.npz");
  }

  checkpointMetadataPath(flyId, checkpointId) {
    this.#assertReady();
    return join(this.#checkpointPath(flyId, checkpointId), "service.json");
  }

  profileFilePath(flyId, revision) {
    this.#assertReady();
    assertFlyId(flyId);
    revisionName(revision);
    return this.#profilePath(flyId, revision);
  }

  cartridgeFilePath(flyId, kind, cartridgeId, name) {
    this.#assertReady();
    assertFlyId(flyId);
    assertCheckpointId(cartridgeId);
    if (!new Set(["imports", "exports"]).has(kind)) {
      throw new FlyRepositoryError("INVALID_CARTRIDGE_KIND", "卡带目录类型无效");
    }
    if (!new Set(["cartridge.json", "state.bin"]).has(name)) {
      throw new FlyRepositoryError("INVALID_CARTRIDGE_FILE", "卡带文件名无效");
    }
    return join(this.#flyRoot(flyId), "cartridges", kind, cartridgeId, name);
  }

  cartridgeMarkerPath(flyId, name) {
    this.#assertReady();
    assertFlyId(flyId);
    if (!new Set(["active.json", "last-export.json"]).has(name)) {
      throw new FlyRepositoryError("INVALID_CARTRIDGE_MARKER", "卡带 marker 名称无效");
    }
    return join(this.#flyRoot(flyId), "cartridges", name);
  }

  async createFromCartridge({
    id, revision = 1, name = "Imported Cartridge", description = "", tags = [], spec,
    checkpointId = this.idFactory(), checkpointDirectory,
    importId = this.idFactory(), cartridgeDirectory, activeCartridge,
  } = {}) {
    this.#assertReady({ write: true });
    assertFlyId(id);
    assertCheckpointId(checkpointId);
    assertCheckpointId(importId);
    revisionName(revision);
    if (typeof checkpointDirectory !== "string" || !await exists(checkpointDirectory)) {
      throw new FlyRepositoryError("CHECKPOINT_NOT_FOUND", "卡带安装 checkpoint 不存在");
    }
    if (typeof cartridgeDirectory !== "string" || !await exists(cartridgeDirectory)) {
      throw new FlyRepositoryError("CARTRIDGE_NOT_FOUND", "卡带文件目录不存在");
    }
    return this.#withFlyLock(id, async () => {
      const root = this.#flyRoot(id);
      if (await exists(root)) throw new FlyRepositoryError("FLY_ALREADY_EXISTS", `果蝇已存在：${id}`);
      const now = this.now();
      const profile = createProfileDocument({
        flyId: id, revision, name, description, tags, spec, now,
      });
      try {
        await mkdir(join(root, "profiles"), { recursive: true });
        await mkdir(join(root, "checkpoints"), { recursive: true });
        await mkdir(join(root, "training-runs"), { recursive: true });
        await mkdir(join(root, "evaluations"), { recursive: true });
        await mkdir(join(root, "cartridges", "imports"), { recursive: true });
        await mkdir(join(root, "cartridges", "exports"), { recursive: true });
        await cp(checkpointDirectory, this.#checkpointPath(id, checkpointId), {
          recursive: true, errorOnExist: true, force: false,
        });
        const importDirectory = join(root, "cartridges", "imports", importId);
        await cp(cartridgeDirectory, importDirectory, {
          recursive: true, errorOnExist: true, force: false,
        });
        const record = {
          id, name, description, tags: structuredClone(tags), currentRevision: revision,
          activeCheckpointId: checkpointId, createdAt: now, updatedAt: now,
          archivedAt: null, clonedFrom: null,
        };
        await atomicWriteJson(this.#profilePath(id, revision), profile, { immutable: true });
        await atomicWriteJson(join(root, "fly.json"), record, { immutable: true });
        await atomicWriteJson(join(root, "cartridges", "active.json"), {
          ...structuredClone(activeCartridge), id: importId, flyId: id,
          checkpointId, profileRevision: revision,
        }, { immutable: true });
        return publicFly(record, profile);
      } catch (error) {
        // root is an exact validated UUID created exclusively by this operation.
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    });
  }

  trainingRunFilePath(flyId, trainingRunId) {
    this.#assertReady();
    assertFlyId(flyId);
    assertCheckpointId(trainingRunId);
    return join(this.#flyRoot(flyId), "training-runs", trainingRunId, "run.json");
  }

  evaluationFilePath(flyId, evaluationId) {
    this.#assertReady();
    assertFlyId(flyId);
    assertCheckpointId(evaluationId);
    return join(this.#flyRoot(flyId), "evaluations", `${evaluationId}.json`);
  }

  async readActiveMarker() {
    this.#assertReady();
    if (!await exists(this.activeMarkerPath)) return null;
    const marker = await readJson(this.activeMarkerPath);
    if (!isPlainObject(marker)
        || Object.keys(marker).sort().join(",") !== "checkpointId,flyId,revision") {
      throw new FlyRepositoryError("ACTIVE_MARKER_CORRUPT", "active marker 字段无效");
    }
    assertFlyId(marker.flyId);
    revisionName(marker.revision);
    if (marker.checkpointId !== null) assertCheckpointId(marker.checkpointId);
    return structuredClone({
      flyId: marker.flyId,
      revision: marker.revision,
      checkpointId: marker.checkpointId,
    });
  }

  async writeActiveMarker(marker) {
    this.#assertReady({ write: true });
    assertFlyId(marker?.flyId);
    revisionName(marker?.revision);
    if (marker?.checkpointId !== null) assertCheckpointId(marker?.checkpointId);
    const fly = await this.get(marker.flyId);
    if (fly.currentRevision !== marker.revision || fly.activeCheckpointId !== marker.checkpointId) {
      throw new FlyRepositoryError("ACTIVE_MARKER_MISMATCH", "active marker 必须与 fly.json 当前 revision/checkpoint 一致");
    }
    const normalized = {
      flyId: marker.flyId,
      revision: marker.revision,
      checkpointId: marker.checkpointId,
    };
    await atomicWriteJson(this.activeMarkerPath, normalized);
    return structuredClone(normalized);
  }

  async ensureCheckpointSlot(flyId, { expectedRevision, checkpointId = randomUUID() } = {}) {
    this.#assertReady({ write: true });
    assertFlyId(flyId);
    assertCheckpointId(checkpointId);
    await mkdir(this.#checkpointPath(flyId, checkpointId), { recursive: false });
    return this.setActiveCheckpoint(flyId, { expectedRevision, checkpointId });
  }

  async adoptLegacyCheckpoint(flyId, {
    expectedRevision, sourceCheckpoint, sourceMeta = sourceCheckpoint?.replace(/\.npz$/i, ".json"),
  } = {}) {
    this.#assertReady({ write: true });
    assertFlyId(flyId);
    if (typeof sourceCheckpoint !== "string" || !await exists(sourceCheckpoint)) {
      throw new FlyRepositoryError("LEGACY_CHECKPOINT_NOT_FOUND", "旧 checkpoint 不存在");
    }
    const fly = await this.get(flyId);
    if (fly.currentRevision !== expectedRevision) {
      throw revisionConflict(expectedRevision, fly.currentRevision);
    }
    const checkpointId = randomUUID();
    const directory = this.#checkpointPath(flyId, checkpointId);
    await mkdir(directory, { recursive: false });
    try {
      const sourceSha256 = await fileSha256(sourceCheckpoint);
      const destinationCheckpoint = join(directory, "service.npz");
      await atomicCopy(sourceCheckpoint, destinationCheckpoint);
      if (await fileSha256(destinationCheckpoint) !== sourceSha256) {
        throw new FlyRepositoryError("CHECKPOINT_HASH_MISMATCH", "旧 checkpoint 复制后 SHA-256 不一致");
      }
      let legacyMetadata = null;
      if (typeof sourceMeta === "string" && await exists(sourceMeta)) {
        await atomicCopy(sourceMeta, join(directory, "legacy-service.json"));
        try {
          legacyMetadata = await readJson(sourceMeta);
        } catch {
          legacyMetadata = null;
        }
      }
      const legacyToken = typeof legacyMetadata?.tokenAddress === "string"
        && /^0x(?!0{40}$)[0-9a-fA-F]{40}$/.test(legacyMetadata.tokenAddress)
        ? legacyMetadata.tokenAddress.toLowerCase() : null;
      await atomicWriteJson(join(directory, "service.json"), {
        flyId,
        profileRevision: fly.currentRevision,
        profileHash: fly.profile.metadata.profileHash,
        modelVersion: "malecns-v1",
        tokenAddress: legacyToken,
        tokenContext: { address: legacyToken, symbol: null },
        learningEnabled: true,
        savedAt: this.now(),
        weightSha256: null,
        migratedFromLegacy: true,
      }, { immutable: true });
      await atomicWriteJson(join(directory, "migration-source.json"), {
        kind: "legacy-default",
        sourceSha256,
        migratedAt: this.now(),
      }, { immutable: true });
      return await this.setActiveCheckpoint(flyId, { expectedRevision, checkpointId });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async #withFlyLock(flyId, task) {
    assertFlyId(flyId);
    const previous = this.#locks.get(flyId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.#locks.set(flyId, current);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#locks.get(flyId) === current) this.#locks.delete(flyId);
    }
  }

  async #listRevisionsUnchecked(flyId) {
    const entries = await readdir(join(this.#flyRoot(flyId), "profiles"));
    return entries
      .filter((name) => REVISION_FILE_PATTERN.test(name) && !TEMP_FILE_PATTERN.test(name))
      .map((name) => Number(REVISION_FILE_PATTERN.exec(name)[1]))
      .sort((a, b) => a - b);
  }

  async #readFly(flyId) {
    const record = await readJson(join(this.#flyRoot(flyId), "fly.json"));
    validateFlyRecord(record, flyId);
    const profile = await readJson(this.#profilePath(flyId, record.currentRevision));
    validateProfileDocument(profile);
    return { record, profile };
  }

  async #commitProfile(flyId, record, profile) {
    validateProfileDocument(profile);
    await atomicWriteJson(this.#profilePath(flyId, profile.metadata.revision), profile, { immutable: true });
    const nextRecord = {
      ...record,
      name: profile.metadata.name,
      description: profile.metadata.description,
      tags: structuredClone(profile.metadata.tags),
      currentRevision: profile.metadata.revision,
      updatedAt: profile.metadata.updatedAt,
    };
    await atomicWriteJson(join(this.#flyRoot(flyId), "fly.json"), nextRecord);
    if (await exists(this.activeMarkerPath)) {
      const marker = await readJson(this.activeMarkerPath);
      if (marker?.flyId === flyId) {
        await atomicWriteJson(this.activeMarkerPath, {
          flyId,
          revision: nextRecord.currentRevision,
          checkpointId: nextRecord.activeCheckpointId,
        });
      }
    }
    return publicFly(nextRecord, profile);
  }

  async create({ id = this.idFactory(), name, description = "", tags = [], spec = {} } = {}) {
    this.#assertReady({ write: true });
    assertFlyId(id);
    return this.#withFlyLock(id, async () => {
      const root = this.#flyRoot(id);
      if (await exists(root)) throw new FlyRepositoryError("FLY_ALREADY_EXISTS", `果蝇已存在：${id}`);
      const now = this.now();
      const profile = createProfileDocument({ flyId: id, revision: 1, name, description, tags, spec, now });
      await mkdir(join(root, "profiles"), { recursive: true });
      await mkdir(join(root, "checkpoints"), { recursive: true });
      await mkdir(join(root, "training-runs"), { recursive: true });
      await mkdir(join(root, "evaluations"), { recursive: true });
      await mkdir(join(root, "cartridges", "imports"), { recursive: true });
      await mkdir(join(root, "cartridges", "exports"), { recursive: true });
      const record = {
        id,
        name,
        description,
        tags: structuredClone(tags),
        currentRevision: 1,
        activeCheckpointId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        clonedFrom: null,
      };
      await atomicWriteJson(this.#profilePath(id, 1), profile, { immutable: true });
      await atomicWriteJson(join(root, "fly.json"), record, { immutable: true });
      return publicFly(record, profile);
    });
  }

  async list({ includeArchived = false } = {}) {
    this.#assertReady();
    const entries = await readdir(this.fliesRoot, { withFileTypes: true });
    const flies = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const fly = await this.get(entry.name);
      if (includeArchived || fly.archivedAt === null) flies.push(fly);
    }
    return flies.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async get(flyId) {
    this.#assertReady();
    assertFlyId(flyId);
    try {
      const { record, profile } = await this.#readFly(flyId);
      return publicFly(record, profile);
    } catch (error) {
      if (error.code === "ENOENT") throw new FlyRepositoryError("FLY_NOT_FOUND", `果蝇不存在：${flyId}`, { cause: error });
      throw error;
    }
  }

  async updateMetadata(flyId, { expectedRevision, ...changes } = {}) {
    this.#assertReady({ write: true });
    assertFlyId(flyId);
    const allowed = new Set(["name", "description", "tags"]);
    for (const key of Object.keys(changes)) {
      if (!allowed.has(key)) throw new FlyRepositoryError("INVALID_METADATA_PATCH", `不允许修改 metadata.${key}`);
    }
    return this.#withFlyLock(flyId, async () => {
      const { record, profile } = await this.#readFly(flyId);
      if (record.currentRevision !== expectedRevision) throw revisionConflict(expectedRevision, record.currentRevision);
      const now = this.now();
      const next = createProfileDocument({
        flyId,
        revision: record.currentRevision + 1,
        name: changes.name ?? profile.metadata.name,
        description: changes.description ?? profile.metadata.description,
        tags: changes.tags ?? profile.metadata.tags,
        spec: profile.spec,
        createdAt: profile.metadata.createdAt,
        updatedAt: now,
      });
      return this.#commitProfile(flyId, record, next);
    });
  }

  async updateProfile(flyId, { expectedRevision, spec } = {}) {
    this.#assertReady({ write: true });
    assertFlyId(flyId);
    return this.#withFlyLock(flyId, async () => {
      const { record, profile } = await this.#readFly(flyId);
      if (record.currentRevision !== expectedRevision) throw revisionConflict(expectedRevision, record.currentRevision);
      const merged = normalizeProfileSpec(mergeProfileSpec(profile.spec, spec));
      const now = this.now();
      const next = createProfileDocument({
        flyId,
        revision: record.currentRevision + 1,
        name: profile.metadata.name,
        description: profile.metadata.description,
        tags: profile.metadata.tags,
        spec: merged,
        createdAt: profile.metadata.createdAt,
        updatedAt: now,
      });
      return this.#commitProfile(flyId, record, next);
    });
  }

  async listRevisions(flyId) {
    this.#assertReady();
    assertFlyId(flyId);
    await this.get(flyId);
    return this.#listRevisionsUnchecked(flyId);
  }

  async getRevision(flyId, revision) {
    this.#assertReady();
    assertFlyId(flyId);
    revisionName(revision);
    await this.get(flyId);
    try {
      const profile = await readJson(this.#profilePath(flyId, revision));
      validateProfileDocument(profile);
      return structuredClone(profile);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new FlyRepositoryError("PROFILE_REVISION_NOT_FOUND", `Revision 不存在：${revision}`, { cause: error });
      }
      throw error;
    }
  }

  async rollback(flyId, { expectedRevision, revision } = {}) {
    this.#assertReady({ write: true });
    assertFlyId(flyId);
    return this.#withFlyLock(flyId, async () => {
      const { record, profile } = await this.#readFly(flyId);
      if (record.currentRevision !== expectedRevision) throw revisionConflict(expectedRevision, record.currentRevision);
      let source;
      try {
        source = await readJson(this.#profilePath(flyId, revision));
        validateProfileDocument(source);
      } catch (error) {
        if (error.code === "ENOENT") throw new FlyRepositoryError("PROFILE_REVISION_NOT_FOUND", `Revision 不存在：${revision}`, { cause: error });
        throw error;
      }
      const now = this.now();
      const next = createProfileDocument({
        flyId,
        revision: record.currentRevision + 1,
        name: profile.metadata.name,
        description: profile.metadata.description,
        tags: profile.metadata.tags,
        spec: source.spec,
        createdAt: profile.metadata.createdAt,
        updatedAt: now,
      });
      return this.#commitProfile(flyId, record, next);
    });
  }

  async setActiveCheckpoint(flyId, { expectedRevision, checkpointId } = {}) {
    this.#assertReady({ write: true });
    assertFlyId(flyId);
    if (checkpointId !== null) assertCheckpointId(checkpointId);
    return this.#withFlyLock(flyId, async () => {
      const { record, profile } = await this.#readFly(flyId);
      if (record.currentRevision !== expectedRevision) throw revisionConflict(expectedRevision, record.currentRevision);
      if (checkpointId !== null && !await exists(this.#checkpointPath(flyId, checkpointId))) {
        throw new FlyRepositoryError("CHECKPOINT_NOT_FOUND", `Checkpoint 不存在：${checkpointId}`);
      }
      const next = { ...record, activeCheckpointId: checkpointId, updatedAt: this.now() };
      await atomicWriteJson(join(this.#flyRoot(flyId), "fly.json"), next);
      return publicFly(next, profile);
    });
  }

  async clone(flyId, {
    id = this.idFactory(), name, description, tags, copyCheckpoint = false, checkpointId,
  } = {}) {
    this.#assertReady({ write: true });
    assertFlyId(flyId);
    assertFlyId(id);
    if (checkpointId !== undefined) assertCheckpointId(checkpointId);
    const source = await this.get(flyId);
    const sourceCheckpointId = checkpointId ?? source.activeCheckpointId;
    if (copyCheckpoint && sourceCheckpointId === null) {
      throw new FlyRepositoryError("CHECKPOINT_NOT_FOUND", "源果蝇没有可复制的活动 checkpoint");
    }
    if (copyCheckpoint && !await exists(this.#checkpointPath(flyId, sourceCheckpointId))) {
      throw new FlyRepositoryError("CHECKPOINT_NOT_FOUND", `Checkpoint 不存在：${sourceCheckpointId}`);
    }

    const clone = await this.create({
      id,
      name: name ?? `${source.name}（克隆）`,
      description: description ?? source.description,
      tags: tags ?? source.tags,
      spec: source.profile.spec,
    });
    const clonedFrom = {
      flyId,
      revision: source.currentRevision,
      checkpointId: copyCheckpoint ? sourceCheckpointId : null,
    };
    let activeCheckpointId = null;
    if (copyCheckpoint) {
      activeCheckpointId = this.idFactory();
      assertCheckpointId(activeCheckpointId);
      const destination = this.#checkpointPath(clone.id, activeCheckpointId);
      await cp(this.#checkpointPath(flyId, sourceCheckpointId), destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      const clonedMetadataPath = join(destination, "service.json");
      if (await exists(clonedMetadataPath)) {
        const clonedMetadata = await readJson(clonedMetadataPath);
        await atomicWriteJson(clonedMetadataPath, {
          ...clonedMetadata,
          flyId: clone.id,
          profileRevision: clone.currentRevision,
          profileHash: clone.profile.metadata.profileHash,
          modelVersion: "malecns-v1",
          clonedFrom: { flyId, checkpointId: sourceCheckpointId },
        });
      }
      await atomicWriteJson(join(destination, "clone-source.json"), {
        source: { flyId, checkpointId: sourceCheckpointId },
        clonedAt: this.now(),
      }, { immutable: true });
    }
    const record = {
      ...clone,
      profile: undefined,
      activeCheckpointId,
      clonedFrom,
      updatedAt: this.now(),
    };
    delete record.profile;
    await atomicWriteJson(join(this.#flyRoot(clone.id), "fly.json"), record);
    return publicFly(record, clone.profile);
  }

  async archive(flyId, { expectedRevision, archived = true } = {}) {
    this.#assertReady({ write: true });
    assertFlyId(flyId);
    return this.#withFlyLock(flyId, async () => {
      const { record, profile } = await this.#readFly(flyId);
      if (record.currentRevision !== expectedRevision) throw revisionConflict(expectedRevision, record.currentRevision);
      const now = this.now();
      const next = { ...record, archivedAt: archived ? now : null, updatedAt: now };
      await atomicWriteJson(join(this.#flyRoot(flyId), "fly.json"), next);
      return publicFly(next, profile);
    });
  }
}
