import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CartridgeDeck } from "../src/cartridge/deck.mjs";
import { FlyRepository } from "../src/flies/fly-repository.mjs";

const TOKEN = `0x${"1".repeat(40)}`;
const V3_CARD = `0x${"2".repeat(64)}`;

async function balancedSpec() {
  return JSON.parse(await readFile(new URL(
    "../src/profile/presets/balanced-v1.json", import.meta.url), "utf8"))["spec"];
}

test("a v3 import becomes a new fly with per-fly v4 cartridge state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flap-cartridge-v4-deck-"));
  const repository = new FlyRepository({ dataRoot: join(root, "data") });
  await repository.init();
  const spec = await balancedSpec();
  const brain = {
    python: "python",
    checkpoint: join(root, "initial.npz"),
    async park() {},
    activateCheckpoint(path) { this.checkpoint = path; },
    snapshot() { return { status: "idle" }; },
  };
  let context = null;
  let wrappedFlyId = null;
  const runV4 = async (_python, args) => {
    const command = args[0];
    const output = args[args.indexOf("--out") + 1];
    if (command === "wrap-v3") {
      wrappedFlyId = args[args.indexOf("--fly-id") + 1];
      await cp(args[1], output, { recursive: true });
      return { sourceCardId: V3_CARD };
    }
    if (command === "install") {
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "service.npz"), "checkpoint", "utf8");
      await writeFile(join(output, "service.json"), "{}", "utf8");
      return {
        cardId: "3".repeat(64), profileHash: `sha256:${"4".repeat(64)}`,
        traitKey: `sha256:${"5".repeat(64)}`, stateSha256: "6".repeat(64),
        stateBytes: 5, fixedBootProbe: { ok: true },
        fly: { flyId: wrappedFlyId, profileRevision: 1 }, profile: spec,
        provenance: { sourceFormatVersion: 3, sourceCardId: V3_CARD },
      };
    }
    if (command === "export") {
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "cartridge.json"), "exported", "utf8");
      await writeFile(join(output, "state.bin"), "state", "utf8");
      return {
        cardId: "7".repeat(64), profileHash: `sha256:${"4".repeat(64)}`,
        traitKey: `sha256:${"5".repeat(64)}`, stateSha256: "6".repeat(64),
        stateBytes: 5, manifestBytes: 8,
        publishability: { localValid: true, publishableToRegistryV3: false },
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const deck = new CartridgeDeck({
    root: join(root, "legacy-deck"), repository, brain, runV4,
    runtime: { state: { status: "idle" } },
    getActiveContext: () => context,
    activateFly: async (flyId) => {
      const fly = await repository.get(flyId);
      context = {
        flyId, revision: fly.currentRevision, checkpointId: fly.activeCheckpointId,
        checkpointPath: repository.checkpointFilePath(flyId, fly.activeCheckpointId),
      };
      brain.activateCheckpoint(context.checkpointPath);
    },
  });
  const manifest = Buffer.from(JSON.stringify({ format: "fly-cartridge", formatVersion: 3 }));
  const imported = await deck.importBytes({
    manifest, state: Buffer.from("state"), tokenAddress: TOKEN,
  });

  assert.equal(imported.sourceFormatVersion, 3);
  assert.equal(imported.wrappedFrom, V3_CARD);
  assert.equal((await repository.list()).length, 1);
  assert.equal(context.flyId, imported.flyId);
  assert.equal(deck.status().active.flyId, imported.flyId);
  assert.equal(deck.status().active.sourceFormatVersion, 3);
  assert.equal(deck.active, null);

  const exported = await deck.exportActive();
  assert.equal(exported.formatVersion, 4);
  assert.equal(exported.flyId, imported.flyId);
  assert.equal((await deck.exportFile(exported.id, "state.bin")).toString(), "state");
  const lastExport = JSON.parse(await readFile(
    repository.cartridgeMarkerPath(imported.flyId, "last-export.json"), "utf8"));
  assert.equal(lastExport.cardId, exported.cardId);

  const reopened = new FlyRepository({ dataRoot: join(root, "data") });
  assert.deepEqual(await reopened.init(), { readOnly: false, issues: [] });
});

test("legacy global active marker is archived after one-time fly migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "flap-cartridge-v4-legacy-"));
  const runId = "11111111-1111-4111-8111-111111111111";
  await mkdir(join(root, "runs", runId), { recursive: true });
  await writeFile(join(root, "runs", runId, "service.npz"), "legacy", "utf8");
  await writeFile(join(root, "active.json"), JSON.stringify({ id: runId, cardId: V3_CARD }), "utf8");
  const deck = new CartridgeDeck({
    root,
    brain: { snapshot: () => ({ status: "idle" }) },
    runtime: { state: { status: "idle" } },
  });
  assert.equal(deck.active.id, runId);
  await deck.completeLegacyMigration(
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  );
  assert.equal(deck.active, null);
  const archived = JSON.parse(await readFile(join(root, "legacy-active-migrated.json"), "utf8"));
  assert.equal(archived.id, runId);
  assert.equal(archived.migratedTo.flyId, "22222222-2222-4222-8222-222222222222");
  await assert.rejects(readFile(join(root, "active.json")), /ENOENT/);
});
