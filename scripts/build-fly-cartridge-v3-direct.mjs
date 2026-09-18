// Rebuild the wallet-direct v3 candidate using only pinned repository inputs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const root = path.resolve(import.meta.dirname, '..');
const name = 'contracts/FlyCartridgeRegistryV3Direct.sol';
const contractName = 'FlyCartridgeRegistryV3Direct';
const target = path.join(root, 'artifacts/fly-cartridge-v3-direct-candidate.json');
assert.equal(solc.version(), '0.8.37+commit.f401782d.Emscripten.clang');
const input = { language: 'Solidity', sources: { [name]: {
  content: fs.readFileSync(path.join(root, name), 'utf8'),
} }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true,
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object',
    'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
} };
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: (filename) => {
  const base = path.join(root, 'node_modules');
  const resolved = path.resolve(base, filename);
  if (!resolved.startsWith(base + path.sep)) return { error: 'Unsafe import' };
  try { return { contents: fs.readFileSync(resolved, 'utf8') }; }
  catch { return { error: `Missing import: ${filename}` }; }
} }));
const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error');
if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
const contract = output.contracts[name][contractName];
const artifact = { contractName, abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  immutableReferences: contract.evm.deployedBytecode.immutableReferences,
  compilerVersion: solc.version() };
const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
if (process.argv.includes('--write')) fs.writeFileSync(target, bytes);
else assert.deepEqual(bytes, fs.readFileSync(target),
  'Direct candidate artifact differs from pinned source or dependencies');
console.log(JSON.stringify({ artifact: path.relative(root, target).replaceAll('\\', '/'),
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'),
  artifactSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  deployedBytes: (artifact.deployedBytecode.length - 2) / 2 }));
