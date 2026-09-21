import { randomUUID } from "node:crypto";

import { loadReplayDataset, atomicWriteJson, assertUuid, checkpointDescriptor } from "./shared.mjs";
import { runDeterministicReplay } from "./replay-engine.mjs";

const TOKEN_PATTERN = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;

export class TrainingServiceError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "TrainingServiceError";
    this.code = code;
  }
}

function safeFailure(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "TRAINING_FAILED",
    message: "训练轮次未完成；详细原因保留在本机运行日志中",
  };
}

function actionLabel(action) {
  return action === "BURN" ? "SELL" : action;
}

export function summarizeLiveTraining(simulation, profile) {
  const decisions = simulation.hybrid?.state?.decisions || [];
  const feedback = simulation.hybrid?.state?.feedbackQueue || [];
  const actionCounts = { BUY: 0, SELL: 0, HOLD: 0 };
  const blockedReasons = {};
  let hybridAllowed = 0;
  const nav = [];
  const neuralSeconds = [];
  const rss = [];
  for (const decision of decisions) {
    const action = actionLabel(decision.actions?.hybrid?.action || "HOLD");
    actionCounts[action] = (actionCounts[action] || 0) + 1;
    const execution = decision.executions?.hybrid;
    if (execution?.status === "simulated") hybridAllowed += 1;
    if (execution?.reason) blockedReasons[execution.reason] = (blockedReasons[execution.reason] || 0) + 1;
    if (Number.isFinite(decision.runtimeMetrics?.simulatedNetAssetValue)) nav.push(decision.runtimeMetrics.simulatedNetAssetValue);
    if (Number.isFinite(decision.runtimeMetrics?.neuralComputeSeconds)) neuralSeconds.push(decision.runtimeMetrics.neuralComputeSeconds);
    if (Number.isFinite(decision.runtimeMetrics?.rssMb)) rss.push(decision.runtimeMetrics.rssMb);
  }
  let peak = nav[0] || 0;
  let maxDrawdown = 0;
  for (const value of nav) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }
  const firstAt = decisions[0] ? Date.parse(decisions[0].at) : NaN;
  const lastAt = decisions.at(-1) ? Date.parse(decisions.at(-1).at) : NaN;
  const durationSeconds = Number.isFinite(firstAt) && Number.isFinite(lastAt) ? Math.max(0, (lastAt - firstAt) / 1_000) : 0;
  return {
    observations: decisions.length,
    actionCounts,
    hybridAllowed,
    blockedReasons,
    simulatedNetAssetValue: nav.at(-1) ?? null,
    maxDrawdown,
    actionFrequencyPerHour: durationSeconds > 0 ? hybridAllowed * 3_600 / durationSeconds : 0,
    averageUtility: feedback.length
      ? feedback.reduce((sum, item) => sum + Number(item.utility || 0), 0) / feedback.length : 0,
    averageNeuralComputeSeconds: neuralSeconds.length
      ? neuralSeconds.reduce((sum, value) => sum + value, 0) / neuralSeconds.length : 0,
    peakRssMb: Math.max(0, ...rss),
    assumptions: {
      samples: decisions.length,
      feePercent: Number(simulation.config?.fullFeePercent || 0),
      slippagePercent: profile.spec.risk.slippagePercent,
      gasBnb: Number(simulation.config?.fullGasBnb || 0),
      simulationOnly: true,
    },
  };
}

export class TrainingService {
  constructor({ repository, store, manager, replayRoot, now = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
    if (!repository || !store || !manager || typeof replayRoot !== "string") {
      throw new TypeError("TrainingService 需要 repository、store、manager 和 replayRoot");
    }
    this.repository = repository;
    this.store = store;
    this.manager = manager;
    this.replayRoot = replayRoot;
    this.now = now;
    this.idFactory = idFactory;
    this.activeRunId = null;
  }

  async #write(run, extra = {}) {
    await this.repository.get(run.flyId);
    const path = this.repository.trainingRunFilePath(run.flyId, run.id);
    await atomicWriteJson(path, {
      format: "flap-training-run",
      version: 1,
      ...run,
      ...extra,
    });
  }

  async init() {
    const interrupted = [];
    for (const run of this.store.runningTrainingRuns()) {
      const stoppedAt = this.now();
      const summary = {
        ...run.summary,
        error: { code: "PROCESS_INTERRUPTED", message: "上次进程退出时训练仍在运行" },
      };
      const updated = this.store.finishTrainingRun(run.id, {
        status: "interrupted", stoppedAt, checkpointAfter: null, summary,
      });
      await this.#write(updated);
      interrupted.push(updated);
    }
    return interrupted;
  }

  #context(flyId) {
    assertUuid(flyId, "flyId");
    const context = this.manager.context;
    if (!context || context.flyId !== flyId || this.manager.state !== "ready") {
      throw new TrainingServiceError("FLY_NOT_READY", "目标果蝇必须已激活且处于 ready 状态");
    }
    return context;
  }

  #token(context, tokenAddress) {
    if (typeof tokenAddress !== "string" || !TOKEN_PATTERN.test(tokenAddress)) {
      throw new TrainingServiceError("INVALID_TOKEN", "tokenAddress 无效");
    }
    const normalized = tokenAddress.toLowerCase();
    const universe = context.effectiveProfile.spec.universe;
    if (universe.tokenBinding === "fixed" && universe.tokenAddress.toLowerCase() !== normalized) {
      throw new TrainingServiceError("TOKEN_OUTSIDE_PROFILE", "tokenAddress 不符合固定代币 Profile");
    }
    return normalized;
  }

  async #begin({ context, tokenAddress, mode, source }) {
    if (this.activeRunId || this.store.runningTrainingRuns().length) {
      throw new TrainingServiceError("TRAINING_ALREADY_RUNNING", "当前已有训练轮次运行中");
    }
    const checkpointBefore = await checkpointDescriptor(this.repository, context);
    const run = this.store.createTrainingRun({
      id: this.idFactory(),
      flyId: context.flyId,
      profileRevision: context.revision,
      profileHash: context.profileHash,
      tokenAddress,
      mode,
      status: "running",
      startedAt: this.now(),
      checkpointBefore,
      summary: {
        source,
        modelVersion: context.effectiveProfile.spec.compatibility.brainModel,
      },
    });
    try {
      await this.#write(run);
    } catch (error) {
      this.store.finishTrainingRun(run.id, {
        status: "failed",
        stoppedAt: this.now(),
        checkpointAfter: null,
        summary: { ...run.summary, error: safeFailure(error) },
      });
      throw error;
    }
    this.activeRunId = run.id;
    return run;
  }

  async #finish(run, { status, checkpointAfter = null, metrics = null, error = null }) {
    const summary = {
      ...run.summary,
      ...(metrics ? { metrics } : {}),
      ...(error ? { error } : {}),
    };
    const updated = this.store.finishTrainingRun(run.id, {
      status,
      stoppedAt: this.now(),
      checkpointAfter,
      summary,
    });
    await this.#write(updated);
    if (this.activeRunId === run.id) this.activeRunId = null;
    return updated;
  }

  async startLive({ flyId, tokenAddress, ...simulationOptions } = {}) {
    const context = this.#context(flyId);
    const token = this.#token(context, tokenAddress);
    const run = await this.#begin({
      context,
      tokenAddress: token,
      mode: "live-observation",
      source: {
        kind: "live-observation",
        marketMode: simulationOptions.metadata?.marketMode || "synthetic",
        priceMethod: simulationOptions.metadata?.priceMethod || null,
        pair: simulationOptions.metadata?.pair || null,
        stage: simulationOptions.metadata?.stage || null,
      },
    });
    try {
      await this.manager.start({ ...simulationOptions, tokenAddress: token, trainingRunId: run.id });
      return this.store.getTrainingRun(run.id);
    } catch (error) {
      await this.#finish(run, { status: "failed", error: safeFailure(error) });
      throw error;
    }
  }

  async stop(runId) {
    assertUuid(runId, "trainingRunId");
    const run = this.store.getTrainingRun(runId);
    if (!run || run.status !== "running" || run.id !== this.activeRunId || run.mode !== "live-observation") {
      throw new TrainingServiceError("TRAINING_NOT_RUNNING", "指定 live training run 当前未运行");
    }
    try {
      const snapshot = await this.manager.stop();
      const context = this.manager.context;
      const checkpointAfter = await checkpointDescriptor(this.repository, context, { required: true });
      const metrics = summarizeLiveTraining(this.manager.simulation, context.effectiveProfile);
      metrics.sessionId = snapshot.sessionId;
      return await this.#finish(run, { status: "completed", checkpointAfter, metrics });
    } catch (error) {
      await this.#finish(run, { status: "failed", error: safeFailure(error) });
      throw error;
    }
  }

  async runReplay({ flyId, datasetPath } = {}) {
    const context = this.#context(flyId);
    const selected = await loadReplayDataset(datasetPath, this.replayRoot);
    const token = this.#token(context, selected.dataset.tokenAddress);
    const run = await this.#begin({
      context,
      tokenAddress: token,
      mode: "deterministic-replay",
      source: {
        kind: "local-dataset",
        relativePath: selected.relativePath,
        datasetHash: selected.hash,
        bytes: selected.bytes,
      },
    });
    try {
      const result = await this.manager.runManagedExperiment(async (fixedContext) => {
        const replay = await runDeterministicReplay({
          client: this.manager.brainClient,
          effectiveProfile: fixedContext.effectiveProfile,
          identity: {
            flyId: fixedContext.flyId,
            profileRevision: fixedContext.revision,
            profileHash: fixedContext.profileHash,
            modelVersion: fixedContext.effectiveProfile.spec.compatibility.brainModel,
          },
          dataset: selected.dataset,
          learning: fixedContext.effectiveProfile.spec.learning.enabled,
        });
        await this.manager.brainClient.park();
        const checkpointAfter = await checkpointDescriptor(this.repository, fixedContext, { required: true });
        return { replay, checkpointAfter };
      });
      return await this.#finish(run, {
        status: "completed",
        checkpointAfter: result.checkpointAfter,
        metrics: result.replay.metrics,
      });
    } catch (error) {
      try { await this.manager.brainClient.park(); } catch { /* primary failure wins */ }
      await this.#finish(run, { status: "failed", error: safeFailure(error) });
      throw error;
    }
  }

  get(runId) {
    return this.store.getTrainingRun(runId);
  }

  list(flyId, limit, offset) {
    return this.store.listTrainingRuns(flyId, limit, offset);
  }
}
