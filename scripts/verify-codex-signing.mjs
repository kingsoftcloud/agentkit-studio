/** Required native Code Mode permissions; an App signature alone cannot prove execution. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertCodeModeHostEntitlements(value) {
  for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory']) {
    if (value?.[key] !== true) throw new Error(`Codex Code Mode host is missing required entitlement: ${key}`);
  }
}

export function assertCodeModeSigningRecord(record) {
  const proof = record?.codeModeHostSigning;
  if (proof?.verified !== true || !/^[a-f0-9]{64}$/.test(proof.sha256 || '')) throw new Error('Signed candidate lacks Code Mode host verification; rebuild with the corrected signing workflow');
  assertCodeModeHostEntitlements(proof.entitlements);
}

export function verifyCodexSigning(app) {
  const root = join(resolve(app), 'Contents/Resources/app.asar.unpacked/dsh/node_modules/@openai');
  const binaries = [['arm64', 'aarch64'], ['x64', 'x86_64']].map(([arch, target]) =>
    join(root, `codex-darwin-${arch}/vendor/${target}-apple-darwin/bin/codex-code-mode-host`)).filter(existsSync);
  if (binaries.length !== 1) throw new Error('Expected exactly one packaged Codex Code Mode host');
  const binary = binaries[0];
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', binary], { stdio: ['ignore', 'pipe', 'pipe'] });
  const xml = execFileSync('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const value = xml.trim() ? JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' })) : {};
  assertCodeModeHostEntitlements(value);
  return { binary, verified: true, sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), entitlements: value };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] === '--record-only') {
    const record = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    assertCodeModeSigningRecord(record);
    console.log(JSON.stringify({ version: record.version, codeModeHostSigning: 'verified' }));
  } else {
    const { binary, ...proof } = verifyCodexSigning(process.argv[2]);
    if (process.argv[3]) {
      const record = JSON.parse(readFileSync(process.argv[3], 'utf8'));
      record.codeModeHostSigning = proof;
      writeFileSync(process.argv[3], JSON.stringify(record, null, 2) + '\n');
    }
    console.log(JSON.stringify({ binary, ...proof }, null, 2));
  }
}
