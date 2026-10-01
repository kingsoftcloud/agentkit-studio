import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLocalResourceContext } from '../src/local-runtime.mjs';

test('knowledge context includes real RetrieveKnowledge Segment content and document name', async () => {
  const prepared = await prepareLocalResourceContext({
    record: { spec: { bindings: { plugins: [{ config: { binding: { resource: { kind: 'knowledge-base', id: 'kb' } } } }] } } },
    input: 'Gravitino',
    resourceAdapter: { searchKnowledge: async () => [
      { Segment: { Content: '每个 workspace 对应一个独立 Gravitino Helm release。', Document: { Name: 'README.md' } }, Score: 0.5 },
    ] },
  });
  assert.match(prepared.resourceContext, /独立 Gravitino Helm release/);
  assert.match(prepared.resourceContext, /README\.md/);
});
