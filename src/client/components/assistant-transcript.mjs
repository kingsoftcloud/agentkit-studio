import { createAssistantImageCache, createAssistantFileCache, assistantFileReference, downloadAssistantFile } from '../dsh/assistant-conversation.mjs';

import { assistantRequestText } from '../state/assistant-attachments.mjs';

const words = content => (content || []).filter(part => part?.type === 'text').map(part => part.text || '').join('');
const filename = value => String(value || '云端文件').split(/[\\/]/).at(-1) || '云端文件';
const statusLabel = root => root.kind === 'tool-result' ? root.isError ? '未完成' : '已完成' : '进行中';
const queuedLabel = item => {
  const text = item.text || words(item.content);
  if (text) return text;
  if (item.source?.kind === 'schedule' || item.source === 'schedule') return '定时任务';
  const attachments = (item.content || []).filter(part => part?.type === 'image' || part?.type === 'file').length;
  return attachments ? `附件消息（${attachments} 个附件）` : '等待处理的消息';
};

/** Product presentation of native DSH ViewNodes, with cloud-only read capabilities. */
export function createAssistantTranscript({ ui, hostRemote, assistantConversation, window }) {
  const { React: { createElement: h, useState, useEffect, useMemo, useRef }, BRAND, MarkdownText, MarkdownDelegateProvider, DisclosureRow, StateDot, ImageLightbox, FileTypeIcon, buttonStyle, Button } = ui;
  const Action = Button || 'button';
  const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };
  // A native Chat ancestor may expose local-file handlers. Cloud text must
  // replace that navigation scope rather than inherit another Host's paths.
  const markdown = value => value ? h(MarkdownDelegateProvider || ui.React.Fragment, null, h(MarkdownText, { text: value, labels })) : null;
  const dot = state => StateDot ? h(StateDot, { state }) : null;
  const muted = { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.6 };
  const card = { border: `1px solid ${BRAND.border}`, borderRadius: '12px', padding: '12px 14px', overflowWrap: 'anywhere' };
  function Disclosure({ title, state = 'idle', children }) {
    const [open, setOpen] = useState(false);
    return DisclosureRow ? h(DisclosureRow, { icon: dot(state), title, open, expandable: true, expandOnRowClick: true,
      running: state === 'ongoing', onToggle: () => setOpen(value => !value) }, children)
      : h('details', null, h('summary', null, title), children);
  }
  function Image({ attachment, cache, available }) {
    const [src, setSrc] = useState(''), [error, setError] = useState(''), [lightbox, setLightbox] = useState(false), [attempt, setAttempt] = useState(0);
    useEffect(() => {
      let alive = true;
      setSrc(''); setError('');
      if (available) cache.read(attachment).then(url => { if (alive) setSrc(url); }).catch(() => { if (alive) setError('图片读取失败，请重试。'); });
      return () => { alive = false; };
    }, [cache, attachment.attachmentId, available, attempt]);
    const name = filename(attachment.name || '图片');
    return h('figure', { style: { margin: '8px 0', maxWidth: '100%' }, 'data-assistant-image': attachment.attachmentId },
      src ? h('button', { type: 'button', onClick: () => setLightbox(true), 'aria-label': `查看图片：${name}`, style: { border: 0, padding: 0, background: 'transparent', cursor: 'zoom-in', maxWidth: '100%' } },
        h('img', { src, alt: name, style: { maxWidth: '100%', maxHeight: '320px', objectFit: 'contain', borderRadius: '10px', display: 'block' } }))
        : h('div', { role: 'status', style: { ...card, ...muted } }, name, ' · ', !available ? '云端图片读取尚未接通' : error || '正在读取云端图片…',
          error ? h('button', { type: 'button', style: buttonStyle(), onClick: () => setAttempt(value => value + 1) }, '重试图片') : null),
      src ? h('figcaption', { style: { ...muted, display: 'flex', gap: '12px', alignItems: 'center' } }, name, h('a', { href: src, download: name, style: { color: BRAND.inkMuted } }, '下载图片')) : null,
      lightbox && src && ImageLightbox ? h(ImageLightbox, { src, alt: name, labels: { dialog: '图片预览', close: '关闭图片' }, onClose: () => setLightbox(false) }) : null);
  }
  function File({ file, delivered = false, cache, files }) {
    const name = filename(file.name || file.path), ref = delivered ? null : assistantFileReference(file);
    const [loading, setLoading] = useState(false), [error, setError] = useState('');
    const attempt = useRef(0), inFlight = useRef(false);
    useEffect(() => { setError(''); setLoading(false); inFlight.current = false; return () => { attempt.current++; }; }, [cache, ref?.attachmentId]);
    const download = async () => {
      if (!files || !ref || inFlight.current) return;
      const token = ++attempt.current; inFlight.current = true; setLoading(true); setError('');
      try {
        const result = await cache.read(ref);
        if (attempt.current === token) downloadAssistantFile(result, window.document);
      } catch { if (attempt.current === token) setError('文件下载失败，请重试'); }
      finally { if (attempt.current === token) { inFlight.current = false; setLoading(false); } }
    };
    return h('div', { style: { ...card, display: 'flex', alignItems: 'center', gap: '12px', margin: '8px 0' }, 'data-assistant-file': true },
      FileTypeIcon ? h(FileTypeIcon, { path: name, size: 28 }) : null,
      h('div', { style: { minWidth: 0, flex: 1 } }, h('div', null, name),
        h('div', { style: muted, ...(loading || error ? { role: 'status' } : {}) }, loading ? '正在读取云端文件…' : error || (files && ref ? '已保存的云端文件' : delivered ? '只有生成记录，此版本不支持安全下载' : '已保存的文件 · 当前云端暂不支持下载'))),
      files && ref ? h(Action, { type: 'button', 'aria-label': `下载文件：${name}`, disabled: loading, onClick: () => void download(), ...(Button ? { variant: 'outline', size: 'sm' } : { style: buttonStyle() }) }, loading ? '读取中…' : error ? '重试下载' : '下载') : null);
  }
  function AttachmentSummary({ attachments }) {
    return attachments?.length ? h('ul', { 'aria-label': '消息附件', style: { listStyle: 'none', margin: '8px 0 0', padding: 0, ...muted } },
      ...attachments.map((row, index) => h('li', { key: row.receiptId || index }, filename(row.attachment?.name), ' · ', row.kind === 'image' ? '图片' : '文件'))) : null;
  }
  function Content({ content, cache, images, fileCache, files }) {
    return h('div', null, ...(content || []).map((part, index) => part?.type === 'text' ? h('div', { key: index }, markdown(part.text))
      : part?.type === 'image' && part.attachment ? h(Image, { key: part.attachment.attachmentId || index, attachment: part.attachment, cache, available: images })
        : part?.type === 'file' && part.attachment ? h(File, { key: part.attachment.attachmentId || index, file: part.attachment, cache: fileCache, files }) : null));
  }
  function Tool({ root, cache, images, fileCache, files, depth = 0 }) {
    const done = root.kind === 'tool-result', state = done ? root.isError ? 'error' : 'done' : 'ongoing';
    return h('section', { 'data-assistant-tool': root.callId, 'aria-label': `工具：${root.name || root.call?.name || '工具'}`, style: { ...card, margin: depth ? '8px 0 0' : 0 } },
      h(Disclosure, { title: `${root.name || root.call?.name || '工具'} · ${statusLabel(root)}`, state },
        (root.argsRaw || root.call?.argsRaw) && (root.argsRaw || root.call?.argsRaw) !== '{}' ? h('details', { style: { margin: '8px 0' } }, h('summary', { style: muted }, '工具输入'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '12px' } }, root.argsRaw || root.call.argsRaw)) : null,
        done && root.isError ? h('p', { style: muted }, '本次工具未完成。敏感诊断信息不会显示在这里。')
          : done ? h(Content, { content: root.content, cache, images, fileCache, files }) : h('p', { style: muted }, '工具正在云端执行，离开页面不会中断。'),
        depth < 8 ? (root.subCalls || []).map(child => h(Tool, { key: child.callId, root: child, cache, images, fileCache, files, depth: depth + 1 })) : null));
  }
  function Message({ node, cache, images, fileCache, files }) {
    const human = ['user', 'steering'].includes(node.kind), data = node.data;
    if (human && data.source?.rpcId === 'assistant-welcome-v1') return null;
    if (node.kind === 'tool-call') return h(Tool, { root: data.root, cache, images, fileCache, files });
    if (node.kind === 'turn-error') return h('div', { style: { ...card, ...muted } }, dot('error'), ' 此前任务未完成');
    if (node.kind === 'model-retry') return h('div', { role: 'status', style: muted }, dot('ongoing'), ' 模型连接中断，云端正在重试…');
    if (node.kind === 'turn-max-tokens') return h('div', { style: muted }, '本次输出达到长度限制。你可以发送消息继续。');
    if (!human && node.kind !== 'assistant-step') return null;
    const content = human ? data.content : (data.blocks || []).filter(block => block.kind !== 'reasoning' && block.kind !== 'tool-call').map(block => block.kind === 'other' ? block.block : ({ ...block, type: block.kind }));
    if (!content?.length) return null;
    return h('article', { 'aria-label': human ? '你' : '助理', style: { alignSelf: human ? 'flex-end' : 'stretch', maxWidth: human ? '86%' : '100%', borderRadius: '16px',
      padding: human ? '12px 16px' : 0, background: human ? BRAND.accentSoft : 'transparent', overflowWrap: 'anywhere', lineHeight: 1.8, fontSize: '15px' } },
      h(Content, { content, cache, images, fileCache, files }), data.finalNode?.interrupted ? h('div', { style: muted }, '已停止') : null);
  }
  return function AssistantTranscript({ messages = [], view, pending, agentId }) {
    const cache = useMemo(() => createAssistantImageCache({ agentId, hostRemote, URL: window.URL || URL, Blob: window.Blob || Blob, decode: value => window.atob(value) }), [agentId]);
    useEffect(() => () => cache.dispose(), [cache]);
    const fileCache = useMemo(() => createAssistantFileCache({ agentId, hostRemote, URL: window.URL || URL, Blob: window.Blob || Blob, decode: value => window.atob(value) }), [agentId]);
    useEffect(() => () => fileCache.dispose(), [fileCache]);
    const native = useMemo(() => {
      try { return assistantConversation.assemble(view?.events, view?.hasMore); } catch { return null; }
    }, [view?.events, view?.hasMore]);
    const images = view?.capabilities?.display?.images === true, files = view?.capabilities?.display?.files === true;
    const visible = native?.filter(node => ['user', 'steering', 'assistant-step', 'tool-call', 'model-retry', 'turn-max-tokens', 'turn-error'].includes(node.kind) && !(node.kind === 'turn-error' && view?.status === 'failed' && node.data?.seq === view.events?.findLast(event => event.type === 'turn/end')?.seq)) || [];
    const renderedIds = new Set((view?.events || []).filter(event => event.type === 'user/message').map(event => event.data?.source?.rpcId));
    const local = messages.filter(message => message.delivery === 'accepted' && !renderedIds.has(message.requestId));
    const fallback = visible.length ? local : messages;
    const rows = visible.map(node => ({ key: node.key, seq: node.anchorSeq, node }));
    // These native records are read-only product cards. They are never treated
    // as active approval requests or local filesystem links.
    for (const event of view?.events || []) {
      if (event.type === 'deliverables/presented' || event.type === 'goal/change' || event.type === 'approval/asked' || event.type === 'approval/decided' || (event.type === 'user/message' && event.data?.source?.kind === 'schedule')) rows.push({ key: `event:${event.seq}`, seq: event.seq, event });
    }
    rows.sort((a, b) => a.seq - b.seq);
    return h(ui.React.Fragment, null,
      view?.historyState === 'migration-required' ? h('p', { role: 'status', style: muted }, '这段历史需要由云端升级后读取。现有任务不会因此取消。') : null,
      view?.events && native === null ? h('p', { role: 'status', style: muted }, '原生会话展示暂不可用，正在显示已保存的文字记录。') : null,
      ...rows.map(row => {
        if (row.node) return h(Message, { key: row.key, node: row.node, cache, images, fileCache, files });
        const { event } = row, data = event.data;
        if (event.type === 'deliverables/presented') return h('section', { key: row.key, 'aria-label': '云端产物' }, ...(data.files || []).map((file, index) => h(File, { key: index, file, delivered: true, cache: fileCache, files })));
        if (event.type === 'user/message') return h('article', { key: row.key, 'aria-label': '提醒', style: muted }, '定时任务已触发。');
        if (event.type === 'goal/change') return h('section', { key: row.key, style: card, 'aria-label': '任务进度' }, data.goal?.objective || '云端任务', h('div', { style: muted }, ({ active: '进行中', paused: '已暂停', blocked: '需要处理', complete: '已完成' })[data.goal?.phase] || '状态已更新'));
        return h('div', { key: row.key, style: muted }, event.type === 'approval/asked' ? '审批记录：此操作曾请求授权；历史记录不能再次批准。' : '审批记录：已有处理结果。');
      }),
      ...fallback.filter(message => message.requestId !== 'assistant-welcome-v1').map(message => h('article', { key: message.id, 'aria-label': message.role === 'user' ? '你' : '助理', style: { alignSelf: message.role === 'user' ? 'flex-end' : 'stretch', maxWidth: '100%', borderRadius: '16px', padding: message.role === 'user' ? '12px 16px' : 0, background: message.role === 'user' ? BRAND.accentSoft : 'transparent', whiteSpace: message.role === 'user' ? 'pre-wrap' : 'normal', lineHeight: 1.8 } },
        message.role === 'assistant' ? markdown(message.text) : message.text, h(AttachmentSummary, { attachments: message.attachments }), message.delivery === 'accepted' ? h('div', { style: muted }, '云端已收到，等待历史同步') : null)),
      pending && !messages.some(message => message.requestId === pending.requestId) ? h('article', { style: { ...card, alignSelf: 'flex-end', background: BRAND.accentSoft, whiteSpace: 'pre-wrap' } }, assistantRequestText(pending), h(AttachmentSummary, { attachments: pending.attachments })) : null,
      view?.queued?.length ? h('section', { 'aria-label': '排队中的消息', style: { ...card, ...muted } }, `等待处理（${view.queuedCount || view.queued.length}）`, ...view.queued.map(item => h('p', { key: item.id || item.requestId }, queuedLabel(item)))) : null,
      view && !view.capabilities?.history?.nativeEvents ? h('p', { style: muted }, '此云端版本仅提供文字历史。更新云端镜像后可查看工具过程和已保存的附件。') : null,
      view?.capabilities ? h('details', { style: { ...muted, marginTop: '8px' }, 'data-assistant-capabilities': true }, h('summary', null, '当前助理能力'),
        h('p', null, view.capabilities.execution?.permission === 'read-only' ? '此云端会话按只读权限执行。'
          : view.capabilities.execution?.managed === true && view.capabilities.execution?.profile === 'workspace-managed/v1' ? '助理可在独立云端工作区内读写和搜索；敏感操作需逐次审批。'
            : '执行权限由当前云端会话策略决定；未获授权的操作不会自动放开。'),
        h('p', null, view.capabilities.approval?.interactive ? '当前云端支持按请求一次性审批；历史审批记录只读。' : '此会话未启用交互审批。'),
        h('p', null, '此会话暂不支持转交本机执行。'),
        view.capabilities.composer?.nativeComposer === false ? h('p', null, '原生会话输入暂未与此云端连接；消息和附件通过云端持久提交。') : null,
        h('p', null, view.capabilities.input?.attachments ? '支持上传图片和文件；上传完成后发送给助理。' : '此云端版本暂不支持上传附件。'),
        h('p', null, images ? '已保存的图片可预览和下载。' : '图片保留记录；云端图片读取尚未接通。'),
        h('p', null, files ? '原生文件回执支持下载；只有路径的产物不会打开本机文件。' : '文件保留记录；云端文件下载尚未接通。')) : null);
  };
}
