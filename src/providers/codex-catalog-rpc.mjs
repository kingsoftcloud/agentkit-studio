/** Short-lived public App Server connection for read-only catalog operations. */
import { resolveCodexCommand } from './codex-command.mjs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const failure = (code, message) => Object.assign(new Error(message), { code });
export async function withCodexCatalogRpc(read, { executable, spawnImpl = spawn, env = process.env, timeoutMs = 10000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const command = resolveCodexCommand({ executable, env });
  let child;
  try { child = spawnImpl(command.executable, [...command.prefixArgs, 'app-server', '--stdio'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], env }); }
  catch { throw failure('CODEX_PROVIDER_UNAVAILABLE', '无法启动 Codex App Server，请检查安装和配置。'); }
  const pending = new Map(); let id = 0, closed = false, size = 0, terminalError;
  const reject = error => { terminalError = error; for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  const unavailable = () => reject(failure('CODEX_PROVIDER_UNAVAILABLE', 'Codex App Server 无法读取目录。'));
  child.on('error', unavailable); child.stdin?.on('error', unavailable); child.stderr?.on('data', () => {});
  child.on('exit', () => { if (!closed) unavailable(); });
  if (!child.stdin || !child.stdout) { child.kill?.('SIGTERM'); throw failure('CODEX_PROVIDER_UNAVAILABLE', 'Codex 未提供 stdio 通道。'); }
  const lines = createInterface({ input: child.stdout });
  child.stdout.on('data', chunk => { size += chunk.length; if (size > maxBytes) reject(failure('CODEX_CATALOG_TOO_LARGE', 'Codex 目录超过大小上限。')); });
  lines.on('line', line => {
    if (terminalError) return;
    let message;
    try { message = JSON.parse(line); } catch { reject(failure('CODEX_PROTOCOL_INVALID', 'Codex 目录返回无效 JSON。')); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(failure('CODEX_CATALOG_FAILED', 'Codex 拒绝读取目录，请检查本地配置。'));
    else entry.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, rejectRequest) => {
    if (terminalError) return rejectRequest(terminalError);
    if (!['initialize', 'config/read', 'model/list', 'plugin/list'].includes(method)) return rejectRequest(failure('CODEX_CATALOG_METHOD_INVALID', '不支持的目录读取方法。'));
    const requestId = ++id; pending.set(requestId, { resolve, reject: rejectRequest });
    try { child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n'); }
    catch (error) { pending.delete(requestId); rejectRequest(error); }
  });
  let timer;
  try {
    return await Promise.race([(async () => {
      await request('initialize', { clientInfo: { name: 'agentkit-studio', version: '0.0.1' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      return read(request);
    })(), new Promise((resolve, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(failure('CODEX_CATALOG_TIMEOUT', '读取 Codex 目录超时。')), timeoutMs); })]);
  } finally {
    closed = true; clearTimeout(timer); lines.close();
    reject(failure('CODEX_TRANSPORT_CLOSED', 'Codex 目录读取已结束。'));
    child.stdin.end?.(); child.kill?.('SIGTERM');
  }
}
