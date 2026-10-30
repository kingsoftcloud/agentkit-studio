/** Run only the shipped MCP client outside the checkout and its dependencies. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (!process.argv[2]) throw Error('usage: verify-native-mcp-package.mjs <Studio tarball>');
const directory = await mkdtemp(join(tmpdir(), 'studio-mcp-package-'));
try {
  execFileSync('tar', ['-xzf', resolve(process.argv[2]), '-C', directory,
    'package/dist/native-mcp-client.mjs', 'package/dist/native-mcp-client.json', 'package/dist/native-mcp-client.LICENSE.txt']);
  const verify = async () => {
    const assert = (await import('node:assert/strict')).default;
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const client = await import('./package/dist/native-mcp-client.mjs');
    const manifest = JSON.parse(await readFile('./package/dist/native-mcp-client.json', 'utf8'));
    assert.equal(manifest.sha256, createHash('sha256').update(await readFile('./package/dist/native-mcp-client.mjs')).digest('hex'));
    assert.ok(manifest.dependencies.some(row => row.name === '@modelcontextprotocol/sdk' && row.version === '1.31.0'));
    assert.ok((await readFile('./package/dist/native-mcp-client.LICENSE.txt', 'utf8')).includes('@modelcontextprotocol/sdk@1.31.0'));
    for (const name of ['StdioClientTransport', 'SSEClientTransport', 'StreamableHTTPClientTransport']) {
      assert.equal(client[name].jsonParserContract, 'mcp.json-parser/v1');
    }
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      const result = message.method === 'initialize'
        ? JSON.stringify({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'isolated', version: '1' } })
        : '{"content":[],"structuredContent":{"id":9007199254740993}}';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`{"jsonrpc":"2.0","id":${message.id},"result":${result}}`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const connection = new client.Client({ name: 'isolated-package-proof', version: '1' });
    try {
      // Exercise the shipped parser seam; production Native parsing is tested
      // separately by the SDK profile with its real core/ledger/model ports.
      const transport = new client.StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
        jsonParser: text => JSON.parse(text, (_key, value, context) => typeof value === 'number'
          && /^-?\d+$/.test(context.source) && !Number.isSafeInteger(value) ? BigInt(context.source) : value),
      });
      await connection.connect(transport);
      const result = await connection.callTool({ name: 'exact', arguments: {} });
      assert.equal(result.structuredContent.id, 9007199254740993n);
    } finally {
      await connection.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    console.log('PASS: packed MCP client runs outside the checkout with PATH=/no-programs and no installed dependencies; exact HTTP result retained.');
  };
  await writeFile(join(directory, 'verify.mjs'), `(${verify.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`);
  const child = spawn(process.execPath, [join(directory, 'verify.mjs')], { cwd: directory,
    env: { ...process.env, PATH: '/no-programs', NODE_PATH: '' }, stdio: 'inherit' });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (exitCode !== 0) throw Error(`Isolated MCP package verification failed (${exitCode})`);
} finally { await rm(directory, { recursive: true, force: true }); }
