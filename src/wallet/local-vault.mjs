import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { createWalletClient, getAddress, http } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BSC_RPC_URL, BSC_TESTNET_RPC_URL } from "../config.mjs";

const scrypt = promisify(scryptCallback);
const VERSION = 1;
const KDF = Object.freeze({ name: "scrypt", N: 131_072, r: 8, p: 1, keyLength: 32, maxmem: 256 * 1024 * 1024 });
const CIPHER = "aes-256-gcm";
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const NETWORKS = Object.freeze({
  mainnet: { chain: bsc, rpc: BSC_RPC_URL },
  testnet: { chain: bscTestnet, rpc: BSC_TESTNET_RPC_URL },
});

function walletNetwork(network) {
  const selected = NETWORKS[network];
  if (!selected) throw new Error("钱包签名网络无效");
  return selected;
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128 || password.trim().length < 12) {
    throw new Error("保险库密码必须为 12–128 个字符，且不能只由空白组成");
  }
  return password;
}

function validatePrivateKey(privateKey) {
  if (!PRIVATE_KEY_PATTERN.test(String(privateKey))) throw new Error("私钥必须是 0x 开头的 32 字节十六进制值");
  try {
    privateKeyToAccount(String(privateKey));
    return String(privateKey);
  } catch {
    throw new Error("私钥不在有效的 secp256k1 范围内");
  }
}

async function deriveKey(password, salt, parameters = KDF) {
  return scrypt(password, salt, parameters.keyLength, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: parameters.maxmem || KDF.maxmem,
  });
}

function authenticatedData(address) {
  return Buffer.from(`FlyNode local vault|${VERSION}|${getAddress(address)}`, "utf8");
}

export class LocalWalletVault {
  constructor(path) {
    this.path = path;
  }

  async exists() {
    try { await access(this.path); return true; } catch { return false; }
  }

  async readVault() {
    const details = await lstat(this.path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("本地钱包文件类型不安全，已拒绝读取");
    const vault = JSON.parse(await readFile(this.path, "utf8"));
    if (vault.version !== VERSION || vault.kdf?.name !== KDF.name || vault.cipher?.name !== CIPHER || !vault.address) {
      throw new Error("本地钱包保险库格式不受支持或已损坏");
    }
    return vault;
  }

  async status() {
    if (!await this.exists()) return { exists: false, address: null, locked: true };
    const vault = await this.readVault();
    return {
      exists: true,
      address: getAddress(vault.address),
      locked: true,
      createdAt: vault.createdAt,
      imported: Boolean(vault.imported),
      encryption: "scrypt N=131072 + AES-256-GCM",
    };
  }

  async encrypt(privateKey, password, imported) {
    validatePassword(password);
    const normalized = validatePrivateKey(privateKey);
    const account = privateKeyToAccount(normalized);
    const salt = randomBytes(32);
    const iv = randomBytes(12);
    const key = await deriveKey(password, salt);
    const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: 16 });
    cipher.setAAD(authenticatedData(account.address));
    const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    key.fill(0);
    return {
      version: VERSION,
      address: account.address,
      createdAt: new Date().toISOString(),
      imported,
      kdf: { name: KDF.name, salt: salt.toString("base64"), N: KDF.N, r: KDF.r, p: KDF.p, keyLength: KDF.keyLength },
      cipher: { name: CIPHER, iv: iv.toString("base64"), tag: tag.toString("base64"), ciphertext: ciphertext.toString("base64") },
    };
  }

  async writeNew(vault) {
    if (await this.exists()) throw new Error("本机已存在钱包保险库；为避免覆盖资金，本应用拒绝自动替换");
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(vault, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => {});
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async create(password) {
    const privateKey = generatePrivateKey();
    const vault = await this.encrypt(privateKey, password, false);
    await this.writeNew(vault);
    return { address: vault.address, privateKey, createdAt: vault.createdAt };
  }

  async import(privateKey, password) {
    const vault = await this.encrypt(privateKey, password, true);
    await this.writeNew(vault);
    return { address: vault.address, createdAt: vault.createdAt };
  }

  async decrypt(password) {
    validatePassword(password);
    const vault = await this.readVault();
    const salt = Buffer.from(vault.kdf.salt, "base64");
    const iv = Buffer.from(vault.cipher.iv, "base64");
    const tag = Buffer.from(vault.cipher.tag, "base64");
    const ciphertext = Buffer.from(vault.cipher.ciphertext, "base64");
    const key = await deriveKey(password, salt, vault.kdf);
    try {
      const decipher = createDecipheriv(CIPHER, key, iv, { authTagLength: 16 });
      decipher.setAAD(authenticatedData(vault.address));
      decipher.setAuthTag(tag);
      const privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const normalized = validatePrivateKey(privateKey);
      if (privateKeyToAccount(normalized).address !== getAddress(vault.address)) throw new Error("钱包地址校验失败");
      return normalized;
    } catch {
      throw new Error("保险库密码错误，或加密钱包文件已被篡改");
    } finally {
      key.fill(0);
    }
  }

  async verifyPassword(password) {
    let privateKey = await this.decrypt(password);
    const address = privateKeyToAccount(privateKey).address;
    privateKey = null;
    return address;
  }

  async sendTransaction(password, transaction) {
    let privateKey = await this.decrypt(password);
    try {
      const account = privateKeyToAccount(privateKey);
      const wallet = createWalletClient({ account, chain: bsc, transport: http(BSC_RPC_URL, { timeout: 10_000, retryCount: 1 }) });
      return await wallet.sendTransaction({
        account,
        to: getAddress(transaction.to),
        data: transaction.data,
        value: BigInt(transaction.value || "0x0"),
      });
    } finally {
      privateKey = null;
    }
  }

  async deployContract(password, { network, abi, bytecode, args, gas }) {
    const selected = walletNetwork(network);
    let privateKey = await this.decrypt(password);
    try {
      const account = privateKeyToAccount(privateKey);
      const wallet = createWalletClient({ account, chain: selected.chain,
        transport: http(selected.rpc, { timeout: 15_000, retryCount: 1 }) });
      return await wallet.deployContract({ account, abi, bytecode, args, gas });
    } finally {
      privateKey = null;
    }
  }

  async writeContract(password, { network, address, abi, functionName, args, gas }) {
    const selected = walletNetwork(network);
    let privateKey = await this.decrypt(password);
    try {
      const account = privateKeyToAccount(privateKey);
      const wallet = createWalletClient({ account, chain: selected.chain,
        transport: http(selected.rpc, { timeout: 15_000, retryCount: 1 }) });
      return await wallet.writeContract({ account, address: getAddress(address), abi,
        functionName, args, gas });
    } finally {
      privateKey = null;
    }
  }
}
