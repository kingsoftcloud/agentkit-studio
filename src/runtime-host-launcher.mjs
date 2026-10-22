/** Both installed input forms share process signals and bounded shutdown. */
import { spawn } from 'node:child_process';

export async function launchRuntimeHost(plan) {
  const child = spawn(process.execPath, [plan.entry, ...plan.args], { cwd: plan.cwd, env: plan.env, stdio: 'inherit' });
  let timer;
  const stop = signal => {
    child.kill(signal);
    timer ||= setTimeout(() => child.kill('SIGKILL'), 15000).unref();
  };
  const term = () => stop('SIGTERM'), interrupt = () => stop('SIGINT');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  try {
    const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept({ code, signal })); });
    return result.code ?? (result.signal === 'SIGINT' ? 130 : 143);
  } finally { clearTimeout(timer); process.off('SIGTERM', term); process.off('SIGINT', interrupt); }
}
