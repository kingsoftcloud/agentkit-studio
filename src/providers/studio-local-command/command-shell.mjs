export const LOCAL_COMMAND_SHELL = 'bash-execution/v1';

/** Skill execution and DSH commands keep their original shell and request digest. */
export function shellCommandArgv(command, policy = null) {
  if (policy === null) return ['/bin/sh', '-c', command];
  if (policy === LOCAL_COMMAND_SHELL) return ['/bin/bash', '-c', command];
  throw Error('unsupported_command_shell');
}
