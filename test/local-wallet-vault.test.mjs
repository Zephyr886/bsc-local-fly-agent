import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { LocalWalletVault } from "../src/wallet/local-vault.mjs";

test("本地钱包只把认证加密密文写入磁盘", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "flynode-vault-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "wallet.vault.json");
  const vault = new LocalWalletVault(path);
  const password = "correct horse battery staple 2026";
  const created = await vault.create(password);
  const disk = await readFile(path, "utf8");

  assert.doesNotMatch(disk, new RegExp(created.privateKey.slice(2), "i"));
  assert.doesNotMatch(disk, /correct horse battery staple/);
  assert.match(disk, /aes-256-gcm/);
  assert.match(disk, /"N": 131072/);
  assert.equal((await vault.status()).address, created.address);
  assert.equal(await vault.verifyPassword(password), created.address);
  await assert.rejects(vault.verifyPassword("wrong password is long enough"), /密码错误|已被篡改/);
});

test("导入私钥后地址一致且不会返回私钥", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "flynode-import-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = new LocalWalletVault(join(directory, "source.json"));
  const generated = await source.create("source password 123456");
  const imported = new LocalWalletVault(join(directory, "imported.json"));
  const result = await imported.import(generated.privateKey, "import password 123456");

  assert.equal(result.address, generated.address);
  assert.equal("privateKey" in result, false);
  assert.equal(await imported.verifyPassword("import password 123456"), generated.address);
});

