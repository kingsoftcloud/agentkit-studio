import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCommandTransport } from '../src/native/local-command-tools.mjs';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';

function setup(t, captureOverride, durableForeground = true) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'command-inventory-')), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = createNativeWorkspaceTools({ workspaceRoot, stateDir: join(root, 'files'), sessionId: 'session' });
  const transport = createLocalCommandTransport({ workspaceRoot, stateRoot: join(root, 'commands'), sessionId: 'session',
    durableForeground, sourceEnv: { PATH: process.env.PATH }, settings: { wallSeconds: 5 },
    authorize: async () => 'allow', resolveOwnedCommand: () => { throw Error('not needed'); },
    assertAuthority: () => true, captureWorkspace: captureOverride ?? (request => files.capture(request)) });
  const request = (command, operationKey) => ({ sessionId: 'session', runId: 'run', operationKey,
    signal: new AbortController().signal, definition: transport.definitions.find(tool => tool.name === 'run_command'),
    call: { callId: operationKey, name: 'run_command', arguments: { command } }, resultGovernance: 'runtime-artifacts/v1' });
  return { workspaceRoot, files, transport, request };
}

test('governed direct and supervised commands execute the Bash syntax their policy checked', async t => {
  for (const durable of [false, true]) {
    const { workspaceRoot, transport, request } = setup(t, undefined, durable);
    const command = `# there's no executable in this comment &\n[[ -n "$BASH_VERSION" ]] || exit 11
cat <<'EOF' > note.txt
literal rm -rf and docker & and an unmatched " quote
EOF
printf done &> result.txt`;
    const result = await transport.execute(request(command, `bash-syntax-${durable}`));
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.content.exit_code, 0);
    assert.match(readFileSync(join(workspaceRoot, 'note.txt'), 'utf8'), /literal rm -rf/);
    assert.equal(readFileSync(join(workspaceRoot, 'result.txt'), 'utf8'), 'done');
  }
});

test('a repository-sized inventory cannot turn a finished command into an unknown effect or prevent the next command', { timeout: 15000 }, async t => {
  const { workspaceRoot, files, transport, request } = setup(t);
  const create = `node -e 'const fs=require("node:fs");fs.mkdirSync("many");for(let i=0;i<2050;i++)fs.writeFileSync("many/"+i,"")'`;
  const first = await transport.execute(request(create, 'create-many-files'));
  assert.equal(first.status, 'ok'); assert.equal(first.content.exit_code, 0);
  assert.equal(first.content.status, 'completed');
  assert.equal(first.workspaceChangeObservation.status, 'unavailable');
  assert.equal(first.workspaceChangeObservation.reason, 'inventory_limit');
  assert.equal(first.workspaceChangedPaths, undefined);
  assert.equal((await files.observe({ sessionId: 'session' })).reason, 'capture_limit_exceeded');
  const second = await transport.execute(request('printf x >> once.txt', 'write-once'));
  assert.equal(second.status, 'ok'); assert.equal(second.content.exit_code, 0);
  assert.equal(second.workspaceChangeObservation.status, 'unavailable');
  assert.equal(readFileSync(join(workspaceRoot, 'once.txt'), 'utf8'), 'x');
});

test('snapshot failures never suppress a boundary violation or change an admitted legacy command contract', async t => {
  const { transport, request } = setup(t, () => { throw Object.assign(Error('private'), { code: 'workspace_root_changed' }); });
  const denied = await transport.execute(request('printf no', 'boundary'));
  assert.equal(denied.status, 'error'); assert.equal(denied.content.executed, false);
  assert.equal(denied.content.error_type, 'workspace_root_changed');
  const legacy = setup(t, () => { throw Object.assign(Error('private'), { code: 'capture_limit_exceeded' }); });
  const frozen = legacy.request('printf no', 'legacy'); delete frozen.definition.workspaceChangePolicy;
  const old = await legacy.transport.execute(frozen);
  assert.equal(old.status, 'error'); assert.equal(old.content.executed, false);
  assert.equal(old.content.error_type, 'capture_limit_exceeded');
});
