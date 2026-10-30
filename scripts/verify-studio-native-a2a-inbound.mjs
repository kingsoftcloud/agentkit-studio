/** Supplement the real mounted outgoing Host proof with actual inbound HTTP.
 * Gateway signer, registry admission and Session facts remain controlled peers;
 * this does not claim Server-command-to-Native model execution. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ingressSigner, kernelFact, targetBinding, platformTaskId, targetVersionId } from '../tests/fixtures/native-a2a-inbound.mjs';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';

export function createMountedInboundProof(root) {
  const signer = ingressSigner(), commandId = randomUUID(), messageId = randomUUID(), calls = [], facts = new Map();
  const message = { messageId: 'mounted-inbound-message', role: 'ROLE_USER', parts: [{ text: 'inbound original' }] };
  const body = method => canonical({ jsonrpc: '2.0', id: 'inbound-proof', method, params: { message } });
  const rows = [kernelFact(1), kernelFact(2, { family: 'runtime', family_version: 2, event_type: 'item.updated', payload: {
    schema_version: 2, event_type: 'item.updated', run_id: 'run-original', scope_id: 'scope', item_id: 'answer', item_kind: 'message', op: 'append',
    update: { content_type: 'text', part_id: 'p', text: 'Mounted inbound answer' } } }),
  kernelFact(3, { family: 'runtime', family_version: 2, event_type: 'run.completed', payload: { schema_version: 2,
    event_type: 'run.completed', run_id: 'run-original', scope_id: 'scope', output_refs: [{ scope_id: 'scope', item_id: 'answer', part_id: null }] } }),
  kernelFact(4, { payload: { run_id: 'run-original', state: 'completed' } })];
  let originalTask, originalRecords, address;
  const taskFiles = async () => {
    const result = {};
    for (const kind of ['admission', 'tasks']) {
      const directory = join(root, 'studio', 'native-harness', 'a2a-inbound', kind);
      for (const name of (await readdir(directory)).filter(name => name.endsWith('.json')).sort())
        result[`${kind}/${name}`] = await readFile(join(directory, name), 'utf8');
    }
    return result;
  };
  return {
    async prepare() { const path = join(root, 'inbound-proof.json'); await writeFile(path, JSON.stringify({ publicKeyPem: signer.publicKeyPem, targetBinding, rows })); return path; },
    async handle(request, response, payload, tokens) {
      const action = request.url.split('/').at(-1);
      if (!['SubmitA2AInboundMessage', 'AppendA2AProductKernelFacts'].includes(action)) return false;
      const audience = action === 'SubmitA2AInboundMessage' ? 'a2a-registry' : 'a2a-task-sink';
      assert.equal(request.headers.authorization, 'Bearer ' + tokens[audience]); calls.push({ action, payload });
      assert.equal(payload.A2ATaskId, platformTaskId); assert.equal(payload.TargetVersionId, targetVersionId);
      if (!address) address = [payload.RemoteTaskId, payload.RemoteContextId];
      assert.deepEqual([payload.RemoteTaskId, payload.RemoteContextId], address);
      if (action === 'SubmitA2AInboundMessage') assert.deepEqual(payload.Message, message);
      else for (const fact of payload.Events) {
        assert.ok([rows[0].event_id, rows[3].event_id].includes(fact.event_id));
        if (facts.has(fact.event_id)) assert.equal(facts.get(fact.event_id), canonical(fact));
        facts.set(fact.event_id, canonical(fact));
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ Code: 0, Data: action === 'SubmitA2AInboundMessage' ? { SessionId: 'a2a-kernel-original', AgentId: targetBinding.agentId,
        CommandId: commandId, Receipt: { schema_version: 1, command_id: commandId, message_id: messageId, status: 'accepted', accepted_seq: 1000, run_id: 'run-original' } } : {} }));
      return true;
    },
    async probe(phase) {
      const mounts = (await readFile(join(root, 'mounted-inbound-host.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse), mount = mounts.at(-1);
      const send = async (operation, raw, options = {}) => {
        const signed = signer.request(operation, { body: raw, product: true, ...options });
        return fetch(mount.origin + signed.path, { method: signed.method, headers: signed.headers,
          ...(signed.method === 'GET' ? {} : { body: signed.body }), signal: AbortSignal.timeout(10000) });
      };
      if (phase === 'before') {
        assert.equal((await fetch(mount.origin + '/.well-known/agent-card.json')).status, 401);
        const card = await send('get_task', '', { path: '/.well-known/agent-card.json', httpMethod: 'GET' });
        assert.equal(card.status, 200); assert.equal((await card.json()).supportedInterfaces[0].protocolVersion, '1.0');
        const response = await send('send_message', body('SendStreamingMessage')), text = await response.text();
        const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        assert.ok(events.every(event => !event.error));
        assert.equal(events.at(-1).result.statusUpdate.status.state, 'TASK_STATE_COMPLETED');
        const initial = events[0].result.task;
        const get = await send('get_task', canonical({ jsonrpc: '2.0', id: 'inbound-proof', method: 'GetTask', params: { id: initial.id } }));
        originalTask = (await get.json()).result; assert.equal(originalTask.status.message.parts[0].text, 'Mounted inbound answer');
        const deadline = Date.now() + 10000;
        for (;;) {
          originalRecords = await taskFiles();
          const record = JSON.parse(Object.entries(originalRecords).find(([name]) => name.startsWith('tasks/'))[1]);
          if (facts.size === 2 && Object.values(record.productOutbox).every(row => row.state === 'acknowledged')) break;
          assert.ok(Date.now() < deadline, 'mounted product outbox did not drain'); await new Promise(resolve => setTimeout(resolve, 20));
        }
      } else {
        const count = calls.length;
        const get = await send('get_task', canonical({ jsonrpc: '2.0', id: 'inbound-proof', method: 'GetTask', params: { id: originalTask.id } }));
        assert.deepEqual((await get.json()).result, originalTask);
        const retry = await send('send_message', body('SendMessage'));
        assert.deepEqual((await retry.json()).result.task, originalTask); assert.equal(calls.length, count);
        assert.deepEqual(await taskFiles(), originalRecords);
        assert.equal(calls.filter(call => call.action === 'SubmitA2AInboundMessage').length, 1);
        assert.equal(facts.size, 2); assert.notEqual(mounts[0].pid, mount.pid);
        const subscriptions = (await readFile(join(root, 'inbound-event-subscriptions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(subscriptions.length, 1);
        await writeFile(join(root, 'mounted-inbound-evidence.json'), JSON.stringify({ originalPid: mounts[0].pid, coldPid: mount.pid,
          admissions: 1, factIds: [...facts.keys()], factBatches: calls.filter(call => call.action === 'AppendA2AProductKernelFacts').length,
          eventSubscriptions: 1, taskId: originalTask.id, contextId: originalTask.contextId, taskState: originalTask.status.state,
          recordsUnchanged: true, coldAdmissionHttp: 0, coldEventSubscriptions: 0,
          limitation: 'Actual maintained DSH WebServer + packed Studio bootstrap, controlled signer/registry/Session facts; no Server-command-to-Native execution or online/fresh-install claim.' }, null, 2));
      }
    },
  };
}
