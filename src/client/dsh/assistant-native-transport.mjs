/** Public Connection RPC carrier. Only cloud receipts enter its recovery journal. */
import { ASSISTANT_ATTACHMENT_LIMITS, assistantAttachmentContent, assistantAttachmentReceipt, assistantStoredRequest } from '../state/assistant-attachments.mjs';
const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const errorResult = error => ({ ok: false, error: { code: ['ASSISTANT_ATTACHMENT_EXPIRED', 'ASSISTANT_REQUEST_CONFLICT', 'ASSISTANT_PERSISTENCE_UNAVAILABLE'].includes(error?.code) ? error.code : 'gateway/invocation-unavailable', message: error?.message || '云端连接暂不可用', details: {} } });
const encodedSize = data => typeof data === 'string' && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data) ? data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) : -1;
const digest = async (crypto, value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export async function createAssistantNativeTransport({ execute, agentId, conversation = 'personal', storage, crypto, onChange = () => {} }) {
  const opened = await execute(agentId, 'native-open', { conversation });
  if (!validId(opened?.carrierId) || !validId(opened.sessionId) || opened.representation !== 'assistant-public-projection/v1'
    || opened.capabilities?.owner !== false || opened.capabilities?.durableSubmit !== true
    || !/^[a-f0-9]{64}$/.test(opened.journalScope || '')) {
    if (validId(opened?.carrierId)) await execute(agentId, 'native-close', { conversation, carrierId: opened.carrierId }).catch(() => {});
    throw fail('云端原生输入契约不完整，请更新运行环境');
  }
  const { carrierId, sessionId, journalScope } = opened, key = `agentkit.assistant.native.pending.${journalScope}.${encodeURIComponent(sessionId)}`;
  let closed = false, operation = null, state = { pending: null, error: '', busy: false, invalid: false };
  const streams = new Map(), receipts = new Map(), listeners = new Set();
  const emit = patch => { state = { ...state, ...patch }; onChange(state); for (const listener of listeners) listener(); };
  function records() {
    if (typeof storage.key !== 'function' || !Number.isSafeInteger(storage.length)) throw fail('此浏览器无法安全恢复待提交记录');
    const keys = new Set([key]);
    for (let index = 0; index < storage.length; index++) { const item = storage.key(index); if (typeof item === 'string' && item.startsWith(key + '.')) keys.add(item); }
    const found = [];
    for (const item of keys) {
      const raw = storage.getItem(item); if (raw === null) continue;
      const value = JSON.parse(raw), request = assistantStoredRequest(value?.request);
      if (value?.scope !== journalScope || !/^[a-f0-9]{64}$/.test(value?.sourceFingerprint || '') || !request
        || item !== key && item !== `${key}.${request.requestId}`) throw fail('待提交记录无法读取，已暂停发送以避免重复执行');
      found.push({ key: item, record: { scope: journalScope, sourceFingerprint: value.sourceFingerprint, request } });
    }
    const identities = new Map();
    for (const item of found) { const id = item.record.request.requestId, identity = JSON.stringify(item.record); if (identities.has(id) && identities.get(id) !== identity) throw fail('同一请求的恢复记录发生冲突，已暂停发送'); identities.set(id, identity); }
    return found.sort((left, right) => left.record.request.requestId.localeCompare(right.record.request.requestId));
  }
  const read = requestId => records().find(item => !requestId || item.record.request.requestId === requestId)?.record || null;
  try { emit({ pending: read() }); } catch (error) { emit({ invalid: true, error: error.message }); }
  const invoke = (operation, input, signal) => execute(agentId, operation, { conversation, carrierId, ...input }, signal);
  const upload = async (part, signal) => {
    if (closed) throw fail('此助理连接已释放');
    const result = assistantAttachmentReceipt(await execute(agentId, 'attachment-upload', { ...part, conversation }, signal));
    if (!result || result.kind !== part.kind || part.kind === 'image' && result.mediaType !== part.mediaType) throw fail('云端附件回执无法识别');
    receipts.set(result.receiptId, result); return result;
  };
  const send = async record => {
    // No view signal on durable admission. Closing a tab cannot cancel cloud work.
    const request = record.request;
    const result = await invoke('native-call', { channel: '/api', endpoint: 'session/prompt', payload: { args: { request: {
      sessionId, requestId: request.requestId, mode: 'queue', content: request.content,
      ...(request.timezone ? { clientTimeZone: request.timezone } : {}),
    } } } });
    if (result?.ok !== true || result.value?.accepted !== true) throw fail(result?.error?.message || '提交结果尚未确认，确认提交会复用同一标识', result?.error?.code);
    for (const saved of records().filter(item => item.record.request.requestId === request.requestId)) {
      if (saved.record.sourceFingerprint !== record.sourceFingerprint) throw fail('待提交记录已变化，请重新检查', 'ASSISTANT_REQUEST_CONFLICT');
      storage.removeItem(saved.key);
    }
    emit({ pending: read(), error: '' }); return result;
  };
  async function prompt(input) {
    if (input?.sessionId !== sessionId || input.mode !== 'queue' || !validId(input.requestId) || input.requestId.length > 96
      || !Array.isArray(input.content) || !input.content.length || input.content.length > ASSISTANT_ATTACHMENT_LIMITS.maxAttachments + 1) throw fail('当前云端只支持排队发送');
    if (state.invalid) throw fail(state.error);
    let textLength = 0, attachmentBytes = 0, attachmentCount = 0;
    for (const part of input.content) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) textLength += part.text.length;
      else if (part?.type === 'image') {
        if (typeof part.data !== 'string' || part.data.length > Math.ceil(ASSISTANT_ATTACHMENT_LIMITS.maxAttachmentBytes / 3) * 4) throw fail('附件大小超出限制');
        const bytes = encodedSize(part.data);
        if (bytes <= 0 || bytes > ASSISTANT_ATTACHMENT_LIMITS.maxAttachmentBytes || !/^image\/(png|jpeg|webp|gif)$/.test(part.mediaType || '')) throw fail('图片格式无法识别');
        attachmentBytes += bytes; attachmentCount++;
      } else if (part?.type === 'file' && validId(part.receiptId)) {
        attachmentBytes += receipts.get(part.receiptId)?.attachment.bytes || 0; attachmentCount++;
      } else throw fail('输入含不支持的附件');
    }
    if (textLength > ASSISTANT_ATTACHMENT_LIMITS.maxTextLength || attachmentBytes > ASSISTANT_ATTACHMENT_LIMITS.maxMessageAttachmentBytes || attachmentCount > ASSISTANT_ATTACHMENT_LIMITS.maxAttachments) throw fail('消息大小或附件数量超出限制');
    const sourceFingerprint = await digest(crypto, { content: input.content, timezone: input.clientTimeZone || '' });
    const existing = state.pending || read();
    if (existing) emit({ pending: existing });
    if (existing && (existing.request.requestId !== input.requestId || existing.sourceFingerprint !== sourceFingerprint)) throw fail('请先确认上一条消息，避免重复执行');
    if (existing) { emit({ pending: existing }); return send(existing); }
    const content = [], attachments = [];
    for (const part of input.content) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() && part.text.length <= 32000) content.push({ type: 'text', text: part.text });
      else if (part?.type === 'file' && validId(part.receiptId)) {
        content.push({ type: 'file', receiptId: part.receiptId });
        const receipt = receipts.get(part.receiptId); if (!receipt) throw fail('附件回执不属于当前输入，请重新选择');
        attachments.push(receipt);
      } else if (part?.type === 'image' && /^image\/(png|jpeg|webp|gif)$/.test(part.mediaType || '') && typeof part.data === 'string') {
        const receipt = await upload({ kind: 'image', mediaType: part.mediaType, name: part.name || '图片', data: part.data });
        attachments.push(receipt); content.push(...assistantAttachmentContent([receipt]));
      } else throw fail('输入含不支持的附件');
    }
    const request = assistantStoredRequest({ requestId: input.requestId, content, attachments, ...(input.clientTimeZone ? { timezone: input.clientTimeZone } : {}) });
    if (!request) throw fail('消息格式无法识别');
    const record = { scope: journalScope, sourceFingerprint, request };
    // Persist before admission. No input data/base64 is copied to this record.
    if (closed) throw fail('此助理连接已释放，请重新连接后再发送');
    storage.setItem(`${key}.${request.requestId}`, JSON.stringify(record)); emit({ pending: record });
    return send(record);
  }
  async function exclusive(work) {
    if (operation) throw fail('上一条消息仍在提交');
    emit({ busy: true, error: '' });
    operation = Promise.resolve().then(work);
    try { return await operation; }
    catch (error) { emit({ error: error.message, errorCode: error.code }); throw error; }
    finally { operation = null; emit({ busy: false }); }
  }
  const rpc = {
    async call(channel, endpoint, payload, signal) {
      if (closed || channel !== '/api') return errorResult(fail('此连接不可用'));
      try {
        if (endpoint === 'session/prompt') return await exclusive(() => prompt(payload?.args?.request));
        if (endpoint === 'fileUploads/upload') {
          const args = payload?.args;
          if ((args?.agent ?? args?.agentId) !== sessionId) throw fail('附件不属于当前云端会话');
          const receipt = await upload({ kind: 'file', name: args.request?.name || '附件', data: args.request?.data }, signal);
          return { ok: true, value: { receiptId: receipt.receiptId, file: receipt.attachment } };
        }
        return await invoke('native-call', { channel, endpoint, payload }, signal);
      } catch (error) { return errorResult(error); }
    },
    async *open(channel, endpoint, payload, signal, _uplink) {
      if (closed || channel !== '/api' || !['$events', 'session/control', 'session/follow', 'remoteAccess/follow'].includes(endpoint)) throw fail('此连接不支持该数据通道');
      const streamId = crypto.randomUUID(), controller = new AbortController();
      streams.set(streamId, controller);
      const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      try {
        await invoke('native-stream-open', { streamId, endpoint, payload }, combined);
        while (!closed && !combined.aborted) {
          const page = await invoke('native-stream-poll', { streamId }, combined);
          if (!Array.isArray(page?.items) || page.items.length > 32) throw fail('云端数据流格式无法识别');
          if (state.readError && !state.disconnected) emit({ readError: '' });
          for (const item of page.items) { if (closed || combined.aborted) return; yield item; }
          if (page.error) throw fail(page.error.message || '云端数据流中断', page.error.code);
          if (page.ended) return;
        }
      } catch (error) {
        if (!closed && !combined.aborted) {
          const oversized = ['ASSISTANT_NATIVE_RESPONSE_TOO_LARGE', 'ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE'].includes(error?.code);
          const terminal = oversized || /STALE|FORBIDDEN|INVALID/.test(error?.code || '') || String(error?.code || '').startsWith('gateway/');
          emit({ readError: oversized ? '会话包含超出展示上限的结构，云端原始记录未改动，请使用已有历史视图。' : terminal ? '云端输入连接已失效，请重新连接。' : '云端输入暂时断开，正在重连…', ...(terminal ? { disconnected: true } : {}) });
          error.dshRemoteStreamFailure = terminal ? { kind: 'remote', code: 'gateway/invocation-unavailable', details: {} } : { kind: 'carrier' };
        }
        throw error;
      } finally { streams.delete(streamId); await invoke('native-stream-cancel', { streamId }).catch(() => {}); }
    },
  };
  return { rpc, sessionId, capabilities: opened.capabilities, getState: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async matchesPending(content) { const saved = state.pending; return Boolean(saved && saved.sourceFingerprint === await digest(crypto, { content, timezone: saved.request.timezone || '' })); },
    discardExpired() { if (state.errorCode !== 'ASSISTANT_ATTACHMENT_EXPIRED' || operation || !state.pending) return false; for (const saved of records().filter(item => item.record.request.requestId === state.pending.request.requestId && item.record.sourceFingerprint === state.pending.sourceFingerprint)) storage.removeItem(saved.key); emit({ pending: read(), error: '', errorCode: null }); return true; },
    async confirm() { if (closed || state.invalid) return false; const record = state.pending || read(); if (!record) return false; try { await exclusive(() => send(record)); return true; } catch { return false; } },
    async dispose() { if (closed) return; closed = true; for (const controller of streams.values()) controller.abort(); streams.clear(); await invoke('native-close', {}).catch(() => {}); },
  };
}
