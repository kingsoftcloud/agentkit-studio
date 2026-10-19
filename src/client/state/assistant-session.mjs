/** Client ownership only. Disconnecting invalidates reads; it never cancels cloud work. */
import { ASSISTANT_ATTACHMENT_LIMITS, assistantAttachmentContent, assistantAttachmentName, assistantAttachmentReceipt, assistantRequestText, assistantStoredRequest, assistantSubmitInput } from './assistant-attachments.mjs';
import { assistantLiveApprovals, assistantApprovalInput, sameAssistantApproval } from './assistant-approvals.mjs';
const attachmentsKey = id => `agentkit.assistant.attachments.${id}`;
const pendingKey = id => `agentkit.assistant.pending.${id}`;
const draftKey = id => `agentkit.assistant.draft.${id}`;
const errorMessage = reason => reason?.message || '连接暂时不可用，请稍后重试。';
const initialState = () => ({ agentId: '', connected: false, view: null, draft: '', attachments: [], attachmentError: '', pending: null, pendingInvalid: false, accepted: [],
  busy: false, busyOperation: null, approvalDecision: null, error: '', errorKind: null, readError: '', notice: '', cancelPhase: null, cancelTarget: null,
  older: [], olderEvents: [], olderCursor: null, olderHasMore: null, loadingOlder: false });
const merge = (rows, key) => [...new Map(rows.map(row => [row[key], row])).values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

export function assistantRetryAvailable(view) {
  const retry = view?.retry;
  return view?.status === 'failed' && view.capabilities?.history?.nativeEvents === true
    && typeof retry?.text === 'string' && Boolean(retry.text.trim())
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(retry.requestId || '')
    && Number.isSafeInteger(retry.turn) && retry.turn >= 0
    && Number.isSafeInteger(retry.endSeq) && retry.endSeq >= 0
    && Number.isSafeInteger(view.asOfSeq) && retry.endSeq <= view.asOfSeq;
}

export function assistantCancelAvailable(view) {
  return view?.status === 'running' && view.capabilities?.execution?.scopedCancel === true
    && Number.isSafeInteger(view.currentTurn) && view.currentTurn >= 0
    && Number.isSafeInteger(view.turnStartSeq) && view.turnStartSeq >= 0;
}

export function assistantTranscript(state) {
  const messages = merge([...state.older, ...(state.view?.messages || [])], 'id');
  const known = new Set(messages.map(row => row.requestId).filter(Boolean));
  return {
    messages: [...messages, ...state.accepted.filter(row => !known.has(row.requestId))],
    view: state.view ? { ...state.view, hasMore: state.olderHasMore ?? state.view.hasMore, events: merge([...state.olderEvents, ...(state.view.events || [])], 'seq') } : null,
  };
}

export function createAssistantSession({ execute, storage, createRequestId, timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  setTimer = setTimeout, clearTimer = clearTimeout, pollInterval = 5000, readAttachment, createUploadId = createRequestId }) {
  let state = initialState(), generation = 0, readSerial = 0, mutationRevision = 0, historyRevision = 0, timer = null, operation = null, historyRead = null;
  const listeners = new Set(), confirmedRequests = new Set(), selectedFiles = new Map(), uploads = new Map();
  const emit = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(state); };
  const read = key => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
  const context = () => ({ agentId: state.agentId, generation });
  const current = owner => state.connected && owner.generation === generation && owner.agentId === state.agentId;
  const clearPoll = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = owner => { if (!current(owner)) return; clearPoll(); timer = setTimer(() => { timer = null; void refresh(); }, pollInterval); };
  const pendingRecord = id => {
    try {
      const raw = storage.getItem(pendingKey(id));
      if (raw === null) return { request: null, invalid: false };
      const request = assistantStoredRequest(JSON.parse(raw));
      return { request, invalid: !request };
    } catch { return { request: null, invalid: true }; }
  };
  const invalidJournal = () => ({ pendingInvalid: true, errorKind: 'journal', error: '本机待提交记录无法读取，已暂停发送以避免重复执行。请检查本机存储后重新连接。' });
  const storedAttachments = id => {
    const values = read(attachmentsKey(id));
    return (Array.isArray(values) ? values : []).slice(0, ASSISTANT_ATTACHMENT_LIMITS.maxAttachments).map(assistantAttachmentReceipt).filter(Boolean)
      .map(value => ({ ...value, id: value.receiptId, name: value.attachment.name, bytes: value.attachment.bytes, status: 'ready' }));
  };
  const rememberAttachments = (attachments = state.attachments) => {
    try { storage.setItem(attachmentsKey(state.agentId), JSON.stringify(attachments.filter(row => row.status === 'ready').map(assistantAttachmentReceipt).filter(Boolean))); return true; }
    catch { emit({ attachmentError: '附件回执暂时无法保存在本机，请发送前不要离开。' }); return false; }
  };
  const clearPending = request => {
    try {
      const record = pendingRecord(state.agentId);
      if (record.invalid) { emit(invalidJournal()); return false; }
      const saved = record.request;
      if (!saved || saved.requestId === request.requestId) storage.removeItem(pendingKey(state.agentId));
      return true;
    } catch { emit({ errorKind: 'storage', error: '本机提交记录未能清理，请刷新后核对；重试仍会使用同一标识。' }); return false; }
  };
  const received = (snapshot, requestId) => snapshot.messages?.some(row => row.requestId === requestId)
    || snapshot.receipt?.accepted === true && snapshot.receipt.requestId === requestId;
  const rememberDraft = value => {
    try { storage.setItem(draftKey(state.agentId), JSON.stringify(value)); return true; }
    catch { return false; }
  };
  const acknowledge = request => {
    confirmedRequests.add(request.requestId);
    const sameDraft = state.draft.trim() === assistantRequestText(request).trim();
    const sentReceipts = new Set((request.content || []).map(part => part.receiptId).filter(Boolean));
    const retained = state.attachments.filter(row => !sentReceipts.has(row.receiptId));
    if (!rememberAttachments(retained) || sameDraft && !rememberDraft('')) {
      emit({ errorKind: 'storage', error: '云端已收到消息，但本机草稿未能清理。重试仍会使用同一标识。' });
      return false;
    }
    if (!clearPending(request)) return false;
    for (const row of state.attachments) if (sentReceipts.has(row.receiptId)) selectedFiles.delete(row.id);
    emit({ attachments: retained, pending: state.pending?.requestId === request.requestId ? null : state.pending,
      ...(sameDraft ? { draft: '' } : {}) });
    return true;
  };
  async function refresh() {
    if (!state.connected || !state.agentId) return;
    const owner = context(), serial = ++readSerial, revision = mutationRevision;
    clearPoll();
    const record = pendingRecord(owner.agentId);
    if (record.invalid) emit(invalidJournal());
    else if (state.pendingInvalid) emit({ pendingInvalid: false, ...(state.errorKind === 'journal' ? { errorKind: null, error: '' } : {}) });
    const pending = state.pending || record.request, receiptRequest = pending || state.accepted[0];
    try {
      const snapshot = await execute(owner.agentId, 'snapshot', receiptRequest ? { requestId: receiptRequest.requestId } : {});
      if (!current(owner) || serial !== readSerial || revision !== mutationRevision) return;
      if (!snapshot || !Array.isArray(snapshot.messages)) throw new Error('云端会话格式无法识别，请重新连接。');
      if (Number.isSafeInteger(state.view?.asOfSeq) && Number.isSafeInteger(snapshot.asOfSeq) && snapshot.asOfSeq < state.view.asOfSeq) return;
      const previous = state.view;
      const gap = Number.isSafeInteger(snapshot.beforeSeq) && Number.isSafeInteger(previous?.asOfSeq) && snapshot.beforeSeq > previous.asOfSeq + 1;
      const resetCursor = !previous || state.olderCursor === null || gap;
      const patch = { view: snapshot, readError: '', accepted: state.accepted.filter(row => !received(snapshot, row.requestId)),
        older: merge([...state.older, ...(previous?.messages || [])], 'id'),
        olderEvents: merge([...state.olderEvents, ...(previous?.events || [])], 'seq') };
      if (resetCursor && Number.isSafeInteger(snapshot.beforeSeq)) {
        historyRevision++;
        patch.olderCursor = snapshot.beforeSeq; patch.olderHasMore = snapshot.hasMore === true;
      }
      const cancelledTurn = state.cancelTarget && snapshot.events?.find(event => event.type === 'turn/end'
        && event.seq > state.cancelTarget.asOfSeq
        && (state.cancelTarget.turn === undefined || event.data?.turn === state.cancelTarget.turn));
      const turnAdvanced = state.cancelTarget?.turn != null && snapshot.currentTurn != null && snapshot.currentTurn !== state.cancelTarget.turn;
      if ((state.cancelPhase || state.errorKind === 'cancel') && (cancelledTurn || turnAdvanced || ['cancelled', 'completed', 'failed', 'idle'].includes(snapshot.status))) {
        patch.cancelPhase = null; patch.cancelTarget = null;
        const outcome = cancelledTurn ? cancelledTurn.data?.reason?.kind === 'aborted' ? 'cancelled' : cancelledTurn.data?.reason?.kind === 'completed' ? 'completed' : 'failed' : turnAdvanced ? 'ended' : snapshot.status;
        const suffix = snapshot.status === 'running' ? '助理正在处理后续任务。' : snapshot.status === 'queued' ? '后续消息仍在排队。' : '';
        if (turnAdvanced && !cancelledTurn) patch.notice = '上一项任务已结束，助理正在处理后续任务。';
        else if (!cancelledTurn && snapshot.capabilities?.history?.nativeEvents) patch.notice = '云端当前没有正在运行的任务。';
        else if (outcome === 'cancelled') patch.notice = suffix ? `上一项任务已停止，${suffix}` : '任务已停止。';
        else if (outcome === 'completed') patch.notice = suffix ? `上一项任务已完成，${suffix}` : '任务已完成。';
        else if (outcome === 'idle') patch.notice = '云端当前没有正在运行的任务。';
        else patch.notice = suffix ? `上一项任务未完成，${suffix}` : '任务已结束，请查看云端状态。';
        // A terminal snapshot resolves a previously unknown cancellation, not a different command's error.
        if (state.errorKind === 'cancel') { patch.error = ''; patch.errorKind = null; }
      }
      if (state.approvalDecision && !assistantLiveApprovals(snapshot).some(row => sameAssistantApproval(row, state.approvalDecision))) {
        patch.approvalDecision = null;
        if (state.errorKind === 'approval') { patch.error = ''; patch.errorKind = null; patch.notice = '该审批已结束，请查看云端后续记录。'; }
      }
      emit(patch);
      if (pending && received(snapshot, pending.requestId)) {
        // Observing the native inbox/log is not a persistence flush watermark.
        // Keep the recovery ID until the idempotent submit returns its durable ACK.
        emit({ pending: { ...pending, observed: true },
          ...(state.cancelPhase || state.errorKind === 'cancel' ? {} : { notice: '消息已出现在云端，请确认提交以核对保存结果。' }) });
      }
    } catch (reason) {
      if (current(owner) && serial === readSerial && revision === mutationRevision) emit({ readError: `暂时无法更新会话，云端任务可能仍在继续。${errorMessage(reason)}` });
    } finally { if (current(owner) && serial === readSerial) schedule(owner); }
  }
  const begin = name => {
    if (!state.connected || operation) return null;
    const owner = { ...context(), name };
    operation = owner; mutationRevision++;
    emit({ busy: true, busyOperation: name, error: '', errorKind: null });
    return owner;
  };
  const owns = owner => current(owner) && operation === owner;
  const finish = owner => {
    if (!owns(owner)) return;
    operation = null; mutationRevision++;
    emit({ busy: false, busyOperation: null });
    void refresh();
  };
  async function submit(retry = false) {
    if (operation || !state.view || !state.connected || state.view.historyState === 'migration-required' || state.view.status === 'migration-required') return false;
    // A lost acknowledgement always reuses its durable journal, even after refresh.
    const record = pendingRecord(state.agentId);
    if (record.invalid) { emit(invalidJournal()); return false; }
    const pending = record.request || state.pending;
    const text = (retry ? assistantRetryAvailable(state.view) ? state.view.retry.text : '' : state.draft)?.trim();
    if (!pending && (retry ? !text : !text && !state.attachments.length || state.attachments.some(row => row.status !== 'ready'))) return false;
    const attachments = !pending && !retry ? state.attachments.map(assistantAttachmentReceipt).filter(Boolean) : [];
    const request = pending || { requestId: createRequestId(), timezone: timezone(), ...(attachments.length || state.view.capabilities?.input?.content === true
      ? { content: [...(text ? [{ type: 'text', text }] : []), ...assistantAttachmentContent(attachments)], ...(attachments.length ? { attachments } : {}) } : { text }) };
    try { storage.setItem(pendingKey(state.agentId), JSON.stringify(request)); }
    catch { emit({ errorKind: 'storage', error: '无法保存提交标识，请检查本机存储后重试。' }); return false; }
    const owner = begin('submit');
    if (!owner) return false;
    emit({ pending: request, pendingInvalid: false, notice: '' });
    try {
      const result = await execute(owner.agentId, 'submit', assistantSubmitInput(request));
      if (!owns(owner)) return false;
      if (confirmedRequests.has(request.requestId)) { acknowledge(request); return true; }
      if (result?.accepted !== true || result.requestId !== request.requestId) {
        emit({ errorKind: 'submit', error: '提交结果尚未确认。请等待会话更新，或重试上一条；不会重复执行。' });
        return false;
      }
      const recorded = received(state.view, request.requestId);
      if (acknowledge(request)) emit({ error: '', errorKind: null, notice: '已收到。你可以随时离开，结果会留在这里。',
        accepted: recorded ? state.accepted : [...state.accepted.filter(row => row.requestId !== request.requestId),
          { id: `client:${request.requestId}`, requestId: request.requestId, role: 'user', source: 'user', text: assistantRequestText(request), ...(request.attachments ? { attachments: request.attachments } : {}), delivery: 'accepted' }] });
      return true;
    } catch (reason) {
      if (owns(owner) && confirmedRequests.has(request.requestId)) { acknowledge(request); return true; }
      if (owns(owner)) emit(reason?.code === 'ASSISTANT_ATTACHMENT_EXPIRED'
        ? { errorKind: 'attachment-expired', error: '附件上传回执已过期，本条消息未提交。请重新选择附件后发送。' }
        : { errorKind: 'submit', error: `提交结果尚未确认。重试上一条会使用同一标识，不会重复执行。${errorMessage(reason)}` });
      return false;
    } finally { finish(owner); }
  }
  const attachmentLimits = () => {
    const supplied = state.view?.capabilities?.input?.limits || {};
    return Object.fromEntries(Object.entries(ASSISTANT_ATTACHMENT_LIMITS).map(([key, limit]) => [key, Number.isSafeInteger(supplied[key]) && supplied[key] > 0 ? Math.min(limit, supplied[key]) : limit]));
  };
  const canUpload = () => state.connected && !operation && !state.pending && state.view?.capabilities?.input?.attachments === true
    && state.view.historyState !== 'migration-required' && state.view.status !== 'migration-required';
  async function uploadAttachment(id) {
    const row = state.attachments.find(value => value.id === id), file = selectedFiles.get(id);
    if (!canUpload() || !row || !file || uploads.has(id) || !readAttachment) return false;
    const owner = { ...context(), controller: new AbortController() };
    uploads.set(id, owner);
    const update = patch => {
      if (!current(owner) || uploads.get(id) !== owner) return false;
      emit({ attachments: state.attachments.map(value => value.id === id ? { ...value, ...patch } : value) });
      return true;
    };
    update({ status: 'reading', progress: 0, error: '' });
    try {
      const data = await readAttachment(file, { signal: owner.controller.signal, onProgress: progress => update({ progress }) });
      if (!update({ status: 'uploading', progress: null })) return false;
      const result = await execute(owner.agentId, 'attachment-upload', { kind: row.kind, name: row.name, ...(row.kind === 'image' ? { mediaType: row.mediaType } : {}), data }, owner.controller.signal);
      if (!current(owner) || uploads.get(id) !== owner) return false;
      const receipt = assistantAttachmentReceipt(result);
      if (!receipt || receipt.kind !== row.kind || receipt.attachment.bytes !== row.bytes || row.kind === 'image' && receipt.mediaType !== row.mediaType) throw new Error('云端附件回执无法识别，请重试上传');
      update({ ...receipt, status: 'ready', progress: null, error: '' });
      rememberAttachments();
      return true;
    } catch (reason) {
      update({ status: 'failed', progress: null, error: errorMessage(reason) });
      return false;
    } finally { if (uploads.get(id) === owner) uploads.delete(id); }
  }
  function addAttachments(files) {
    if (!canUpload() || !readAttachment) return false;
    const limits = attachmentLimits(), input = state.view.capabilities.input, added = [], errors = [];
    const imageTypes = Array.isArray(input.imageMediaTypes) ? input.imageMediaTypes : ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    let count = state.attachments.length, bytes = state.attachments.reduce((sum, row) => sum + row.bytes, 0);
    for (const file of files) {
      const name = assistantAttachmentName(file.name), mediaType = file.type || '', kind = mediaType.startsWith('image/') ? 'image' : 'file';
      if (kind === 'image' && (input.images !== true || !imageTypes.includes(mediaType) || !/^image\/(png|jpeg|webp|gif)$/.test(mediaType))) { errors.push(`${name}：暂不支持这种图片格式`); continue; }
      if (kind === 'file' && input.files !== true) { errors.push('当前云端暂不支持文件上传'); continue; }
      const maxBytes = kind === 'image' && Number.isSafeInteger(input.maxImageBytes) ? Math.min(limits.maxAttachmentBytes, input.maxImageBytes) : limits.maxAttachmentBytes;
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes || kind === 'image' && !file.size) { errors.push(`${name}：附件大小不符合限制`); continue; }
      if (count >= limits.maxAttachments || bytes + file.size > limits.maxMessageAttachmentBytes) { errors.push('附件数量或总大小已达到上限，请移除部分附件'); break; }
      const id = createUploadId(); count++; bytes += file.size;
      selectedFiles.set(id, file);
      added.push({ id, kind, name, bytes: file.size, ...(kind === 'image' ? { mediaType } : {}), status: 'reading', progress: 0 });
    }
    emit({ attachments: [...state.attachments, ...added], attachmentError: errors.join('；') });
    for (const row of added) void uploadAttachment(row.id);
    return added.length > 0;
  }
  function replaceExpiredAttachments() {
    const request = state.pending;
    if (operation || state.errorKind !== 'attachment-expired' || !request || !clearPending(request)) return false;
    selectedFiles.clear();
    emit({ pending: null, attachments: [], draft: state.draft || assistantRequestText(request), error: '', errorKind: null, attachmentError: '', notice: '请重新选择附件后发送。' });
    rememberAttachments(); rememberDraft(state.draft);
    return true;
  }
  function cancelUpload(id, remove = false) {
    if (state.pending || operation?.name === 'submit') return false;
    const owner = uploads.get(id); uploads.delete(id); owner?.controller.abort();
    if (remove) { selectedFiles.delete(id); emit({ attachments: state.attachments.filter(row => row.id !== id) }); rememberAttachments(); }
    else emit({ attachments: state.attachments.map(row => row.id === id && ['reading', 'uploading'].includes(row.status) ? { ...row, status: 'cancelled', progress: null, error: '上传已取消，尚未发送给助理' } : row) });
    return true;
  }
  async function decideApproval(request, decision) {
    const live = assistantLiveApprovals(state.view).find(row => sameAssistantApproval(row, request));
    if (operation || !live || !['allowed-once', 'rejected'].includes(decision) || !live.choices.includes(decision)
      || decision === 'allowed-once' && live.canAllow !== true
      || sameAssistantApproval(live, state.approvalDecision) && state.approvalDecision.phase === 'accepted') return false;
    const owner = begin('approval');
    if (!owner) return false;
    const input = assistantApprovalInput(live, decision);
    emit({ approvalDecision: { ...input, phase: 'requesting' }, notice: '' });
    try {
      const result = await execute(owner.agentId, 'approval-decide', input);
      if (!owns(owner)) return false;
      if (result?.accepted === true && result.outcome === decision) {
        const stillLive = assistantLiveApprovals(state.view).some(row => sameAssistantApproval(row, input));
        emit({ approvalDecision: stillLive ? { ...input, phase: 'accepted' } : null, notice: '审批决定已送达。执行结果请查看云端后续记录。' });
        return true;
      }
      emit({ approvalDecision: { ...input, phase: 'stale' }, errorKind: 'approval', error: '审批已失效，未对其他操作授权。请刷新查看最新请求。' });
      return false;
    } catch (reason) {
      if (owns(owner)) emit({ approvalDecision: { ...input, phase: 'unknown' }, errorKind: 'approval', error: `审批结果尚未确认，请刷新核对当前请求。${errorMessage(reason)}` });
      return false;
    } finally { finish(owner); }
  }
  async function cancel(confirm = async () => true) {
    if (operation || !assistantCancelAvailable(state.view) || state.cancelPhase === 'stopping') return false;
    const start = state.view?.events?.findLast(event => event.type === 'turn/start');
    const target = { asOfSeq: state.view?.asOfSeq ?? -1, startSeq: state.view?.turnStartSeq ?? start?.seq, turn: state.view?.currentTurn ?? start?.data?.turn };
    const owner = begin('cancel');
    if (!owner) return false;
    try {
      if (!await confirm() || !owns(owner)) return false;
      const latestStart = state.view?.events?.findLast(event => event.type === 'turn/start');
      if (state.view?.status !== 'running' || target.turn != null && state.view?.currentTurn != null && target.turn !== state.view.currentTurn
        || latestStart && target.startSeq !== undefined && latestStart.seq !== target.startSeq) {
        emit({ notice: '任务状态已变化，请核对后重新停止。' }); return false;
      }
      emit({ cancelPhase: 'requesting', cancelTarget: target, notice: '正在发送停止请求…' });
      const result = await execute(owner.agentId, 'cancel-turn', { turn: target.turn, turnStartSeq: target.startSeq });
      if (!owns(owner)) return false;
      if (!state.cancelTarget || ['cancelled', 'completed', 'failed', 'idle'].includes(state.view?.status)) return result?.accepted === true;
      if (result?.accepted !== true) {
        emit({ cancelPhase: null, cancelTarget: null, notice: '', errorKind: 'cancel', error: result?.reason === 'turn-changed' ? '任务状态已变化，未停止其他任务。请刷新核对后重试。' : '云端未接受停止请求，任务可能仍在运行。请刷新核对后重试。' });
        return false;
      }
      emit({ cancelPhase: 'stopping', notice: '已收到停止请求，正在等待云端确认。' });
      return true;
    } catch (reason) {
      if (owns(owner) && (!state.cancelTarget || ['cancelled', 'completed', 'failed', 'idle'].includes(state.view?.status))) return false;
      if (owns(owner)) emit({ cancelPhase: 'unknown', notice: '', errorKind: 'cancel', error: `停止结果尚未确认，任务可能仍在运行。请核对状态后重试。${errorMessage(reason)}` });
      return false;
    } finally { finish(owner); }
  }
  async function loadOlder() {
    if (!state.connected || historyRead || !state.view || !(state.olderHasMore ?? state.view.hasMore)) return false;
    const beforeSeq = state.olderCursor ?? state.view.beforeSeq;
    if (!Number.isSafeInteger(beforeSeq)) return false;
    const owner = { ...context(), historyRevision }; historyRead = owner; emit({ loadingOlder: true });
    try {
      const result = await execute(owner.agentId, 'snapshot', { beforeSeq });
      if (!current(owner) || historyRead !== owner) return false;
      emit({ older: merge([...(result.messages || []), ...state.older], 'id'), olderEvents: merge([...(result.events || []), ...state.olderEvents], 'seq'),
        ...(owner.historyRevision === historyRevision ? { olderCursor: result.beforeSeq, olderHasMore: result.hasMore === true } : {}) });
      return true;
    } catch (reason) { if (current(owner) && historyRead === owner) emit({ errorKind: 'history', error: errorMessage(reason) }); return false; }
    finally { if (current(owner) && historyRead === owner) { historyRead = null; emit({ loadingOlder: false }); } }
  }
  function disconnect() {
    generation++; readSerial++; clearPoll(); operation = null; historyRead = null;
    for (const upload of uploads.values()) upload.controller.abort();
    uploads.clear(); selectedFiles.clear();
    emit({ connected: false, busy: false, busyOperation: null, loadingOlder: false });
    // Deliberately no cancel, abort of a mutation, or cleanup of its durable journal.
  }
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    connect(agentId) {
      disconnect(); confirmedRequests.clear();
      const draft = agentId ? read(draftKey(agentId)) : '';
      const record = agentId ? pendingRecord(agentId) : { request: null, invalid: false };
      state = { ...initialState(), agentId, connected: Boolean(agentId), pending: record.request, ...(record.invalid ? invalidJournal() : {}), attachments: agentId ? storedAttachments(agentId) : [], draft: typeof draft === 'string' ? draft : '' };
      emit({});
      if (agentId) void refresh();
    },
    disconnect, refresh, decideApproval, addAttachments, replaceExpiredAttachments, retryUpload: uploadAttachment, cancelUpload, removeAttachment: id => cancelUpload(id, true), submit: () => submit(false), retry: () => submit(true), cancel, loadOlder,
    setDraft(value) { emit({ draft: value }); if (state.agentId && !rememberDraft(value)) emit({ errorKind: 'draft', error: '草稿暂时无法保存在本机，请保留文字后再离开。' }); },
    updateIdentity(identity, agentId = state.agentId) { if (state.view && state.agentId === agentId) emit({ view: { ...state.view, identity } }); },
  };
}
