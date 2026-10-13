import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshRoot = resolve(process.env.AGENTKIT_DSH_ROOT || join(projectRoot, '../../deepseek-harness'));
const packageRoot = join(projectRoot, 'packages/agentkit-harness');
const artifactRoot = join(projectRoot, '.artifacts');

await mkdir(artifactRoot, { recursive: true });
// Vitest's pinned workspace config only includes files under the DSH repo.
// Keep the probe in its scripts directory for discovery, then remove it in
// the finally block; no source or test file is retained in the checkout.
const probe = join(dshRoot, 'scripts', `.agentkit-studio-harness-${process.pid}.spec.ts`);
const persistenceRoot = await mkdtemp('/private/tmp/agentkit-studio-harness-persistence-');
const packOutput = execFileSync('pnpm', ['pack', '--pack-destination', artifactRoot], {
  cwd: packageRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const tarball = resolve(packOutput.split(/\r?\n/).at(-1).trim());
const npmInstallRoot = await mkdtemp('/private/tmp/agentkit-harness-npm-');

  // Extract the packed artifact directly instead of invoking the registry
  // resolver. Peer dependencies are intentionally host-owned and the npm
  // acceptance must remain deterministic without network or npm cache state.
const packedPackageRoot = join(npmInstallRoot, 'node_modules/@kingsoftcloud/agentkit-harness');
  await mkdir(packedPackageRoot, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', packedPackageRoot, '--strip-components=1'], { stdio: 'inherit', timeout: 30_000 });
  execFileSync(process.execPath, ['--input-type=module', '-e', "const p=await import('@kingsoftcloud/agentkit-harness'); if(p.name!=='agentkit-harness'||typeof p.apply!=='function') throw new Error('packed plugin entry invalid')"], {
    cwd: npmInstallRoot, stdio: 'inherit', timeout: 30_000,
  });

await symlink(join(dshRoot, 'node_modules/@deepseek-ai'), join(npmInstallRoot, 'node_modules/@deepseek-ai'), 'dir');
await symlink(join(dshRoot, 'node_modules/@types'), join(npmInstallRoot, 'node_modules/@types'), 'dir');
const typeProbe = join(npmInstallRoot, 'types.ts');
await writeFile(typeProbe, `import plugin, { AgentKitHarnessService } from '@kingsoftcloud/agentkit-harness';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
declare const ctx: Context;
plugin.apply(ctx);
const harness = new AgentKitHarnessService(ctx);
const created: Promise<AgentHandle> = harness.create({sessionId: SessionId('type-probe')});
const live: Agent | undefined = harness.get(SessionId('type-probe'));
void created; void live;
`);
const baseConfig = (await readFile(join(dshRoot, 'tsconfig.base.json'), 'utf8')).replace(/\/\/.*$/gm, '');
const officialPaths = JSON.parse(baseConfig).compilerOptions.paths;
const paths = Object.fromEntries(Object.entries(officialPaths).map(([key, values]) => [key, values.map(value => join(dshRoot, value.replace('/src', '/lib/types').replace(/\.ts$/, '.d.ts')))]));
const typeConfig = join(npmInstallRoot, 'tsconfig.json');
await writeFile(typeConfig, JSON.stringify({compilerOptions: {target:'esnext',module:'esnext',moduleResolution:'bundler',strict:true,skipLibCheck:false,paths,types:[]},files:[typeProbe]}));
execFileSync('pnpm', ['exec', 'tsc', '--noEmit', '--project', typeConfig], { cwd: dshRoot, stdio: 'inherit', timeout: 120_000 });

const packageEntry = join(packedPackageRoot, 'src/index.mjs');

const probeSource = `
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse } from ${JSON.stringify(join(dshRoot, 'packages/core/agent-loop/tests/mock-adapter.ts'))}
import * as HarnessPlugin from ${JSON.stringify(packageEntry)}

const persistenceRoot = ${JSON.stringify(persistenceRoot)}
const contexts: Context[] = []

async function mount(script: unknown[]): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script as never[]))
  const harnessFiber = await ctx.plugin(HarnessPlugin)
  Object.assign(ctx, { harnessFiber })
  return ctx
}

afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

describe('AgentKit Harness DSH plugin', () => {
  it('loads, executes official stream frames, persists DSH events and unloads cleanly', async () => {
    const ctx = await mount([textResponse('hello')])
    const harness = ctx.agentkitHarness
    expect(harness.contract.persistenceOwner).toBe('dsh-session-persistence')
    const id = SessionId('agentkit-harness-e2e')
    const handle = await harness.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    const frames = []
    const events = []
    const stop = harness.observe(id, { onAssistantStream: frame => frames.push(frame), onEvent: event => events.push(event) })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    stop()
    expect(frames.some(frame => frame.type === 'start')).toBe(true)
    expect(frames.some(frame => frame.type === 'end')).toBe(true)
    expect(frames.filter(frame => frame.type === 'chunk').length).toBeGreaterThanOrEqual(5)
    const eventTypes = events.map(event => event.type)
    expect(eventTypes).toEqual(expect.arrayContaining(['user/message', 'assistant/message', 'turn/start', 'turn/end']))
    await handle.dispose()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.agentkitHarness).toBeDefined()
    await ctx.harnessFiber.dispose()
    expect(ctx.get('agentkitHarness')).toBeUndefined()
    expect(ctx.get('agents')).toBeDefined()
    expect(ctx.get('sessions')).toBeDefined()
    const native = await ctx.agents.create({ sessionId: SessionId('after-harness-unload'), agentOptions: { provider: 'mock', model: 'mock' } })
    await native.dispose()
  })

  it('resumes the persisted DSH session through the public AgentRegistry seam', async () => {
    const first = await mount([textResponse('first')])
    const id = SessionId('agentkit-harness-resume')
    const created = await first.agentkitHarness.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    first.agentkitHarness.followup(id, createUserMessage({ content: [{ type: 'text', text: 'remember this' }], source: { kind: 'user' } }))
    await created.agent.whenIdle()
    await created.dispose()
    await first.sessionPersistence.flush()
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const second = await mount([textResponse('continued')])
    const persisted = await second.sessionPersistence.open(id, 'read')
    const stored = await persisted.read()
    await persisted.close()
    expect(stored.events.some(event => event.type === 'user/message')).toBe(true)
    const resumed = await second.agentkitHarness.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    second.agentkitHarness.followup(id, createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await resumed.agent.whenIdle()
    await second.sessionPersistence.flush()
    const persistedAgain = await second.sessionPersistence.open(id, 'read')
    const storedAgain = await persistedAgain.read()
    await persistedAgain.close()
    expect(storedAgain.events.filter(event => event.type === 'assistant/message').length).toBeGreaterThanOrEqual(2)
    await resumed.dispose()
  })

  it('cancels through DSH Agent.cancel and ends the official assistant stream', async () => {
    const ctx = await mount(['hang'])
    const id = SessionId('agentkit-harness-cancel')
    const handle = await ctx.agentkitHarness.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    const frames = []
    const stop = ctx.agentkitHarness.observe(id, { onAssistantStream: frame => frames.push(frame) })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'stop this' }], source: { kind: 'user' } }))
    await new Promise(resolve => setTimeout(resolve, 10))
    ctx.agentkitHarness.cancel(id)
    await handle.agent.whenIdle()
    stop()
    expect(frames.some(frame => frame.type === 'end')).toBe(true)
    await handle.dispose()
  })
})
`;

await writeFile(probe, probeSource);
try {
  execFileSync('pnpm', ['exec', 'vitest', 'run', relative(dshRoot, probe), '--config', 'vitest.config.ts'], {
    cwd: dshRoot,
    env: process.env,
    stdio: 'inherit',
    timeout: 120_000,
  });
} finally {
  await rm(probe, { force: true });
  await rm(persistenceRoot, { recursive: true, force: true });
  await rm(npmInstallRoot, { recursive: true, force: true });
}

const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const required = [
  'package/src/index.mjs',
  'package/src/core.mjs',
  'package/src/contract.mjs',
  'package/src/dsh-adapter.mjs',
  'package/agentkit-harness.plugin.json',
  'package/LICENSE',
  'package/package.json',
];
for (const entry of required) if (!entries.includes(entry)) throw new Error(`Harness tarball is missing ${entry}`);
for (const entry of entries) {
  if (entry.includes('node_modules/') || entry.includes('test/')) throw new Error(`Harness tarball contains forbidden content ${entry}`);
}
for (const privateEntry of ['package/src/local-runtime.mjs', 'package/src/model-route.mjs', 'package/src/sse.mjs']) {
  if (entries.includes(privateEntry)) throw new Error(`Harness npm package leaked Studio-private runtime file ${privateEntry}`);
}
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
if (!metadata.peerDependencies?.['@deepseek-ai/dsh-agent'] || !metadata.peerDependencies?.['@deepseek-ai/dsh-session']) {
  throw new Error('Harness package must declare DSH Agent and Session peer dependencies');
}
console.log(JSON.stringify({ dsh: 'passed', unload: 'passed', npmPack: 'passed', tarball }, null, 2));
