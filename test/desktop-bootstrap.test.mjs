import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  PYTHON_INSTALLER_SHA256,
  PYTHON_INSTALLER_URL,
  brainReady,
  windowsRuntimePaths,
} from "../desktop/bootstrap.mjs";
import {
  desktopPreflight,
  migrationPaths,
  runDesktopMigration,
  sha256File,
} from "../desktop/migration.mjs";

const LEGACY_SQL = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, token_address TEXT NOT NULL, started_at TEXT NOT NULL,
    status TEXT NOT NULL, checkpoint_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`;

function makePaths(root) {
  return windowsRuntimePaths({ userData: root, runtimeRoot: join(root, "runtime") });
}

async function createLegacyDatabase(path) {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try { db.exec(LEGACY_SQL); }
  finally { db.close(); }
}

test("Windows desktop runtime keeps mutable state outside packaged resources", () => {
  const paths = windowsRuntimePaths({ userData: "C:\\Users\\Alice\\AppData\\Local\\FLAP", runtimeRoot: "C:\\Program Files\\FLAP\\resources" });
  assert.match(paths.dataRoot, /AppData[\\/]Local[\\/]FLAP[\\/]data$/);
  assert.match(paths.venvPython, /AppData[\\/]Local[\\/]FLAP[\\/]work[\\/]full-brain-venv[\\/]Scripts[\\/]python\.exe$/);
  assert.match(paths.requirements, /Program Files[\\/]FLAP[\\/]resources[\\/]server[\\/]full-brain[\\/]requirements\.txt$/);
  assert.ok(!paths.dataRoot.startsWith(paths.runtimeRoot));
});

test("Windows bootstrap pins the official Python installer by HTTPS and SHA-256", () => {
  assert.equal(PYTHON_INSTALLER_URL, "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe");
  assert.match(PYTHON_INSTALLER_SHA256, /^[0-9a-f]{64}$/);
});

test("brain readiness requires the interpreter and all locked data entry points", async () => {
  const root = await mkdtemp(join(tmpdir(), "flap-desktop-test-"));
  const paths = windowsRuntimePaths({ userData: root, runtimeRoot: join(root, "runtime") });
  try {
    assert.equal(brainReady(paths), false);
    for (const path of [
      paths.venvPython,
      join(paths.brainData, "graph.npz"),
      join(paths.brainData, "annotations.feather"),
      join(paths.brainData, "normalized", "neurons.feather"),
    ]) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "test");
    }
    assert.equal(brainReady(paths), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop migration clean install writes a resumable completion marker without inventing a fly", async () => {
  const root = await mkdtemp(join(tmpdir(), "flap-desktop-clean-"));
  const paths = makePaths(root);
  try {
    const report = await desktopPreflight(paths);
    assert.equal(report.legacy.found, false);
    assert.equal(report.database.version, 0);
    assert.equal(report.activeCheckpoint.valid, true);
    await assert.rejects(stat(paths.dataRoot), /ENOENT/);
    const result = await runDesktopMigration(paths, { preflight: report });
    assert.equal(result.migrated, false);
    assert.equal(result.complete.skippedReason, "clean-install");
    assert.equal((await stat(join(paths.dataRoot, "flies"))).isDirectory(), true);
    const complete = JSON.parse(await readFile(migrationPaths(paths).complete, "utf8"));
    assert.equal(complete.flyId, null);
    const manifest = JSON.parse(await readFile(
      join(paths.dataRoot, complete.backupManifest), "utf8"));
    assert.equal(manifest.files.length, 0);
    assert.ok(manifest.excludedLargeState.some((item) => item.path === "full-brain/graph.npz"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop preflight blocks an explicitly insufficient disk without writing migration state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flap-desktop-space-"));
  const paths = makePaths(root);
  try {
    const report = await desktopPreflight(paths, {
      statfsFn: async () => ({ bavail: 1n, bsize: 1n }),
    });
    assert.equal(report.disk.sufficient, false);
    await assert.rejects(runDesktopMigration(paths, { preflight: report }), /迁移空间不足/);
    await assert.rejects(stat(paths.dataRoot), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop migration backs up metadata and migrates one legacy checkpoint after SHA-256 verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "flap-desktop-legacy-"));
  const paths = makePaths(root);
  const checkpoint = join(paths.dataRoot, "full-brain", "service.npz");
  const database = join(paths.dataRoot, "bsc-fly-agent.sqlite");
  try {
    await mkdir(join(paths.dataRoot, "full-brain"), { recursive: true });
    await writeFile(checkpoint, Buffer.from("legacy-checkpoint-exact-bytes"));
    await writeFile(join(paths.dataRoot, "full-brain", "service.json"), "{\"legacy\":true}");
    await writeFile(join(paths.dataRoot, "local-wallet.vault.json"), "{\"ciphertext\":\"opaque\"}");
    await createLegacyDatabase(database);
    const beforeHash = await sha256File(checkpoint);

    const report = await desktopPreflight(paths);
    assert.equal(report.legacy.source.kind, "legacy-full-brain");
    assert.equal(report.database.version, 1);
    const result = await runDesktopMigration(paths, { preflight: report });
    assert.equal(result.migrated, true);
    const marker = JSON.parse(await readFile(join(paths.dataRoot, "active-fly.json"), "utf8"));
    const migrated = join(paths.dataRoot, "flies", marker.flyId,
      "checkpoints", marker.checkpointId, "service.npz");
    assert.equal(await sha256File(migrated), beforeHash);
    assert.equal(await sha256File(checkpoint), beforeHash);
    const provenance = JSON.parse(await readFile(join(paths.dataRoot, "flies", marker.flyId,
      "checkpoints", marker.checkpointId, "migration-source.json"), "utf8"));
    assert.equal(provenance.sourceSha256, beforeHash);

    const manifest = JSON.parse(await readFile(
      join(paths.dataRoot, result.complete.backupManifest), "utf8"));
    assert.ok(manifest.files.some((item) => item.path === "bsc-fly-agent.sqlite"));
    assert.ok(manifest.files.some((item) => item.path === "local-wallet.vault.json"));
    assert.ok(!manifest.files.some((item) => item.path.endsWith("service.npz")));
    assert.equal((await stat(join(paths.dataRoot, result.complete.backupManifest))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted desktop migration resumes from its journal without duplicating the fly", async () => {
  const root = await mkdtemp(join(tmpdir(), "flap-desktop-resume-"));
  const paths = makePaths(root);
  const checkpoint = join(paths.dataRoot, "full-brain", "service.npz");
  try {
    await mkdir(join(paths.dataRoot, "full-brain"), { recursive: true });
    await writeFile(checkpoint, "resume-checkpoint", "utf8");
    let interrupted = false;
    await assert.rejects(runDesktopMigration(paths, {
      afterStage: async (stage) => {
        if (stage === "fly-created" && !interrupted) {
          interrupted = true;
          throw new Error("injected migration interruption");
        }
      },
    }), /injected migration interruption/);
    const partial = JSON.parse(await readFile(migrationPaths(paths).journal, "utf8"));
    assert.equal(partial.stage, "fly-created");

    const resumed = await runDesktopMigration(paths);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.migrated, true);
    const flyDirectories = (await readdir(join(paths.dataRoot, "flies"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    assert.equal(flyDirectories.length, 1);
    assert.equal(flyDirectories[0].name, partial.flyId);
    const marker = JSON.parse(await readFile(join(paths.dataRoot, "active-fly.json"), "utf8"));
    assert.equal(marker.flyId, partial.flyId);
    assert.equal(await sha256File(join(paths.dataRoot, "flies", marker.flyId,
      "checkpoints", marker.checkpointId, "service.npz")), await sha256File(checkpoint));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop migration prefers and retires the old active v3 marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "flap-desktop-v3-"));
  const paths = makePaths(root);
  const runId = "11111111-1111-4111-8111-111111111111";
  const runRoot = join(paths.dataRoot, "cartridge-console", "runs", runId);
  try {
    await mkdir(runRoot, { recursive: true });
    await mkdir(join(paths.dataRoot, "full-brain"), { recursive: true });
    await writeFile(join(runRoot, "service.npz"), "active-v3", "utf8");
    await writeFile(join(paths.dataRoot, "full-brain", "service.npz"), "older-full-brain", "utf8");
    await writeFile(join(paths.dataRoot, "cartridge-console", "active.json"),
      JSON.stringify({ id: runId, cardId: `0x${"a".repeat(64)}` }), "utf8");

    const report = await desktopPreflight(paths);
    assert.equal(report.legacy.source.kind, "v3-active");
    const result = await runDesktopMigration(paths, { preflight: report });
    const marker = JSON.parse(await readFile(join(paths.dataRoot, "active-fly.json"), "utf8"));
    assert.equal(await readFile(join(paths.dataRoot, "flies", marker.flyId,
      "checkpoints", marker.checkpointId, "service.npz"), "utf8"), "active-v3");
    const archived = JSON.parse(await readFile(join(paths.dataRoot,
      "cartridge-console", "legacy-active-migrated.json"), "utf8"));
    assert.equal(archived.migratedTo.flyId, result.complete.flyId);
    await assert.rejects(readFile(join(paths.dataRoot, "cartridge-console", "active.json")), /ENOENT/);
    assert.equal(await readFile(join(paths.dataRoot, "full-brain", "service.npz"), "utf8"), "older-full-brain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop package preserves user data and startup failures disclose the log location", () => {
  const root = join(import.meta.dirname, "..");
  const builder = readFileSync(join(root, "electron-builder.yml"), "utf8");
  const main = readFileSync(join(root, "desktop", "main.mjs"), "utf8");
  const loading = readFileSync(join(root, "desktop", "loading.html"), "utf8");
  assert.match(builder, /deleteAppDataOnUninstall:\s*false/);
  assert.match(main, /desktopPreflight/);
  assert.match(main, /runDesktopMigration/);
  assert.match(main, /诊断日志/);
  assert.match(loading, /正在检查并迁移旧数据|检查并迁移旧数据/);
});

test("desktop navigation is limited to packaged pages, loopback backend, and exact BscScan transactions", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "desktop", "main.mjs"), "utf8");
  assert.match(main, /allowedLocalPages/);
  assert.match(main, /setup\.html/);
  assert.match(main, /loading\.html/);
  assert.match(main, /bscscan\\\.com\\\/tx\\\/0x\[0-9a-f\]\{64\}/i);
  assert.doesNotMatch(main, /url\.startsWith\("file:"\)/);
  assert.ok(!main.includes('if (/^https:\\/\\//i.test(url))'));
});
