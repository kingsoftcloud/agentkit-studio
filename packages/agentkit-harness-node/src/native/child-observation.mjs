import { canonical } from '@kingsoftcloud/agentkit-harness-core';

const key = value => canonical({ scope: value.scope, runId: value.runId });
const clip = (value, limit = 16000) => {
  const text = typeof value === 'string' ? value : canonical(value ?? null);
  return { text: text.slice(0, limit), omittedChars: Math.max(0, text.length - limit) };
};

/** Latest observed read/search activity, without results or execution authority. */
export function nativeChildActivity(record) {
  const names = new Set(['read_workspace_file', 'list_workspace_files', 'search_workspace_files']);
  const intent = (record.intents ?? []).findLast(row => row.kind === 'tool' && row.payload.calls?.some(call => names.has(call.name)));
  const calls = intent?.payload.calls ?? [], index = calls.findLastIndex(call => names.has(call.name)), call = calls[index];
  if (!call) return null;
  const receipt = (record.receipts ?? []).find(row => row.operationKey === intent.operationKey && row.status === 'committed');
  const result = receipt?.result.results?.[index];
  const running = !receipt && record.snapshot.pendingIntent === intent.operationKey && record.snapshot.phase === 'executing_tools'
    && record.lease?.expiresAt > Date.now();
  return { name: call.name, input: Object.fromEntries(['path', 'directory', 'pattern', 'query'].flatMap(key =>
    typeof call.arguments?.[key] === 'string' ? [[key, call.arguments[key].slice(0, 512)]] : [])),
    status: { ok: 'completed', error: 'failed', uncertain: 'uncertain', approval_required: 'waiting' }[result?.status]
      ?? (running ? 'running' : 'scheduled') };
}

/** Ephemeral provider text only. It grants no execution, receipt or recovery authority. */
export function createNativeChildObservationCache({ maxRuns = 32, maxChars = 65536, now = Date.now } = {}) {
  const entries = new Map();
  return {
    accept(context, record) {
      try {
        if (context.signal?.aborted || !['text', 'thinking'].includes(record.event?.kind)) return;
        const id = key(context), previous = entries.get(id);
        const entry = previous?.operationKey === context.operationKey && previous.fence === context.executionFence
          ? previous : { operationKey: context.operationKey, fence: context.executionFence, text: '', thinking: '', textOmitted: 0, thinkingOmitted: 0 };
        const field = record.event.kind === 'thinking' ? 'thinking' : 'text';
        const delta = record.event.text;
        if (typeof delta !== 'string') return;
        const available = Math.max(0, maxChars - entry[field].length);
        entry[field] += delta.slice(0, available); entry[field + "Omitted"] += Math.max(0, delta.length - available); entry.time = now();
        entries.delete(id); entries.set(id, entry);
        while (entries.size > maxRuns) entries.delete(entries.keys().next().value);
      } catch { /* presentation cannot interrupt model execution */ }
    },
    read(record) {
      const entry = entries.get(key(record.snapshot));
      if (!entry || entry.operationKey !== record.snapshot.pendingIntent || entry.fence !== record.fence
        || record.snapshot.phase !== 'requesting_model' || !record.lease || record.lease.expiresAt <= now()
        || record.receipts.some(receipt => receipt.operationKey === entry.operationKey)) return null;
      return { operationKey: entry.operationKey, text: entry.text,
        thinking: record.configuration.profile.providerThinkingDisplayPolicy === 'provider-visible/v1' ? entry.thinking : '',
        omittedChars: entry.textOmitted + (record.configuration.profile.providerThinkingDisplayPolicy === 'provider-visible/v1' ? entry.thinkingOmitted : 0) };
    },
    clear() { entries.clear(); },
  };
}

/** Bounded child-only public observations. System context and replay data never leave this view. */
export function nativeChildObservation(record, live = null) {
  const { snapshot, configuration } = record;
  const reasoning = new Map();
  if (configuration.profile.providerThinkingDisplayPolicy === 'provider-visible/v1')
    for (const event of record.events ?? []) if (event.kind === 'model.completed' && Number.isSafeInteger(event.payload.messageIndex)
      && snapshot.messages[event.payload.messageIndex]?.role === 'assistant'
      && snapshot.messages[event.payload.messageIndex]?.content === event.payload.text) {
      const text = (event.payload.displayStream?.records ?? []).filter(row => row.event?.kind === 'thinking').map(row => row.event.text).join('');
      if (text) reasoning.set(event.payload.messageIndex, clip(text));
    }
  const results = new Map();
  for (const receipt of record.receipts) {
    if (receipt.status !== 'committed') continue;
    const intent = record.intents.find(intent => intent.operationKey === receipt.operationKey);
    const pairs = intent?.kind === 'tool' ? (intent.payload.calls ?? []).map((call, i) => [call.callId, receipt.result.results?.[i]])
      : ['tool_receipt', 'workspace_repair'].includes(intent?.kind) ? [[intent.payload.callId, receipt.result.result]] : [];
    for (const [id, result] of pairs) if (result) results.set(id, result);
  }
  const rows = [];
  snapshot.messages.forEach((message, index) => {
    if (message.history || message.role === 'system' || message.kind === 'compaction_summary') return;
    if (message.role === 'assistant') {
      if (reasoning.has(index)) rows.push({ id: `thought:${index}`, kind: 'thought', ...reasoning.get(index) });
      if (message.content) rows.push({ id: `text:${index}`, kind: 'text', ...clip(message.content) });
      for (const call of message.toolCalls ?? []) rows.push({ id: call.callId, kind: 'tool', name: call.name,
        input: clip(call.arguments), status: 'scheduled' });
    } else if (message.role === 'tool') {
      const call = rows.find(row => row.kind === 'tool' && row.id === message.callId);
      if (call) {
        const result = results.get(message.callId);
        call.status = { ok: 'completed', error: 'failed', uncertain: 'uncertain', approval_required: 'waiting' }[result?.status] ?? 'interrupted';
        call.result = clip(message.content);
        if (result?.status === 'ok' && result.metadata?.nativeTaskDisplay?.contract === 'agentkit.workspace-display/v1')
          call.display = result.metadata.nativeTaskDisplay.display;
      }
    }
  });
  const selected = rows.slice(-120);
  return { contract: 'agentkit.native-child-observation/v1', runId: snapshot.runId, sessionId: snapshot.sessionId,
    workspaceView: configuration.hostRecoveryBinding?.childWorkspace ? 'isolated' : 'parent',
    snapshotRevision: snapshot.revision, prompt: clip(snapshot.goal), driving: Boolean(record.lease && record.lease.expiresAt > Date.now()), phase: snapshot.phase, outcome: snapshot.outcome, totalRows: rows.length,
    omittedRows: Math.max(0, rows.length - selected.length), rows: selected, live };
}
