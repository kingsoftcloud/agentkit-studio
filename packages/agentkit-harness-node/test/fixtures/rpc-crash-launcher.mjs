// TEST-ONLY launcher for the crash-after-write no-replay test. It is NOT part
// of the published package (it lives under test/, which is excluded from the
// package `files`). It imports the ACTUAL bundled dist and builds the server
// with crashAfterWrite=true so a write hard-exits (code 7) before the kernel
// commits the receipt — proving a resume recovers the in-flight write as
// unknown and never replays it. The published bin never sets crashAfterWrite.
//
// Usage: node test/fixtures/rpc-crash-launcher.mjs --db <run.sqlite> --ledger
//   <request.sqlite> --workspace <dir> [same options as the bin, minus --crash-after-write]
import { parseArgs } from 'node:util';
import { resolve as resolvePath } from 'node:path';
import * as readline from 'node:readline';
import { buildStartup, createNativeRpcServer, RPC_PROTOCOL_VERSION } from '../../dist/rpc-entry.mjs';
import { SqliteRunStore } from '../../dist/index.mjs';
import { RpcRequestLedger } from '../../src/rpc-ledger.mjs';
import { createWorkspaceToolExecutor } from '../../src/rpc-tools.mjs';

const { values: args } = parseArgs({
  options: {
    db: { type: 'string' }, ledger: { type: 'string' }, workspace: { type: 'string' },
    permissions: { type: 'string' }, owner: { type: 'string', default: 'native-rpc' },
    'scope-tenant': { type: 'string' }, 'scope-workspace': { type: 'string' },
    'scope-user': { type: 'string' }, 'scope-agent': { type: 'string' },
    'lease-ms': { type: 'string' }, 'max-model-calls': { type: 'string' },
    'effect-timeout-ms': { type: 'string' }, 'request-timeout-ms': { type: 'string' },
    'exec-log': { type: 'string' },
  },
  args: process.argv.slice(2),
});
const startup = buildStartup(args);
const store = new SqliteRunStore(resolvePath(args.db));
const ledger = new RpcRequestLedger(resolvePath(args.ledger));
// crashAfterWrite is the test-only hook the bin never exposes.
const execute = createWorkspaceToolExecutor({ ...startup, execLogPath: startup.execLogPath });
const server = createNativeRpcServer({ startup, store, ledger, owner: startup.owner,
  toolExecutor: async request => {
    const result = await execute(request);
    if (request.call.name === 'write' && result.status === 'ok') process.exit(7);
    return result;
  } });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await server.dispose(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

let writeChain = Promise.resolve();
const writeLine = (obj) => { writeChain = writeChain.then(() => process.stdout.write(JSON.stringify(obj) + '\n')).catch(() => {}); };
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let req;
  try { req = JSON.parse(line); } catch { writeLine({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
  server.handle(req).then(res => { if (res) writeLine(res); });
}
await shutdown();
