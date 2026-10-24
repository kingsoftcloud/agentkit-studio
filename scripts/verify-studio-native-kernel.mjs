/** Actual packed Host proof: Gateway -> controlled Server -> signed HTTP
 * command -> NativeKernel -> HTTP model -> file tool -> durable Session facts.
 * The trusted model/tool binding and Server peer are explicit fixtures. */
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { canonical, parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';
import { ingressSigner, targetBinding, platformTaskId, targetVersionId } from '../tests/fixtures/native-a2a-inbound.mjs';
import { permitIssuer, command } from '../tests/fixtures/native-managed-kernel.mjs';

export function createMountedNativeKernelProof(root, { formalBinding = false, structuredInput = false } = {}) {
  const boundTarget = { ...targetBinding };
  const signer = ingressSigner(), issuer = permitIssuer({ target: { tenantId: targetBinding.tenantId, agentInstanceId: targetBinding.agentId } });
  const cmd = command({ tenant_id: targetBinding.tenantId, agent_instance_id: targetBinding.agentId,
    session_id: 'a2a-kernel-mounted-native', payload: { content: 'write the proof and answer' } });
  const message = { messageId: 'native-kernel-inbound-message', parts: [{ text: cmd.payload.content }] };
  const calls = [], facts = new Map(), modelRequests = [];
  let origin, accepted, originalTask, originalRecords, originalOwner, remote, originalLedger, originalFileMtime, originalHistory;
  function formalLedger() {
    const db = new DatabaseSync(join(root, 'studio/native-harness/managed-kernel/runs.sqlite'), { readOnly: true });
    try {
      const row = db.prepare("SELECT key,data FROM native_runs WHERE json_extract(data,'$.snapshot.runId')=?").get(accepted.run_id);
      assert.ok(row, 'formal binding must use the receiver ledger');
      const record = parseNativeJson(row.data);
      record.events = db.prepare('SELECT data FROM native_events WHERE run_key=? ORDER BY seq').all(row.key).map(row => parseNativeJson(row.data));
      record.items = db.prepare('SELECT collection,data FROM native_items WHERE run_key=? ORDER BY collection,item_key').all(row.key);
      return record;
    } finally { db.close(); }
  }
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
      await writeFile(path, JSON.stringify({ executeNative: true, formalBinding, structuredInput, sessionId: cmd.session_id, publicKeyPem: signer.publicKeyPem,
        targetBinding, kernelPublicKeyPem: issuer.publicKeyPem })); return path;
    },
    async handle(request, response, payload, tokens) {
      if (request.url === '/native-inbound-model/chat/completions') {
        assert.equal(request.headers.authorization, 'Bearer controlled-inbound-model'); modelRequests.push(payload);
        assert.ok(modelRequests.length <= 2, 'duplicate inbound model execution');
        const first = modelRequests.length === 1;
        if (structuredInput) {
          const input = payload.messages.find(message => message.role === 'user' && Array.isArray(message.content)
            && message.content.some(part => part.type === 'image_url'));
          assert.ok(input, 'the actual model request must contain the admitted image');
          assert.ok(input.content.some(part => part.type === 'text' && part.text.includes('managed-input.txt')),
            'the same user message must retain the Host file context');
          assert.match(input.content.find(part => part.type === 'image_url').image_url.url, /^data:image\/(?:png|jpeg|webp);base64,/);
        }
        if (!first) assert.ok(payload.messages.some(message => message.role === 'tool'
          && (formalBinding ? message.content.includes('managed-proof.txt') : message.content.includes('Durable proof file written'))));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ usage: { prompt_tokens: first ? 11 : 17,
          completion_tokens: first ? 5 : 7, total_tokens: first ? 16 : 24 },
          choices: [{ index: 0, delta: first ? { tool_calls: [{ index: 0, id: 'inbound-write', type: 'function',
          function: { name: formalBinding ? 'write_workspace_file' : 'write_fixture', arguments: formalBinding
            ? JSON.stringify({ path: 'managed-proof.txt', content: 'Managed formal binding proof\n' }) : '{}' } }] }
          : { content: 'Mounted Native executed answer' }, finish_reason: first ? 'tool_calls' : 'stop' }] })
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
        await writeFile(join(root, 'managed-command-accepted'), accepted.run_id);
        data = { SessionId: cmd.session_id, AgentId: cmd.agent_instance_id, CommandId: cmd.command_id, Receipt: accepted };
      } else for (const fact of payload.Events) {
        assert.equal(fact.run_id, accepted.run_id); assert.equal(fact.event_type, 'control.run_transition');
        if (facts.has(fact.event_id)) assert.equal(facts.get(fact.event_id), canonical(fact)); facts.set(fact.event_id, canonical(fact));
      }
      response.setHeader('content-type', 'application/json'); response.end(canonical({ Code: 0, Data: data })); return true;
    },
    async probe(phase) {
      if (formalBinding) {
        const binding = JSON.parse(await readFile(join(root, 'managed-studio-binding.json'), 'utf8'));
        boundTarget.agentId = binding.agentId; cmd.agent_instance_id = binding.agentId;
      }
      const mounts = (await readFile(join(root, 'mounted-inbound-host.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      origin = mounts.at(-1).origin;
      const send = async (operation, method, params) => {
        const signed = signer.request(operation, { product: true, claims: { target_agent_id: boundTarget.agentId },
          body: canonical({ jsonrpc: '2.0', id: 'native-kernel-proof', method, params }) });
        signed.headers['x-agentengine-route-target'] = boundTarget.agentId;
        const response = await fetch(origin + signed.path, { method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(15000) });
        assert.equal(response.status, 200); return response;
      };
      if (phase === 'before') {
        if (structuredInput) {
          const input = JSON.parse(await readFile(join(root, 'managed-input-upload.json'), 'utf8'));
          for (const parts of [
            [{ type: 'file', receiptId: input.foreignReceiptId }],
            [{ type: 'image', mediaType: 'image/png', data: 'invalid-base64' }],
          ]) {
            const invalid = { ...cmd, command_id: randomUUID(), idempotency_key: randomUUID(),
              payload: { content: { format: 'agentkit.managed-studio-input/v1', parts } } };
            const rejected = await fetch(origin + '/_agentkit/native-kernel/v1/commands', { method: 'POST',
              headers: { 'content-type': 'application/json' }, body: canonical({ command: invalid, permit: issuer.issue(invalid) }),
              signal: AbortSignal.timeout(10000) });
            assert.equal(rejected.status, 400, 'invalid/foreign input must fail before admission');
            assert.equal((await rejected.json()).error.code, 'NATIVE_KERNEL_INVALID_REQUEST');
          }
          assert.equal(modelRequests.length, 0);
          const db = new DatabaseSync(join(root, 'studio/native-harness/managed-kernel/runs.sqlite'), { readOnly: true });
          try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM native_runs').get().n, 0, 'refused input cannot create a Native Run'); }
          finally { db.close(); }
          cmd.payload.content = { format: 'agentkit.managed-studio-input/v1', parts: [
            { type: 'text', text: 'write the proof using the original attachments and answer' },
            { type: 'file', receiptId: input.receiptId },
            { type: 'image', mediaType: 'image/png', data: input.imageData, name: 'managed-input.png' },
          ] };
        }
        const response = await send('send_message', 'SendStreamingMessage', { message });
        const body = await response.text();
        const updates = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        assert.ok(updates.length > 3, body); assert.ok(updates.every(update => !update.error), body);
        assert.equal(updates.at(-1).result.statusUpdate.status.state, 'TASK_STATE_COMPLETED');
        const first = updates[0].result.task;
        originalTask = (await (await send('get_task', 'GetTask', { id: first.id })).json()).result;
        assert.equal(originalTask.status.message.parts[0].text, 'Mounted Native executed answer');
        const deadline = Date.now() + 10000;
        for (;;) {
          originalRecords = await records();
          const task = JSON.parse(Object.entries(originalRecords).find(([key]) => key.startsWith('tasks/'))[1]);
          const owners = (await readFile(join(root, 'managed-session-owner.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
          originalOwner = owners.find(row => row.phase === 'closed' && row.runId === accepted.run_id)?.state;
          if (facts.size === 2 && originalOwner && Object.values(task.productOutbox).every(row => row.state === 'acknowledged')) break;
          assert.ok(Date.now() < deadline, 'actual Native product facts did not drain'); await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(originalOwner.current, null); assert.equal(originalOwner.lastClosed.turn, 1);
        assert.equal(JSON.parse(originalOwner.lastClosed.binding).identity.runId, accepted.run_id);
        if (formalBinding) {
          originalLedger = formalLedger();
          const delivered = JSON.parse(await readFile(join(root, 'managed-session-history.json'), 'utf8'));
          originalHistory = delivered.history;
          const users = originalHistory.filter(event => event.type === 'user/message' && event.data.source.kind === 'user');
          assert.equal(users.length, 1, 'managed input must reach public Session history exactly once');
          assert.deepEqual(users[0].data, originalLedger.configuration.hostRecoveryBinding.messages[0]);
          assert.equal(users[0].data.source.rpcId, cmd.command_id);
          assert.equal(originalHistory.filter(event => event.type === 'tool/result').length, 1);
          assert.deepEqual(originalHistory.filter(event => event.type === 'assistant/message' && event.data.usage)
            .map(event => event.data.usage), [{ inputTokens: 11, outputTokens: 5 }, { inputTokens: 17, outputTokens: 7 }]);
          assert.ok(originalHistory.some(event => event.type === 'assistant/message'
            && event.data.message.content.some(part => part.type === 'text' && part.text === 'Mounted Native executed answer')));
          if (structuredInput) {
            assert.equal(delivered.receiptAvailable, false, 'durable admission must retire staged receipts in the live Host');
            const input = originalLedger.configuration.inputMessages[0];
            assert.ok(input.content.includes('managed-input.txt'));
            assert.equal(input.media.length, 1);
            const image = modelRequests[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
              .find(part => part.type === 'image_url');
            assert.equal(input.media[0].image_url.url, image.image_url.url);
            const parts = originalLedger.configuration.hostRecoveryBinding.messages[0].content;
            assert.deepEqual(parts.map(part => part.type), ['text', 'file', 'image']);
            assert.ok(parts.slice(1).every(part => typeof part.attachment?.attachmentId === 'string'));
          }
          assert.equal(originalLedger.snapshot.phase, 'completed');
          assert.equal(originalLedger.snapshot.scope.agentId, boundTarget.agentId);
          assert.equal(originalLedger.configuration.hostRecoveryBinding.agentId, boundTarget.agentId);
          assert.equal(originalLedger.events.filter(event => event.kind === 'tool.completed'
            && event.payload.callId === 'inbound-write' && event.payload.status === 'ok').length, 1);
          assert.equal(originalLedger.events.filter(event => event.kind === 'model.completed').length, 2);
          originalFileMtime = (await stat(join(root, 'workspace/managed-proof.txt'), { bigint: true })).mtimeNs;
        }
      } else {
        const count = calls.length;
        assert.deepEqual((await (await send('get_task', 'GetTask', { id: originalTask.id })).json()).result, originalTask);
        assert.deepEqual((await (await send('send_message', 'SendMessage', { message })).json()).result.task, originalTask);
        assert.equal(calls.length, count); assert.deepEqual(await records(), originalRecords);
        assert.equal(modelRequests.length, 2); assert.equal(calls.filter(call => call.action === 'SubmitA2AInboundMessage').length, 1);
        if (formalBinding) {
          const coldHistory = JSON.parse(await readFile(join(root, 'managed-session-history-cold.json'), 'utf8'));
          assert.deepEqual(coldHistory.slice(0, originalHistory.length), originalHistory,
            'cold Session must preserve every original managed event byte-for-byte');
          assert.deepEqual(coldHistory.slice(originalHistory.length).map(({ type, seq, data }) => ({ type, seq, data })),
            [{ type: 'session/end-seed', seq: originalHistory.at(-1).seq + 1, data: {} }],
            'only the SDK restore seed boundary may be appended; no duplicate user/model/tool/usage events');
          if (structuredInput) {
            const restored = JSON.parse(await readFile(join(root, 'managed-input-cold.json'), 'utf8'));
            assert.equal(restored.pid, mounts.at(-1).pid);
            assert.equal(restored.receiptAvailable, false, 'cold Host must not retain the original upload receipt');
          }
          assert.equal(await readFile(join(root, 'workspace/managed-proof.txt'), 'utf8'), 'Managed formal binding proof\n');
          assert.equal((await stat(join(root, 'workspace/managed-proof.txt'), { bigint: true })).mtimeNs, originalFileMtime);
          assert.deepEqual(formalLedger(), originalLedger, 'cold Host must not alter the original managed Native ledger');
        }
        else {
          const writes = (await readFile(join(root, 'inbound-native-effects.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
          assert.equal(writes.length, 1); assert.equal(writes[0].pid, mounts[0].pid); assert.equal(writes[0].callId, 'inbound-write');
        }
        assert.notEqual(mounts[0].pid, mounts.at(-1).pid);
        const owners = (await readFile(join(root, 'managed-session-owner.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(owners.filter(row => row.phase === 'closed').length, 1);
        assert.deepEqual(owners.find(row => row.phase === 'loaded' && row.pid === mounts.at(-1).pid).state, originalOwner);
        await writeFile(join(root, 'mounted-inbound-evidence.json'), JSON.stringify({ originalPid: mounts[0].pid, coldPid: mounts.at(-1).pid,
          actualNativeExecution: true, actualSessionOwnership: true, formalStudioBinding: formalBinding, ownerUnchangedAfterRestart: true,
          structuredInput, ...(formalBinding ? { publicHistory: { user: 1, toolResults: 1, modelUsage: 2,
            coldUnchanged: true, restoreBoundary: 'session/end-seed' } } : {}),
          ...(structuredInput ? { input: { hostFileReceipt: true, actualImageAdmission: true, liveReceiptRetired: true,
            modelMedia: true, persistedInput: true, coldReceiptExpired: true,
            foreignSessionReceiptRejected: true, invalidImageRejected: true } } : {}),
          ownerEngine: originalOwner.lastClosed.engine, ownerTurn: originalOwner.lastClosed.turn,
          admissions: 1, modelHttp: 2, fileWrites: 1, kernelRunId: accepted.run_id, factIds: [...facts.keys()],
          taskId: originalTask.id, taskState: originalTask.status.state, recordsUnchanged: true, coldAdmissionHttp: 0, coldModelHttp: 0, coldFileWrites: 0,
          limitation: formalBinding
            ? 'Actual maintained Host/packed Studio/shared formal Studio assembler/preset/Node workspace tool/Session lifecycle. Server peer/model responses controlled; no deployed Server interoperability, all resources or fresh-install claim.'
            : 'Actual maintained Host/packed Studio/signed callback/NativeKernel/SQLite/HTTP model/file tool/Session facts. Server peer, model replies and trusted binding are controlled; no deployed Server interoperability, online/fresh-install/all-entry claim.' }, null, 2));
      }
    },
  };
}
