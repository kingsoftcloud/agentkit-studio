/** Catalog discovery reuses the existing Agent authoring form and navigation. */
export function createExpertCatalogPage(React, { remote, initialCatalog, CreatePage, onAgents, onResources, onSummoned, artwork }) {
  const { createElement: h, useState, useEffect, useRef } = React;
  const { Avatar, Scene } = artwork;
  const avatarCache = new Map();
  function CatalogAvatar({ item, size = 48 }) {
    const [url, setUrl] = useState(avatarCache.get(item.id) || ''), node = useRef(null);
    useEffect(() => {
      if (url || !item.artwork?.available || !remote.templateAvatar) return;
      let active = true;
      const observer = new IntersectionObserver(entries => { if (!entries.some(entry => entry.isIntersecting)) return; observer.disconnect(); remote.templateAvatar({ id: item.id, version: item.version, digest: item.digest }).then(value => { if (value) { avatarCache.set(item.id, value); if (active) setUrl(value); } }).catch(() => {}); }, { rootMargin: '120px' });
      if (node.current) observer.observe(node.current); return () => { active = false; observer.disconnect(); };
    }, [item.id, url]);
    return h('span', { ref: node, style: { flex: 'none', width: size, height: size } }, url ? h('img', { src: url, alt: '', width: size, height: size, className: 'ec-portrait', style: { objectFit: 'cover' } }) : h(Avatar, { id: item.id, size }));
  }
  const labels = { 'dsh-native': 'DSH Native', harness: 'AgentKit Harness', codex: 'Codex' };
  const icons = {
    expert: ['M9 4h6l5 4v7l-5 5H9l-5-5V8l5-4Z', 'M8 10h3v3H8zM14 10h3v3h-3zM10 16h4'],
    skill: ['m14 3 7 7-4 4-3-3-9 10-3-3 10-9-3-3 5-3Z'],
    link: ['m10 13 4-4', 'm8 15-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0', 'm14 9 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0'],
    search: ['M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm15 15 6 6'],
    close: ['m6 6 12 12M6 18 18 6'], arrow: ['m9 5 7 7-7 7'],
    chat: ['M4 4h16v13H9l-5 4V4Z', 'M8 9h8M8 13h5'],
    bulb: ['M8 16c0-3-3-3-3-7a7 7 0 0 1 14 0c0 4-3 4-3 7M9 20h6M9 16h6'],
  };
  function Icon({ kind, size = 20 }) { return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, (icons[kind] || icons.expert).map((d, i) => h('path', { key: i, d }))); }
  const css = `
    .ec-page{--ec-text:var(--dsw-alias-label-primary,#202124);--ec-muted:var(--dsw-alias-label-secondary,#777b80);--ec-line:var(--dsw-alias-border-l3,#ececef);--ec-surface:var(--dsw-alias-bg-layer-1,#fff);--ec-soft:color-mix(in srgb,var(--ec-text) 4%,var(--ec-surface));color:var(--ec-text);padding:22px 30px 40px;max-width:1900px;margin:auto;font-family:inherit;container-type:inline-size}
    .ec-page *{box-sizing:border-box}.ec-page button,.ec-page input{font-family:inherit}.ec-page button{cursor:pointer}.ec-page button:disabled{cursor:wait;opacity:.55}.ec-page button:focus-visible,.ec-page input:focus-visible,.ec-page summary:focus-visible{outline:2px solid #597896;outline-offset:4px}.ec-page h1:focus{outline:none}
    .ec-top{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:23px}.ec-navigation{display:flex;align-items:center;gap:24px}.ec-navigation h1{margin:0;font-size:21px;letter-spacing:-.03em;display:flex;gap:8px;align-items:center}.ec-navigation>button{border:0;background:none;color:var(--ec-muted);font-size:18px;display:flex;gap:7px;align-items:center;padding:6px 0}.ec-navigation>button:hover{color:var(--ec-text)}.ec-actions{display:flex;align-items:center;gap:13px}.ec-search{display:flex;align-items:center;gap:8px;border:1px solid var(--ec-line);border-radius:9px;height:36px;padding:0 11px;color:var(--ec-muted)}.ec-search input{background:none;border:0;color:var(--ec-text);width:170px;min-width:0;font-size:12px;outline:none}.ec-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:8px 13px;border:1px solid var(--ec-line);border-radius:9px;background:var(--ec-surface);color:var(--ec-text);font-size:13px;white-space:nowrap}.ec-button.primary{background:var(--ec-text);border-color:var(--ec-text);color:var(--ec-surface);font-weight:550;padding:10px 19px}
    .ec-collections{display:flex;gap:16px;overflow:auto;scrollbar-width:thin;scroll-snap-type:x proximity;padding:0 1px 10px;margin-bottom:27px}.ec-collection{flex:0 0 255px;border:1px solid var(--ec-line);border-radius:17px;overflow:hidden;scroll-snap-align:start;background:var(--ec-surface);box-shadow:0 3px 12px #00000002}.ec-collection-head{height:94px;padding:0 18px;display:flex;align-items:center;position:relative;overflow:hidden;background:var(--ec-tint)}.ec-collection-head strong{font-size:17px;color:#252932;z-index:1}.ec-scene{position:absolute;height:116px;width:174px;right:-5px;bottom:-7px}.ec-collection-head strong{max-width:100px}.ec-collection-body{padding:13px 17px 15px}.ec-featured{display:flex;align-items:center;gap:5px;width:100%;border:0;background:none;color:var(--ec-muted);text-align:left;font-size:12px;padding:7px 0;line-height:1.5}.ec-featured:hover{color:var(--ec-text)}.ec-featured span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.ec-featured svg{flex:none;opacity:.6}.ec-collection-all{border:0;background:none;color:var(--ec-muted);padding:7px 0 3px;font-size:11px}
    .ec-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px}.ec-section-head h2{font-size:16px;margin:0;font-weight:650}.ec-count{font-size:11px;color:var(--ec-muted);font-weight:400;margin-left:10px}.ec-sort{display:flex;border:1px solid var(--ec-line);border-radius:9px;background:var(--ec-soft);padding:3px;gap:2px}.ec-sort button{background:none;border:0;border-radius:6px;color:var(--ec-muted);padding:5px 12px;font-size:12px}.ec-sort button[aria-pressed=true]{background:var(--ec-surface);color:var(--ec-text);box-shadow:0 1px 3px #00000008}.ec-categories{display:flex;gap:10px;overflow:auto;scrollbar-width:thin;margin-bottom:20px;padding-bottom:3px}.ec-category{flex:none;border:0;border-radius:7px;background:none;color:var(--ec-muted);font-size:12px;padding:8px 12px}.ec-category[aria-pressed=true]{background:var(--ec-soft);color:var(--ec-text);font-weight:600}
    .ec-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:15px}.ec-card{display:flex;flex-direction:column;align-items:stretch;min-width:0;min-height:166px;padding:19px 19px 16px;border:1px solid var(--ec-line);border-radius:17px;background:var(--ec-surface);text-align:left;color:var(--ec-text);box-shadow:0 3px 14px #00000002;transition:box-shadow .18s,border-color .18s,transform .18s}.ec-card:hover{border-color:#bac5cd;box-shadow:0 7px 20px #22334309;transform:translateY(-2px)}.ec-card-heading{display:flex;align-items:center;gap:12px;min-width:0;margin-bottom:14px}.ec-portrait{flex:none;display:block;border-radius:14px}.ec-card-copy{min-width:0}.ec-card h3{font-size:16px;font-weight:600;margin:0 0 6px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ec-card p{margin:0;color:var(--ec-muted);font-size:13px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ec-tags{display:flex;gap:5px;flex-wrap:wrap}.ec-tag{font-size:12px;line-height:1.4;padding:3px 6px;border-radius:3px;background:var(--ec-soft);color:var(--ec-muted)}.ec-card-footer{display:flex;align-items:center;justify-content:space-between;margin-top:auto;padding-top:17px;color:var(--ec-muted);font-size:11px}.ec-card-footer span:last-child{display:flex;align-items:center;gap:3px;opacity:0;transition:opacity .18s}.ec-card:hover .ec-card-footer span:last-child,.ec-card:focus-visible .ec-card-footer span:last-child{opacity:1}
    .ec-modal{border:1px solid var(--ec-line);border-radius:25px;width:min(724px,calc(100vw - 40px));max-height:calc(100dvh - 70px);padding:29px 30px 32px;background:var(--ec-surface);color:var(--ec-text);box-shadow:0 20px 80px #11152233;overflow-y:auto;overscroll-behavior:contain}.ec-modal::backdrop{background:#14182030;backdrop-filter:blur(6px)}.ec-close{position:absolute;right:22px;top:23px;display:grid;place-items:center;border:0;background:none;color:var(--ec-muted);width:30px;height:30px;border-radius:8px}.ec-close:hover{background:var(--ec-soft);color:var(--ec-text)}.ec-detail-top{display:flex;align-items:center;gap:21px;padding-right:27px;margin-bottom:25px}.ec-detail-top h2{font-size:22px;line-height:1.4;letter-spacing:-.025em;margin:0 0 12px}.ec-detail-top h2 small{font-size:14px;font-weight:400;color:var(--ec-muted);margin-left:9px}.ec-detail-description{font-size:14px;line-height:1.85;margin:0 0 17px}.ec-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;border-block:1px solid var(--ec-line);padding:20px 0;margin:27px 0}.ec-meta div{text-align:center;min-width:0}.ec-meta strong{font-size:14px;line-height:1.5;font-weight:550;overflow-wrap:anywhere}.ec-meta small{display:block;font-size:11px;color:var(--ec-muted);margin-top:7px}.ec-detail-section{margin:25px 0 0}.ec-detail-section h3{display:flex;align-items:center;gap:7px;margin:0 0 15px;font-size:15px;font-weight:600}.ec-example{display:flex;align-items:center;gap:18px;justify-content:space-between;width:100%;border:1px solid transparent;background:var(--ec-soft);border-radius:14px;padding:15px 17px;margin:9px 0;color:var(--ec-muted);font-size:13px;line-height:1.8;text-align:left}.ec-example:hover{border-color:var(--ec-line);color:var(--ec-text)}.ec-example svg{flex:none}.ec-detail-section p{font-size:13px;line-height:1.8;color:var(--ec-muted)}.ec-detail-section details{font-size:12px;line-height:1.8;color:var(--ec-muted)}.ec-detail-section summary{cursor:pointer}.ec-detail-section pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--ec-soft);border-radius:12px;padding:15px}.ec-resources{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.ec-empty{text-align:center;padding:65px 15px;color:var(--ec-muted);font-size:13px}.ec-notice{font-size:12px;line-height:1.7;color:var(--ec-muted);margin-top:18px}.ec-error{font-size:13px;line-height:1.7;border-radius:9px;background:#fff1e9;color:#8e391e;padding:10px 14px}.ec-success{display:flex;align-items:center;justify-content:space-between;gap:15px;background:var(--ec-soft);border:1px solid var(--ec-line);border-radius:12px;padding:13px 16px;margin-bottom:20px;font-size:13px}
    .ec-card{position:relative;padding:0;overflow:hidden}.ec-card-main{display:flex;flex-direction:column;align-items:stretch;flex:1;min-width:0;padding:20px;border:0;color:inherit;background:none;text-align:left}.ec-card h3{padding-right:58px}.ec-summon{position:absolute;right:14px;top:18px;border:0;border-radius:8px;background:var(--ec-text);color:var(--ec-surface);padding:7px 11px;font-size:12px;z-index:1;opacity:0;pointer-events:none;transform:translateY(3px);transition:opacity .15s,transform .15s}.ec-card:hover .ec-summon,.ec-card:focus-within .ec-summon{opacity:1;pointer-events:auto;transform:none}.ec-card:focus-within{border-color:#bac5cd}.ec-loading{position:fixed;inset:0;z-index:1000;background:color-mix(in srgb,var(--ec-surface) 87%,transparent);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:17px;font-size:14px;backdrop-filter:blur(2px)}.ec-loading progress{width:min(320px,75vw);height:7px;accent-color:var(--ec-text)}.ec-spinner{width:36px;height:36px;border:3px solid var(--ec-line);border-top-color:var(--ec-text);border-radius:50%;animation:ec-spin .8s linear infinite}@keyframes ec-spin{to{transform:rotate(360deg)}}.ec-config{border:1px solid var(--ec-line);border-radius:14px;padding:18px;margin:18px 0;background:var(--ec-soft)}.ec-config label{display:block;font-size:13px;margin:14px 0}.ec-config select{display:block;width:100%;padding:10px;margin-top:7px;border:1px solid var(--ec-line);border-radius:8px;background:var(--ec-surface);color:var(--ec-text);font:inherit}.ec-config p{font-size:12px;color:var(--ec-muted);line-height:1.8}.ec-secondary{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
    @media(hover:none),(pointer:coarse){.ec-summon{opacity:1;pointer-events:auto;transform:none}}
    @container(max-width:790px){.ec-navigation{gap:15px}.ec-navigation>button{font-size:15px}.ec-navigation h1{font-size:19px}.ec-search input{width:130px}.ec-actions{gap:8px}.ec-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.ec-collection{flex-basis:235px}}
    @container(max-width:560px){.ec-top{align-items:flex-start;flex-direction:column;gap:15px}.ec-actions{width:100%}.ec-search{flex:1}.ec-search input{width:100%}.ec-grid{grid-template-columns:1fr}.ec-count{display:none}}
    @media(max-width:700px){.ec-page{padding:20px 16px}.ec-modal{padding:24px 20px;border-radius:20px;max-height:calc(100dvh - 30px)}.ec-detail-top{gap:14px}.ec-detail-top h2{font-size:19px}.ec-detail-top h2 small{display:block;margin:4px 0}.ec-meta{gap:8px}.ec-meta strong{font-size:12px}.ec-card-footer span:last-child{opacity:1}}
    @media(prefers-reduced-motion:reduce){.ec-card,.ec-summon,.ec-card-footer span:last-child{transition:none}}
  `;
  return function ExpertCatalogPage({ inline = false } = {}) {
    const [catalog, setCatalog] = useState(initialCatalog), [query, setQuery] = useState('');
    const [category, setCategory] = useState('all'), [sort, setSort] = useState('recommended'), [includeBlocked, setIncludeBlocked] = useState(false);
    const [selected, setSelected] = useState(null), [draft, setDraft] = useState(null), [created, setCreated] = useState(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [offline, setOffline] = useState(false);
    const [plan, setPlan] = useState(null), [choices, setChoices] = useState({}), [phase, setPhase] = useState('');
    const [progress,setProgress]=useState(null),[notice,setNotice]=useState('');
    const lock = useRef(false), summonKeys = useRef(new Map()), summoned = useRef(new Map());
    const dialogRef = useRef(null), returnFocus = useRef(null), requestRef = useRef(0), alive = useRef(true);
    useEffect(() => { alive.current = true; remote.templates().then(value => { if (alive.current) { setCatalog(value); setOffline(false); } }).catch(() => { if (alive.current) setOffline(true); }); return () => { alive.current = false; requestRef.current++; }; }, []);
    useEffect(() => {
      const dialog = dialogRef.current;
      if (selected && !draft && dialog && !dialog.open) dialog.showModal();
      return () => { if (dialog?.open) dialog.close(); };
    }, [selected, draft]);
    function open(item, event) { returnFocus.current = event?.currentTarget; setSelected(item); setPlan(null); setChoices({}); setError(''); setCreated(null); const request=++requestRef.current;if(remote.templateDefinition)remote.templateDefinition({id:item.id,version:item.version,digest:item.digest}).then(full=>{if(alive.current&&request===requestRef.current)setSelected(full);}).catch(reason=>{if(alive.current&&request===requestRef.current)setError(reason.message);}); }
    const bytes = value => value >= 1024*1024 ? `${(value/1024/1024).toFixed(1)} MB` : `${Math.ceil(value/1024)} KB`;
    function updateProgress(value){if(!alive.current)return;setProgress(value);setPhase(value.label||({'downloading':'正在下载专家资源','verifying':'正在校验资源包','installing':'正在安装完整技能文件','cache-hit':'使用本机缓存，无需重新下载','checking':'正在检查模型与绑定','checking-mcp':'正在检查连接器','creating':'正在创建专家'}[value.phase])||'正在准备专家');}
    function close() {
      if (lock.current) return;
      requestRef.current++; setBusy(false); dialogRef.current?.close(); setSelected(null); setError('');
      const target = returnFocus.current; requestAnimationFrame(() => { if (target?.isConnected) target.focus(); });
    }
    async function summon(item, options = {}, task = '') {
      if (lock.current) return;
      lock.current = true; requestRef.current++; setBusy(true); setError(''); setNotice(''); setSelected(null); setProgress(null); setPhase('正在准备专家及配套资源…');
      const ref = { id: item.id, version: item.version, ...(item.digest ? { digest: item.digest } : {}) };
      const signature = JSON.stringify({ ref, options, task });
      if (!summonKeys.current.has(signature)) summonKeys.current.set(signature, crypto.randomUUID());
      try {
        let agent = summoned.current.get(signature);
        if (!agent) {
          const payload={ref,requestId:summonKeys.current.get(signature),bindings:options,...(options.runtimeType?{runtimeType:options.runtimeType}:{}),task};
          const result = await (remote.runTemplateWorkflow?remote.runTemplateWorkflow(payload,updateProgress):remote.summonTemplate(payload));
          if (!alive.current) return;
          if (result.status === 'needs-input') { setSelected(item); setPlan({ ...result.plan, task }); setChoices({ ...options, modelId: result.plan.modelId }); return; }
          agent = result.agent; summoned.current.set(signature, agent);
        }
        setCreated({ ...agent.metadata, metadata: agent.metadata }); setProgress(null); setPhase('专家已就绪，正在打开会话…');
        if (onSummoned) await onSummoned(agent);
      } catch (reason) { if (alive.current) { if(reason.code==='TEMPLATE_CANCELLED'){setNotice('已取消召唤，重新尝试时可复用下载缓存。');}else{setSelected(item);setError(reason.message || '召唤未完成，请重试');} } }
      finally { lock.current = false; if (alive.current) { setBusy(false); setPhase(''); } }
    }
    async function configure(item) {
      if (lock.current) return;
      lock.current = true; setBusy(true); setError('');
      try { const value = await remote.planTemplateSummon({ ref: { id: item.id, version: item.version, digest: item.digest }, configure: true }); if (alive.current) { setPlan(value); setChoices({ modelId: value.modelId }); } }
      catch (reason) { if (alive.current) setError(reason.message); }
      finally { lock.current = false; if (alive.current) setBusy(false); }
    }
    async function useTemplate(item, example) {
      if (busy) return;
      const request = ++requestRef.current; setBusy(true); setError('');
      try {
        const ref={id:item.id,version:item.version,...(item.digest?{digest:item.digest}:{})};setPhase('正在准备自定义创建');
        const value = await (remote.runTemplateWorkflow?remote.runTemplateWorkflow({kind:'prepare',ref,requestId:crypto.randomUUID()},updateProgress):remote.prepareTemplate(ref));
        if (alive.current && request === requestRef.current) setDraft(example ? { ...value, spec: { ...value.spec, instructions: { ...value.spec.instructions, task: example } } } : value);
      } catch (reason) { if (alive.current && request === requestRef.current) {if(reason.code==='TEMPLATE_CANCELLED')setNotice('已取消准备，下载缓存仍可复用。');else setError(reason.message || '模板暂不可用，请重试');} }
      finally { if (alive.current && request === requestRef.current) {setBusy(false);setPhase('');} }
    }
    const categories = catalog.categories || [], items = catalog.items || [];
    let filtered = items.filter(item => (includeBlocked || item.availability?.state !== 'blocked') && (category === 'all' || item.categoryId === category) && (!query.trim() || [item.name, item.description, ...item.tags].join(' ').toLowerCase().includes(query.trim().toLowerCase())));
    if (sort === 'name') filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const tags = item => h('div', { className: 'ec-tags' }, [...new Set([...item.tags, ...item.requirements.filter(req => ['knowledge-base', 'memory-instance'].includes(req.kind)).map(req => req.kind === 'knowledge-base' ? '知识库' : '长期记忆')])].slice(0, 3).map(tag => h('span', { className: 'ec-tag', key: tag }, tag)));
    if (draft) return h('div', { className: 'ec-page' }, h('style', null, css), h(CreatePage, { key: draft.templateSource.id, creationSeed: draft, onBack: () => setDraft(null), onCreated: agent => { setDraft(null); setSelected(null); setCreated(agent); } }));
    return h('section', { className: 'ec-page', 'aria-label': '专家模板目录' }, h('style', null, css),
      h('header', { className: 'ec-top' }, !inline ? h('nav', { className: 'ec-navigation', 'aria-label': '能力目录' }, h('h1', null, h(Icon, { kind: 'expert', size: 23 }), '专家模板'),
        onResources ? h('button', { onClick: () => onResources('skill') }, h(Icon, { kind: 'skill' }), '技能') : null,
        onResources ? h('button', { onClick: () => onResources('mcp') }, h(Icon, { kind: 'link' }), '连接器') : null) : h('strong',null,'发现适合你的专家'),
        h('div', { className: 'ec-actions' }, h('label', { className: 'ec-search' }, h(Icon, { kind: 'search', size: 16 }), h('input', { type: 'search', 'aria-label': '搜索专家', placeholder: '搜索专家', value: query, onChange: event => setQuery(event.target.value) })))),
      created ? h('div', { className: 'ec-success', role: 'status' }, h('span', null, `已创建「${created.name}」`), h('button', { className: 'ec-button', onClick: onAgents }, '查看我的专家')) : null,
      notice||catalog.notice?h('p',{className:'ec-notice',role:'status'},notice||catalog.notice):null,
      h('div', { className: 'ec-collections', 'aria-label': '场景专题' }, categories.filter(group => group.featured?.length).map(group => h('article', { className: 'ec-collection', key: group.id, style: { '--ec-tint': group.color } },
        h('div', { className: 'ec-collection-head' }, h('strong', null, group.name), h(Scene, { kind: group.icon })),
        h('div', { className: 'ec-collection-body' }, items.filter(item => item.categoryId === group.id).slice(0, 3).map(item => h('button', { className: 'ec-featured', key: item.id, onClick: event => open(item, event) }, h('span', null, item.name), h(Icon, { kind: 'arrow', size: 12 }))),
          h('button', { className: 'ec-collection-all', onClick: () => { setCategory(group.id); setQuery(''); } }, '浏览专题 →'))))),
      h('div', { className: 'ec-section-head' }, h('h2', null, '精选专家', h('span', { className: 'ec-count', role: 'status', 'aria-live': 'polite' }, `${filtered.length} 个模板`)),
        h('div', { className: 'ec-sort', 'aria-label': '专家排序' }, h('button', { 'aria-pressed': includeBlocked, onClick: () => setIncludeBlocked(value => !value) }, '显示依赖待补齐项'), [['recommended', '精选'], ['name', '名称']].map(([id, label]) => h('button', { key: id, 'aria-pressed': sort === id, onClick: () => setSort(id) }, label)))),
      h('div', { className: 'ec-categories', 'aria-label': '专家分类' }, [{ id: 'all', name: '全部' }, ...categories].map(group => h('button', { key: group.id, className: 'ec-category', 'aria-pressed': group.id === category, onClick: () => setCategory(group.id) }, group.name))),
      filtered.length ? h('div', { className: 'ec-grid' }, filtered.map(item => h('article', { className: 'ec-card', key: item.id },
        h('button', { className: 'ec-summon', disabled: busy || offline || item.availability?.state === 'blocked', 'aria-label': `召唤${item.name}`, onClick: () => summon(item) }, item.availability?.state === 'blocked' ? '依赖缺失' : item.availability?.state === 'needs-setup' ? '连接后召唤' : item.instantiated ? '对话' : '召唤'),
        h('button', { type: 'button', className: 'ec-card-main', 'aria-label': `查看${item.name}`, onClick: event => open(item, event) },
        h('div', { className: 'ec-card-heading' }, h(CatalogAvatar, { item }), h('div', { className: 'ec-card-copy' }, h('h3', null, item.name), h('p', null, item.description))), tags(item),
        h('div', { className: 'ec-card-footer' }, h('span', null, item.origin?.type === 'original' ? 'Studio 原创' : '社区模板', ' · v', item.version), h('span', null, '查看专家', h(Icon, { kind: 'arrow', size: 12 })))))))
        : h('div', { className: 'ec-empty' }, h('h3', null, '没有找到匹配的专家'), h('p', null, '试试其他关键词，或浏览全部专家。'), h('button', { className: 'ec-button', onClick: () => { setQuery(''); setCategory('all'); } }, '查看全部专家')),
      offline ? h('p', { className: 'ec-notice', role: 'status' }, '正在显示内置目录。连接 Studio Host 后即可创建专家。') : null,
      phase ? h('div', { className: 'ec-loading', role: 'status', 'aria-live': 'polite' }, h('span', { className: 'ec-spinner', 'aria-hidden': true }), h('span', null, phase),progress?.phase==='downloading'&&progress.total>0?h('progress',{'aria-label':'资源下载进度',value:progress.received,max:progress.total}):null,progress?.phase==='downloading'&&progress.total>0?h('span',null,`${bytes(progress.received)} / ${bytes(progress.total)} · ${Math.min(100,Math.floor(progress.received/progress.total*100))}%`):null,progress?.cancellable?h('button',{className:'ec-button',onClick:()=>{setProgress({...progress,cancellable:false});void remote.cancelTemplateWorkflow(progress.requestId);}},'取消'):null) : null,
      selected ? h('dialog', { className: 'ec-modal', ref: dialogRef, 'aria-labelledby': 'ec-detail-title', onKeyDown: event => { if (event.key === 'Escape') event.stopPropagation(); }, onCancel: event => { event.preventDefault(); close(); }, onClick: event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } } },
        h('button', { className: 'ec-close', 'aria-label': '关闭专家详情', onClick: close }, h(Icon, { kind: 'close', size: 18 })),
        h('div', { className: 'ec-detail-top' }, h(CatalogAvatar, { item: selected, size: 76 }), h('div', null, h('h2', { id: 'ec-detail-title' }, selected.name, h('small', null, selected.author)),
          h('button', { className: 'ec-button primary', disabled: busy || selected.availability?.state === 'blocked', onClick: () => summon(selected, plan ? choices : {}, plan?.task || '') }, busy ? '正在准备…' : selected.availability?.state === 'blocked' ? '依赖尚未补齐' : '召唤专家'),
          h('div', { className: 'ec-secondary' }, h('button', { className: 'ec-button', disabled: busy, onClick: () => configure(selected) }, '绑定知识与记忆'), h('button', { className: 'ec-button', disabled: busy, onClick: () => useTemplate(selected) }, '自定义创建')))),
        error ? h('p', { role: 'alert', className: 'ec-error' }, error) : null,
        selected.availability?.reasons?.length ? h('p', { className: 'ec-error', role: 'status' }, selected.availability.reasons.join('；')) : null,
        plan ? h('section', { className: 'ec-config', 'aria-label': '召唤选项' }, h('strong', null, '补齐资源，即可召唤'),
          h('p', null, '配套 Skill 自动安装；创建后仍可在“我的智能体”中编辑。长期记忆默认仅在你明确要求保存时写入。'),
          h('label', null, '模型', h('select', { value: choices.modelId || '', onChange: event => setChoices({ ...choices, modelId: event.target.value }) }, h('option', { value: '' }, '请选择模型'), plan.models.map(row => h('option', { key: row.id, value: row.id, disabled: row.disabled }, row.name)))),
          ...['knowledge-base', 'memory-instance'].filter(kind => plan.catalogs[kind]).map(kind => h('label', { key: kind }, kind === 'knowledge-base' ? '知识库' : '记忆库', h('select', { value: choices[kind] || '', onChange: event => setChoices({ ...choices, [kind]: event.target.value }) }, h('option', { value: '' }, plan.requirements.some(req => req.kind === kind && req.required) ? '请选择必需资源' : '暂不绑定'), plan.catalogs[kind].items.map(row => h('option', { key: row.id, value: row.id, disabled: row.disabled }, row.name || row.id))))),
          plan.missing.filter(value => value.kind === 'mcp').map(value => h('div', { key: value.key }, h('p', null, `请先连接并探测 ${value.label}${value.endpointUrl ? `（${value.endpointUrl}）` : ''}`), onResources ? h('button', { className: 'ec-button', onClick: () => onResources('mcp', value.key) }, '配置此连接器') : null)),
          h('button', { className: 'ec-button primary', disabled: busy, onClick: () => summon(selected, choices, plan.task || '') }, '确认召唤')) : null,
        h('p', { className: 'ec-detail-description' }, selected.description), tags(selected),
        h('div', { className: 'ec-meta' }, h('div', null, h('strong', null, `v${selected.version}`), h('small', null, '模板版本')), h('div', null, h('strong', null, '自由定制'), h('small', null, '角色、资源与记忆')), h('div', null, h('strong', null, selected.origin?.type === 'original' ? 'Studio 原创' : '社区模板'), h('small', null, '内容来源'))),
        h('section', { className: 'ec-detail-section' }, h('h3', null, h(Icon, { kind: 'bulb', size: 18 }), '专家帮你做'), selected.examples.map(example => h('button', { className: 'ec-example', key: example, disabled: busy, onClick: () => summon(selected, {}, example) }, h('span', null, example), h(Icon, { kind: 'chat', size: 18 })))),
        h('section', { className: 'ec-detail-section' }, h('h3', null, '交付与能力'), h('p', null, selected.deliverable),
          h('div', { className: 'ec-resources' }, selected.requirements.map((req, index) => h('span', { className: 'ec-tag', key: `${req.kind}-${index}` }, req.label || req.kind, req.required ? ' · 必需' : ' · 可选'))),
          h('p', null, selected.requirements.some(req => req.required) ? '创建时选择模型，并绑定上方标记的必需资源。' : '创建时选择模型，也可以绑定自己的知识库和记忆库。'),
          h('details', null, h('summary', null, '查看角色指令与运行方式'), h('p', null, selected.runtimes.map(type => labels[type]).join(' · ')), h('pre', null, selected.spec?.instructions?.system||'正在读取完整角色指令…')),
          h('p', { className: 'ec-notice' }, `ID: ${selected.id}`))) : null);
  };
}
