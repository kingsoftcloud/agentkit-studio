import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createManagedNativeKernel } from '../../src/providers/native-managed-kernel.mjs';
import { permitIssuer, target, binding } from './native-managed-kernel.mjs';
import { preparedContext, callbackPermit } from './native-teams-context.mjs';

const [directory, mode] = process.argv.slice(2), issuer = permitIssuer(), hold = new Int32Array(new SharedArrayBuffer(4));
let armed = false;
const runtime = createManagedNativeKernel({ directory, target, permitVerifier: issuer.verifier, assertCurrent: () => true,
  autoStart: false, resolveBinding: request => binding(request.command), beforeCommit() {
    if (armed) { process.send({ kind: 'held', pid: process.pid, mode }); Atomics.wait(hold, 0, 0); }
  } });
const context = preparedContext(), opts = { expectedIncarnation: runtime.teamsContexts.incarnation() },
  first = callbackPermit(context), newer = callbackPermit(context, { ttl: 25000 });
writeFileSync(join(directory, 'process-context.json'), JSON.stringify({ context, opts, first, newer, pid: process.pid }));
if (mode === 'context-rollback') { armed = true; runtime.teamsContexts.put(context, opts); }
else {
  runtime.teamsContexts.put(context, opts); runtime.teamsContexts.putCallback(context.context_ref, first, opts);
  if (mode === 'callback-rollback') { armed = true; runtime.teamsContexts.putCallback(context.context_ref, newer, opts); }
  else { process.send({ kind: 'held', pid: process.pid, mode }); Atomics.wait(hold, 0, 0); }
}
