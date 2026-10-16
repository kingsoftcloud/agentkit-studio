/** Local Server credentials are resolved at startup and only passed in process memory. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGlobalConfiguration } from '../../src/global-config.mjs';
import { localCatalogKey } from '../../src/template-catalog-client.mjs';
const [serverRoot, stateRoot, python, port = '3210', bucket = 'xiayu-test'] = process.argv.slice(2);
if (!serverRoot || !stateRoot || !python) throw new Error('Usage: run-local-server.mjs server-root state-root python [port] [bucket]');
const { values } = await createGlobalConfiguration().resolve();
if (!values.cloudAccessKey || !values.cloudSecretKey) throw new Error('Local catalog needs the configured cloud storage credentials');
const state = resolve(stateRoot); await mkdir(state, { recursive: true, mode: 0o700 });
const log = await open(`${state}/server-private.log`, 'a', 0o600);
const child = spawn(python, ['-m', 'uvicorn', 'app.template_catalog_app:from_environment', '--factory', '--host', '127.0.0.1', '--port', port, '--no-access-log', '--log-level', 'warning'], {
  cwd: resolve(serverRoot), stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env, STUDIO_TEMPLATE_DATABASE_URL: `sqlite+aiosqlite:///${state}/catalog.db`, STUDIO_TEMPLATE_SIGNING_KEY: localCatalogKey(values.cloudSecretKey), STUDIO_TEMPLATE_ACCOUNT: `local-${createHash('sha256').update(values.cloudAccessKey).digest('hex').slice(0,24)}`,
    KS3_ACCESS_KEY: values.cloudAccessKey, KS3_SECRET_KEY: values.cloudSecretKey, KS3_SECURITY_TOKEN: values.cloudSessionToken || '', KS3_ENDPOINT: 'ks3-cn-beijing.ksyuncs.com', KS3_REGION: 'cn-beijing', KS3_BUCKET: bucket },
});
await writeFile(`${state}/server-pid.json`, JSON.stringify({ pid: child.pid, port: Number(port) }), { mode: 0o600 });
console.log(JSON.stringify({ pid: child.pid, origin: `http://127.0.0.1:${port}`, credentialsLogged: false }));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
await new Promise(resolve => child.on('exit', code => { process.exitCode = code || 0; resolve(); }));
await log.close();
