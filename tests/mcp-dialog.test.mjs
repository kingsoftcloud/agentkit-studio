import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fragment = await readFile(new URL('../src/client-fragments/04-create-edit-and-resources.js', import.meta.url), 'utf8');
const source = fragment.slice(fragment.indexOf('function McpResourceDialog'), fragment.indexOf('function formatResourceSize'));

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
  const Dialog = new Function('useState', 'h', 'hostRemote', 'BRAND', 'buttonStyle', 'inputStyle', 'ResourceDialog', `${source}; return McpResourceDialog;`)(useState, h, host, {}, () => ({}), () => ({}), 'dialog');
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
