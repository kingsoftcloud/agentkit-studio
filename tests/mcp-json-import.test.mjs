import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpCredentialName, parseMcpJsonImport, MCP_JSON_IMPORT_CONTRACT } from '../src/client/state/mcp-json-import.mjs';
import { createLocalMcpStore } from '../src/local-mcp-store.mjs';

const HOST_CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_./:-]{0,127}$/;
const entryOf = (result, index = 0) => result.entries[index];

test('bare single-server config with a literal custom auth header is recognized without leaking it into the declaration', () => {
  const result = parseMcpJsonImport(JSON.stringify({
    'custom-header-mcp': {
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { 'X-Service-Token': 'fixture-custom-header-token' },
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.contract, MCP_JSON_IMPORT_CONTRACT);
  assert.equal(result.entries.length, 1);
  const entry = entryOf(result);
  assert.equal(entry.key, 'custom-header-mcp');
  assert.equal(entry.displayName, 'custom-header-mcp');
  assert.equal(entry.transport, 'http');
  assert.equal(entry.endpointUrl, 'https://mcp.example.test/mcp');
  assert.deepEqual(entry.publicHeaders, {});
  assert.equal(entry.credentialHeaders.length, 1);
  const [credential] = entry.credentialHeaders;
  assert.equal(credential.target, 'header');
  assert.equal(credential.key, 'X-Service-Token');
  assert.equal(credential.value, 'fixture-custom-header-token');
  assert.match(credential.reference, HOST_CREDENTIAL_NAME);
  assert.equal(entry.envRefs['X-Service-Token'], `env://${credential.reference}`);
  // The only declaration-shaped data names the reference, never the secret.
  assert.doesNotMatch(JSON.stringify(entry.publicHeaders), /fixture-custom-header-token/);
  assert.equal(entry.errors.length, 0);
});

test('mcpServers wrapper keeps placeholder references, markdown endpoints and public headers', () => {
  const result = parseMcpJsonImport(JSON.stringify({ mcpServers: {
    'metaso-inner': {
      type: 'streamable-http', name: '金山云星流_秘塔AI搜索-inner', description: 'search',
      url: '[https://metaso-inner.example/mcp](https://metaso-inner.example/mcp)',
      headers: { Authorization: 'Bearer ${ksc_aipro_API_KEY}', accept: 'application/json', 'x-request-source': 'studio' },
    },
  } }));
  assert.equal(result.ok, true);
  const entry = entryOf(result);
  assert.equal(entry.transport, 'http');
  assert.equal(entry.endpointUrl, 'https://metaso-inner.example/mcp');
  assert.deepEqual(entry.publicHeaders, { accept: 'application/json', 'x-request-source': 'studio' });
  const authorization = entry.credentialHeaders.find(row => row.key === 'Authorization');
  assert.equal(authorization.reference, 'ksc_aipro_API_KEY');
  assert.equal(authorization.value, undefined);
  assert.equal(entry.envRefs.Authorization, 'env://ksc_aipro_API_KEY');
});

test('sse and stdio transports are recognized instead of being collapsed into http', () => {
  const sse = parseMcpJsonImport(JSON.stringify({ mcpServers: { search: { type: 'sse', url: 'https://sse.example/mcp' } } }));
  assert.equal(entryOf(sse).transport, 'sse');
  const stdio = parseMcpJsonImport(JSON.stringify({ mcpServers: {
    local: { command: 'node', args: ['path with spaces/server.js', '--format=json'], env: { MODE: 'public', API_KEY: '${LOCAL_API_KEY}' } },
  } }));
  const entry = entryOf(stdio);
  assert.equal(entry.transport, 'stdio');
  assert.equal(entry.command, 'node');
  assert.deepEqual(entry.args, ['path with spaces/server.js', '--format=json']);
  assert.deepEqual(entry.publicEnv, { MODE: 'public' });
  assert.deepEqual(entry.envRefs, { API_KEY: 'env://LOCAL_API_KEY' });
});

test('VS Code servers wrapper, bare name maps, arrays and unnamed single descriptors are all supported', () => {
  const servers = parseMcpJsonImport(JSON.stringify({ servers: { one: { type: 'http', url: 'https://one.example/mcp' }, two: { type: 'http', url: 'https://two.example/mcp' } } }));
  assert.equal(servers.ok, true);
  assert.deepEqual(servers.entries.map(entry => entry.key), ['one', 'two']);
  const bare = parseMcpJsonImport(JSON.stringify({ alpha: { type: 'http', url: 'https://alpha.example/mcp' }, beta: { command: 'npx', args: ['-y', '@acme/beta-mcp'] } }));
  assert.deepEqual(bare.entries.map(entry => [entry.key, entry.transport]), [['alpha', 'http'], ['beta', 'stdio']]);
  const array = parseMcpJsonImport(JSON.stringify([{ name: 'named', type: 'http', url: 'https://named.example/mcp' }]));
  assert.deepEqual(array.entries.map(entry => entry.key), ['named']);
  const unnamed = parseMcpJsonImport(JSON.stringify({ type: 'http', url: 'https://single-host.example/mcp' }));
  assert.equal(unnamed.ok, true);
  assert.equal(entryOf(unnamed).key, 'single-host');
  assert.deepEqual(unnamed.warnings, []);
});

test('custom header placeholders resolve to the declared credential name and public headers stay literal', () => {
  const result = parseMcpJsonImport(JSON.stringify({ mcpServers: { tenant: {
    type: 'http', url: 'https://tenant.example/mcp',
    headers: { 'X-Tenant': '${user_config.TENANT}', 'X-Service-Token': '${env:AGENT_TOKEN}', 'X-Trace': 'fixed' },
  } } }));
  const entry = entryOf(result);
  assert.deepEqual(entry.publicHeaders, {});
  assert.deepEqual(entry.credentialHeaders.map(row => [row.key, row.reference]), [['X-Tenant', 'TENANT'], ['X-Service-Token', 'AGENT_TOKEN'], ['X-Trace', entry.credentialHeaders[2].reference]]);
  assert.match(entry.credentialHeaders[2].reference, HOST_CREDENTIAL_NAME);
  assert.equal(entry.credentialHeaders[2].value, 'fixed');
  assert.deepEqual(entry.envRefs, { 'X-Tenant': 'env://TENANT', 'X-Service-Token': 'env://AGENT_TOKEN', 'X-Trace': entry.envRefs['X-Trace'] });
});

test('literal authorization values are preserved as credential material instead of public headers', () => {
  const result = parseMcpJsonImport(JSON.stringify({ mcpServers: { api: { type: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer abc123' } } } }));
  const entry = entryOf(result);
  assert.deepEqual(entry.publicHeaders, {});
  assert.equal(entry.credentialHeaders[0].key, 'Authorization');
  assert.equal(entry.credentialHeaders[0].value, 'Bearer abc123');
  assert.match(entry.credentialHeaders[0].reference, HOST_CREDENTIAL_NAME);
});

test('invalid JSON, unknown shapes, missing endpoints and unsafe URLs produce actionable results', () => {
  assert.deepEqual(parseMcpJsonImport('').ok, false);
  assert.match(parseMcpJsonImport('{ broken').error, /JSON 格式无法解析/);
  const unknown = parseMcpJsonImport(JSON.stringify({ unrelated: 'value' }));
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /没有找到 MCP Server 配置/);
  const missing = parseMcpJsonImport(JSON.stringify({ mcpServers: { broken: { type: 'http' } } }));
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.entries[0].errors, ['缺少可直接访问的 http(s) MCP 地址']);
  const unsafe = parseMcpJsonImport(JSON.stringify({ mcpServers: { broken: { type: 'http', url: 'https://user:pass@example.test/mcp' } } }));
  assert.ok(unsafe.entries[0].errors.some(message => /用户名或密码/.test(message)));
  const query = parseMcpJsonImport(JSON.stringify({ mcpServers: { token: { type: 'http', url: 'https://example.test/mcp?token=abc' } } }));
  assert.ok(query.entries[0].warnings.some(message => /查询参数/.test(message)));
  assert.equal(query.warnings.length, 1);
  assert.match(query.warnings[0], /^token：/);
});

test('generated credential names satisfy the Host credential-name contract and never collide across endpoints', () => {
  const names = [mcpCredentialName('custom-header-mcp', 'X-Service-Token', 'https://pre.example/mcp'),
    mcpCredentialName('数据代理', 'Authorization', 'std npx'),
    mcpCredentialName('a'.repeat(200), 'X-Very-Long-Custom-Authorization-Header-Name-For-Testing', 'https://example.test/mcp?x=1')];
  for (const name of names) {
    assert.match(name, HOST_CREDENTIAL_NAME);
    assert.ok(name.length <= 128);
  }
  assert.equal(mcpCredentialName('custom-header-mcp', 'X-Service-Token', 'https://pre.example/mcp'),
    mcpCredentialName('custom-header-mcp', 'X-Service-Token', 'https://pre.example/mcp'));
  assert.notEqual(mcpCredentialName('custom-header-mcp', 'X-Service-Token', 'https://pre.example/mcp'),
    mcpCredentialName('custom-header-mcp', 'X-Service-Token', 'https://prod.example/mcp'));
});

test('templated header or env values that cannot be preserved exactly are reported instead of silently altered', () => {
  const headers = parseMcpJsonImport(JSON.stringify({ mcpServers: { mixed: {
    type: 'http', url: 'https://mixed.example/mcp',
    headers: { Authorization: 'Bearer ${TOKEN}', 'X-Signature': 'sig_${TOKEN}', accept: 'application/json' },
  } } }));
  const entry = entryOf(headers);
  assert.deepEqual(entry.credentialHeaders.map(row => [row.key, row.reference]), [['Authorization', 'TOKEN'], ['X-Signature', 'TOKEN']]);
  assert.equal(entry.warnings.some(message => /Authorization/.test(message)), false);
  assert.ok(entry.warnings.some(message => /X-Signature/.test(message) && /前缀/.test(message)));
  const env = parseMcpJsonImport(JSON.stringify({ mcpServers: { local: { command: 'node', env: { FLAG: '${MODE}-suffix' } } } }));
  assert.ok(entryOf(env).warnings.some(message => /FLAG/.test(message) && /前后缀/.test(message)));
});

test('wrapper arrays and quoted string args are recognized', () => {
  const wrapped = parseMcpJsonImport(JSON.stringify({ mcpServers: [{ name: 'array-one', type: 'http', url: 'https://one.example/mcp' }] }));
  assert.deepEqual(wrapped.entries.map(entry => [entry.key, entry.endpointUrl]), [['array-one', 'https://one.example/mcp']]);
  const stdio = parseMcpJsonImport(JSON.stringify({ mcpServers: { node: { command: 'node', args: '"path with spaces/server.js" --format=json' } } }));
  assert.deepEqual(entryOf(stdio).args, ['path with spaces/server.js', '--format=json']);
});

test('recognized public headers are exactly what the Host store accepts and client-owned protocol headers are dropped', async () => {
  const result = parseMcpJsonImport(JSON.stringify({ mcpServers: { search: {
    type: 'http', url: 'https://search.example/mcp',
    headers: { accept: 'application/json', 'x-request-source': 'studio', 'x-dsh-client': 'studio',
      'mcp-protocol-version': '2025-03-26', 'X-Service-Token': '${AGENT_TOKEN}', 'x-bad-value': { nested: true } },
  } } }));
  const entry = entryOf(result);
  assert.deepEqual(Object.keys(entry.publicHeaders).sort(), ['accept', 'x-dsh-client', 'x-request-source']);
  // The MCP client negotiates the protocol version itself; a pasted value is dropped with a warning.
  assert.equal(entry.credentialHeaders.some(row => row.key === 'mcp-protocol-version'), false);
  assert.equal('mcp-protocol-version' in entry.envRefs, false);
  assert.ok(entry.warnings.some(message => /mcp-protocol-version 由 MCP 客户端协商/.test(message)));
  assert.ok(entry.warnings.some(message => /x-bad-value/.test(message)));
  const store = createLocalMcpStore({ storeDir: await mkdtemp(join(tmpdir(), 'mcp-import-store-')) });
  const record = await store.create({ displayName: entry.displayName, server: {
    name: entry.key, transport: entry.transport, endpointUrl: entry.endpointUrl,
    headers: entry.publicHeaders, envRefs: entry.envRefs,
  } });
  assert.deepEqual(record.server.headers, entry.publicHeaders);
  assert.equal(record.server.envRefs['X-Service-Token'], 'env://AGENT_TOKEN');
});

test('variable endpoints, malformed placeholders and credential-like stdio env values are reported safely', () => {
  const variable = parseMcpJsonImport(JSON.stringify({ mcpServers: { host: { type: 'http', url: 'https://${HOST}/mcp' } } }));
  assert.ok(entryOf(variable).errors.some(message => /\$\{\.\.\.\}/.test(message)));
  const malformed = parseMcpJsonImport(JSON.stringify({ mcpServers: { host: { type: 'http', url: 'https://host.example/mcp', headers: { 'X-Service-Token': '${1BAD}' } } } }));
  assert.ok(entryOf(malformed).warnings.some(message => /占位符无法解析/.test(message)));
  const allowlisted = parseMcpJsonImport(JSON.stringify({ mcpServers: { host: { type: 'http', url: 'https://host.example/mcp', headers: { 'x-request-source': '${token' } } } }));
  assert.deepEqual(entryOf(allowlisted).publicHeaders, {});
  assert.equal(entryOf(allowlisted).credentialHeaders[0].key, 'x-request-source');
  const database = parseMcpJsonImport(JSON.stringify({ mcpServers: { local: { command: 'node', env: {
    DATABASE_URL: 'postgres://user:pw@db.example/app', EMPTY_USER: 'postgres://:pw@db.example/app',
    SHORT_TOKEN: 'Bearer abc', MODE: 'production',
  } } } }));
  const entry = entryOf(database);
  assert.deepEqual(entry.publicEnv, { MODE: 'production' });
  assert.deepEqual(entry.credentialHeaders.map(row => row.key), ['DATABASE_URL', 'EMPTY_USER', 'SHORT_TOKEN']);
  assert.equal(entry.credentialHeaders[0].value, 'postgres://user:pw@db.example/app');
});
