/** Isolated real Web Host for manual Native conversation/approval acceptance.
 * Reuses a built maintained Host and dependency graph; installs nothing.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNativeWebA2aPeer } from './native-web-a2a-peer.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  assert(['--source', '--dependencies', '--output', '--resume', '--children', '--a2a'].includes(key), `Unknown option: ${key}`);
  assert(options[key] === undefined, `Duplicate option: ${key}`);
  options[key] = ['--resume', '--children', '--a2a'].includes(key) ? true : process.argv[++i];
  assert(options[key], `Missing value: ${key}`);
}
for (const key of ['--source', '--dependencies', '--output']) assert(options[key], `${key} is required`);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = realpathSync(options['--source']), dependencies = realpathSync(options['--dependencies']);
const output = resolve(options['--output']), contract = 'agentkit.native-web-session-proof/v1';
const expected = JSON.parse(readFileSync(join(repository, 'patches/dsh-v0.2.1-rc.2/source.json'), 'utf8'));
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
assert.equal(sourceHead, expected.headCommit, 'Use the pinned maintained Host');
assert(existsSync(join(source, 'apps/cli/lib/bin.js')), 'Build the maintained Host first');
assert(existsSync(join(dependencies, '@deepseek-ai/dsh-agent')), 'A complete Host dependency graph is required');
const previous = options['--resume'] ? JSON.parse(readFileSync(join(output, 'setup.json'), 'utf8')) : null;
const children = previous?.children ?? Boolean(options['--children']);
const a2a = previous?.a2a ?? Boolean(options['--a2a']);
if (previous) {
  assert.equal(previous.contract, contract);
  assert.equal(previous.source, source); assert.equal(previous.dependencies, dependencies);
} else mkdirSync(output, { mode: 0o700 });
const root = realpathSync(previous?.root ?? await mkdtemp(join(tmpdir(), 'studio-native-browser-')));
const remote = a2a ? await createNativeWebA2aPeer({ directory: output, port: previous?.a2aPort }) : null;
const plugin = join(root, 'plugin'), home = join(root, 'agentkit'), dshHome = join(root, 'dsh');
const workspace = join(root, 'documents/deepseek-harness/default-workspace');
for (const path of [plugin, home, workspace]) mkdirSync(path, { recursive: true });
for (const name of ['src', 'packages', 'dist', 'patches', 'host-source', 'assets', 'package.json', 'studio.plugin.json', 'cordis.patch.yml'])
  cpSync(join(repository, name), join(plugin, name), { recursive: true });
const link = (target, path) => { if (!existsSync(path)) symlinkSync(target, path); };
link(dependencies, join(plugin, 'node_modules'));
const profile = join(dshHome, 'profiles/native-browser');
mkdirSync(join(profile, 'node_modules/@kingsoftcloud'), { recursive: true });
link(plugin, join(profile, 'node_modules/@kingsoftcloud/agentkit-studio'));
writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kingsoftcloud/agentkit-studio'] } } }));
const marker = /NATIVE_BROWSER_(A2A_DENY|A2A|CHILD_CANCEL|CHILD|APPROVAL|REJECT|CANCEL|CHAT|RECOVER)/;
let requestCount = 0;
const pending = new Map();
const model = createServer(async (req, res) => {
  try {
    // Fixture gates control deterministic model replies only, never product state.
    if (req.method === 'POST' && ['/fixture/release-child', '/fixture/release-parent'].includes(req.url)) {
      const owner = req.url.endsWith('release-child') ? 'child' : 'parent';
      const released = [];
      for (const [id, entry] of pending) if (entry.owner === owner) { released.push(id); pending.delete(id); entry.release(); }
      appendFileSync(join(output, 'fixture-controls.jsonl'), JSON.stringify({ owner, released }) + '\n');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ released })); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    // DSH appends runtime context as user-role messages after the actual input.
    const lastUser = input.messages.findLastIndex(message => message.role === 'user' && marker.test(JSON.stringify(message.content)));
    assert(lastUser >= 0, 'Send an explicit NATIVE_BROWSER_* marker');
    const tag = marker.exec(JSON.stringify(input.messages[lastUser].content))[1];
    const afterTools = input.messages.slice(lastUser + 1).filter(message => message.role === 'tool').length;
    const requestId = `${process.pid}:${++requestCount}`;
    const owner = input.model === 'browser-child-proof' ? 'child' : 'parent';
    const guidanceSeen = input.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('BROWSER_CHILD_GUIDANCE'));
    appendFileSync(join(output, 'model-requests.jsonl'), JSON.stringify({ requestId, tag, owner, afterTools, guidanceSeen }) + '\n');
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: requestId, model: 'browser-proof',
      choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 7, completion_tokens: 5 } } : {}) })}\n\n`;
    if (tag.startsWith('A2A')) {
      assert(a2a, 'Use --a2a for remote question controls');
      if (afterTools === 0) res.end(frame({ tool_calls: [{ index: 0, id: `browser-remote-${requestId}`, type: 'function', function: {
        name: 'call_a2a_agent', arguments: JSON.stringify({ agent: 'research', message: 'NATIVE_BROWSER_' + tag }),
      } }] }, 'tool_calls') + 'data: [DONE]\n\n');
      else res.end(frame({ content: tag === 'A2A' ? 'BROWSER_REMOTE_PARENT_DONE' : 'BROWSER_REMOTE_DENIED_DONE' }, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    if (tag.startsWith('CHILD')) {
      assert(children, 'Use --children for child controls');
      if (owner === 'parent' && afterTools === 0) {
        res.end(frame({ tool_calls: [{ index: 0, id: `browser-child-${requestId}`, type: 'function', function: {
          name: 'native_delegate', arguments: JSON.stringify({ role: 'reader', task: `NATIVE_BROWSER_${tag}: wait for guidance and report it.` }),
        } }] }, 'tool_calls') + 'data: [DONE]\n\n'); return;
      }
      if (owner === 'child' && guidanceSeen) {
        res.end(frame({ content: 'BROWSER_CHILD_GUIDED_DONE' }, 'stop') + 'data: [DONE]\n\n'); return;
      }
      res.write(frame({ content: owner === 'child' ? 'BROWSER_CHILD_WAITING' : 'BROWSER_PARENT_WAITING' }));
      pending.set(requestId, { owner, release: () => res.end(frame({ content: owner === 'child'
        ? ' BROWSER_CHILD_INITIAL_DONE' : ' BROWSER_CHILD_PARENT_DONE' }, 'stop') + 'data: [DONE]\n\n') });
      res.on('close', () => { pending.delete(requestId); appendFileSync(join(output, 'model-streams.jsonl'),
        JSON.stringify({ requestId, owner, tag, completed: res.writableEnded }) + '\n'); });
      return;
    }
    if (tag === 'CANCEL' || tag === 'RECOVER') { res.write(frame({ content: `BROWSER_${tag}_PREFIX` })); return; }
    if ((tag === 'APPROVAL' || tag === 'REJECT') && afterTools === 0) {
      res.end(frame({ tool_calls: [{ index: 0, id: `browser-write-${requestId}`, type: 'function', function: {
        name: 'write_workspace_file', arguments: JSON.stringify({ path: tag === 'APPROVAL' ? 'approved.txt' : 'rejected.txt', content: `BROWSER_${tag}_EFFECT` }),
      } }] }, 'tool_calls') + 'data: [DONE]\n\n');
    } else res.end(frame({ content: `BROWSER_${tag}_DONE` }, 'stop') + 'data: [DONE]\n\n');
  } catch (error) {
    appendFileSync(join(output, 'model-errors.log'), String(error) + '\n');
    if (!res.headersSent) res.writeHead(400); res.end();
  }
});
await new Promise((done, reject) => { model.once('error', reject); model.listen(previous?.modelPort ?? 0, '127.0.0.1', done); });
const modelPort = model.address().port;
writeFileSync(join(home, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'browser', provider: 'openai-compatible', modelName: 'browser-proof',
  baseUrl: `http://127.0.0.1:${modelPort}/v1`, default: true, credentialName: 'BROWSER_PROOF_KEY' },
  ...(children ? [{ id: 'browser-child', provider: 'openai-compatible', modelName: 'browser-child-proof',
    baseUrl: `http://127.0.0.1:${modelPort}/v1`, credentialName: 'BROWSER_PROOF_KEY' }] : [])],
  modelProfileKeys: { BROWSER_PROOF_KEY: 'local-browser-proof-only' } }), { mode: 0o600 });
const { createAgentStore } = await import(pathToFileURL(join(plugin, 'src/agent-store.mjs')));
const agent = previous ? null : await createAgentStore({ storeDir: join(home, 'studio/agents') }).create({ name: 'Native 浏览器验收', runtimeType: 'harness',
  ...(children ? { spec: { subAgents: [{ name: 'reader', instructions: 'BROWSER_CHILD_WORKER: obey the admitted task and guidance.',
    tools: ['read_workspace_file'], modelProfileId: 'browser-child', maxTurns: 4, timeoutSeconds: 600, inheritSkills: false }] } } : {}),
  bindings: { modelProfileIds: children ? ['browser', 'browser-child'] : ['browser'],
    tools: [...(children ? ['read_workspace_file', 'write_workspace_file'] : ['write_workspace_file']), ...(a2a ? ['call_a2a_agent'] : [])],
    ...(a2a ? { a2a: [remote.spec] } : {}) } });
const policy = join(plugin, 'browser-policy.mjs');
writeFileSync(policy, `import { appendFileSync, existsSync } from 'node:fs';
export const inject = ['tools', 'approval'];
export function apply(ctx, options) {
 ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.name !== 'write_workspace_file') return next();
  appendFileSync(options.log, JSON.stringify({kind:'before', callId:exec.callId, fileExists:existsSync(options.workspace+'/'+exec.arguments.path)})+'\\n');
  const answer = await ctx.approval.request({agent:exec.agent, callId:exec.callId, toolName:exec.name,
    reason:'Native browser proof: confirm original file write', signal:exec.signal});
  appendFileSync(options.log, JSON.stringify({kind:'decision', answer})+'\\n');
  return answer === 'allowed-once' || answer === 'allowed-session' ? next() : {kind:'deny', reason:'User rejected browser proof write'};
 });
}
`);
writeFileSync(join(profile, 'cordis.patch.yml'), [
  '- id: typert-loader', '  disabled: true',
  '- id: workspace-controller', '  config:', `    documentsDirectory: ${JSON.stringify(join(root, 'documents'))}`,
  '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
  '- insert:', '    - id: native-browser-proof-policy', `      name: ${JSON.stringify(pathToFileURL(policy).href)}`,
  '      config:', `        workspace: ${JSON.stringify(workspace)}`, `        log: ${JSON.stringify(join(output, 'approval.jsonl'))}`, '',
].join('\n'));
const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true }); link(process.execPath, join(bin, 'node'));
const env = { ...process.env, DSH_HOME: dshHome, AGENTKIT_HOME: home, AGENTKIT_STUDIO_WORKSPACE: workspace,
  PATH: bin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'), ...(remote?.env ?? {}) };
delete env.AGENTKIT_STUDIO_NATIVE_HARNESS;
const child = spawn(process.execPath, [join(source, 'apps/cli/lib/bin.js'), '--profile', 'native-browser', '--host', '127.0.0.1',
  '--no-open', '--port', String(previous?.webPort ?? 0)], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
const setup = { contract, root, plugin, home, dshHome, workspace, agentId: previous?.agentId ?? agent.metadata.id,
  children,
  a2a, a2aPort: remote?.port,
  pid: child.pid, source, sourceHead, dependencies, modelPort, webPort: previous?.webPort,
  studioHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), node: process.version,
  runtimeBridgeSha256: createHash('sha256').update(readFileSync(join(plugin, 'src/host/runtime-bridge.mjs'))).digest('hex'),
  streamModuleSha256: createHash('sha256').update(readFileSync(join(plugin, 'packages/agentkit-harness/src/native/assistant-stream.mjs'))).digest('hex') };
const saveSetup = () => writeFileSync(join(output, 'setup.json'), JSON.stringify(setup, null, 2));
saveSetup();
let tail = '', ready = false;
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  appendFileSync(join(output, 'host.log'), chunk); tail = (tail + String(chunk)).slice(-65536);
  const match = tail.match(/dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=[A-Za-z0-9_-]+)/);
  if (match && !ready) {
    ready = true; setup.webPort = Number(match[2]); saveSetup();
    // localhost uses the normal token/cookie login in the in-app browser.
    writeFileSync(join(output, 'connection.json'), JSON.stringify({ url: match[1].replace('127.0.0.1', 'localhost') }), { mode: 0o600 });
    console.log(`WEB_READY ${join(output, 'connection.json')}`);
  }
});
const closeModel = () => { model.closeAllConnections(); model.close(); remote?.close(); };
child.on('error', error => { console.error(error.message); closeModel(); process.exitCode = 1; });
child.on('exit', (code, signal) => { console.log('HOST_EXIT', code, signal); closeModel(); process.exitCode = code ?? (signal === 'SIGTERM' ? 0 : 1); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill('SIGTERM'); closeModel(); });
