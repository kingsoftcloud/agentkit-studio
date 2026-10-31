// Fault injection only: constrain the real launcher process before its fork,
// while leaving the Node owner and unrelated commands' limits untouched.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const spawn = childProcess.spawn;
childProcess.spawn = (command, args = [], options) => {
  if (command === process.execPath && args[0]?.endsWith('/local-background-supervisor.mjs'))
    return spawn(command, ['--import', import.meta.url, ...args], options);
  if (/\/local-process-bin\/[^/]+\/launcher$/.test(command))
    return spawn('/usr/bin/prlimit', ['--nproc=1:1', '--', command, ...args], options);
  return spawn(command, args, options);
};
syncBuiltinESMExports();
