// Distribution check only: no C compiler, Docker, Python or target execution.
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
const directory = dirname(createRequire(join(root, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/local-process'));
const hash = value => createHash('sha256').update(value).digest('hex');
const check = (condition, message) => { if (!condition) throw Error(message); };
const manifest = JSON.parse(readFileSync(join(directory, 'local-process-manifest.json'), 'utf8'));
check(manifest.schemaVersion === 'agentkit.local-process-binary/v1', 'Unknown local launcher manifest');
check(manifest.sourceSha256 === hash(readFileSync(join(directory, 'local-process-launcher.c'))), 'Rebuild launchers after source changes');
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
check(Object.keys(manifest.builds).length === targets.length, 'All four distribution launchers are required');
for (const target of targets) {
  const entry = manifest.builds[target], file = `local-process-bin/${target}/launcher`;
  check(entry?.file === file, `Missing ${target}`);
  const stat = lstatSync(join(directory, file)), bytes = readFileSync(join(directory, file));
  check(stat.isFile() && (stat.mode & 0o111) !== 0 && stat.size === entry.bytes && hash(bytes) === entry.sha256, `Invalid executable ${target}`);
  if (target.startsWith('darwin')) {
    check(bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (target.endsWith('arm64') ? 0x0100000c : 0x01000007)
      && bytes.readUInt32LE(12) === 2, `Wrong Mach-O architecture ${target}`);
  } else {
    check(bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes[5] === 1
      && bytes.readUInt16LE(18) === (target.endsWith('arm64') ? 183 : 62), `Wrong ELF architecture ${target}`);
    const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
    check(Number.isSafeInteger(offset) && size >= 4 && offset + size * count <= bytes.length, `Invalid ELF headers ${target}`);
    for (let index = 0; index < count; index++) check(bytes.readUInt32LE(offset + size * index) !== 3, `${target} needs an external dynamic loader`);
  }
}
for (const [file, marker] of [['musl-COPYRIGHT', 'musl'], ['GCC-COPYING3', 'GNU GENERAL PUBLIC LICENSE'], ['GCC-COPYING.RUNTIME', 'GCC RUNTIME LIBRARY EXCEPTION']])
  check(readFileSync(join(directory, 'local-process-licenses', file), 'utf8').includes(marker), `Missing launcher redistribution license ${file}`);
console.log(`local-process launchers: ${targets.length} source-bound executables and redistribution licenses verified`);
