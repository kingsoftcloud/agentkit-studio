import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSkillTools } from '../src/native/skill-tools.mjs';
import { canonical, copy, scopeKey } from '../../agentkit-harness-core/dist/index.mjs';

const FORMAL = name => {
  const defs = createNativeSkillTools({ authorize: async () => 'allow' }).definitions;
  return copy(defs.find(d => d.name === name));
};

const SCOPE = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };

function makeRequest(name, args, { signal, scope = SCOPE, ...over } = {}) {
  const def = FORMAL(name);
  return {
    call: { callId: 'call-1', name, arguments: args },
    definition: def,
    signal: signal ?? new AbortController().signal,
    scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build',
    parentRunId: null, taskChainId: 'chain', operationKey: 'op-1', executionFence: 1,
    budget: { maxToolCallsRemaining: 10, parentFinalizationReserved: true, depth: 0, maxDepth: 3 },
    interaction: null,
    ...over,
  };
}

function setup({ authorize = async () => 'allow', serviceClient, loadSkillFn, executeWorkflow, ...over } = {}) {
  const tools = createNativeSkillTools({ authorize, serviceClient, loadSkillFn, executeWorkflow,
    skillSpaceIds: ['space-1'], publicSpaceIds: [], publicAllowlist: [], boundSkillNames: [],
    binding: { agentId: 'agent', agentRevision: 1, buildId: 'build' }, ...over });
  const agent = { session: { id: 'session' } };
  const authority = { scope: SCOPE, sessionId: 'session', assertCurrent: () => true, agentRevision: 1 };
  const port = tools.forAgent(agent, authority);
  const execute = (name, args, opts = {}) => port.tools.execute(makeRequest(name, args, opts));
  return { tools, port, execute, agent, authority };
}

function gate() {
  let enter, reject;
  const entered = new Promise(resolve => { enter = resolve; });
  const pending = new Promise((_, fail) => { reject = fail; });
  return { entered, reject, invoke() { enter(); return pending; } };
}
async function within(pending, milliseconds) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('non-cooperative operation did not cancel')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

// --- snapshot includes ALL enumerable request keys (budget/interaction/unknown) ---

test('budget drift after authorization await is detected', async () => {
  let release;
  const authPromise = new Promise(r => { release = r; });
  const req = makeRequest('list_skill_spaces', {});
  let authCount = 0;
  const { port } = setup({
    authorize: async () => { authCount++; if (authCount === 1) { req.budget.maxToolCallsRemaining = 999; } await authPromise; return 'allow'; },
  });
  const pending = port.tools.execute(req);
  release();
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.equal(result.content.code, 'NATIVE_SKILL_DRIFT');
});

test('unknown field drift after authorization await is detected', async () => {
  let release;
  const authPromise = new Promise(r => { release = r; });
  const req = makeRequest('list_skill_spaces', {});
  req.customField = 'original';
  let authCount = 0;
  const { port } = setup({
    authorize: async () => { authCount++; if (authCount === 1) { req.customField = 'changed'; } await authPromise; return 'allow'; },
  });
  const pending = port.tools.execute(req);
  release();
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.equal(result.content.code, 'NATIVE_SKILL_DRIFT');
});

test('interaction drift after authorization await is detected', async () => {
  let release;
  const authPromise = new Promise(r => { release = r; });
  const req = makeRequest('list_skill_spaces', {});
  let authCount = 0;
  const { port } = setup({
    authorize: async () => { authCount++; if (authCount === 1) { req.interaction = { decision: 'allow' }; } await authPromise; return 'allow'; },
  });
  const pending = port.tools.execute(req);
  release();
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /NATIVE_SKILL_DRIFT/);
});

// --- scope four-domain per-field binding (canonical, not scopeKey) ---

test('scope.agentId drift is detected', async () => {
  let release;
  const authPromise = new Promise(r => { release = r; });
  const req = makeRequest('list_skill_spaces', {});
  let authCount = 0;
  const { port } = setup({
    authorize: async () => { authCount++; if (authCount === 1) { req.scope = { ...req.scope, agentId: 'different' }; } await authPromise; return 'allow'; },
  });
  const pending = port.tools.execute(req);
  release();
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /NATIVE_SKILL_DRIFT|SCOPE_MISMATCH/);
});

test('slash-containing scope fields remain distinct through the existing core scope encoding', async () => {
  const original = { ...SCOPE, tenantId: 'tenant/space' };
  const other = { ...SCOPE, workspaceId: 'space/workspace' };
  assert.notEqual(scopeKey(original), scopeKey(other), 'core already uses unambiguous JSON field encoding');
  const tools = createNativeSkillTools({ authorize: async () => 'allow' });
  const port = tools.forAgent({ session: { id: 'session' } }, {
    scope: original, sessionId: 'session', assertCurrent: () => true,
  }).tools;
  const result = await port.execute(makeRequest('list_skill_spaces', {}, { scope: other }));
  assert.equal(result.content.code, 'NATIVE_SKILL_AUTHORITY_SCOPE_MISMATCH');
});

for (const stage of ['authorize', 'service', 'loader', 'workflow']) {
  test('non-cooperative ' + stage + ' cancels after actual entry and observes late rejection', { timeout: 2000 }, async () => {
    const blocked = gate(), controller = new AbortController(), unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const options = { serviceClient: {
        listSkillsBySpaceId: async () => ({ activeSkills: [{ name: 'test', skillId: 'skill', versionId: 'v1' }] }),
      } };
      let name = 'list_skill_spaces', args = {};
      if (stage === 'authorize') options.authorize = blocked.invoke;
      if (stage === 'service') options.serviceClient.listSkillSpaces = blocked.invoke;
      if (stage === 'loader') { options.loadSkillFn = blocked.invoke; name = 'load_skill'; args = { skill_name: 'test' }; }
      if (stage === 'workflow') { options.executeWorkflow = blocked.invoke; name = 'execute_skills'; args = { workflow_prompt: 'run' }; }
      const { port } = setup(options);
      const pending = port.tools.execute(makeRequest(name, args, { signal: controller.signal }));
      await blocked.entered;
      controller.abort();
      const result = await within(pending, 500);
      assert.equal(result.status, stage === 'workflow' ? 'uncertain' : 'error');
      if (stage === 'workflow') {
        assert.equal(result.content.operationKey, 'op-1'); assert.equal(result.content.executed, undefined);
      } else assert.equal(result.content.executed, false);
      blocked.reject(new Error('late ' + stage + ' rejection'));
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally { process.off('unhandledRejection', onUnhandled); }
  });
}

// --- locator: deep-copy + freeze, backend mutation does not affect it ---

test('locator is frozen and backend mutation of scope/call does not affect uncertain result', async () => {
  const { port } = setup({
    executeWorkflow: async (req) => {
      // Mutate the scope and call objects that the backend received.
      req.scope.agentId = 'mutated';
      req.call.callId = 'mutated';
      throw new Error('backend crashed after mutation');
    },
  });
  const result = await port.tools.execute(makeRequest('execute_skills', { workflow_prompt: 'test' }));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.content.scope.agentId, 'agent', 'locator scope must be the original, not mutated');
  assert.equal(result.content.callId, 'call-1', 'locator callId must be the original');
  assert.equal(result.content.call.callId, 'call-1', 'locator call must be the original');
  // The locator values in the uncertain result are deep-copied from the frozen locator.
  // The frozen locator itself is internal; the result preserves the original values.
});

// --- execute_skills uncertain includes full locator ---

test('execute_skills uncertain includes full locator with all identity fields', async () => {
  const { port } = setup({ executeWorkflow: async () => { throw new Error('crash'); } });
  const result = await port.tools.execute(makeRequest('execute_skills', { workflow_prompt: 'test' }));
  assert.equal(result.status, 'uncertain');
  const c = result.content;
  assert.equal(c.runId, 'run');
  assert.equal(c.sessionId, 'session');
  assert.equal(c.turnId, 'turn');
  assert.equal(c.buildId, 'build');
  assert.equal(c.parentRunId, null);
  assert.equal(c.taskChainId, 'chain');
  assert.equal(c.operationKey, 'op-1');
  assert.ok(c.executionFence !== undefined);
  assert.equal(c.callId, 'call-1');
  assert.ok(c.call);
  assert.equal(c.uncertain, true);
});

// --- authorization layer approval_required is preserved ---

test('authorization layer approval_required is preserved (not uncertain)', async () => {
  const { port } = setup({
    authorize: async () => ({ status: 'approval_required', interactionId: 'int-auth', message: 'need approval' }),
  });
  const result = await port.tools.execute(makeRequest('list_skill_spaces', {}));
  assert.equal(result.status, 'approval_required');
  assert.equal(result.interactionId, 'int-auth');
  assert.notEqual(result.status, 'uncertain');
});

// --- backend approval_required returns uncertain (side effects possible) ---

test('backend approval_required result returns uncertain (side effects possible)', async () => {
  const { port } = setup({
    executeWorkflow: async () => ({ approval_required: true, interactionId: 'int-backend', message: 'need approval' }),
  });
  const result = await port.tools.execute(makeRequest('execute_skills', { workflow_prompt: 'test' }));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.content.uncertain, true);
  assert.equal(result.content.error_type, 'invalid_skill_approval');
});

// --- result getter exception returns uncertain ---

test('execute_skills result with throwing getter returns uncertain', async () => {
  const { port } = setup({
    executeWorkflow: async () => {
      const obj = { ok: true };
      Object.defineProperty(obj, 'exit_code', { get() { throw new Error('getter crash'); } });
      return obj;
    },
  });
  const result = await port.tools.execute(makeRequest('execute_skills', { workflow_prompt: 'test' }));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.content.uncertain, true);
});

// --- signal replacement detected ---

test('original signal replacement is detected', async () => {
  let release;
  const authPromise = new Promise(r => { release = r; });
  const req = makeRequest('list_skill_spaces', {});
  let authCount = 0;
  const { port } = setup({
    authorize: async () => { authCount++; if (authCount === 1) { req.signal = new AbortController().signal; } await authPromise; return 'allow'; },
  });
  const pending = port.tools.execute(req);
  release();
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.match(result.content.code, /NATIVE_SKILL_DRIFT|REQUEST_CANCELLED/);
});

// --- abort before authorization ---

test('abort before authorization returns clean error', async () => {
  const controller = new AbortController();
  const { port } = setup();
  controller.abort();
  const result = await port.tools.execute(makeRequest('list_skill_spaces', {}, { signal: controller.signal }));
  assert.equal(result.status, 'error');
  assert.equal(result.content.code, 'REQUEST_CANCELLED');
});

// --- definition forgery ---

test('forged definition is rejected before authorization', async () => {
  const { port } = setup();
  const req = makeRequest('list_skill_spaces', {});
  req.definition = { name: 'list_skill_spaces', readOnly: true, parameters: { type: 'object' }, additionalProperties: true };
  const result = await port.tools.execute(req);
  assert.equal(result.status, 'error');
  assert.equal(result.content.code, 'NATIVE_SKILL_DEFINITION_FORGED');
});

// --- public definitions mutation ---

test('mutating public definitions does not bypass formal validation', async () => {
  const tools = createNativeSkillTools({ authorize: async () => 'allow' });
  tools.definitions[0].parameters.additionalProperties = true;
  const agent = { session: { id: 'session' } };
  const authority = { scope: SCOPE, sessionId: 'session', assertCurrent: () => true, agentRevision: 1 };
  const port = tools.forAgent(agent, authority);
  const req = makeRequest('list_skill_spaces', { extra: true });
  const result = await port.tools.execute(req);
  assert.equal(result.status, 'error');
  assert.equal(result.content.code, 'invalid_arguments');
});

// --- authority scope mismatch ---

test('request scope mismatch with authority scope is rejected', async () => {
  const { port } = setup();
  const req = makeRequest('list_skill_spaces', {}, { scope: { tenantId: 'other', workspaceId: 'workspace', userId: 'user', agentId: 'agent' } });
  const result = await port.tools.execute(req);
  assert.equal(result.status, 'error');
  assert.equal(result.content.code, 'NATIVE_SKILL_AUTHORITY_SCOPE_MISMATCH');
});

// --- thenable assertCurrent ---

test('thenable assertCurrent rejection is observed', async () => {
  let rejected = false;
  const unhandled = [];
  const listener = e => unhandled.push(e.message);
  process.on('unhandledRejection', listener);
  try {
    const tools = createNativeSkillTools({ authorize: async () => 'allow' });
    const agent = { session: { id: 'session' } };
    const authority = { scope: SCOPE, sessionId: 'session',
      assertCurrent: () => { const p = Promise.reject(new Error('auth-reject')); p.then(() => {}, () => { rejected = true; }); return p; },
      agentRevision: 1 };
    const port = tools.forAgent(agent, authority);
    const result = await port.tools.execute(makeRequest('list_skill_spaces', {}));
    assert.equal(result.status, 'error');
    assert.match(result.content.code, /NATIVE_SKILL_AUTHORITY_EXPIRED|NATIVE_SKILL_DRIFT/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
    assert.equal(rejected, true);
  } finally { process.off('unhandledRejection', listener); }
});

// --- buildId mismatch ---

test('buildId mismatch with binding is rejected', async () => {
  const { port } = setup();
  const req = makeRequest('list_skill_spaces', {}, { buildId: 'different-build' });
  const result = await port.tools.execute(req);
  assert.equal(result.status, 'error');
  assert.equal(result.content.code, 'NATIVE_SKILL_BINDING_BUILD_MISMATCH');
});

// --- authorize rejection ---

test('authorize rejection returns error not uncertain', async () => {
  const { port } = setup({ authorize: async () => 'deny' });
  const result = await port.tools.execute(makeRequest('list_skill_spaces', {}));
  assert.equal(result.status, 'error');
  assert.equal(result.content.executed, false);
});

// A callback is itself a reentrancy boundary even when it returns synchronously.
test('authority callback cannot mutate request body and still authorize a service', async () => {
  let calls = 0;
  const req = makeRequest('list_skill_spaces', {});
  const tools = createNativeSkillTools({ authorize: async () => 'allow', serviceClient: {
    listSkillSpaces: async () => { calls++; return {}; },
  } });
  const port = tools.forAgent({ session: { id: 'session' } }, { scope: SCOPE, sessionId: 'session',
    assertCurrent: () => { req.budget.maxToolCallsRemaining = 999; return true; } }).tools;
  const result = await port.execute(req);
  assert.equal(result.content.code, 'NATIVE_SKILL_DRIFT'); assert.equal(calls, 0);
});

test('a request key matching an internal snapshot label is still sealed', async () => {
  const req = makeRequest('list_skill_spaces', {}); req._internalDefinition = 'original';
  const { port } = setup({ authorize: async () => { req._internalDefinition = 'changed'; return 'allow'; } });
  const result = await port.tools.execute(req);
  assert.equal(result.content.code, 'NATIVE_SKILL_DRIFT');
});

test('the reserved runtime locator survives cancellation of a non-cooperative workflow', async () => {
  const backend = gate(), controller = new AbortController();
  const locator = { runtime_id: 'local-skill:original', task_id: 'a'.repeat(64) };
  const h = setup({ executeWorkflow: () => backend.invoke(), locateWorkflow: () => locator });
  const pending = h.execute('execute_skills', { workflow_prompt: 'test' }, { signal: controller.signal });
  await backend.entered; controller.abort();
  const result = await within(pending, 500);
  assert.equal(result.status, 'uncertain'); assert.equal(result.content.runtime_id, locator.runtime_id);
  assert.equal(result.content.task_id, locator.task_id); assert.equal(result.content.runId, 'run');
  backend.reject(new Error('late backend rejection')); await new Promise(resolve => setImmediate(resolve));
});

test('a backend cannot replace the reserved runtime or command identity with a foreign result', async () => {
  const h = setup({ locateWorkflow: () => ({ runtime_id: 'original', task_id: 'a'.repeat(64) }),
    executeWorkflow: async () => ({ runtime_id: 'foreign', task_id: 'b'.repeat(64), exit_code: 0, ok: true }) });
  const result = await h.execute('execute_skills', { workflow_prompt: 'test' });
  assert.equal(result.status, 'uncertain'); assert.equal(result.content.runtime_id, 'original'); assert.equal(result.content.task_id, 'a'.repeat(64));
});

test('a rejecting asynchronous locator cannot authorize workflow dispatch through synchronous identity fields', async () => {
  let calls = 0;
  const locator = Object.assign(Promise.reject(new Error('locator rejected')), { runtime_id: 'original', task_id: 'a'.repeat(64) });
  const h = setup({ locateWorkflow: () => locator, executeWorkflow: async () => { calls++; return { exit_code: 0, ok: true }; } });
  const result = await h.execute('execute_skills', { workflow_prompt: 'test' });
  assert.equal(result.status, 'uncertain'); assert.equal(calls, 0);
  await new Promise(resolve => setImmediate(resolve));
});
