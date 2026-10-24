/** Actual packed Host proof: Gateway -> controlled Server -> signed HTTP
 * command -> NativeKernel -> HTTP model -> file tool -> durable Session facts.
 * The trusted model/tool binding and Server peer are explicit fixtures. */
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { ingressSigner, targetBinding, platformTaskId, targetVersionId } from '../tests/fixtures/native-a2a-inbound.mjs';
import { permitIssuer, command } from '../tests/fixtures/native-managed-kernel.mjs';

export function createMountedNativeKernelProof(root) {
  const signer = ingressSigner(), issuer = permitIssuer({ target: { tenantId: targetBinding.tenantId, agentInstanceId: targetBinding.agentId } });
  const cmd = command({ tenant_id: targetBinding.tenantId, agent_instance_id: targetBinding.agentId,
    session_id: 'a2a-kernel-mounted-native', payload: { content: 'write the proof and answer' } });
  const message = { messageId: 'native-kernel-inbound-message', parts: [{ text: cmd.payload.content }] };
  const calls = [], facts = new Map(), modelRequests = [];
  let origin, accepted, originalTask, originalRecords, remote;
  const records = async () => {
    const result = {};
    for (const kind of ['admission', 'tasks']) {
      const directory = join(root, 'studio', 'native-harness', 'a2a-inbound', kind);
      for (const name of (await readdir(directory)).filter(name => name.endsWith('.json')).sort()) result[`${kind}/${name}`] = await readFile(join(directory, name), 'utf8');
    }
    return result;
  };
  return {
    async prepare() {
      const path = join(root, 'inbound-proof.json');
      await writeFile(path, JSON.stringify({ executeNative: true, publicKeyPem: signer.publicKeyPem,
        targetBinding, kernelPublicKeyPem: issuer.publicKeyPem })); return path;
    },
    async handle(request, response, payload, tokens) {
      if (request.url === '/native-inbound-model/chat/completions') {
        assert.equal(request.headers.authorization, 'Bearer controlled-inbound-model'); modelRequests.push(payload);
        assert.ok(modelRequests.length <= 2, 'duplicate inbound model execution');
        const first = modelRequests.length === 1;
        if (!first) assert.ok(payload.messages.some(message => message.role === 'tool' && message.content.includes('Durable proof file written')));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: first ? { tool_calls: [{ index: 0, id: 'inbound-write', type: 'function',
          function: { name: 'write_fixture', arguments: '{}' } }] } : { content: 'Mounted Native executed answer' }, finish_reason: first ? 'tool_calls' : 'stop' }] })
          + '\n\ndata: [DONE]\n\n'); return true;
      }
      const action = request.url.split('/').at(-1);
      if (!['SubmitA2AInboundMessage', 'AppendA2AProductKernelFacts'].includes(action)) return false;
      assert.equal(request.headers.authorization, 'Bearer ' + tokens[action === 'SubmitA2AInboundMessage' ? 'a2a-registry' : 'a2a-task-sink']);
      calls.push({ action, payload }); assert.equal(payload.A2ATaskId, platformTaskId); assert.equal(payload.TargetVersionId, targetVersionId);
      remote ??= [payload.RemoteTaskId, payload.RemoteContextId]; assert.deepEqual([payload.RemoteTaskId, payload.RemoteContextId], remote);
      let data = {};
      if (action === 'SubmitA2AInboundMessage') {
        assert.deepEqual(payload.Message, message);
        const delivered = await fetch(origin + '/_agentkit/native-kernel/v1/commands', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: canonical({ command: cmd, permit: issuer.issue(cmd) }), signal: AbortSignal.timeout(10000) });
        assert.equal(delivered.status, 202); accepted = await delivered.json(); assert.equal(accepted.status, 'accepted');
        data = { SessionId: cmd.session_id, AgentId: cmd.agent_instance_id, CommandId: cmd.command_id, Receipt: accepted };
      } else for (const fact of payload.Events) {
        assert.equal(fact.run_id, accepted.run_id); assert.equal(fact.event_type, 'control.run_transition');
        if (facts.has(fact.event_id)) assert.equal(facts.get(fact.event_id), canonical(fact)); facts.set(fact.event_id, canonical(fact));
      }
      response.setHeader('content-type', 'application/json'); response.end(canonical({ Code: 0, Data: data })); return true;
    },
    async probe(phase) {
      const mounts = (await readFile(join(root, 'mounted-inbound-host.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      origin = mounts.at(-1).origin;
      const send = async (operation, method, params) => {
        const signed = signer.request(operation, { product: true, body: canonical({ jsonrpc: '2.0', id: 'native-kernel-proof', method, params }) });
        const response = await fetch(origin + signed.path, { method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(15000) });
        assert.equal(response.status, 200); return response;
      };
      if (phase === 'before') {
        const response = await send('send_message', 'SendStreamingMessage', { message });
        const updates = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        assert.ok(updates.length > 3); assert.ok(updates.every(update => !update.error));
        assert.equal(updates.at(-1).result.statusUpdate.status.state, 'TASK_STATE_COMPLETED');
        const first = updates[0].result.task;
        originalTask = (await (await send('get_task', 'GetTask', { id: first.id })).json()).result;
        assert.equal(originalTask.status.message.parts[0].text, 'Mounted Native executed answer');
        const deadline = Date.now() + 10000;
        for (;;) {
          originalRecords = await records();
          const task = JSON.parse(Object.entries(originalRecords).find(([key]) => key.startsWith('tasks/'))[1]);
          if (facts.size === 2 && Object.values(task.productOutbox).every(row => row.state === 'acknowledged')) break;
          assert.ok(Date.now() < deadline, 'actual Native product facts did not drain'); await new Promise(resolve => setTimeout(resolve, 20));
        }
      } else {
        const count = calls.length;
        assert.deepEqual((await (await send('get_task', 'GetTask', { id: originalTask.id })).json()).result, originalTask);
        assert.deepEqual((await (await send('send_message', 'SendMessage', { message })).json()).result.task, originalTask);
        assert.equal(calls.length, count); assert.deepEqual(await records(), originalRecords);
        assert.equal(modelRequests.length, 2); assert.equal(calls.filter(call => call.action === 'SubmitA2AInboundMessage').length, 1);
        const writes = (await readFile(join(root, 'inbound-native-effects.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(writes.length, 1); assert.equal(writes[0].pid, mounts[0].pid); assert.equal(writes[0].callId, 'inbound-write');
        assert.notEqual(mounts[0].pid, mounts.at(-1).pid);
        await writeFile(join(root, 'mounted-inbound-evidence.json'), JSON.stringify({ originalPid: mounts[0].pid, coldPid: mounts.at(-1).pid,
          actualNativeExecution: true, admissions: 1, modelHttp: 2, fileWrites: 1, kernelRunId: accepted.run_id, factIds: [...facts.keys()],
          taskId: originalTask.id, taskState: originalTask.status.state, recordsUnchanged: true, coldAdmissionHttp: 0, coldModelHttp: 0, coldFileWrites: 0,
          limitation: 'Actual maintained Host/packed Studio/signed callback/NativeKernel/SQLite/HTTP model/file tool/Session facts. Server peer, model replies and trusted binding are controlled; no deployed Server interoperability, online/fresh-install/all-entry claim.' }, null, 2));
      }
    },
  };
}
