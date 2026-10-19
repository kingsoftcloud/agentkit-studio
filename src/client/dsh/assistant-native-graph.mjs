/** Independent real DSH Client graph. No local Controller or page-global Host hooks. */
import { ASSISTANT_ATTACHMENT_LIMITS, readAssistantAttachment } from '../state/assistant-attachments.mjs';
const allowed = new Set(['session/follow', 'session/projections', 'session/page', 'session/prompt', 'fileUploads/upload']);
const bytesBase64 = bytes => { let value = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(value); };

/** Retain accepts discovered identities, not a Host-authenticated id on its own. */
function waitForCloudSession(sessions, sessionId, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false, unsubscribe = () => {};
    const finish = error => {
      if (settled) return; settled = true;
      clearTimeout(timer); unsubscribe(); signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(signal.reason || new Error('云端输入连接已关闭'));
    const check = () => {
      if (signal.aborted) { aborted(); return; }
      const catalog = sessions.list.getSnapshot();
      if (catalog.phase !== 'ready') return;
      finish(catalog.ids.includes(sessionId) && catalog.byId[sessionId] ? undefined : new Error('云端会话尚未出现在当前目录，请重新连接输入'));
    };
    const timer = setTimeout(() => finish(new Error('读取云端会话目录超时，请重新连接输入')), 30000);
    signal.addEventListener('abort', aborted, { once: true });
    unsubscribe = sessions.list.subscribe(check);
    if (settled) unsubscribe();
    check();
  });
}

export async function createAssistantNativeGraph({ modules, transport, window, container, signal }) {
  const { Context, React, connection, typert, gateway, remotes, renderer, sessions, uiSession, settings, locale, conversation, attachment, createSnapshotStore } = modules;
  const policy = conversation.Config?.({});
  if (policy?.hostPathPolicy !== 'host-paths' || policy.draftPersistence !== 'session-local' || policy.submissionActions !== 'native') { await transport.dispose(); throw new Error('请更新 Studio 宿主后使用安全的云端原生输入'); }
  const ctx = new Context(); let reference, unmount, disposed = false;
  const lifetime = new AbortController();
  const dispose = async () => {
    if (disposed) return; disposed = true; signal?.removeEventListener('abort', aborted); lifetime.abort();
    // A nested native React root must unmount after the parent commit finishes.
    await Promise.resolve(); unmount?.(); reference?.release(); await ctx.fiber.dispose(); await transport.dispose();
  };
  const aborted = () => { void dispose(); };
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    signal?.throwIfAborted();
    await ctx.plugin({ apply(scope) { connection.installConnection(scope, {
      interactions: 'answer', location: { hostname: 'assistant-cloud.invalid' },
      transport: { rpc: transport.rpc, ownsHost: false, createWebSocket() { throw new Error('Cloud graph cannot use a local socket'); } },
    }); } }).await();
    for (const plugin of [typert, gateway, remotes, renderer]) await ctx.plugin(plugin).await();
    await ctx.plugin({ inject: ['remote', 'connection', 'slots'], apply(scope) {
      const sources = new Map(); let grants = new Set(), active = true;
      const publish = () => { for (const [key, source] of sources) source.set(active && grants.has(key)); };
      const clear = () => { grants = new Set(); publish(); };
      const keyFor = (kind, id, action) => JSON.stringify([kind, id, action]);
      const source = (kind, id, action) => {
        const key = keyFor(kind, id, action);
        if (!sources.has(key)) sources.set(key, createSnapshotStore(active && grants.has(key)));
        return sources.get(key);
      };
      scope.provide('remoteAccess', { source });
      scope.slots.provideRoot({ keyedHooks: { remoteAccess: action => source('global', '', action) } });
      const applyGrant = grant => {
        if (grant?.resource?.kind !== 'session' || grant.resource.id !== transport.sessionId || !Array.isArray(grant.actions)) return;
        for (const action of grant.actions) if (allowed.has(action)) grants.add(keyFor('session', transport.sessionId, action));
      };
      const stream = scope.remote.$stream({ name: 'Assistant cloud access',
        open: signal => transport.rpc.open('/api', 'remoteAccess/follow', { args: {} }, signal),
        ended: () => new gateway.RemoteStreamCarrierError('Cloud access stream ended'), carrierFailed: clear });
      const follow = new gateway.RemoteSnapshotStream(stream, { name: 'Assistant cloud access', isSnapshot: frame => frame?.type === 'baseline',
        replace(frame) { clear(); if (frame.owner !== false || !Array.isArray(frame.grants) || !scope.connection.generation.getSnapshot()) return; for (const grant of frame.grants) applyGrant(grant); publish(); },
        update() { clear(); }, failed: clear });
      const unsubscribe = scope.connection.generation.subscribe(() => { clear(); follow.restart(); });
      follow.start();
      scope.effect(() => async () => { active = false; clear(); unsubscribe(); await follow.dispose(); });
      scope.provide('fileUpload', { async upload(sessionId, data, name, signal, onProgress) {
        if (sessionId !== transport.sessionId) throw new Error('Attachment belongs to a different cloud session');
        const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]); combined.throwIfAborted();
        if (!(data instanceof window.Blob) && !(data instanceof Uint8Array)) throw new Error('Only selected browser files are supported');
        const size = data instanceof Uint8Array ? data.byteLength : data.size;
        if (size > ASSISTANT_ATTACHMENT_LIMITS.maxAttachmentBytes) throw new Error('附件超过大小限制');
        const encoded = data instanceof Uint8Array ? bytesBase64(data) : await readAssistantAttachment(data, { FileReader: window.FileReader, signal: combined,
          onProgress: progress => onProgress?.({ loaded: Math.floor(size * progress / 100), total: size }) });
        combined.throwIfAborted();
        return transport.rpc.call('/api', 'fileUploads/upload', { args: { agent: sessionId, request: { data: encoded, name: name || '附件' } } }, combined);
      } });
    } }).await();
    for (const plugin of [sessions, uiSession, settings, locale]) await ctx.plugin(plugin).await();
    // This graph has no workspace authority. The published navigation face is
    // explicitly unavailable; it never imports or accesses the local navigator.
    ctx.provide('uiWorkspace', { openSession() { throw new Error('Cloud navigation unavailable'); }, async openWorkspace() { throw new Error('Cloud workspaces unavailable'); } });
    ctx.slots.provideRoot({ hooks: { workspaces: createSnapshotStore({ phase: 'ready', items: [] }) } });
    ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'studio.assistant.cloud-composer': { kind: 'single', scope: 'session' } } },
      function CloudComposerRoot({ SessionProvider, renderSlot }) {
        return React.createElement(SessionProvider, { session: reference }, renderSlot('studio.assistant.cloud-composer', {}));
      });
    const EmptyView = () => null;
    ctx.slots.register({ name: 'studio.assistant.cloud-composer' }, function NativeComposer({ renderFactorySlot }) {
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: { views: EmptyView, widthControls: EmptyView } });
    });
    await ctx.plugin(conversation, { hostPathPolicy: 'upload-only', draftPersistence: 'memory-only', submissionActions: 'queue-only' }).await();
    await ctx.plugin(attachment).await();
    // Existing product history already renders the safe Queue and plan facts.
    for (const id of ['queue', 'todo']) ctx.slots.register({ name: 'conversation.input.dock', id, priority: 1000 }, () => null);
    const updateBlock = () => {
      const pending = transport.getState();
      ctx.conversation.blocks.set(transport.sessionId, pending.invalid || pending.pending || pending.busy || pending.disconnected ? { reason: '请先确认上一条消息的保存结果' } : undefined);
    };
    updateBlock(); ctx.effect(() => transport.subscribe(updateBlock));
    // Plugin installation starts an asynchronous Host list pull. A real network
    // must finish catalog discovery before the public synchronous retain call.
    await waitForCloudSession(ctx.sessions, transport.sessionId, lifetime.signal);
    lifetime.signal.throwIfAborted();
    reference = ctx.sessions.retain(transport.sessionId, { source: 'controllerOperation', signal: lifetime.signal });
    await reference.ready;
    if (disposed) throw new Error('Cloud composer was released before it opened');
    const snapshot = reference.binding.session.getSnapshot();
    if (snapshot.openState !== 'open' || snapshot.openError) throw new Error('云端原生会话未能打开');
    if (ctx.sessions.binding(transport.sessionId) !== reference.binding) throw new Error('Cloud session binding changed');
    if (container) unmount = ctx.get('uiRenderer').mount(container);
    return { ctx, reference, transport, dispose,
      addFiles(files) {
        if (disposed || ctx.sessions.binding(transport.sessionId) !== reference.binding) return '云端输入连接已关闭，请重新连接';
        const pending = transport.getState();
        if (pending.invalid || pending.pending || pending.busy || pending.disconnected) return '请先确认上一条消息的保存结果';
        // Public ComposerBarInjected owns native browser intake, draft allocation
        // and upload cancellation; this picker never creates a parallel draft.
        const bar = ctx.slots.entries('conversation.composer.bar')[0];
        const intake = bar?.inject(transport.sessionId)?.addFiles;
        return typeof intake === 'function' ? intake(files) : '当前原生输入未提供文件选择，请重新连接';
      },
      async confirm() {
        if (disposed) return { accepted: false, reset: false };
        const input = ctx.conversation.input.for(reference.binding.ctx), before = input.state.getSnapshot();
        let matches = false;
        try {
          const serialized = await ctx.conversation.serializeDraftAttachments(before.attachmentIds);
          matches = await transport.matchesPending([...serialized.attachments, ...(before.draft.trim() ? [{ type: 'text', text: before.draft.trim() }] : [])]);
        } catch { /* New or incomplete attachments must never be discarded by confirmation. */ }
        const accepted = await transport.confirm();
        if (disposed || !accepted) return { accepted: false, reset: false };
        const after = input.state.getSnapshot();
        // Only rebuild an unchanged restored failed send. Later user edits and
        // attachments stay in the same memory-only graph, including its undo state.
        return { accepted: true, reset: matches && before.draftRev === after.draftRev
          && before.attachmentIds.length === after.attachmentIds.length && before.attachmentIds.every((id, index) => id === after.attachmentIds[index]) };
      }, mount(element) { if (disposed || unmount) throw new Error('Cloud composer already mounted or released'); unmount = ctx.get('uiRenderer').mount(element); } };
  } catch (error) { await dispose(); throw error; }
}
