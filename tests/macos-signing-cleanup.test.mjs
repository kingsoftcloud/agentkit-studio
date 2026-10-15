import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/release-desktop.yml', 'utf8'));
const steps = workflow.jobs['macos-arm64'].steps;
const prepare = steps.find(step => step.name === 'Prepare temporary Apple signing keychain').run;
const cleanup = steps.find(step => step.name === 'Remove temporary signing material').run;
const originalKeychains = '/fixture/keychains/login keychain-db\n/fixture/keychains/system.keychain-db\n';
const commands = `
openssl() { printf '%s' 'synthetic-keychain-password'; }
base64() { cat; }
security() {
  local security_operation="$1"; shift
  case "$security_operation" in
    list-keychains)
      if [ "\${3:-}" = '-s' ]; then
        security_operation=list-write
        printf '%s\\n' "\${@:4}" > "$CURRENT_KEYCHAINS"
      else
        security_operation=list-read
        while IFS= read -r keychain; do printf '    "%s"\\n' "$keychain"; done < "$CURRENT_KEYCHAINS"
      fi ;;
    create-keychain) touch "\${@: -1}" ;;
    find-identity) printf '%s\\n' '1) FIXTURE "Developer ID Application: Signing Fixture (TEAM)"' ;;
    delete-keychain)
      if [ "\${FAIL_DELETE:-}" = true ]; then return 24; fi
      rm -f "$1" ;;
  esac
  if [ "$security_operation" = "\${FAIL_AT:-}" ]; then return 23; fi
}
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-signing-cleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktop = join(root, 'dsh-source/apps/desktop');
  mkdirSync(desktop, { recursive: true });
  writeFileSync(join(root, 'environment'), '');
  writeFileSync(join(root, 'keychains'), originalKeychains);
  const env = {
    PATH: process.env.PATH, RUNNER_TEMP: root, GITHUB_WORKSPACE: root,
    GITHUB_ENV: join(root, 'environment'), CURRENT_KEYCHAINS: join(root, 'keychains'),
    P12_BASE64: 'synthetic-certificate', P12_PASSWORD: 'synthetic-password',
    APPLE_ID_VALUE: 'fixture@example.invalid', APPLE_APP_PASSWORD_VALUE: 'synthetic-app-password',
    APPLE_TEAM_ID_VALUE: 'TEAM', STUDIO_PRODUCT_APP_ID: 'org.example.fixture',
    STUDIO_PRODUCT_UPDATE_ENV: 'prod', UPDATE_ORIGIN_VALUE: 'https://updates.example.invalid',
    UPDATE_CHANNEL_VALUE: 'preview',
  };
  return { root, desktop, env };
}

function run(script, env) {
  return spawnSync('bash', ['-c', `${commands}\n${script}`], { cwd: env.GITHUB_WORKSPACE, env, encoding: 'utf8', timeout: 10000 });
}

const unsupported = process.platform === 'win32' && 'The owning macOS signing step runs Bash.';
for (const failAt of ['list-read', 'create-keychain', 'set-keychain-settings', 'unlock-keychain', 'list-write', 'import', 'set-key-partition-list', 'find-identity', '']) {
  test(`Apple signing cleanup restores state after ${failAt || 'successful preparation'}`, { skip: unsupported }, t => {
    const { root, desktop, env } = fixture(t);
    const prepared = run(prepare, { ...env, FAIL_AT: failAt });
    assert.equal(prepared.status, failAt ? 23 : 0, prepared.stderr);
    const certificate = join(root, 'agentkit-studio-signing.p12');
    if (existsSync(certificate)) assert.equal(statSync(certificate).mode & 0o077, 0);
    if (!failAt) assert.equal(statSync(join(desktop, '.env.macos')).mode & 0o077, 0);
    // Deliberately omit STUDIO_* paths: cleanup must also work before GITHUB_ENV is imported.
    const cleaned = run(cleanup, env);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(readFileSync(join(root, 'keychains'), 'utf8'), originalKeychains);
    for (const path of [certificate, join(root, 'agentkit-studio-signing.keychain-db'), join(root, 'agentkit-studio-existing-keychains'), join(desktop, '.env.macos')]) {
      assert.equal(existsSync(path), false, 'Temporary signing material must be removed');
    }
  });
}

test('Apple signing cleanup removes owned files and fails if the keychain command fails', { skip: unsupported }, t => {
  const { root, env } = fixture(t);
  assert.equal(run(prepare, env).status, 0);
  const cleaned = run(cleanup, { ...env, FAIL_DELETE: 'true' });
  assert.equal(cleaned.status, 1);
  assert.equal(existsSync(join(root, 'agentkit-studio-signing.p12')), false);
  assert.equal(existsSync(join(root, 'agentkit-studio-signing.keychain-db')), false);
  assert.equal(readFileSync(join(root, 'keychains'), 'utf8'), originalKeychains);
});
