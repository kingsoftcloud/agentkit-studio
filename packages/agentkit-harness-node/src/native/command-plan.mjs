import { Worker } from 'node:worker_threads';

export const PLAN_COMMAND_POLICY = 'zcode-posix-readonly/v1';

/** Read-only permission classification, not execution or safe-replay authority. */
export async function checkPlanCommand(command, { cwd, workspaceRoot, env, signal, timeoutMs = 2000 } = {}) {
  signal?.throwIfAborted();
  if (typeof command !== 'string' || command.length > 10000 || typeof cwd !== 'string' || typeof workspaceRoot !== 'string'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return false;
  let worker;
  try { worker = new Worker(new URL('./command-plan-worker.mjs', import.meta.url), {
    workerData: { command, cwd, workspaceRoot, env }, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  }); } catch { return false; }
  return await new Promise(resolve => {
    let output, settled = false;
    const finish = allowed => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(allowed);
    };
    const stop = () => { worker.unref(); void worker.terminate().catch(() => {}); finish(false); };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    worker.once('message', value => { output = value; });
    worker.once('error', stop);
    worker.once('exit', code => {
      finish(!signal?.aborted && code === 0 && output?.contract === PLAN_COMMAND_POLICY && output.allowed === true);
    });
    if (signal?.aborted) stop();
  });
}
