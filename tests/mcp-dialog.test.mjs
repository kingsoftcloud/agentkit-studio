import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceDialogs } from '../src/client/components/resource-dialogs.mjs';
import { mcpCredentialName } from '../src/client/state/mcp-json-import.mjs';

test('failed MCP probe retry updates the saved resource instead of creating duplicates', async () => {
  const state = [], calls = [], saved = [];
  let cursor = 0, refreshed = 0, closed = 0;
  const useState = initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  };
  const host = {
    createMcpResource: async payload => { saved.push(payload); calls.push('create'); return { resourceId: 'saved-mcp' }; },
    updateMcpResource: async (id,payload) => { saved.push(payload); calls.push(['update', id]); return { resourceId: id }; },
    putCredential: async () => { throw new Error('existing references must not overwrite credentials'); },
    probeMcpResource: async id => { calls.push(['probe', id]); throw new Error('Endpoint 连接失败'); },
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const { McpResourceDialog: Dialog } = createResourceDialogs({ ui: { React: { createElement: h, useState }, BRAND: {}, buttonStyle: () => ({}), inputStyle: () => ({}), ResourceDialog: 'dialog' }, hostRemote: host });
  const render = () => { cursor = 0; return Dialog({ onCreated: () => { refreshed += 1; }, onClose: () => { closed += 1; } }); };
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
  const field = placeholder => walk(render()).find(node => node.type === 'input' && node.props.placeholder === placeholder);
  const fill = (placeholder, value) => field(placeholder).props.onChange({ target: { value } });
  fill('例如：企业搜索', '测试 MCP'); fill('例如：enterprise-search', 'test-mcp'); fill('例如：https://mcp.example.com', 'http://127.0.0.1:1');
  const submit = async () => walk(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  fill('例如：SEARCH_API_KEY', 'E2E_EXISTING_A');
  await submit();
  fill('例如：SEARCH_API_KEY', 'E2E_EXISTING_B');
  await submit();
  assert.equal(saved[0].server.envRefs.Authorization,'env://E2E_EXISTING_A');
  assert.equal(saved[1].server.envRefs.Authorization,'env://E2E_EXISTING_B');
  assert.deepEqual(calls, ['create', ['probe', 'saved-mcp'], ['update', 'saved-mcp'], ['probe', 'saved-mcp']]);
  assert.equal(refreshed, 2);
  assert.equal(closed, 0);
  assert.match(JSON.stringify(render()), /配置已保存.*探测失败/);
});

test('MCP dialog imports streamable-http mcpServers JSON without retaining inline credentials', async () => {
  const state = [];
  let cursor = 0;
  const useState = initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const host = { createMcpResource: async () => ({ resourceId: 'mcp-json' }), probeMcpResource: async () => ({ toolCount: 1 }) };
  const { McpResourceDialog: Dialog } = createResourceDialogs({ ui: { React: { createElement: h, useState }, BRAND: {}, buttonStyle: () => ({}), inputStyle: () => ({}), ResourceDialog: 'dialog' }, hostRemote: host });
  const render = () => { cursor = 0; return Dialog({ onClose() {} }); };
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
  const json = JSON.stringify({ mcpServers: { 'metaso-inner': { type: 'streamable-http', name: '金山云星流_秘塔AI搜索-inner', description: 'search', url: '[https://metaso-inner.example/mcp](https://metaso-inner.example/mcp)', headers: { Authorization: 'Bearer ${ksc_aipro_API_KEY}' } } } });
  let node = walk(render()).find(item => item.type === 'textarea' && item.props['aria-label'] === 'MCP JSON');
  node.props.onChange({ target: { value: json } });
  node = walk(render()).find(item => item.type === 'button' && item.children.includes('识别并填充'));
  node.props.onClick();
  const tree = render();
  const field = placeholder => walk(tree).find(item => item.type === 'input' && item.props.placeholder === placeholder);
  assert.equal(field('例如：enterprise-search').props.value, 'metaso-inner');
  assert.equal(field('例如：https://mcp.example.com').props.value, 'https://metaso-inner.example/mcp');
  assert.equal(field('例如：SEARCH_API_KEY').props.value, 'ksc_aipro_API_KEY');
  assert.equal(field('不会写入资源目录').props.value, '');
  assert.match(JSON.stringify(tree), /Authorization=env:\/\/ksc_aipro_API_KEY/);
});

// --- JSON recognition and custom-header credential handling -----------------

function createDialogHarness({ host, resource } = {}) {
  const state = [], calls = [];
  let cursor = 0;
  const useState = initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const SecretInput = ({ label, value = '', onChange, placeholder }) => h('input', { type: 'password', 'aria-label': label, value, onChange, placeholder });
  const { McpResourceDialog: Dialog } = createResourceDialogs({ ui: { React: { createElement: h, useState }, SecretInput, BRAND: {}, buttonStyle: () => ({}), inputStyle: () => ({}), ResourceDialog: 'dialog' }, hostRemote: host });
  const render = () => { cursor = 0; return Dialog({ resource, onClose() { calls.push('close'); }, onCreated() { calls.push('created'); } }); };
  const walk = node => {
    if (!node || typeof node !== 'object') return [];
    // The harness has no React runtime: expand function components (SecretInput)
    // so their rendered inputs are visible to assertions.
    if (typeof node.type === 'function') return walk(node.type(node.props));
    return [node, ...node.children.flatMap(walk)];
  };
  const find = predicate => walk(render()).find(predicate);
  const byPlaceholder = placeholder => find(node => node.type === 'input' && node.props.placeholder === placeholder);
  const byAria = label => find(node => node.type === 'input' && node.props['aria-label'] === label);
  const importJson = text => {
    find(node => node.type === 'textarea' && node.props['aria-label'] === 'MCP JSON').props.onChange({ target: { value: text } });
    find(node => node.type === 'button' && node.children.includes('识别并填充')).props.onClick();
  };
  const submit = () => find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const transport = () => find(node => node.type === 'select' && node.children.some(option => option.children?.includes('SSE'))).props.value;
  return { render, walk, find, byPlaceholder, byAria, importJson, submit, transport, calls };
}

function createRecordingHost() {
  const calls = [], saved = [];
  return { calls, saved,
    putCredential: async (...args) => { calls.push(['credential', ...args]); },
    createMcpResource: async payload => { saved.push(payload); calls.push('create'); return { resourceId: 'mcp-recorded' }; },
    updateMcpResource: async (id, payload) => { saved.push(payload); calls.push(['update', id]); return { resourceId: id }; },
    probeMcpResource: async id => { calls.push(['probe', id]); return { toolCount: 1 }; } };
}

test('bare single-server JSON with a literal custom auth header fills the form without writing the secret into the declaration', async () => {
  const host = createRecordingHost();
  const harness = createDialogHarness({ host });
  harness.importJson(JSON.stringify({ 'custom-header-mcp': { type: 'http', url: 'https://mcp.example.test/mcp', headers: { 'X-Service-Token': 'fixture-custom-header-token' } } }));
  const tree = harness.render();
  const field = placeholder => harness.walk(tree).find(node => node.type === 'input' && node.props.placeholder === placeholder);
  const endpoint = 'https://mcp.example.test/mcp';
  const expectedCredential = mcpCredentialName('custom-header-mcp', 'X-Service-Token', endpoint);
  assert.equal(field('例如：enterprise-search').props.value, 'custom-header-mcp');
  assert.equal(field('例如：https://mcp.example.com').props.value, endpoint);
  assert.equal(harness.transport(), 'http');
  assert.match(JSON.stringify(tree), new RegExp(`X-Service-Token=env://${expectedCredential}`));
  assert.match(JSON.stringify(tree), /认证：X-Service-Token/);
  assert.equal(harness.byPlaceholder('仅保存到本机凭证服务').props.value, 'fixture-custom-header-token');
  await harness.submit();
  assert.deepEqual(host.calls.filter(call => Array.isArray(call) && call[0] === 'credential'),
    [['credential', expectedCredential, 'fixture-custom-header-token']]);
  const payload = host.saved[0];
  assert.deepEqual(payload.server.envRefs, { 'X-Service-Token': `env://${expectedCredential}` });
  assert.equal(payload.server.headers, undefined);
  assert.equal('Authorization' in payload.server.envRefs, false);
  assert.equal(payload.server.env, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /fixture-custom-header-token/);
  assert.deepEqual(host.calls.filter(call => Array.isArray(call) && call[0] === 'probe'), [['probe', 'mcp-recorded']]);
});

test('multiple servers expose a selector and switching refills the form including the sse transport', () => {
  const host = createRecordingHost();
  const harness = createDialogHarness({ host });
  harness.importJson(JSON.stringify({ servers: {
    one: { type: 'sse', url: 'https://one.example/mcp' },
    two: { type: 'http', url: 'https://two.example/mcp', headers: { 'X-Api-Key': '${TWO_KEY}' } },
  } }));
  const selector = harness.find(node => node.type === 'select' && node.props['aria-label'] === '识别到的 MCP');
  assert.deepEqual(selector.children.map(option => option.props.value), ['0', '1']);
  assert.equal(harness.transport(), 'sse');
  assert.equal(harness.byPlaceholder('例如：https://mcp.example.com').props.value, 'https://one.example/mcp');
  selector.props.onChange({ target: { value: '1' } });
  assert.equal(harness.transport(), 'http');
  assert.equal(harness.byPlaceholder('例如：https://mcp.example.com').props.value, 'https://two.example/mcp');
  assert.match(JSON.stringify(harness.render()), /X-Api-Key=env:\/\/TWO_KEY/);
});

test('placeholder custom headers render a credential input and save the entered value as a reference', async () => {
  const host = createRecordingHost();
  const harness = createDialogHarness({ host });
  harness.importJson(JSON.stringify({ mcpServers: { search: { type: 'http', url: 'https://search.example/mcp', headers: { 'X-Service-Token': '${AGENT_TOKEN}' } } } }));
  const credential = harness.byPlaceholder('仅保存到本机凭证服务');
  assert.equal(credential.props.value, '');
  credential.props.onChange({ target: { value: 'typed-token' } });
  await harness.submit();
  assert.deepEqual(host.calls.filter(call => Array.isArray(call) && call[0] === 'credential'), [['credential', 'AGENT_TOKEN', 'typed-token']]);
  assert.deepEqual(host.saved[0].server.envRefs, { 'X-Service-Token': 'env://AGENT_TOKEN' });
  assert.doesNotMatch(JSON.stringify(host.saved[0]), /typed-token/);
});

test('unrecognized JSON keeps the form untouched and reports an actionable error', () => {
  const harness = createDialogHarness({ host: createRecordingHost() });
  harness.importJson(JSON.stringify({ unrelated: 'value' }));
  const tree = JSON.stringify(harness.render());
  assert.match(tree, /没有找到 MCP Server 配置/);
  assert.equal(harness.find(node => node.props && node.props['data-studio-mcp-recognition'] === 'true'), undefined);
});

test('unsafe endpoints and literal env references are rejected before anything is saved', async () => {
  const host = createRecordingHost();
  const harness = createDialogHarness({ host });
  harness.importJson(JSON.stringify({ mcpServers: { unsafe: { type: 'http', url: 'https://user:pass@example.test/mcp' } } }));
  await harness.submit();
  assert.deepEqual(host.calls.filter(call => call === 'create'), []);
  assert.match(JSON.stringify(harness.render()), /用户名或密码/);

  const literalHost = createRecordingHost();
  const literal = createDialogHarness({ host: literalHost });
  literal.importJson(JSON.stringify({ mcpServers: { search: { type: 'http', url: 'https://search.example/mcp', headers: { 'X-Service-Token': '${AGENT_TOKEN}' } } } }));
  literal.byPlaceholder('例如：API_KEY=env://SEARCH_API_KEY').props.onChange({ target: { value: 'X-Service-Token=inline-plaintext-secret' } });
  await literal.submit();
  assert.deepEqual(literalHost.calls.filter(call => call === 'create'), []);
  assert.match(JSON.stringify(literal.render()), /env:\/\/凭证名称/);
});

test('switching multi-server entries never saves the previous entry credential', async () => {
  const host = createRecordingHost();
  const harness = createDialogHarness({ host });
  harness.importJson(JSON.stringify({ servers: {
    one: { type: 'http', url: 'https://one.example/mcp', headers: { 'X-One': 'secret-one' } },
    two: { type: 'http', url: 'https://two.example/mcp', headers: { 'X-Two': 'secret-two' } },
  } }));
  harness.find(node => node.type === 'select' && node.props['aria-label'] === '识别到的 MCP').props.onChange({ target: { value: '1' } });
  harness.byPlaceholder('例如：https://mcp.example.com').props.onChange({ target: { value: 'https://two.example/mcp' } });
  await harness.submit();
  const credentials = host.calls.filter(call => Array.isArray(call) && call[0] === 'credential');
  assert.equal(credentials.length, 1);
  assert.deepEqual(credentials[0].slice(1), [mcpCredentialName('two', 'X-Two', 'https://two.example/mcp'), 'secret-two']);
  assert.deepEqual(host.saved[0].server.envRefs, { 'X-Two': `env://${mcpCredentialName('two', 'X-Two', 'https://two.example/mcp')}` });
  assert.doesNotMatch(JSON.stringify(host.saved[0]), /secret-one|X-One/);
});

test('protocol and allowlisted headers from JSON do not block saving', async () => {
  const host = createRecordingHost();
  const harness = createDialogHarness({ host });
  harness.importJson(JSON.stringify({ mcpServers: { search: { type: 'http', url: 'https://search.example/mcp', headers: {
    accept: 'application/json', 'x-request-source': 'studio', 'mcp-protocol-version': '2025-03-26', 'X-Service-Token': '${AGENT_TOKEN}',
  } } } }));
  await harness.submit();
  assert.deepEqual(host.calls.filter(call => call === 'create'), ['create']);
  assert.deepEqual(host.saved[0].server.headers, { accept: 'application/json', 'x-request-source': 'studio' });
  assert.equal(host.saved[0].server.envRefs['X-Service-Token'], 'env://AGENT_TOKEN');
  // Client-negotiated protocol headers are dropped, not credentialized.
  assert.equal('mcp-protocol-version' in host.saved[0].server.envRefs, false);
  assert.match(JSON.stringify(harness.render()), /mcp-protocol-version 由 MCP 客户端协商/);
});

test('editing a legacy record with a bare credential reference normalizes it to env://', async () => {
  const host = createRecordingHost();
  const harness = createDialogHarness({ host, resource: {
    resourceId: 'mcp-local-0000000000000001', name: 'legacy', displayName: 'Legacy',
    server: { name: 'legacy', transport: 'http', endpointUrl: 'https://legacy.example/mcp', envRefs: { 'X-Service-Token': 'LEGACY_TOKEN' } },
  } });
  assert.match(JSON.stringify(harness.render()), /X-Service-Token=env:\/\/LEGACY_TOKEN/);
  await harness.submit();
  assert.deepEqual(host.saved[0].server.envRefs, { 'X-Service-Token': 'env://LEGACY_TOKEN' });
});

test('MCP JSON textarea grows with the pasted document instead of staying five rows', () => {
  const harness = createDialogHarness({ host: createRecordingHost() });
  const textarea = () => harness.find(node => node.type === 'textarea' && node.props['aria-label'] === 'MCP JSON');
  assert.ok(textarea().props.rows >= 6);
  textarea().props.onChange({ target: { value: JSON.stringify({ mcpServers: {
    one: { type: 'http', url: 'https://one.example/mcp', headers: { 'X-One': '${ONE}' } },
    two: { type: 'http', url: 'https://two.example/mcp', headers: { 'X-Two': '${TWO}' } },
  } }, null, 2) } });
  const rows = textarea().props.rows;
  assert.ok(rows > 6 && rows <= 20, `expected the textarea to grow, got ${rows} rows`);
  textarea().props.onChange({ target: { value: '{"mcpServers":{}}' } });
  assert.equal(textarea().props.rows, 6, 'short input falls back to the minimum height');
});

test('Header credential section is always visible and manual add creates the credential row', async () => {
  const host = createRecordingHost();
  const harness = createDialogHarness({ host });
  assert.match(JSON.stringify(harness.render()), /认证 Header \/ 环境变量凭证/);
  assert.match(JSON.stringify(harness.render()), /还没有认证 Header 凭证/);
  harness.find(node => node.type === 'input' && node.props['aria-label'] === '新增 Header 名称').props.onChange({ target: { value: 'X-KIP-Token' } });
  harness.find(node => node.type === 'input' && node.props['aria-label'] === '新增 Header 凭证名称').props.onChange({ target: { value: 'KIP_TOKEN' } });
  harness.find(node => node.type === 'button' && node.children.includes('添加')).props.onClick();
  const tree = harness.render();
  assert.match(JSON.stringify(tree), /X-KIP-Token=env:\/\/KIP_TOKEN/);
  assert.match(JSON.stringify(tree), /X-KIP-Token · KIP_TOKEN/);
  harness.byPlaceholder('例如：企业搜索').props.onChange({ target: { value: 'KIP MCP' } });
  harness.byPlaceholder('例如：enterprise-search').props.onChange({ target: { value: 'kip-mcp' } });
  harness.byPlaceholder('例如：https://mcp.example.com').props.onChange({ target: { value: 'https://kip.example.test/mcp' } });
  await harness.submit();
  assert.deepEqual(host.saved[0].server.envRefs, { 'X-KIP-Token': 'env://KIP_TOKEN' });
  assert.equal(host.saved[0].server.headers, undefined);
  assert.deepEqual(host.calls.filter(call => Array.isArray(call) && call[0] === 'credential'), []);
});

test('manual Authorization entry reuses the dedicated credential fields instead of a duplicate envRef', () => {
  const harness = createDialogHarness({ host: createRecordingHost() });
  harness.find(node => node.type === 'input' && node.props['aria-label'] === '新增 Header 名称').props.onChange({ target: { value: 'Authorization' } });
  harness.find(node => node.type === 'input' && node.props['aria-label'] === '新增 Header 凭证名称').props.onChange({ target: { value: 'AUTH_TOKEN' } });
  harness.find(node => node.type === 'button' && node.children.includes('添加')).props.onClick();
  const tree = harness.render();
  assert.equal(harness.byPlaceholder('例如：SEARCH_API_KEY').props.value, 'AUTH_TOKEN');
  assert.doesNotMatch(JSON.stringify(tree), /Authorization=env:\/\//);
});

test('manual credential entry rejects malformed names with an actionable message', () => {
  const harness = createDialogHarness({ host: createRecordingHost() });
  harness.find(node => node.type === 'input' && node.props['aria-label'] === '新增 Header 名称').props.onChange({ target: { value: 'X Bad Header' } });
  harness.find(node => node.type === 'input' && node.props['aria-label'] === '新增 Header 凭证名称').props.onChange({ target: { value: 'KIP_TOKEN' } });
  harness.find(node => node.type === 'button' && node.children.includes('添加')).props.onClick();
  assert.match(JSON.stringify(harness.render()), /Header 名称格式无效/);
  harness.find(node => node.type === 'input' && node.props['aria-label'] === '新增 Header 名称').props.onChange({ target: { value: 'X-KIP-Token' } });
  harness.find(node => node.type === 'input' && node.props['aria-label'] === '新增 Header 凭证名称').props.onChange({ target: { value: 'bad name' } });
  harness.find(node => node.type === 'button' && node.children.includes('添加')).props.onClick();
  assert.match(JSON.stringify(harness.render()), /凭证名称需要以字母或下划线开头/);
});
