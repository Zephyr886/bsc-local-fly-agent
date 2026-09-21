export { ACTIVATION_MODES_BY_PATH, activationModeForPath } from "./activation.mjs";
export { canonicalJson, parseJsonStrict, profileHash } from "./canonical.mjs";
export { DEFAULT_PROFILE_SPEC, cloneDefaultProfileSpec } from "./defaults.mjs";
export { assertEffectiveProfile, buildEffectiveProfile } from "./effective-profile.mjs";
export { PROFILE_PRESETS, getProfilePreset } from "./presets.mjs";
export {
  PROFILE_SCHEMA,
  ProfileValidationError,
  createProfileDocument,
  normalizeProfileSpec,
  validateProfileDocument,
  validateProfileSpec,
} from "./validate.mjs";
