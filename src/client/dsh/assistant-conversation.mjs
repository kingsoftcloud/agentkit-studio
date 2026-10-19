/** Read-only cloud history assembly. Never retain a same-named local Host Session. */
export function createAssistantConversation({ ConversationNodeAssembler }) {
  let registry;
  return {
    bind(uiConversation) {
      registry = uiConversation;
      return () => { if (registry === uiConversation) registry = undefined; };
    },
    assemble(events, hasMore = false) {
      if (!ConversationNodeAssembler || !registry || !Array.isArray(events)) return null;
      // Each response is an authoritative native window, not a stream of new
      // events. Replacement tolerates reconnect, duplicate and late pages.
      const unique = [...new Map(events.filter(event => Number.isSafeInteger(event?.seq)).map(event => [event.seq, event])).values()]
        .sort((left, right) => left.seq - right.seq);
      // The public history projection intentionally omits provider stream records.
      // Native lifecycle Definitions still require the stream array, even for an
      // inactive target such as Trajectory. Unknown routes stay empty; native token
      // accounting must remain unavailable instead of restoring provider details.
      const inputs = unique.map(event => ({ type: 'event', event: event.type === 'assistant/message'
        ? { ...event, data: { ...event.data, stream: [], message: { ...event.data?.message, source: { kind: 'model', provider: '', model: '' } } } }
        : event.type === 'turn/end' && event.data?.reason?.kind === 'aborted'
          ? { ...event, data: { ...event.data, reason: { kind: 'aborted', reason: { kind: 'legacy' } } } } : event }));
      const assembler = new ConversationNodeAssembler(registry.events, registry.views, registry.groups);
      assembler.replaceWindow(inputs, hasMore);
      assembler.activateTarget('chat');
      const snapshot = assembler.snapshot('chat');
      return snapshot ? [...snapshot.nodes.values()].filter(node => node.visibility === 'visible') : null;
    },
  };
}

/** One view-owned image cache. Cloud receipts never go through local file APIs. */
export function createAssistantImageCache({ agentId, hostRemote, URL, Blob, decode = globalThis.atob }) {
  const entries = new Map();
  let disposed = false;
  return {
    read(attachment) {
      if (disposed) return Promise.reject(new Error('图片查看已关闭'));
      const id = attachment?.attachmentId;
      if (typeof id !== 'string' || !id) return Promise.reject(new Error('图片凭据无效'));
      if (entries.has(id)) return entries.get(id).promise;
      const entry = {};
      entry.promise = hostRemote.assistantExecute(agentId, 'image-read', { attachmentId: id }).then(result => {
        const ref = result?.attachment;
        if (ref?.attachmentId !== id || !/^image\/(png|jpeg|webp|gif)$/.test(ref.mediaType || '') || typeof result.data !== 'string' || result.data.length > 28 * 1024 * 1024) throw new Error('云端图片格式无法识别');
        const binary = decode(result.data);
        if (!binary.length || binary.length > 20 * 1024 * 1024) throw new Error('云端图片大小无法显示');
        if (disposed) throw new Error('图片查看已关闭');
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        entry.url = URL.createObjectURL(new Blob([bytes], { type: ref.mediaType }));
        return entry.url;
      }).catch(error => { if (entries.get(id) === entry) entries.delete(id); throw error; });
      entries.set(id, entry);
      return entry.promise;
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) if (entry.url) URL.revokeObjectURL(entry.url);
      entries.clear();
    },
  };
}

/** File download identity must come from a native attachment, never a displayed path. */
export function assistantFileReference(value) {
  const ref = value?.attachment || value;
  return /^sha256:[a-f0-9]{64}$/.test(ref?.attachmentId || '') && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0
    && ref.bytes <= 20 * 1024 * 1024 && typeof ref.name === 'string' && ref.name
    ? { attachmentId: ref.attachmentId, name: ref.name.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || '附件', bytes: ref.bytes } : null;
}

/** View-owned cloud downloads produce inert binary blobs and release them on disposal. */
export function createAssistantFileCache({ agentId, hostRemote, URL, Blob, decode = globalThis.atob }) {
  const entries = new Map();
  let disposed = false;
  return {
    read(file) {
      if (disposed) return Promise.reject(new Error('文件查看已关闭'));
      const ref = assistantFileReference(file);
      if (!ref) return Promise.reject(new Error('云端文件凭据无效'));
      const id = ref.attachmentId;
      if (entries.has(id)) {
        const entry = entries.get(id);
        if (entry.bytes !== ref.bytes) return Promise.reject(new Error('云端文件大小无法识别'));
        return entry.promise.then(url => ({ url, name: ref.name }));
      }
      const entry = { controller: new AbortController(), bytes: ref.bytes };
      entry.promise = hostRemote.assistantExecute(agentId, 'file-read', { attachmentId: id }, entry.controller.signal).then(result => {
        const returned = assistantFileReference(result?.attachment);
        if (!returned || returned.attachmentId !== id || returned.bytes !== ref.bytes || typeof result.data !== 'string'
          || result.data.length > 28 * 1024 * 1024 || result.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data)) throw new Error('云端文件格式无法识别');
        const binary = decode(result.data);
        if (binary.length !== returned.bytes) throw new Error('云端文件大小无法识别');
        if (disposed) throw new Error('文件查看已关闭');
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        entry.url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        return entry.url;
      }).catch(error => { if (entries.get(id) === entry) entries.delete(id); throw error; });
      entries.set(id, entry);
      return entry.promise.then(url => ({ url, name: ref.name }));
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) { entry.controller.abort(); if (entry.url) URL.revokeObjectURL(entry.url); }
      entries.clear();
    },
  };
}

/** Trigger a browser download from a verified blob; this does not open the local filesystem. */
export function downloadAssistantFile({ url, name }, document) {
  if (typeof url !== 'string' || !url.startsWith('blob:')) throw new Error('文件下载地址无法识别');
  const link = document.createElement('a');
  link.href = url; link.download = name; link.rel = 'noopener';
  document.body.appendChild(link);
  try { link.click(); } finally { link.remove(); }
}
