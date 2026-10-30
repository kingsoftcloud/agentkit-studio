import { parentPort, workerData } from 'node:worker_threads';
import { isRuntimeReadOnlyBashCommand } from '../../dist/native-command-plan.mjs';

const context = { workingDirectory: workerData.cwd, workspaceRoot: workerData.workspaceRoot };
const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
try {
  // Native's explicit env object is equivalent to shell assignment prefixes.
  // Use the reference's own assignment policy, including PATH/GIT_* denials.
  const allowedEnvironment = Object.entries(workerData.env ?? {}).every(([name, value]) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === 'string' && !value.includes('\0')
    && isRuntimeReadOnlyBashCommand(`${name}=${quote(value)} true`, context));
  parentPort.postMessage({ contract: 'zcode-posix-readonly/v1',
    allowed: allowedEnvironment && isRuntimeReadOnlyBashCommand(workerData.command, context) });
} catch { parentPort.postMessage({ contract: 'zcode-posix-readonly/v1', allowed: false }); }
