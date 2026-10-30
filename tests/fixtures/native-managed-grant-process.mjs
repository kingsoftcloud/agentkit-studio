import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createManagedNativeKernel } from '../../src/providers/native-managed-kernel.mjs';
import { permitIssuer, command, target, binding } from './native-managed-kernel.mjs';

const [directory, mode] = process.argv.slice(2), issuer = permitIssuer();
const spec = { grant_id: 'process-occurrence', tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId,
  session_id: 'a2a-kernel-managed', owner_ref: 'trusted-process-host', attempt_epoch: null };
let armed = false;
const hold = new Int32Array(new SharedArrayBuffer(4));
const runtime = createManagedNativeKernel({ directory, target, permitVerifier: issuer.verifier, assertCurrent: () => true,
  autoStart: false,
  beforeCommit() {
    if (armed && mode === 'rollback') {
      process.send({ kind: 'held', pid: process.pid, boundary: 'grant-and-discard-before-commit' });
      Atomics.wait(hold, 0, 0);
    }
  },
  async resolveBinding(request) {
    if (request.stage === 'execute' && mode === 'qualified') {
      process.send({ kind: 'held', pid: process.pid, boundary: 'qualified-before-native-start' });
      await new Promise(() => {});
    }
    return binding(request.command);
  },
});
runtime.executionGrants.ensure(spec);
const cmd = command({ payload: { content: 'Original process work', execution_grant_id: spec.grant_id } });
const receipt = await runtime.receive(cmd, issuer.issue(cmd));
writeFileSync(join(directory, 'process-admission.json'), JSON.stringify({ spec, command: cmd, receipt, pid: process.pid }));
process.send({ kind: 'admitted', pid: process.pid, spec, command: cmd, receipt });
armed = true;
if (mode === 'rollback') runtime.executionGrants.setState(spec, 'revoked', { expected_revision: 1, idempotency_key: 'crash-stop' });
else await runtime.drain(cmd.session_id);
