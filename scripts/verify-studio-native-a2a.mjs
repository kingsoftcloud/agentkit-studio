/**
 * Verify outbound A2A and signed inbound projection through the current
 * Studio package, an independent Harness and a cold Studio Host restart.
 *
 * Usage:
 *   node scripts/verify-studio-native-a2a.mjs --source <built DSH> --archive <Studio.tgz>
 *   node scripts/verify-studio-native-a2a.mjs --installation <verified Host> --archive <Studio.tgz>
 *
 * The embedded-kernel options belonged to the retired runtime. The current
 * proof inspects Run history through the Studio Host and retains its evidence.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, installation: { type: 'string' }, archive: { type: 'string' },
  'inbound-protocol': { type: 'boolean' }, keep: { type: 'boolean' }, help: { type: 'boolean' },
} });
const args = [fileURLToPath(new URL('./verify-independent-workspace-host.mjs', import.meta.url))];
for (const name of ['source', 'installation', 'archive']) {
  if (values[name]) args.push('--' + name, values[name]);
}
if (values.help) args.push('--help');
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
