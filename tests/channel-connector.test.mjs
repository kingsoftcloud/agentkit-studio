import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { connectorUrl, createChannelConnector } from '../src/channel-connector.mjs';

const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('condition timed out'); };
async function gateway(t, invoke) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const frames = [], requests = [], peers = [];
  server.on('connection', (peer, request) => {
    peers.push(peer); requests.push(request);
    peer.on('message', raw => {
      const frame = JSON.parse(raw); frames.push(frame);
      if (frame.type === 'register') peer.send(JSON.stringify({ type: 'register_ok', payload: { protocol_version: 1, identity: frame.payload } }));
    });
  });
  const connector = createChannelConnector({ url: `http://127.0.0.1:${server.address().port}`, token: 'test-token', tenantId: 't', workspaceId: 'w', agentId: 'a', invoke, reconnectMs: 10 });
  t.after(async () => { connector.stop(); for (const peer of peers) peer.terminate(); await new Promise(resolve => server.close(resolve)); });
  connector.start(); await until(() => connector.status.connected);
  const send = (type, payload) => peers.at(-1).send(JSON.stringify({ type, payload }));
  return { connector, frames, requests, peers, send };
}

test('gateway v1 uses authenticated headers and stays responsive during concurrent tasks', async t => {
  let calls = 0;
  const g = await gateway(t, async request => {
    calls++;
    if (request.message === 'slow') return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    return 'native reply';
  });
  assert.equal(g.requests[0].headers.authorization, 'Bearer test-token');
  assert.equal(g.requests[0].url, '/agentengine/connector/v1');
  g.send('invoke', { task_id: 'slow', session_id: 's1', message: 'slow' });
  g.send('ping', {});
  g.send('invoke', { task_id: 'fast', session_id: 's2', message: 'fast' });
  await until(() => g.frames.some(frame => frame.type === 'complete'));
  assert.ok(g.frames.some(frame => frame.type === 'pong'));
  assert.equal(g.frames.find(frame => frame.type === 'complete').payload.result, 'native reply');
  g.send('invoke', { task_id: 'fast', session_id: 's2', message: 'fast' });
  g.send('cancel', { task_id: 'slow' });
  await until(() => g.frames.some(frame => frame.type === 'error' && frame.payload.code === 'cancelled'));
  assert.equal(calls, 2, 'duplicate task uses its terminal result');
  assert.equal(g.frames.filter(frame => frame.type === 'complete').length, 2);
  assert.equal(JSON.stringify(g.connector.status).includes('test-token'), false);
});

test('expired requests never execute, and disconnect cancels without replay', async t => {
  let calls = 0, aborted = false;
  const g = await gateway(t, request => {
    calls++;
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => { aborted = true; reject(request.signal.reason); }, { once: true }));
  });
  g.send('invoke', { task_id: 'expired', session_id: 's', message: 'expired', deadline: '2000-01-01T00:00:00Z' });
  await until(() => g.frames.some(frame => frame.payload.code === 'deadline_exceeded'));
  assert.equal(calls, 0);
  g.send('invoke', { task_id: 'running', session_id: 's', message: 'running' });
  await until(() => calls === 1);
  g.peers[0].terminate();
  await until(() => g.peers.length === 2 && g.connector.status.connected);
  assert.equal(aborted, true); assert.equal(calls, 1);
  g.send('invoke', { task_id: 'running', session_id: 's', message: 'running' });
  await until(() => g.frames.some(frame => frame.payload.code === 'connection_lost'));
  assert.equal(calls, 1);
});

test('remote cleartext, embedded credentials and credential query URLs are rejected', () => {
  const embeddedCredentialUrl = ['https://user:', 'secret@example.com'].join('');
  for (const url of ['http://example.com', 'ws://example.com', embeddedCredentialUrl, 'https://example.com?token=secret']) assert.throws(() => connectorUrl(url), { code: 'CHANNEL_URL_INVALID' });
  assert.equal(connectorUrl('https://example.com'), 'wss://example.com/agentengine/connector/v1');
});

test('an HTTP authentication rejection stays failed until credentials are changed', async t => {
  let requests = 0;
  const server = createServer();
  server.on('upgrade', (_request, socket) => { requests++; socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connector = createChannelConnector({ url: `http://127.0.0.1:${server.address().port}`, token: 'expired-token', tenantId: 't', workspaceId: 'w', agentId: 'a', invoke: async () => '', reconnectMs: 10 });
  t.after(async () => { connector.stop(); await new Promise(resolve => server.close(resolve)); });
  connector.start(); await until(() => connector.status.state === 'error');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(requests, 1); assert.equal(connector.status.lastError, 'authentication_failed');
});
