import {
  ACTIVATION_MODES_BY_PATH,
  PROFILE_PRESETS,
  PROFILE_SCHEMA,
  activationModeForPath,
  buildEffectiveProfile,
  canonicalJson,
  getProfilePreset,
} from "../profile/index.mjs";
import { SYSTEM_POLICY } from "../policy/system-policy.mjs";
import {
  ApiError,
  assertLocalMutation,
  exactBody,
  positiveInteger,
  readApiJson,
  sendApiError,
  sendJson,
} from "./http.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertUuid(value, name) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError(`INVALID_${name.toUpperCase()}_ID`, `${name}Id 格式无效`, {
      fields: [{ path: `/${name}Id`, reason: "必须是 UUID" }],
    });
  }
  return value;
}

function diffPaths(before, after, path = "/spec") {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (!before || !after || typeof before !== "object" || typeof after !== "object"
      || Array.isArray(before) || Array.isArray(after)) return [path];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].sort().flatMap((key) => diffPaths(before[key], after[key], `${path}/${key}`));
}

function activationSummary(paths) {
  const ranking = { hot: 0, "next-start": 1, "next-training-run": 2, "fork-required": 3 };
  const byPath = Object.fromEntries(paths.map((path) => [path, activationModeForPath(path)]));
  const activationMode = Object.values(byPath)
    .sort((left, right) => ranking[right] - ranking[left])[0] || "hot";
  return { activationMode, activationModes: byPath };
}

function effectiveResult(fly, changedPaths = []) {
  const effective = buildEffectiveProfile(fly.profile);
  return {
    fly,
    revision: fly.currentRevision,
    profileHash: fly.profile.metadata.profileHash,
    changedPaths,
    ...activationSummary(changedPaths),
    effectiveRisk: effective.spec.risk,
    warnings: effective.restrictions.map((item) => ({
      path: item.path,
      reason: item.reason,
      requested: item.requested,
      effective: item.effective,
    })),
  };
}

function page(url) {
  return {
    limit: positiveInteger(url.searchParams.get("limit") || 50, "limit", { min: 1, max: 200 }),
    offset: positiveInteger(url.searchParams.get("offset") || 0, "offset", { min: 0, max: 1_000_000 }),
  };
}

function publicPolicy() {
  return {
    version: SYSTEM_POLICY.version,
    risk: {
      liveTradingAllowed: SYSTEM_POLICY.risk.liveTradingAllowed,
      maxCapitalBudgetPercent: SYSTEM_POLICY.risk.maxCapitalBudgetPercent,
      maxPoolParticipationPercent: SYSTEM_POLICY.risk.maxPoolParticipationPercent,
      maxBuyBnb: SYSTEM_POLICY.risk.maxBuyBnb,
      slippagePercent: SYSTEM_POLICY.risk.slippagePercent,
      maxDailyActionLimit: SYSTEM_POLICY.risk.maxDailyActionLimit,
      minActionIntervalSeconds: SYSTEM_POLICY.risk.minActionIntervalSeconds,
      transactionDeadlineSeconds: SYSTEM_POLICY.risk.transactionDeadlineSeconds,
    },
  };
}

function flySummary(fly, manager, trainingService) {
  const active = manager.context?.flyId === fly.id;
  const latestTraining = trainingService.list(fly.id, 1, 0)[0] || null;
  return {
    id: fly.id,
    name: fly.name,
    description: fly.description,
    tags: fly.tags,
    currentRevision: fly.currentRevision,
    profileHash: fly.profile.metadata.profileHash,
    activeCheckpointId: fly.activeCheckpointId,
    archivedAt: fly.archivedAt,
    createdAt: fly.createdAt,
    updatedAt: fly.updatedAt,
    active,
    runtimeState: active ? manager.state : "inactive",
    trainingStatus: latestTraining?.status || null,
    latestTrainingAt: latestTraining?.startedAt || null,
  };
}

export function createFlyRouteHandler({
  repository,
  manager,
  trainingService,
  evaluationService,
  resolveLiveToken,
  respondJson = sendJson,
} = {}) {
  if (!repository || !manager || !trainingService || !evaluationService || typeof resolveLiveToken !== "function") {
    throw new TypeError("Fly routes 缺少服务依赖");
  }

  return async function handleFlyRoute(request, response, url) {
    const profileEndpoint = url.pathname === "/api/fly-profile/schema"
      || url.pathname === "/api/fly-profile/presets";
    const routeEndpoint = url.pathname === "/api/flies" || url.pathname.startsWith("/api/flies/")
      || url.pathname.startsWith("/api/training-runs/");
    if (!profileEndpoint && !routeEndpoint) return false;

    try {
      if (!["GET", "HEAD"].includes(request.method)) assertLocalMutation(request);
      const parts = url.pathname.split("/").filter(Boolean);

      if (request.method === "GET" && url.pathname === "/api/fly-profile/schema") {
        respondJson(response, 200, {
          schema: PROFILE_SCHEMA,
          activationModes: ACTIVATION_MODES_BY_PATH,
          systemPolicy: publicPolicy(),
        });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/fly-profile/presets") {
        respondJson(response, 200, { items: PROFILE_PRESETS.map(({ id, schemaVersion, name, description }) => ({
          id, schemaVersion, name, description,
        })) });
        return true;
      }

      if (url.pathname === "/api/flies") {
        if (request.method === "GET") {
          const includeArchived = url.searchParams.get("includeArchived") === "true";
          const flies = await repository.list({ includeArchived });
          respondJson(response, 200, { items: flies.map((fly) => flySummary(fly, manager, trainingService)) });
          return true;
        }
        if (request.method === "POST") {
          const body = exactBody(await readApiJson(request),
            ["name", "description", "tags", "presetId", "profile"], ["name"]);
          if (body.profile !== undefined && body.presetId !== undefined) {
            throw new ApiError("PROFILE_SOURCE_CONFLICT", "profile 与 presetId 只能选择一个");
          }
          let spec = body.profile;
          if (spec === undefined) {
            try { spec = getProfilePreset(body.presetId || "balanced-v1").spec; } catch (error) {
              throw new ApiError("UNKNOWN_PROFILE_PRESET", "未知 Profile 预设", { cause: error });
            }
          }
          const fly = await repository.create({
            name: body.name,
            description: body.description,
            tags: body.tags,
            spec,
          });
          respondJson(response, 201, effectiveResult(fly));
          return true;
        }
      }

      if (parts[1] === "training-runs" && parts.length === 3) {
        const runId = assertUuid(parts[2], "trainingRun");
        if (request.method === "GET") {
          const run = trainingService.get(runId);
          if (!run) throw new ApiError("TRAINING_RUN_NOT_FOUND", "训练轮次不存在", { status: 404 });
          respondJson(response, 200, run);
          return true;
        }
        throw new ApiError("METHOD_NOT_ALLOWED", "该 API 方法不受支持", { status: 405 });
      }
      if (parts[1] === "training-runs" && parts.length === 4 && parts[3] === "stop") {
        if (request.method === "POST") {
          const runId = assertUuid(parts[2], "trainingRun");
          exactBody(await readApiJson(request), []);
          respondJson(response, 200, await trainingService.stop(runId));
          return true;
        }
        throw new ApiError("METHOD_NOT_ALLOWED", "该 API 方法不受支持", { status: 405 });
      }
      if (parts[1] === "training-runs") {
        throw new ApiError("ROUTE_NOT_FOUND", "API 路径不存在", { status: 404 });
      }

      if (parts[1] !== "flies") return false;
      if (parts.length < 3) throw new ApiError("METHOD_NOT_ALLOWED", "该 API 方法不受支持", { status: 405 });
      const flyId = assertUuid(parts[2], "fly");

      if (parts.length === 3) {
        if (request.method === "GET") {
          const fly = await repository.get(flyId);
          const effectiveProfile = buildEffectiveProfile(fly.profile);
          const training = trainingService.list(flyId, 200, 0);
          const evaluations = evaluationService.list(flyId, 200, 0);
          respondJson(response, 200, {
            fly,
            effectiveProfile,
            stats: {
              trainingRuns: training.length,
              evaluations: evaluations.length,
              latestTraining: training[0] || null,
              latestEvaluation: evaluations[0] || null,
            },
          });
          return true;
        }
        if (request.method === "PATCH") {
          const body = exactBody(await readApiJson(request),
            ["expectedRevision", "name", "description", "tags", "archived"], ["expectedRevision"]);
          const expectedRevision = positiveInteger(body.expectedRevision, "expectedRevision");
          const changedMetadata = ["name", "description", "tags"].filter((key) => Object.hasOwn(body, key));
          if (!changedMetadata.length && !Object.hasOwn(body, "archived")) {
            throw new ApiError("EMPTY_PATCH", "至少需要一个可修改字段");
          }
          if (Object.hasOwn(body, "archived") && typeof body.archived !== "boolean") {
            throw new ApiError("INVALID_ARCHIVED", "archived 必须是 boolean");
          }
          if (body.archived === true && manager.context?.flyId === flyId) {
            throw new ApiError("ACTIVE_FLY_ARCHIVE_CONFLICT", "活动果蝇不能归档", { status: 409 });
          }
          let fly = await repository.get(flyId);
          if (fly.currentRevision !== expectedRevision) {
            const error = new ApiError("PROFILE_REVISION_CONFLICT", "Profile revision 已变化", { status: 409,
              fields: [{ path: "/expectedRevision", reason: `当前 revision 为 ${fly.currentRevision}` }] });
            throw error;
          }
          if (changedMetadata.length) {
            fly = await repository.updateMetadata(flyId, Object.fromEntries([
              ["expectedRevision", fly.currentRevision],
              ...changedMetadata.map((key) => [key, body[key]]),
            ]));
            await manager.profileUpdated(flyId);
          }
          if (Object.hasOwn(body, "archived")) {
            fly = await repository.archive(flyId, {
              expectedRevision: fly.currentRevision,
              archived: body.archived,
            });
          }
          respondJson(response, 200, effectiveResult(fly,
            changedMetadata.map((key) => `/metadata/${key}`)));
          return true;
        }
      }

      if (parts.length === 4 && parts[3] === "profile" && request.method === "PUT") {
        const body = exactBody(await readApiJson(request), ["expectedRevision", "spec"], ["expectedRevision", "spec"]);
        body.expectedRevision = positiveInteger(body.expectedRevision, "expectedRevision");
        const before = await repository.get(flyId);
        const fly = await repository.updateProfile(flyId, body);
        const changedPaths = diffPaths(before.profile.spec, fly.profile.spec);
        const activation = await manager.profileUpdated(flyId);
        respondJson(response, 200, { ...effectiveResult(fly, changedPaths), pendingActivation: activation.pending });
        return true;
      }

      if (parts.length === 4 && parts[3] === "revisions" && request.method === "GET") {
        const revisions = await repository.listRevisions(flyId);
        const items = await Promise.all(revisions.map(async (revision) => {
          const document = await repository.getRevision(flyId, revision);
          return {
            revision,
            profileHash: document.metadata.profileHash,
            updatedAt: document.metadata.updatedAt,
            name: document.metadata.name,
          };
        }));
        respondJson(response, 200, { items: items.reverse() });
        return true;
      }
      if (parts.length === 5 && parts[3] === "revisions" && request.method === "GET") {
        respondJson(response, 200, await repository.getRevision(flyId,
          positiveInteger(parts[4], "revision")));
        return true;
      }

      if (parts.length === 4 && parts[3] === "rollback" && request.method === "POST") {
        const body = exactBody(await readApiJson(request),
          ["expectedRevision", "revision"], ["expectedRevision", "revision"]);
        body.expectedRevision = positiveInteger(body.expectedRevision, "expectedRevision");
        body.revision = positiveInteger(body.revision, "revision");
        const before = await repository.get(flyId);
        const fly = await repository.rollback(flyId, body);
        const changedPaths = diffPaths(before.profile.spec, fly.profile.spec);
        const activation = await manager.profileUpdated(flyId);
        respondJson(response, 200, { ...effectiveResult(fly, changedPaths), pendingActivation: activation.pending });
        return true;
      }

      if (parts.length === 4 && parts[3] === "clone" && request.method === "POST") {
        const body = exactBody(await readApiJson(request),
          ["name", "description", "tags", "copyCheckpoint", "checkpointId"]);
        if (body.copyCheckpoint !== undefined && typeof body.copyCheckpoint !== "boolean") {
          throw new ApiError("INVALID_COPY_CHECKPOINT", "copyCheckpoint 必须是 boolean");
        }
        const fly = await repository.clone(flyId, body);
        respondJson(response, 201, effectiveResult(fly));
        return true;
      }

      if (parts.length === 4 && parts[3] === "activate" && request.method === "POST") {
        const body = exactBody(await readApiJson(request), ["expectedRevision"], ["expectedRevision"]);
        body.expectedRevision = positiveInteger(body.expectedRevision, "expectedRevision");
        const fly = await repository.get(flyId);
        if (fly.currentRevision !== body.expectedRevision) {
          throw new ApiError("PROFILE_REVISION_CONFLICT", "Profile revision 已变化", { status: 409 });
        }
        const context = await manager.activate(flyId);
        respondJson(response, 200, {
          flyId: context.flyId,
          revision: context.revision,
          profileHash: context.profileHash,
          checkpointId: context.checkpointId,
          state: manager.state,
        });
        return true;
      }

      if (parts.length === 4 && parts[3] === "training-runs") {
        if (request.method === "GET") {
          const { limit, offset } = page(url);
          respondJson(response, 200, { items: trainingService.list(flyId, limit, offset), limit, offset });
          return true;
        }
        if (request.method === "POST") {
          const body = exactBody(await readApiJson(request),
            ["mode", "tokenAddress", "datasetPath", "initialQuote", "initialToken"], ["mode"]);
          for (const field of ["initialQuote", "initialToken"]) {
            if (body[field] !== undefined && (typeof body[field] !== "number"
                || !Number.isFinite(body[field]) || body[field] <= 0)) {
              throw new ApiError("INVALID_SIMULATION_BALANCE", `${field} 必须是正有限数`, {
                fields: [{ path: `/${field}`, reason: "必须是正有限数" }],
              });
            }
          }
          let run;
          if (body.mode === "live-observation") {
            if (typeof body.tokenAddress !== "string") throw new ApiError("INVALID_TOKEN", "live training 需要 tokenAddress");
            const metadata = await resolveLiveToken(body.tokenAddress);
            if (metadata.marketMode !== "live" || !(Number(metadata.price) > 0)) {
              throw new ApiError("LIVE_PRICE_UNAVAILABLE", "没有取得可验证的链上现货价格");
            }
            run = await trainingService.startLive({
              flyId,
              tokenAddress: body.tokenAddress,
              metadata,
              initialQuote: body.initialQuote,
              initialToken: body.initialToken,
            });
          } else if (body.mode === "deterministic-replay") {
            if (typeof body.datasetPath !== "string") throw new ApiError("INVALID_DATASET_PATH", "回放训练需要 datasetPath");
            run = await trainingService.runReplay({ flyId, datasetPath: body.datasetPath });
          } else {
            throw new ApiError("INVALID_TRAINING_MODE", "mode 只允许 live-observation 或 deterministic-replay");
          }
          respondJson(response, 201, run);
          return true;
        }
      }

      if (parts.length === 4 && parts[3] === "evaluations") {
        if (request.method === "GET") {
          const { limit, offset } = page(url);
          respondJson(response, 200, { items: evaluationService.list(flyId, limit, offset), limit, offset });
          return true;
        }
        if (request.method === "POST") {
          const body = exactBody(await readApiJson(request), ["datasetPath"], ["datasetPath"]);
          respondJson(response, 201, await evaluationService.evaluate({ flyId, datasetPath: body.datasetPath }));
          return true;
        }
      }

      throw new ApiError("ROUTE_NOT_FOUND", "API 路径不存在", { status: 404 });
    } catch (error) {
      sendApiError(response, error, respondJson);
      return true;
    }
  };
}
