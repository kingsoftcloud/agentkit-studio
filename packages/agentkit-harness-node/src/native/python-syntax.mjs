import { Worker } from 'node:worker_threads';

export const NATIVE_PYTHON_SYNTAX = Object.freeze({
  contract: 'agentkit.python-ast-syntax/v1',
  parser: 'ruff-wasm', parserVersion: '0.16.8', targetVersion: 'py312', mode: 'ast-only',
  decimalDigitLimit: 4300, nestingLimit: 200, indentLimit: 99,
});
const failure = (code, message) => Object.assign(new Error(message), { code });

/** Parse captured source, never a path, project configuration or executable.
 * A fresh worker bounds each parse's lifetime and keeps malformed source from
 * blocking the Host. V8 limits do not cap WASM linear memory; the input limit
 * and terminated worker are additional resource boundaries, not a sandbox.
 */
export async function checkPythonSyntax(source, { signal, timeoutMs = 10000 } = {}) {
  signal?.throwIfAborted();
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 2 * 1024 * 1024)
    throw failure('python_syntax_input_invalid', 'Python source exceeds the workspace text limit.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw failure('python_syntax_deadline_invalid', 'Invalid Python syntax deadline.');
  let worker;
  try { worker = new Worker(new URL('./python-syntax-worker.mjs', import.meta.url), {
    workerData: source, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  }); } catch { throw failure('python_syntax_unavailable', 'The Node Python syntax parser could not start.'); }
  return await new Promise((resolve, reject) => {
    let output, error, stopping = false;
    const stop = reason => {
      if (stopping) return;
      stopping = true; error = reason;
      // Settle only at exit, after the parser can no longer consume resources.
      void worker.terminate().catch(() => {});
    };
    const abort = () => stop(signal.reason ?? failure('python_syntax_cancelled', 'Python syntax check cancelled.'));
    const timer = setTimeout(() => stop(failure('python_syntax_timeout', 'Python syntax check timed out.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', value => { output = value; });
    worker.once('error', () => stop(failure('python_syntax_unavailable', 'The Node Python syntax parser failed.')));
    worker.once('exit', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) return reject(error);
      if (code !== 0 || output?.contract !== NATIVE_PYTHON_SYNTAX.contract || !Array.isArray(output.issues)
        || output.issues.some(issue => issue?.severity !== 'error' || !Number.isSafeInteger(issue.line) || issue.line < 1
          || !Number.isSafeInteger(issue.column) || issue.column < 1 || typeof issue.message !== 'string' || !issue.message))
        return reject(failure('python_syntax_unavailable', 'The Node Python syntax parser returned no valid result.'));
      resolve(output.issues);
    });
    if (signal?.aborted) abort();
  });
}
