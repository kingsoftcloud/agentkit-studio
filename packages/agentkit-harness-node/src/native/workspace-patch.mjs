import { Worker } from 'node:worker_threads';

/** Pure hunk verification. Publication remains in the owning workspace port. */
export async function prepareWorkspacePatch(input, { signal, timeoutMs = 2000 } = {}) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./workspace-patch-worker.mjs', import.meta.url), { workerData: input, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
  return new Promise(resolve => {
    let output, settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(value); };
    const stop = () => { worker.unref(); void worker.terminate().catch(() => {}); finish(null); };
    const timer = setTimeout(stop, timeoutMs);
    worker.once('message', value => { output = value; }); worker.once('error', stop);
    worker.once('exit', code => finish(!signal?.aborted && code === 0 && output?.contract === 'zcode-patch/v1' ? output : null));
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  });
}
