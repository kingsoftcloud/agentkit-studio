// Maintainer build only. Consumers use the verified, packaged executables.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'packages/agentkit-harness/src/native');
const source = join(directory, 'local-process-launcher.c');
const manifestFile = join(directory, 'local-process-manifest.json');
const args = process.argv.slice(2), target = args[args.indexOf('--target') + 1];
if (!['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].includes(target)) throw Error('Use --target darwin-arm64|darwin-x64|linux-arm64|linux-x64');
const [platform, arch] = target.split('-'), output = join(directory, 'local-process-bin', target);
mkdirSync(output, { recursive: true });
const filename = join(output, 'launcher'), temporary = filename + '.building';
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceSha256 = hash(readFileSync(source));
let compiler, image = null;
const run = (file, argv, options = {}) => {
  const result = spawnSync(file, argv, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw Error(`${file} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout.trim();
};
if (platform === 'darwin') {
  if (process.platform !== 'darwin') throw Error('Darwin build requires the Apple SDK');
  compiler = run('/usr/bin/cc', ['--version']).split('\n')[0];
  run('/usr/bin/cc', ['-arch', arch === 'x64' ? 'x86_64' : 'arm64', '-mmacosx-version-min=11.0', '-O2', '-std=c11',
    '-Wall', '-Wextra', '-Werror', source, '-o', temporary]);
} else {
  // Static musl builds require no target dynamic loader or libc installation.
  const imageName = args.includes('--image') ? args[args.indexOf('--image') + 1] : 'alpine:3.22.2';
  compiler = run('docker', ['run', '--rm', '--platform', `linux/${arch === 'x64' ? 'amd64' : 'arm64'}`, '--network=bridge',
    '-v', `${source}:/source.c:ro`, '-v', `${output}:/out`, imageName, '/bin/sh', '-c',
    'apk add --no-cache build-base >/dev/null && cc --version | head -1 && cc -O2 -static -s -std=c11 -Wall -Wextra -Werror -Wl,--build-id=none /source.c -o /out/launcher.building']);
  compiler = compiler.split('\n').find(line => /(?:gcc|cc) .*\d/.test(line)) ?? compiler.split('\n').at(-1);
  image = run('docker', ['image', 'inspect', imageName, '--format', '{{index .RepoDigests 0}}']);
}
chmodSync(temporary, 0o755); renameSync(temporary, filename);
const previous = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { builds: {} };
const builds = previous.sourceSha256 === sourceSha256 ? previous.builds : {};
builds[target] = { file: `local-process-bin/${target}/launcher`, sha256: hash(readFileSync(filename)),
  bytes: readFileSync(filename).length, compiler, ...(image ? { image } : {}) };
writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 'agentkit.local-process-binary/v1', sourceSha256, builds }, null, 2) + '\n');
console.log(`${target}: ${builds[target].bytes} bytes ${builds[target].sha256}`);
