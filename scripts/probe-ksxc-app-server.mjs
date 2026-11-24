#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { probeKsxcPayload } from '../src/providers/ksxc-probe.mjs';

export { probeKsxcPayload };

const failure = code => Object.assign(new Error(code), { code });
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const usage = 'Usage: node scripts/probe-ksxc-app-server.mjs --executable /absolute/ksxc --sha256 <digest>';
  const options = {};
  try {
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index] === '--executable' ? 'executable' : args[index] === '--sha256' ? 'expectedSha256' : null;
      if (!key || !args[index + 1] || options[key] !== undefined) throw failure('KSXC_PROBE_ARGUMENT_INVALID');
      options[key] = args[index + 1];
    }
    if (!options.executable || !options.expectedSha256) throw failure('KSXC_PROBE_ARGUMENT_INVALID');
    process.stdout.write(JSON.stringify(await probeKsxcPayload(options), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: error.code || 'KSXC_PROBE_FAILED',
      ...(error.code === 'KSXC_PROBE_ARGUMENT_INVALID' ? { usage } : {}) }) + '\n');
    process.exitCode = 1;
  }
}
