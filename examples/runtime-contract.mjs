/** Inspect the frozen runtime contract without loading credentials or starting a Host. */
import { studioRuntimeContract, studioRunIdentity } from '../src/runtime-contract.mjs';

const contract = studioRuntimeContract();
const run = studioRunIdentity({
  agentId: 'demo-agent', revision: 1, buildId: 'demo-build',
  sessionId: 'demo-session', runId: 'demo-run',
});
console.log(JSON.stringify({ version: contract.version, runtimes: contract.runtimes, run }, null, 2));
