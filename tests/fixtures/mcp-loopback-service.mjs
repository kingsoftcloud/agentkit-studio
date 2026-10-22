/** Real MCP transports, confined to loopback and synthetic credentials. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function createMcpLoopbackService({ transport, getCredential, onCall }) {
  const sessions = new Map(), servers = new Set();
  const receipt = `EXCLUSIVE_${transport}_${randomUUID()}`;
  const toolName = `probe_${transport}`;
  const counts = { requests: 0, authenticated: 0, initialized: 0, listed: 0, called: 0 };
  const mcp = () => {
    const server = new Server({ name: `${transport}-fixture`, version: '1' }, { capabilities: { tools: {} } });
    servers.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      counts.listed++;
      return { tools: [{ name: toolName, description: `Controlled direct MCP ${transport} proof`, inputSchema: { type: 'object', properties: {} } }] };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (request.params.name !== toolName) throw new Error('Unknown fixture tool');
      counts.called++;
      await onCall?.(request, extra);
      return { content: [{ type: 'text', text: receipt }] };
    });
    return server;
  };
  const http = createServer(async (req, res) => {
    try {
      counts.requests++;
      if (req.headers.authorization !== `Bearer ${getCredential()}`) { res.writeHead(401).end(); return; }
      counts.authenticated++;
      const url = new URL(req.url, 'http://127.0.0.1');
      if (transport === 'sse') {
        if (req.method === 'GET' && url.pathname === '/sse') {
          const stream = new SSEServerTransport('/messages', res);
          sessions.set(stream.sessionId, stream); counts.initialized++;
          await mcp().connect(stream); return;
        }
        const stream = sessions.get(url.searchParams.get('sessionId'));
        if (req.method === 'POST' && url.pathname === '/messages' && stream) return await stream.handlePostMessage(req, res);
      } else if (url.pathname === '/mcp') {
        let body;
        if (req.method === 'POST') {
          let raw = ''; for await (const chunk of req) raw += chunk;
          body = JSON.parse(raw);
        }
        let stream = sessions.get(req.headers['mcp-session-id']);
        if (!stream && req.method === 'POST' && body?.method === 'initialize') {
          stream = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
            onsessioninitialized: id => { sessions.set(id, stream); counts.initialized++; } });
          await mcp().connect(stream);
        }
        if (stream) return await stream.handleRequest(req, res, body);
      }
      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) res.writeHead(500).end(); else res.destroy();
    }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  return { endpoint: `http://127.0.0.1:${http.address().port}/${transport === 'sse' ? 'sse' : 'mcp'}`,
    toolName, receipt, counts,
    close: async () => { await Promise.allSettled([...servers].map(server => server.close())); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); },
  };
}
