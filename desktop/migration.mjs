import { createHash, randomUUID } from "node:crypto";
import {
  copyFile, mkdir, open, readFile, readdir, rename, rm, stat, statfs,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { FlyRepository } from "../src/flies/fly-repository.mjs";
import { CURRENT_SCHEMA_VERSION } from "../src/persistence/migrations.mjs";

const MIGRATION_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE_MARGIN_BYTES = 8 * 1024 * 1024;
const STAGES = ["started", "backed-up", "fly-created", "checkpoint-adopted", "pointer-updated", "complete"];

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function sha256File(path) {
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

function dataRelative(paths, path) {
  return relative(paths.dataRoot, path).split(sep).join("/");
}

function resolveDataPath(paths, path) {
  if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error("迁移 journal 包含无效相对路径");
  }
  const target = resolve(paths.dataRoot, path);
  const root = `${resolve(paths.dataRoot)}${sep}`;
  if (!target.startsWith(root)) throw new Error("迁移 journal 路径越界");
  return target;
}

function migrationPaths(paths) {
  const root = join(paths.dataRoot, "migrations", "fly-profile-v1");
  return {
    root,
    journal: join(root, "journal.json"),
    complete: join(root, "complete.json"),
  };
}

async function sqliteVersion(path) {
  if (!await exists(path)) return { exists: false, version: 0, supported: true, bytes: 0 };
  const info = await stat(path);
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const table = (name) => Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(name));
    let version = 0;
    if (table("schema_meta")) {
      const rows = database.prepare("SELECT version FROM schema_meta").all();
      version = rows.length === 1 && Number.isSafeInteger(rows[0].version) ? rows[0].version : null;
    } else if (table("sessions")) version = 1;
    return {
      exists: true, version, supported: Number.isSafeInteger(version) && version <= CURRENT_SCHEMA_VERSION,
      bytes: info.size,
    };
  } catch (error) {
    return { exists: true, version: null, supported: false, bytes: info.size, error: error.message };
  } finally {
    database?.close();
  }
}

async function legacySource(paths) {
  const markerPath = join(paths.dataRoot, "cartridge-console", "active.json");
  if (await exists(markerPath)) {
    try {
      const marker = await readJson(markerPath);
      const checkpoint = join(paths.dataRoot, "cartridge-console", "runs", marker.id, "service.npz");
      if (UUID.test(marker.id) && await exists(checkpoint)) {
        const metadata = checkpoint.replace(/\.npz$/i, ".json");
        return {
          kind: "v3-active", checkpoint: dataRelative(paths, checkpoint),
          metadata: await exists(metadata) ? dataRelative(paths, metadata) : null,
          marker: dataRelative(paths, markerPath), bytes: (await stat(checkpoint)).size,
        };
      }
    } catch {
      // A corrupt optional v3 marker is reported separately and never guessed.
    }
  }
  const checkpoint = join(paths.dataRoot, "full-brain", "service.npz");
  if (!await exists(checkpoint)) return null;
  const metadata = checkpoint.replace(/\.npz$/i, ".json");
  return {
    kind: "legacy-full-brain", checkpoint: dataRelative(paths, checkpoint),
    metadata: await exists(metadata) ? dataRelative(paths, metadata) : null,
    marker: null, bytes: (await stat(checkpoint)).size,
  };
}

async function existingFlyCount(paths) {
  const root = join(paths.dataRoot, "flies");
  if (!await exists(root)) return 0;
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && UUID.test(entry.name)).length;
}

async function activeCheckpointStatus(paths) {
  const markerPath = join(paths.dataRoot, "active-fly.json");
  if (!await exists(markerPath)) return { selected: false, valid: true };
  try {
    const marker = await readJson(markerPath);
    if (!UUID.test(marker.flyId) || !UUID.test(marker.checkpointId)) {
      return { selected: true, valid: false, reason: "active-fly.json 字段无效" };
    }
    const checkpoint = join(paths.dataRoot, "flies", marker.flyId,
      "checkpoints", marker.checkpointId, "service.npz");
    return { selected: true, valid: await exists(checkpoint), flyId: marker.flyId,
      checkpointId: marker.checkpointId };
  } catch (error) {
    return { selected: true, valid: false, reason: error.message };
  }
}

function backupCandidates(paths) {
  return [
    "bsc-fly-agent.sqlite", "bsc-fly-agent.sqlite-wal", "bsc-fly-agent.sqlite-shm",
    "local-wallet.vault.json", "active-fly.json", "full-brain/service.json",
    "cartridge-console/active.json", "cartridge-console/last-export.json",
  ].map((path) => ({ relativePath: path, source: resolveDataPath(paths, path) }));
}

export async function desktopPreflight(paths, { statfsFn = statfs } = {}) {
  const databasePath = join(paths.dataRoot, "bsc-fly-agent.sqlite");
  const [source, database, flyCount, activeCheckpoint] = await Promise.all([
    legacySource(paths), sqliteVersion(databasePath), existingFlyCount(paths),
    activeCheckpointStatus(paths),
  ]);
  let backupBytes = 0;
  for (const item of backupCandidates(paths)) {
    if (await exists(item.source)) backupBytes += (await stat(item.source)).size;
  }
  let disk;
  try {
    const value = await statfsFn(paths.userData);
    disk = { availableBytes: Number(value.bavail) * Number(value.bsize) };
  } catch (error) {
    disk = { availableBytes: null, error: error.message };
  }
  const requiredBytes = backupBytes + (source?.bytes || 0) + BASE_MARGIN_BYTES;
  return {
    version: MIGRATION_VERSION,
    disk: { ...disk, requiredBytes,
      sufficient: disk.availableBytes === null ? null : disk.availableBytes >= requiredBytes },
    legacy: { found: Boolean(source), source },
    database,
    flies: { count: flyCount },
    activeCheckpoint,
    currentSchemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

async function copyVerified(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const sourceHash = await sha256File(source);
  if (await exists(destination)) {
    if (await sha256File(destination) !== sourceHash) throw new Error(`迁移备份校验失败：${destination}`);
  } else {
    await copyFile(source, destination);
    if (await sha256File(destination) !== sourceHash) throw new Error(`迁移备份 SHA-256 不一致：${destination}`);
  }
  const info = await stat(source);
  return { bytes: info.size, sha256: sourceHash };
}

async function createBackup(paths, journal, now) {
  const backupRoot = resolveDataPath(paths, journal.backupRelative);
  const manifestPath = join(backupRoot, "manifest.json");
  if (await exists(manifestPath)) return readJson(manifestPath);
  const files = [];
  for (const item of backupCandidates(paths)) {
    if (!await exists(item.source)) continue;
    const copied = await copyVerified(item.source, join(backupRoot, item.relativePath));
    files.push({ path: item.relativePath, ...copied });
  }
  const manifest = {
    format: "flap-desktop-migration-backup", version: 1,
    migrationId: journal.migrationId, createdAt: now(), files,
    excludedLargeState: [
      { path: "full-brain/service.npz", reason: "checkpoint is hash-verified into its fly instead" },
      { path: "full-brain/graph.npz", reason: "shared MaleCNS data is reproducible and not duplicated" },
      { path: "full-brain/annotations.feather", reason: "shared MaleCNS data is reproducible and not duplicated" },
      { path: "full-brain/normalized/", reason: "shared MaleCNS data is reproducible and not duplicated" },
    ],
  };
  await atomicJson(manifestPath, manifest);
  return manifest;
}

function assertJournal(journal) {
  if (journal?.format !== "flap-desktop-migration" || journal.version !== MIGRATION_VERSION
      || !UUID.test(journal.migrationId) || !UUID.test(journal.flyId)
      || !STAGES.includes(journal.stage)) {
    throw new Error("桌面迁移 journal 无效，拒绝猜测恢复");
  }
  return journal;
}

function stageAtLeast(journal, stage) {
  return STAGES.indexOf(journal.stage) >= STAGES.indexOf(stage);
}

async function archiveLegacyMarker(paths, journal, checkpointId, now) {
  if (journal.source?.kind !== "v3-active" || !journal.source.marker) return;
  const markerPath = resolveDataPath(paths, journal.source.marker);
  if (!await exists(markerPath)) return;
  const marker = await readJson(markerPath);
  const archivedPath = join(dirname(markerPath), "legacy-active-migrated.json");
  if (await exists(archivedPath)) {
    const archived = await readJson(archivedPath);
    if (archived.migratedTo?.flyId !== journal.flyId
        || archived.migratedTo?.checkpointId !== checkpointId) {
      throw new Error("旧卡带迁移归档与当前 journal 不一致");
    }
    await rm(markerPath, { force: true });
    return;
  }
  await atomicJson(archivedPath, {
    ...marker,
    migratedTo: { flyId: journal.flyId, checkpointId },
    migratedAt: now(),
  });
  await rm(markerPath, { force: true });
}

export async function runDesktopMigration(paths, {
  preflight = null, onProgress = () => {}, now = () => new Date().toISOString(),
  idFactory = randomUUID, afterStage = async () => {},
} = {}) {
  const report = preflight || await desktopPreflight(paths);
  if (report.disk.sufficient === false) {
    throw new Error(`迁移空间不足：需要 ${report.disk.requiredBytes} 字节，可用 ${report.disk.availableBytes} 字节`);
  }
  if (!report.database.supported) {
    throw new Error(`SQLite 版本无法安全迁移：${report.database.version ?? report.database.error ?? "unknown"}`);
  }
  if (!report.activeCheckpoint.valid) throw new Error(report.activeCheckpoint.reason || "活动 checkpoint 缺失");

  const pathsForMigration = migrationPaths(paths);
  if (await exists(pathsForMigration.complete)) {
    return { migrated: false, resumed: false, complete: await readJson(pathsForMigration.complete), report };
  }
  await mkdir(pathsForMigration.root, { recursive: true });
  let resumed = await exists(pathsForMigration.journal);
  let journal;
  if (resumed) {
    journal = assertJournal(await readJson(pathsForMigration.journal));
  } else {
    const migrationId = idFactory();
    const flyId = idFactory();
    if (!UUID.test(migrationId) || !UUID.test(flyId)) throw new Error("迁移 ID 生成器未返回 UUID");
    journal = {
      format: "flap-desktop-migration", version: MIGRATION_VERSION,
      migrationId, flyId, stage: "started", startedAt: now(), updatedAt: now(),
      source: report.legacy.source,
      backupRelative: `migration-backups/fly-profile-v1/${migrationId}`,
      checkpointId: null, skippedReason: null,
    };
    await atomicJson(pathsForMigration.journal, journal);
    await afterStage("started", structuredClone(journal));
  }
  const saveStage = async (stage, changes = {}) => {
    journal = { ...journal, ...changes, stage, updatedAt: now() };
    await atomicJson(pathsForMigration.journal, journal);
    onProgress({ stage: "migration", percent: null, message: `果蝇数据迁移：${stage}` });
    await afterStage(stage, structuredClone(journal));
  };

  onProgress({ stage: "migration", percent: null,
    message: resumed ? "正在恢复未完成的果蝇数据迁移" : "正在迁移旧果蝇数据" });
  if (!stageAtLeast(journal, "backed-up")) {
    const manifest = await createBackup(paths, journal, now);
    await saveStage("backed-up", { backupManifest: `${journal.backupRelative}/manifest.json`,
      backupFileCount: manifest.files.length });
  }

  const repository = new FlyRepository({ dataRoot: paths.dataRoot, now, idFactory });
  const health = await repository.init();
  if (health.readOnly) throw new Error(`果蝇仓库一致性检查失败：${health.issues[0]?.message || "unknown"}`);
  const flies = await repository.list({ includeArchived: true });
  let fly = flies.find((item) => item.id === journal.flyId) || null;

  if (!journal.source || (flies.length > 0 && !fly)) {
    if (!stageAtLeast(journal, "pointer-updated")) {
      await saveStage("pointer-updated", {
        skippedReason: journal.source ? "existing-flies" : "clean-install",
      });
    }
  } else {
    const sourceCheckpoint = resolveDataPath(paths, journal.source.checkpoint);
    const sourceMetadata = journal.source.metadata
      ? resolveDataPath(paths, journal.source.metadata) : undefined;
    if (!await exists(sourceCheckpoint)) throw new Error("迁移源 checkpoint 已不存在，保留 journal 等待人工处理");
    if (!fly) {
      fly = await repository.create({
        id: journal.flyId, name: "legacy-default",
        description: "Windows v1 升级时从旧版活动 checkpoint 保留迁移",
        tags: ["legacy-migration"],
      });
      await saveStage("fly-created");
    }
    if (fly.activeCheckpointId === null) {
      fly = await repository.adoptLegacyCheckpoint(fly.id, {
        expectedRevision: fly.currentRevision,
        sourceCheckpoint,
        sourceMeta: sourceMetadata,
      });
      const sourceSha256 = await sha256File(sourceCheckpoint);
      const copiedSha256 = await sha256File(repository.checkpointFilePath(fly.id, fly.activeCheckpointId));
      if (sourceSha256 !== copiedSha256) throw new Error("迁移 checkpoint 最终 SHA-256 校验失败");
      await saveStage("checkpoint-adopted", { checkpointId: fly.activeCheckpointId, sourceSha256 });
    } else if (!stageAtLeast(journal, "checkpoint-adopted")) {
      const sourceSha256 = await sha256File(sourceCheckpoint);
      const copiedSha256 = await sha256File(repository.checkpointFilePath(fly.id, fly.activeCheckpointId));
      if (sourceSha256 !== copiedSha256) throw new Error("恢复迁移时 checkpoint SHA-256 不一致");
      await saveStage("checkpoint-adopted", { checkpointId: fly.activeCheckpointId, sourceSha256 });
    }
    if (!stageAtLeast(journal, "pointer-updated")) {
      await repository.writeActiveMarker({
        flyId: fly.id, revision: fly.currentRevision, checkpointId: fly.activeCheckpointId,
      });
      await archiveLegacyMarker(paths, journal, fly.activeCheckpointId, now);
      await saveStage("pointer-updated");
    }
  }

  if (!stageAtLeast(journal, "complete")) await saveStage("complete");
  const complete = {
    format: "flap-desktop-migration-complete", version: MIGRATION_VERSION,
    migrationId: journal.migrationId, completedAt: now(),
    flyId: journal.skippedReason ? null : journal.flyId,
    checkpointId: journal.checkpointId,
    backupManifest: journal.backupManifest,
    skippedReason: journal.skippedReason,
  };
  await atomicJson(pathsForMigration.complete, complete);
  onProgress({ stage: "migration-complete", percent: 100, message: "旧果蝇数据迁移完成" });
  return { migrated: !complete.skippedReason, resumed, complete, report };
}

export { migrationPaths };
