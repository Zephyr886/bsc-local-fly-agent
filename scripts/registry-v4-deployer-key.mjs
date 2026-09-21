import path from 'node:path';
import { LocalWalletVault } from '../src/wallet/local-vault.mjs';

export async function loadDeploymentPrivateKey() {
  const environmentPrivateKey = process.env.FLAP_REGISTRY_V4_DEPLOYER_PRIVATE_KEY;
  const vaultPath = process.env.FLAP_REGISTRY_V4_VAULT_PATH;
  const vaultPassword = process.env.FLAP_REGISTRY_V4_VAULT_PASSWORD;
  delete process.env.FLAP_REGISTRY_V4_DEPLOYER_PRIVATE_KEY;
  delete process.env.FLAP_REGISTRY_V4_VAULT_PASSWORD;
  if (environmentPrivateKey && vaultPath) {
    throw new Error('Choose either a process-only private key or an encrypted vault, not both');
  }
  const privateKey = environmentPrivateKey || (vaultPath && vaultPassword
    ? await new LocalWalletVault(path.resolve(vaultPath)).decrypt(vaultPassword) : null);
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey || '')) {
    throw new Error('Use a process-only FLAP_REGISTRY_V4_DEPLOYER_PRIVATE_KEY or encrypted vault credentials');
  }
  return privateKey;
}
