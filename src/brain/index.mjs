// 始终调用本目录内的完整原版模块。fly-brain.mjs 与 ../../server/fly-brain.mjs 做 SHA-256 一致性测试。
export { FLY_BRAIN_DEFAULTS, createFlyBrain, rewardFromMfe } from "./fly-brain.mjs";
