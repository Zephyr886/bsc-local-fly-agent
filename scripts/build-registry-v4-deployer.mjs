import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const toolRoot = path.join(root, 'tools', 'registry-v4-deployer');
const artifactPath = path.join(root, 'artifacts', 'fly-cartridge-v4-registry-candidate.json');
const artifactBytes = fs.readFileSync(artifactPath);
const artifact = JSON.parse(artifactBytes);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const artifactSha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');

const built = await build({
  entryPoints: [path.join(toolRoot, 'app.mjs')],
  bundle: true,
  minify: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  target: ['chrome120', 'edge120'],
  define: {
    __FLAP_REGISTRY_V4_ARTIFACT__: JSON.stringify(artifact),
    __FLAP_REGISTRY_V4_ARTIFACT_SHA256__: JSON.stringify(artifactSha256),
    __FLAP_TOOL_VERSION__: JSON.stringify(pkg.version),
  },
});
if (built.outputFiles.length !== 1) throw new Error('Unexpected deployer bundle output');

const template = fs.readFileSync(path.join(toolRoot, 'template.html'), 'utf8');
const styles = fs.readFileSync(path.join(toolRoot, 'style.css'), 'utf8');
const script = built.outputFiles[0].text.replaceAll('</script', '<\\/script');
const html = template.replace('/* FLAP_STYLES */', () => styles)
  .replace('/* FLAP_SCRIPT */', () => script);
if (html.includes('/* FLAP_STYLES */') || html.includes('/* FLAP_SCRIPT */')) {
  throw new Error('Standalone deployer placeholders were not replaced');
}
const outputDir = path.join(root, 'deployment', 'registry-v4');
fs.mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, 'FLAP-Registry-V4-Deployer.html');
fs.writeFileSync(output, html);
const outputSha256 = crypto.createHash('sha256').update(html).digest('hex');
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(html), outputSha256, artifactSha256 }, null, 2));
