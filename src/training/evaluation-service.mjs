import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { FullBrainClient } from "../brain/full-brain-client.mjs";
import {
  atomicWriteJson,
  assertUuid,
  checkpointDescriptor,
  loadReplayDataset,
  sha256File,
} from "./shared.mjs";
import { runDeterministicReplay } from "./replay-engine.mjs";

export class EvaluationServiceError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "EvaluationServiceError";
    this.code = code;
  }
}

function safeFailure(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "EVALUATION_FAILED",
    message: "评估未完成；详细原因保留在本机运行日志中",
  };
}

export class EvaluationService {
  constructor({
    repository,
    store,
    manager,
    replayRoot,
    now = () => new Date().toISOString(),
    idFactory = randomUUID,
    clientFactory = (options) => new FullBrainClient(options),
  } = {}) {
    if (!repository || !store || !manager || typeof replayRoot !== "string" || typeof clientFactory !== "function") {
      throw new TypeError("EvaluationService 需要 repository、store、manager、replayRoot 和 clientFactory");
    }
    this.repository = repository;
    this.store = store;
    this.manager = manager;
    this.replayRoot = replayRoot;
    this.now = now;
    this.idFactory = idFactory;
    this.clientFactory = clientFactory;
  }

  async #write(evaluation, detail) {
    await this.repository.get(evaluation.flyId);
    await atomicWriteJson(this.repository.evaluationFilePath(evaluation.flyId, evaluation.id), {
      format: "flap-evaluation",
      version: 1,
      ...evaluation,
      detail,
    });
  }

  #context(flyId) {
    assertUuid(flyId, "flyId");
    const context = this.manager.context;
    if (!context || context.flyId !== flyId || this.manager.state !== "ready") {
      throw new EvaluationServiceError("FLY_NOT_READY", "目标果蝇必须已激活且处于 ready 状态");
    }
    return context;
  }

  async init() {
    const failed = [];
    for (const evaluation of this.store.runningEvaluations()) {
      const metrics = {
        ...evaluation.metrics,
        error: { code: "PROCESS_INTERRUPTED", message: "上次进程退出时评估仍在运行" },
        learningEnabled: false,
      };
      const updated = this.store.finishEvaluation(evaluation.id, { status: "failed", metrics });
      await this.#write(updated, { source: metrics.source || null });
      failed.push(updated);
    }
    return failed;
  }

  async evaluate({ flyId, datasetPath } = {}) {
    const context = this.#context(flyId);
    const selected = await loadReplayDataset(datasetPath, this.replayRoot);
    const evaluationId = this.idFactory();
    assertUuid(evaluationId, "evaluationId");
    const checkpointBefore = await checkpointDescriptor(this.repository, context, { required: true });
    const source = {
      relativePath: selected.relativePath,
      datasetHash: selected.hash,
      bytes: selected.bytes,
      profileHash: context.profileHash,
      modelVersion: context.effectiveProfile.spec.compatibility.brainModel,
      checkpointFileSha256: checkpointBefore.fileSha256,
    };
    let evaluation = this.store.createEvaluation({
      id: evaluationId,
      flyId: context.flyId,
      profileRevision: context.revision,
      checkpointId: context.checkpointId,
      datasetHash: selected.hash,
      status: "running",
      metrics: { source },
      createdAt: this.now(),
    });
    try {
      await this.#write(evaluation, { source });
    } catch (error) {
      this.store.finishEvaluation(evaluationId, {
        status: "failed",
        metrics: { source, error: safeFailure(error), learningEnabled: false },
      });
      throw error;
    }

    const evaluationFile = this.repository.evaluationFilePath(context.flyId, evaluationId);
    let temporaryDirectory = null;
    let client = null;
    try {
      await mkdir(dirname(evaluationFile), { recursive: true });
      temporaryDirectory = await mkdtemp(join(dirname(evaluationFile), `.tmp-${evaluationId}-`));
      const temporaryCheckpoint = join(temporaryDirectory, "service.npz");
      await cp(this.repository.checkpointFilePath(context.flyId, context.checkpointId), temporaryCheckpoint, {
        errorOnExist: true,
        force: false,
      });
      try {
        await cp(this.repository.checkpointMetadataPath(context.flyId, context.checkpointId),
          join(temporaryDirectory, "service.json"), { errorOnExist: true, force: false });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      client = this.clientFactory({
        checkpoint: temporaryCheckpoint,
        meta: join(temporaryDirectory, "service.json"),
      });
      const replay = await this.manager.runManagedExperiment(async (fixedContext) => runDeterministicReplay({
        client,
        effectiveProfile: fixedContext.effectiveProfile,
        identity: {
          flyId: fixedContext.flyId,
          profileRevision: fixedContext.revision,
          profileHash: fixedContext.profileHash,
          modelVersion: fixedContext.effectiveProfile.spec.compatibility.brainModel,
        },
        dataset: selected.dataset,
        learning: false,
      }));
      await client.park();
      const originalAfter = `sha256:${await sha256File(this.repository.checkpointFilePath(context.flyId, context.checkpointId))}`;
      if (originalAfter !== checkpointBefore.fileSha256) {
        throw new EvaluationServiceError("EVALUATION_MUTATED_CHECKPOINT", "评估改变了被测 checkpoint");
      }
      const metrics = {
        ...replay.metrics,
        source,
        learningEnabled: false,
        checkpointUnchanged: true,
      };
      evaluation = this.store.finishEvaluation(evaluationId, { status: "completed", metrics });
      await this.#write(evaluation, { source });
      return evaluation;
    } catch (error) {
      try { await client?.park(); } catch { /* primary failure wins */ }
      const metrics = { source, error: safeFailure(error), learningEnabled: false };
      evaluation = this.store.finishEvaluation(evaluationId, { status: "failed", metrics });
      await this.#write(evaluation, { source });
      throw error;
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  get(evaluationId) {
    return this.store.getEvaluation(evaluationId);
  }

  list(flyId, limit, offset) {
    return this.store.listEvaluations(flyId, limit, offset);
  }
}
