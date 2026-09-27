import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthoringTools } from '../src/authoring-tools.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-authoring-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writes = [];
  const remote = {
    resources: async query => ({ items: [{ resourceId: `${new URLSearchParams(query).get('kind')}:one`, displayName: 'First resource' }] }),
    quickAuthorAgent: async payload => {
      writes.push(payload);
      return { metadata: { id: 'created-agent', name: payload.name, revision: 1 } };
    },
  };
  const make = () => new Map(createAuthoringTools({ directory, remoteFactory: async () => remote }).map(tool => [tool.name, tool]));
  const exec = { agent: { session: { id: 'native-session-1' } }, signal: new AbortController().signal };
  return { directory, remote, writes, make, exec };
}

test('native conversation preserves the draft across turns and restart; only confirmation creates', async t => {
  const { make, writes, exec } = await fixture(t);
  let tools = make();
  const first = await tools.get('studio_agent_draft').execute({ expectedRevision: 0, patch: {
    name: '日报助手', systemPrompt: '整理工作区日报', taskPrompt: '输出重点', modelProfileIds: ['model:one'],
  } }, exec);
  assert.equal(first.revision, 1);
  assert.equal(writes.length, 0);
  tools = make();
  assert.equal((await tools.get('studio_agent_draft').execute({}, exec)).draft.name, '日报助手');
  const second = await tools.get('studio_agent_draft').execute({ expectedRevision: 1, patch: { name: '周报助手', taskPrompt: '输出重点、风险与负责人' } }, exec);
  assert.equal(second.draft.systemPrompt, '整理工作区日报');
  assert.deepEqual(second.draft.modelProfileIds, ['model:one']);
  assert.equal(second.revision, 2);
  assert.equal(writes.length, 0);
  const created = await tools.get('studio_agent_create').execute({ expectedRevision: 2, confirm: true }, exec);
  assert.equal(created.agent.id, 'created-agent');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, '周报助手');
  assert.equal(writes[0].runtimeType, 'dsh-native');
  assert.deepEqual(writes[0].spec.instructions, { system: '整理工作区日报', task: '输出重点、风险与负责人' });
  assert.deepEqual(writes[0].spec.bindings.modelProfileIds, ['model:one']);
  assert.deepEqual(writes[0].spec.bindings.tools, []);
  await make().get('studio_agent_create').execute({ expectedRevision: 2, confirm: true }, exec);
  assert.equal(writes.length, 1, 'repeated confirmation must not duplicate the Agent');
});

test('drafts isolate native sessions, reject stale edits and require reviewed confirmation', async t => {
  const { make, exec, writes } = await fixture(t);
  const tools = make();
  await tools.get('studio_agent_draft').execute({ expectedRevision: 0, patch: { name: 'A' } }, exec);
  const other = { ...exec, agent: { session: { id: 'another-session' } } };
  assert.equal((await tools.get('studio_agent_draft').execute({}, other)).revision, 0);
  await assert.rejects(tools.get('studio_agent_draft').execute({ expectedRevision: 0, patch: { name: 'B' } }, exec), /DRAFT_REVISION_CONFLICT/);
  await assert.rejects(tools.get('studio_agent_create').execute({ expectedRevision: 1 }, exec), /CONFIRMATION_REQUIRED/);
  await assert.rejects(tools.get('studio_agent_create').execute({ expectedRevision: 0, confirm: true }, exec), /DRAFT_REVISION_CONFLICT/);
  assert.equal(writes.length, 0);
});

test('unknown resources and runtimes cannot become a silently accepted binding', async t => {
  const { make, exec, writes } = await fixture(t);
  const tools = make();
  await assert.rejects(tools.get('studio_agent_draft').execute({ expectedRevision: 0, patch: { runtimeType: 'langgraph' } }, exec), /RUNTIME_UNSUPPORTED/);
  await tools.get('studio_agent_draft').execute({ expectedRevision: 0, patch: { name: 'A', systemPrompt: 'B', modelProfileIds: ['model:missing'] } }, exec);
  await assert.rejects(tools.get('studio_agent_create').execute({ expectedRevision: 1, confirm: true }, exec), /RESOURCE_NOT_FOUND/);
  assert.equal(writes.length, 0);
});

test('ambiguous commit failure is not automatically retried', async t => {
  const { make, remote, exec } = await fixture(t);
  let requests = 0;
  remote.quickAuthorAgent = async () => { requests++; throw new Error('connection closed after write'); };
  const tools = make();
  await tools.get('studio_agent_draft').execute({ expectedRevision: 0, patch: { name: 'A', systemPrompt: 'B', modelProfileIds: ['model:one'] } }, exec);
  await assert.rejects(tools.get('studio_agent_create').execute({ expectedRevision: 1, confirm: true }, exec), /CREATE_OUTCOME_UNKNOWN/);
  await assert.rejects(make().get('studio_agent_create').execute({ expectedRevision: 1, confirm: true }, exec), /CREATE_OUTCOME_UNKNOWN/);
  assert.equal(requests, 1);
});
