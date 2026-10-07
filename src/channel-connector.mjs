/** Channel Gateway v1 transport. Execution stays in the host's native runner. */
import WebSocket from 'ws';

export function connectorUrl(serverUrl) {
  const url = new URL(serverUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(['https:', 'wss:'].includes(url.protocol) || loopback && ['http:', 'ws:'].includes(url.protocol))) {
    throw Object.assign(new Error('远程渠道连接必须使用 HTTPS/WSS；仅本机允许 HTTP/WS'), { code: 'CHANNEL_URL_INVALID' });
  }
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  url.pathname = '/agentengine/connector/v1';
  return url.href;
}

export function createChannelConnector({ url, token, tenantId, workspaceId, agentId, invoke, reconnectMs = 1000, maxReconnectMs = 60000, timeoutMs = 300000, cacheSize = 1024 } = {}) {
  const endpoint = connectorUrl(url);
  if (![token, tenantId, workspaceId, agentId].every(value => typeof value === 'string' && value.trim()) || typeof invoke !== 'function') throw new Error('渠道连接需要账号、工作区、Agent、凭证和运行适配器');
  let socket, stopped = true, state = 'stopped', error = '', timer, handshake, seq = 0, backoff = reconnectMs;
  const tasks = new Map(), completed = new Map();
  const identity = { tenant_id: tenantId, workspace_id: workspaceId, agent_id: agentId };
  const send = (type, payload) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type, seq: ++seq, ts: new Date().toISOString(), payload }));
    return true;
  };
  const finish = (id, type, payload) => {
    completed.set(id, { type, payload });
    while (completed.size > cacheSize) completed.delete(completed.keys().next().value);
    send(type, payload);
  };
  const execute = async payload => {
    const id = String(payload.task_id || '');
    if (!id || id.length > 256) throw new Error('invalid task');
    if (completed.has(id)) { const terminal = completed.get(id); send(terminal.type, terminal.payload); return; }
    if (tasks.has(id)) return;
    const deadline = payload.deadline ? Date.parse(payload.deadline) : Date.now() + timeoutMs;
    if (!Number.isFinite(deadline) || deadline <= Date.now()) { finish(id, 'error', { task_id: id, code: 'deadline_exceeded', message: 'deadline exceeded' }); return; }
    if (typeof payload.message !== 'string' || !payload.message.trim() || !payload.session_id) {
      finish(id, 'error', { task_id: id, code: 'invalid_request', message: 'message and session_id are required' }); return;
    }
    const abort = new AbortController();
    tasks.set(id, abort);
    const expiry = setTimeout(() => abort.abort(Object.assign(new Error('deadline exceeded'), { code: 'deadline_exceeded' })), Math.min(timeoutMs, deadline - Date.now()));
    try {
      const result = await invoke({ ...payload, signal: abort.signal });
      abort.signal.throwIfAborted();
      finish(id, 'complete', { task_id: id, result: String(result) });
    } catch {
      const code = abort.signal.aborted ? abort.signal.reason?.code || 'cancelled' : 'execution_error';
      finish(id, 'error', { task_id: id, code, message: code === 'execution_error' ? 'agent invocation failed' : code });
    } finally { clearTimeout(expiry); tasks.delete(id); }
  };
  const connect = () => {
    if (stopped) return;
    state = 'connecting';
    const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, followRedirects: false, maxPayload: 1024 * 1024, handshakeTimeout: 10000 });
    let rejectedAuth = false;
    socket = ws;
    ws.on('open', () => {
      if (socket !== ws || stopped) return;
      state = 'registering';
      send('register', { ...identity, protocol_version: 1, capabilities: ['invoke', 'cancel'], sdk: 'agentkit-studio' });
      handshake = setTimeout(() => { error = 'registration_timeout'; ws.terminate(); }, 10000);
    });
    ws.on('message', raw => {
      if (socket !== ws || stopped) return;
      try {
        const frame = JSON.parse(raw.toString());
        const payload = frame?.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid frame');
        if (frame.type === 'register_ok' && state === 'registering') {
          if (payload.protocol_version !== 1 || Object.entries(identity).some(([key, value]) => payload.identity?.[key] !== value)) throw new Error('registration identity mismatch');
          clearTimeout(handshake); state = 'connected'; error = ''; backoff = reconnectMs;
        } else if (frame.type === 'register_err') { error = 'registration_rejected'; ws.close(1008); }
        else if (state !== 'connected') throw new Error('not registered');
        else if (frame.type === 'ping') send('pong', {});
        else if (frame.type === 'cancel') tasks.get(String(payload.task_id || ''))?.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        else if (frame.type === 'invoke') void execute(payload).catch(() => { error = 'protocol_error'; ws.close(1002); });
      } catch { error = 'protocol_error'; ws.close(1002); }
    });
    ws.on('unexpected-response', (_request, response) => {
      rejectedAuth = [401, 403].includes(response.statusCode);
      response.resume(); error = rejectedAuth ? 'authentication_failed' : 'connection_failed'; ws.terminate();
    });
    ws.on('error', () => { if (!rejectedAuth) error = 'connection_failed'; });
    ws.on('close', code => {
      if (socket !== ws) return;
      clearTimeout(handshake); socket = undefined;
      // An unobserved partial execution must not be replayed on reconnection.
      for (const abort of tasks.values()) abort.abort(Object.assign(new Error('connection closed'), { code: 'connection_lost' }));
      if (stopped) { state = 'stopped'; return; }
      if (rejectedAuth || [4001, 4002, 1008].includes(code)) { state = 'error'; error = code === 4002 ? 'connection_replaced' : 'authentication_failed'; return; }
      state = 'reconnecting'; error ||= 'connection_lost';
      timer = setTimeout(connect, backoff); timer.unref?.(); backoff = Math.min(backoff * 2, maxReconnectMs);
    });
  };
  return {
    get status() { return { state, connected: state === 'connected', activeTasks: tasks.size, lastError: error || null }; },
    start() { if (!stopped) return; stopped = false; connect(); },
    stop() {
      stopped = true; state = 'stopped'; clearTimeout(timer); clearTimeout(handshake);
      for (const abort of tasks.values()) abort.abort(Object.assign(new Error('connector stopped'), { code: 'cancelled' }));
      socket?.terminate();
    },
  };
}
