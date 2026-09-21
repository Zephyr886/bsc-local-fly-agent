import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Desktop builds keep immutable application/runtime files under Program Files
// and mutable state under Electron's per-user data directory. CLI use keeps the
// historical repository-local layout unless these variables are supplied.
export const APP_ROOT = resolve(process.env.FLAP_APP_ROOT || SOURCE_ROOT);
export const RUNTIME_ROOT = resolve(process.env.FLAP_RUNTIME_ROOT || APP_ROOT);
export const DATA_ROOT = resolve(process.env.FLAP_DATA_ROOT || join(APP_ROOT, "data"));
export const WORK_ROOT = resolve(process.env.FLAP_WORK_ROOT || join(APP_ROOT, "work"));
