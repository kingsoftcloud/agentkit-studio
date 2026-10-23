// Real child process for A2A SIGKILL checkpoints. No Python and no signal
// handler that could turn the crash into an ordinary caught exception.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NativeKernel, emptyUsage } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeDshTools } from '../../src/providers/native-dsh-tools.mjs';
const [mode, root, origin] = process.argv.slice(2), workspaceRoot = join(root, 'workspace');
const store = new SqliteRunStore(join(root, 'runs.sqlite'));
if (mode === 'recover') {
  const forbidden = () => { appendFileSync(join(root, 'forbidden.jsonl'), 'called\n'); throw Error('cold recovery re-entered an effect'); };
  const kernel = new NativeKernel({ store, digest, owner: 'replacement', ports: {
    model: { generate: forbidden }, tools: { execute: forbidden },
  } });
  const snapshot = await kernel.runUntilIdle(scope, 'run');
  process.stdout.write(JSON.stringify({ phase: snapshot.phase, reason: snapshot.reason, receipts: store.load(scope, 'run').receipts.length }) + '\n');
  store.close();
} else {
  mkdirSync(workspaceRoot, { recursive: true });
  const registry = new Map(), agent = { session: { id: 'session' } };
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, tools: {
    register(tool) { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    async execute(input) {
      const tool = registry.get(input.name), value = await tool.execute(input.arguments, input);
      return { isError: false, value, content: tool.output.render(input.arguments, value) };
    },
  } };
  const gateway = createNativeDshTools({ ctx, config: { agentId: scope.agentId, a2aBindings: [{ local_name: 'remote',
    binding_id: 'binding', space_id: 'space', target_agent_id: 'remote', expected_version_id: 'version', exposure: 'tool' }] },
    workspaceRoot, stateDir: join(root, 'state'), commandEnvironment: {
      KSADK_A2A_SERVICE_URL: origin, KSADK_A2A_ALLOW_PRIVATE: 'true',
    } });
  const data = fixture({ tools: gateway.definitions(agent, [...registry.values()]), limits: { leaseMs: 1000 } });
  const kernel = new NativeKernel({ store, digest, owner: 'doomed', ports: {
    ...gateway.forAgent(agent, { scope, store }), model: { generate: async () => {
      appendFileSync(join(root, 'models.jsonl'), 'model\n');
      return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'real-call', name: 'call_a2a_agent',
        arguments: { agent: 'remote', message: 'one original send' } }] };
    } },
  } });
  kernel.start(data.snapshot, data.config);
  await kernel.runUntilIdle(scope, 'run');
  throw Error('fixture must be SIGKILLed before it returns');
}
