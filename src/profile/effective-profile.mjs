import { resolveEffectiveRisk, SYSTEM_POLICY } from "../policy/system-policy.mjs";
import { validateProfileDocument } from "./validate.mjs";

const effectiveProfiles = new WeakSet();

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function buildEffectiveProfile(document, systemPolicy = SYSTEM_POLICY) {
  validateProfileDocument(document);
  const { effectiveRisk, restrictions } = resolveEffectiveRisk(document.spec.risk, systemPolicy);
  const effective = {
    apiVersion: "flap.ai/v1",
    kind: "EffectiveFlyProfile",
    source: {
      flyId: document.metadata.flyId,
      revision: document.metadata.revision,
      profileHash: document.metadata.profileHash,
    },
    spec: {
      ...structuredClone(document.spec),
      risk: structuredClone(effectiveRisk),
    },
    requestedRisk: structuredClone(document.spec.risk),
    restrictions: structuredClone(restrictions),
    systemPolicyVersion: systemPolicy.version,
  };
  deepFreeze(effective);
  effectiveProfiles.add(effective);
  return effective;
}

export function assertEffectiveProfile(value) {
  if (!effectiveProfiles.has(value)) {
    throw new TypeError("运行时只接受由 buildEffectiveProfile 创建的 Effective Profile");
  }
  return value;
}
