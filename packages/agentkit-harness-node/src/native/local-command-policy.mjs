import { Worker } from 'node:worker_threads';

export const LOCAL_COMMAND_POLICY = 'agentkit.local-command-policy/v1';
export const GOVERNED_COMMAND_POLICY = 'agentkit.governed-command-policy/v1';
const failure = code => Object.assign(new Error(code), { code });

/** Same-container risk checks, not an OS sandbox. Approval and workspace
 * ownership are Host duties. Source is parsed/read in a bounded Node worker;
 * no Python interpreter or workspace module is imported or executed.
 */
export const checkLocalCommand = (command, options) => checkCommand(command, options, false);
export const checkGovernedCommand = (command, options) => checkCommand(command, options, true);
async function checkCommand(command, { cwd, allowedRoots, signal, timeoutMs = 10000 } = {}, governed) {
  signal?.throwIfAborted();
  if (!(typeof command === 'string' || Array.isArray(command) && command.every(item => typeof item === 'string'))
    || Buffer.byteLength(JSON.stringify(command)) > 2 * 1024 * 1024 || typeof cwd !== 'string'
    || !Array.isArray(allowedRoots) || !allowedRoots.length || allowedRoots.some(root => typeof root !== 'string'))
    throw failure('invalid_command_policy_input');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw failure('invalid_command_policy_deadline');
  let worker;
  try { worker = new Worker(new URL('./local-command-policy-worker.mjs', import.meta.url), {
    workerData: { command, cwd, allowedRoots, governed }, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  }); } catch { throw failure('command_policy_unavailable'); }
  return await new Promise((resolve, reject) => {
    let output, error, stopping = false;
    const stop = reason => { if (stopping) return; stopping = true; error = reason; void worker.terminate().catch(() => {}); };
    const abort = () => stop(signal.reason ?? failure('command_policy_canceled'));
    const timer = setTimeout(() => stop(failure('command_policy_timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', value => { output = value; });
    worker.once('error', () => stop(failure('command_policy_unavailable')));
    worker.once('exit', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) return reject(error);
      const finding = output?.finding;
      if (code !== 0 || output?.contract !== LOCAL_COMMAND_POLICY || !(finding === null || finding
        && typeof finding.rule === 'string' && finding.rule && typeof finding.detail === 'string'
        && typeof finding.path === 'string' && (finding.line === null || Number.isSafeInteger(finding.line) && finding.line > 0)))
        return reject(failure('command_policy_unavailable'));
      resolve(finding);
    });
    if (signal?.aborted) abort();
  });
}
