import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop package includes every resource required by the external v4 Python tool", async () => {
  const config = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  for (const resource of ["scripts", "server", "schemas", "src/profile/presets"]) {
    assert.match(config, new RegExp(`- from: ${resource.replaceAll("/", "\\/")}\\r?\\n\\s+to: ${resource.replaceAll("/", "\\/")}`));
  }
});
