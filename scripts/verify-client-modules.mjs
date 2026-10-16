/** Architecture and size admission for the actual generated browser artifact. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_PRIVATE_PROPERTIES } from './client-private-properties.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await import('./build-client.mjs');
const baselinePath = resolve(process.argv[2] || '.artifacts/refactor/stage-3/baseline.json');
const output = resolve(process.argv[3] || '.artifacts/refactor/stage-3/module-admission.json');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
// The default remains 5%. A reviewed exception is explicit and cannot silently
// replace either the baseline commit or its original compressed byte count.
const budget = process.argv[4] ? JSON.parse(await readFile(resolve(process.argv[4]), 'utf8')) : null;
if (budget && (budget.baselineCommit !== baseline.sourceCommit || budget.baselineGzipBytes !== baseline.clientGzipBytes
  || !budget.approval || !Number.isFinite(budget.maximumGrowthPercent) || budget.maximumGrowthPercent < 0)) throw new Error('Invalid or mismatched client budget approval');
const maximumGrowthPercent = budget?.maximumGrowthPercent ?? 5;
const graph = JSON.parse(await readFile(resolve(root, '.artifacts/client/metafile.json'), 'utf8'));
const bundle = await readFile(resolve(root, 'dist/client.js'));
const privateProperties = JSON.parse(await readFile(resolve(root, '.artifacts/client/private-properties.json'), 'utf8'));
const inputs = Object.keys(graph.inputs);
const cycles = [], done = new Set(), active = [];
function visit(name) {
  const index = active.indexOf(name);
  if (index >= 0) { cycles.push([...active.slice(index), name]); return; }
  if (done.has(name)) return;
  active.push(name);
  for (const edge of graph.inputs[name]?.imports || []) if (!edge.external && graph.inputs[edge.path]) visit(edge.path);
  active.pop(); done.add(name);
}
inputs.forEach(visit);
const sources = await Promise.all(inputs.map(name => readFile(resolve(root, name), 'utf8')));
const businessGlobals = sources.flatMap((source, index) => [...source.matchAll(/(?:window|globalThis)\.__AGENTKIT_[A-Z_]+/g)]
  .filter(match => match[0] !== 'window.__AGENTKIT_STUDIO__' && match[0] !== 'globalThis.__AGENTKIT_STUDIO__')
  .map(match => ({ input: inputs[index], name: match[0] })));
const nodeInputs = inputs.filter(name => /node_modules|src\/(host|providers)\//.test(name));
const compatibilityInputs = inputs.filter(name => /src\/client\/remote\/(host-client|compatibility-methods)\.mjs$|src\/remote\/(compatibility-methods|node-client)\.mjs$/.test(name));
const publicProperties = ['window', 'document', 'CustomEvent', 'MutationObserver', 'React', 'rpc', 'remote', 'slots', 'effect', 'createElement', 'style', 'className', 'sessionId', 'agentId', 'model', 'provider', 'ok', 'error', 'details'];
const unexpectedRenames = Object.keys(privateProperties).filter(name => !CLIENT_PRIVATE_PROPERTIES.includes(name) || publicProperties.includes(name));
const registrations = sources.reduce((count, source) => count + [...source.matchAll(/window\.__ModuleLoader__\.load\(/g)].length, 0);
const hostReactLoads = sources.reduce((count, source) => count + [...source.matchAll(/require\(['"]react['"]\)/g)].length, 0);
const gzipBytes = gzipSync(bundle).length;
const originalMaximumGzipBytes = Math.floor(baseline.clientGzipBytes * 1.05);
const maximumGzipBytes = Math.floor(baseline.clientGzipBytes * (1 + maximumGrowthPercent / 100));
const report = {
  evidence: 'generated-browser-module-graph-and-size',
  baselineCommit: baseline.sourceCommit, clientSha256: createHash('sha256').update(bundle).digest('hex'),
  moduleCount: inputs.length, cycles, nodeInputs, compatibilityInputs, businessGlobals, registrations, hostReactLoads,
  privatePropertyCount: Object.keys(privateProperties).length, unexpectedRenames,
  clientBytes: bundle.length, baselineGzipBytes: baseline.clientGzipBytes, gzipBytes, maximumGzipBytes,
  maximumGrowthPercent, originalMaximumGzipBytes, originalSizePassed: gzipBytes <= originalMaximumGzipBytes,
  budgetApproval: budget?.id || null,
  growthPercent: (gzipBytes / baseline.clientGzipBytes - 1) * 100,
  architecturePassed: !cycles.length && !nodeInputs.length && !compatibilityInputs.length && !unexpectedRenames.length && !businessGlobals.length && registrations === 1 && hostReactLoads === 1,
  sizePassed: gzipBytes <= maximumGzipBytes,
};
report.passed = report.architecturePassed && report.sizePassed;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
