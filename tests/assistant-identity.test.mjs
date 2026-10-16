import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantIdentity } from '../src/assistant-identity.mjs';

test('identity survives restart with private durable storage and rejects invalid changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createAssistantIdentity({ directory, defaultName: '助理' });
  assert.deepEqual(store.read(), { assistantName: '助理', ownerName: '' });
  await store.update({ assistantName: ' 小星 ', ownerName: ' 小夏 ' });
  assert.deepEqual((await createAssistantIdentity({ directory })).read(), { assistantName: '小星', ownerName: '小夏' });
  assert.equal((await stat(join(directory, 'assistant-identity.json'))).mode & 0o777, 0o600);
  for (const assistantName of ['', 'x'.repeat(65), 'a\nb', 'a\u202eb']) {
    assert.throws(() => store.update({ assistantName, ownerName: '' }), { code: 'ASSISTANT_IDENTITY_INVALID' });
  }
  const saved = JSON.parse(await readFile(join(directory, 'assistant-identity.json'), 'utf8'));
  assert.deepEqual(saved, { assistantName: '小星', ownerName: '小夏' });
  await Promise.all([store.update({ assistantName: '一', ownerName: '' }), store.update({ assistantName: '二', ownerName: '' })]);
  assert.deepEqual((await createAssistantIdentity({ directory })).read(), { assistantName: '二', ownerName: '' });
});
