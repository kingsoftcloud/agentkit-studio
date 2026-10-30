export const LOCAL_COMMAND_SHELL = 'bash-execution/v1';

/** A missing policy belongs to a persisted legacy request. Never reinterpret
 * it under a new shell during supervision/recovery. No PATH-based fallback.
 */
export function shellCommandArgv(command, policy = null) {
  if (policy !== null && policy !== LOCAL_COMMAND_SHELL) throw Error('unsupported_command_shell');
  return [policy === LOCAL_COMMAND_SHELL ? '/bin/bash' : '/bin/sh', '-c', command];
}
