import { stat } from "node:fs/promises";

import { buildEffectiveProfile } from "../profile/index.mjs";

export class FlyManagerError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "FlyManagerError";
    this.code = code;
  }
}

async function exists(path) {
  if (typeof path !== "string") return false;
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function freezeContext(context) {
  return Object.freeze(context);
}

export class FlyManager {
  #busy = false;

  constructor({
    repository,
    brainClient,
    simulation,
    deck,
    legacyCheckpoint = brainClient?.checkpoint,
    systemPolicy,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!repository || !brainClient || !simulation || !deck) {
      throw new TypeError("FlyManager 需要 repository、brainClient、simulation 和 deck");
    }
    this.repository = repository;
    this.brainClient = brainClient;
    this.simulation = simulation;
    this.deck = deck;
    this.legacyCheckpoint = legacyCheckpoint;
    this.systemPolicy = systemPolicy;
    this.now = now;
    this.state = "inactive";
    this.context = null;
    this.pendingContext = null;
    this.error = null;
  }

  snapshot() {
    return {
      state: this.state,
      error: this.error,
      active: this.context ? {
        flyId: this.context.flyId,
        revision: this.context.revision,
        profileHash: this.context.profileHash,
        checkpointId: this.context.checkpointId,
      } : null,
      pendingProfile: this.pendingContext ? {
        revision: this.pendingContext.revision,
        profileHash: this.pendingContext.profileHash,
      } : null,
    };
  }

  async #exclusive(operation) {
    if (this.#busy) throw new FlyManagerError("FLY_MANAGER_BUSY", "另一项果蝇状态变更正在进行");
    this.#busy = true;
    try {
      return await operation();
    } finally {
      this.#busy = false;
    }
  }

  async #legacyCandidate() {
    if (this.deck.active?.id) {
      const path = this.deck.runCheckpoint(this.deck.active.id);
      if (await exists(path)) return path;
    }
    return await exists(this.legacyCheckpoint) ? this.legacyCheckpoint : null;
  }

  async #migrateLegacyDefault() {
    if ((await this.repository.list({ includeArchived: true })).length !== 0) return null;
    const sourceCheckpoint = await this.#legacyCandidate();
    if (!sourceCheckpoint) return null;
    const fly = await this.repository.create({
      name: "legacy-default",
      description: "首次升级时从旧版活动 checkpoint 保留迁移",
      tags: ["legacy-migration"],
    });
    const adopted = await this.repository.adoptLegacyCheckpoint(fly.id, {
      expectedRevision: fly.currentRevision,
      sourceCheckpoint,
    });
    await this.repository.writeActiveMarker({
      flyId: adopted.id,
      revision: adopted.currentRevision,
      checkpointId: adopted.activeCheckpointId,
    });
    await this.deck.completeLegacyMigration?.(adopted.id, adopted.activeCheckpointId);
    return adopted;
  }

  async #contextFor(flyId) {
    let fly = await this.repository.get(flyId);
    if (fly.archivedAt !== null) {
      throw new FlyManagerError("FLY_ARCHIVED", "已归档果蝇不能激活");
    }
    if (fly.activeCheckpointId === null) {
      fly = await this.repository.ensureCheckpointSlot(fly.id, {
        expectedRevision: fly.currentRevision,
      });
    }
    const checkpointPath = this.repository.checkpointFilePath(fly.id, fly.activeCheckpointId);
    const effectiveProfile = buildEffectiveProfile(fly.profile, this.systemPolicy);
    return freezeContext({
      flyId: fly.id,
      revision: fly.currentRevision,
      profileHash: fly.profile.metadata.profileHash,
      checkpointId: fly.activeCheckpointId,
      checkpointPath,
      effectiveProfile,
      activatedAt: this.now(),
    });
  }

  async init() {
    return this.#exclusive(async () => {
      const health = await this.repository.init();
      if (health.readOnly) {
        this.state = "error";
        this.error = "果蝇仓库一致性检查失败，拒绝恢复活动选择";
        throw new FlyManagerError("FLY_REPOSITORY_READ_ONLY", this.error);
      }
      await this.#migrateLegacyDefault();
      const marker = await this.repository.readActiveMarker();
      if (!marker) {
        this.state = "inactive";
        this.context = null;
        this.error = null;
        return this.snapshot();
      }
      try {
        const context = await this.#contextFor(marker.flyId);
        if (context.revision !== marker.revision || context.checkpointId !== marker.checkpointId) {
          throw new FlyManagerError("ACTIVE_MARKER_MISMATCH", "活动 marker 与果蝇当前状态不一致");
        }
        this.brainClient.activateCheckpoint(context.checkpointPath);
        this.simulation.setActivationContext?.(context);
        this.context = context;
        this.state = "ready";
        this.error = null;
        return this.snapshot();
      } catch (error) {
        this.state = "error";
        this.error = error.message;
        throw error;
      }
    });
  }

  async activate(flyId) {
    return this.#exclusive(async () => {
      if (this.state === "running" || this.simulation.state.status === "running") {
        throw new FlyManagerError("FLY_SWITCH_WHILE_RUNNING", "运行中不能直接切换果蝇，请先停止当前 session");
      }
      if (this.state === "ready" && this.context?.flyId === flyId) return this.context;
      if (this.state === "ready") return this.#switchReady(flyId);
      if (this.state !== "inactive") {
        throw new FlyManagerError("INVALID_FLY_MANAGER_STATE", `状态 ${this.state} 不能激活果蝇`);
      }
      this.state = "activating";
      const previousCheckpoint = this.brainClient.checkpoint;
      try {
        const context = await this.#contextFor(flyId);
        this.brainClient.activateCheckpoint(context.checkpointPath);
        await this.repository.writeActiveMarker({
          flyId: context.flyId,
          revision: context.revision,
          checkpointId: context.checkpointId,
        });
        this.simulation.setActivationContext?.(context);
        this.context = context;
        this.state = "ready";
        this.error = null;
        return context;
      } catch (error) {
        if (this.brainClient.checkpoint !== previousCheckpoint) {
          this.brainClient.activateCheckpoint(previousCheckpoint);
        }
        this.state = "inactive";
        this.error = error.message;
        throw error;
      }
    });
  }

  async #switchReady(flyId) {
    const oldContext = this.context;
    const oldMarker = {
      flyId: oldContext.flyId,
      revision: oldContext.revision,
      checkpointId: oldContext.checkpointId,
    };
    this.state = "switching";
    try {
      const nextContext = await this.#contextFor(flyId);
      this.simulation.stop();
      await this.brainClient.park();
      await this.repository.writeActiveMarker({
        flyId: nextContext.flyId,
        revision: nextContext.revision,
        checkpointId: nextContext.checkpointId,
      });
      this.brainClient.activateCheckpoint(nextContext.checkpointPath);
      this.simulation.setActivationContext?.(nextContext);
      this.context = nextContext;
      this.state = "ready";
      this.error = null;
      return nextContext;
    } catch (error) {
      try {
        await this.repository.writeActiveMarker(oldMarker);
        if (this.brainClient.checkpoint !== oldContext.checkpointPath) {
          this.brainClient.activateCheckpoint(oldContext.checkpointPath);
        }
        this.simulation.setActivationContext?.(oldContext);
        this.context = oldContext;
        this.state = "ready";
        this.error = error.message;
      } catch (rollbackError) {
        this.state = "error";
        this.error = `切换失败且回滚失败：${rollbackError.message}`;
        throw new FlyManagerError("FLY_SWITCH_ROLLBACK_FAILED", this.error, { cause: error });
      }
      throw error;
    }
  }

  async switchTo(flyId) {
    return this.#exclusive(async () => {
      if (this.state === "running" || this.simulation.state.status === "running") {
        throw new FlyManagerError("FLY_SWITCH_WHILE_RUNNING", "运行中不能直接切换果蝇，请先停止当前 session");
      }
      if (this.state !== "ready" || !this.context) {
        throw new FlyManagerError("INVALID_FLY_MANAGER_STATE", `状态 ${this.state} 不能切换果蝇`);
      }
      if (this.context.flyId === flyId) return this.context;
      return this.#switchReady(flyId);
    });
  }

  async profileUpdated(flyId) {
    return this.#exclusive(async () => {
      if (!this.context || this.context.flyId !== flyId) return { active: false, pending: false };
      const nextContext = await this.#contextFor(flyId);
      if (this.state === "running" || this.simulation.state.status === "running") {
        this.pendingContext = nextContext;
        return { active: true, pending: true, revision: nextContext.revision };
      }
      if (this.state !== "ready") {
        throw new FlyManagerError("INVALID_FLY_MANAGER_STATE", `状态 ${this.state} 不能刷新 Profile`);
      }
      this.context = nextContext;
      this.pendingContext = null;
      this.simulation.setActivationContext?.(nextContext);
      return { active: true, pending: false, revision: nextContext.revision };
    });
  }

  async start(options = {}) {
    return this.#exclusive(async () => {
      if (this.state !== "ready" || !this.context) {
        throw new FlyManagerError("NO_ACTIVE_FLY", "必须先激活果蝇才能启动 session");
      }
      if (this.brainClient.checkpoint !== this.context.checkpointPath) {
        throw new FlyManagerError("ACTIVE_CHECKPOINT_DRIFT", "全脑 checkpoint 已被外部流程改变；请重新激活当前果蝇");
      }
      try {
        const runtimeContext = options.trainingRunId
          ? freezeContext({ ...this.context, trainingRunId: options.trainingRunId })
          : this.context;
        const { trainingRunId: _trainingRunId, ...simulationOptions } = options;
        const result = await this.simulation.start({
          ...simulationOptions,
          effectiveProfile: this.context.effectiveProfile,
          activationContext: runtimeContext,
        });
        this.state = "running";
        this.error = null;
        return result;
      } catch (error) {
        this.state = "ready";
        this.error = error.message;
        throw error;
      }
    });
  }

  async runManagedExperiment(operation) {
    if (typeof operation !== "function") throw new TypeError("operation 必须是函数");
    return this.#exclusive(async () => {
      if (this.state !== "ready" || !this.context) {
        throw new FlyManagerError("NO_ACTIVE_FLY", "必须先激活果蝇才能运行训练或评估");
      }
      if (this.brainClient.checkpoint !== this.context.checkpointPath) {
        throw new FlyManagerError("ACTIVE_CHECKPOINT_DRIFT", "全脑 checkpoint 已被外部流程改变；请重新激活当前果蝇");
      }
      this.state = "running";
      try {
        const result = await operation(this.context);
        this.state = "ready";
        this.error = null;
        return result;
      } catch (error) {
        this.state = "ready";
        this.error = error.message;
        throw error;
      }
    });
  }

  async stop() {
    return this.#exclusive(async () => {
      if (this.state === "ready") return this.simulation.state;
      if (this.state !== "running") {
        throw new FlyManagerError("INVALID_FLY_MANAGER_STATE", `状态 ${this.state} 不能停止 session`);
      }
      this.state = "stopping";
      try {
        const snapshot = this.simulation.stop();
        await this.brainClient.park();
        if (this.pendingContext) {
          this.context = this.pendingContext;
          this.pendingContext = null;
          this.simulation.setActivationContext?.(this.context);
        }
        this.state = "ready";
        this.error = null;
        return snapshot;
      } catch (error) {
        this.state = "error";
        this.error = error.message;
        throw error;
      }
    });
  }

  async reset() {
    if (this.state === "running") await this.stop();
    if (this.state !== "ready") {
      throw new FlyManagerError("INVALID_FLY_MANAGER_STATE", `状态 ${this.state} 不能重置 session`);
    }
    return this.simulation.reset();
  }

  async close() {
    if (this.state === "running") await this.stop();
    await this.simulation.close?.();
  }
}
