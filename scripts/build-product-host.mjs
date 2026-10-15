/** Invoke official DSH build scripts with explicit public product configuration. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveProductInputs } from './product-config.mjs';
import { packageManagerEnvironment, packageManagerInvocation } from './package-desktop.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, script: { type: 'string' } } });
if (!values.source || !['build:official', 'build:web', 'build:desktop'].includes(values.script)) throw new Error('usage: build-product-host.mjs --source <DSH> --script <build:official|build:web|build:desktop>');
const product = resolveProductInputs();
const environment = packageManagerEnvironment({ ...process.env, ...product.environment });
const manager = packageManagerInvocation(process.platform, environment);
const args = ['run', values.script];
const child = spawn(manager.command, [...manager.args, ...args], { cwd: resolve(values.source), env: environment, stdio: 'inherit' });
child.once('error', () => { console.error('Product host build could not start'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
