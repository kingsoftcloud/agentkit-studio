/** Build and test the reviewed patch series in a locked, isolated DSH checkout. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkPatchManifest } from './check-patch-manifest.mjs';
import { withDesktopCheckout } from './desktop-checkout.mjs';
import { packageManagerInvocation } from './package-desktop.mjs';
import { assertPatchedSource } from './patched-source-fingerprint.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['source', 'output', 'patches', 'report'].map(name => [name, { type: 'string' }])) });
if (!values.source || !values.output || !values.patches || !values.report) throw new Error('usage: verify-patched-dsh-host.mjs --source <fixed DSH> --output <isolated root> --patches <series> --report <json>');
const output = resolve(values.output), reportPath = resolve(values.report);
const { manifest, report: inputs } = await checkPatchManifest(resolve(values.patches));
const { verified, ...identity } = inputs;
const result = { evidence: 'isolated-patched-dsh-build-and-affected-host-tests', ...identity, manifestVerified: verified, passed: false };
const started = Date.now();
const manager = packageManagerInvocation(process.platform, process.env);
function run(args, cwd) {
  return new Promise((accept, reject) => {
    const child = spawn(manager.command, [...manager.args, ...args], { cwd, stdio: 'inherit', env: { ...process.env, DSH_HOME: join(output, 'dsh-home'), AGENTKIT_HOME: join(output, 'agentkit-home') } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(Object.assign(new Error('Patched DSH verification command failed'), { code: 'PATCHED_HOST_COMMAND_FAILED' })));
  });
}
try {
  await withDesktopCheckout({ source: resolve(values.source), output, patches: resolve(values.patches), commit: manifest.baseCommit }, async checkout => {
    result.checkout = checkout;
    result.sourceBeforeBuild = await assertPatchedSource(checkout, manifest);
    for (const file of inputs.hostTests) if (!(await stat(join(checkout, file))).isFile()) throw new Error('Missing registered host test');
    await run(['install', '--frozen-lockfile'], checkout);
    await run(['run', 'build:official'], checkout);
    result.buildPassed = true;
    const testReport = join(output, 'host-tests.json');
    try {
      await run(['exec', 'vitest', 'run', ...inputs.hostTests, '--reporter=default', '--reporter=json', `--outputFile=${testReport}`], checkout);
    } finally {
      try {
        const tests = JSON.parse(await readFile(testReport, 'utf8'));
        result.tests = { passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests, files: inputs.hostTests.length };
        result.skippedTests = tests.testResults.flatMap(file => file.assertionResults.filter(test => ['pending', 'skipped', 'todo'].includes(test.status)).map(test => ({ name: test.fullName, status: test.status })));
      } catch { /* The command failure still records a missing or incomplete test report. */ }
    }
    if (!result.tests?.passed || result.tests.failed) throw new Error('Host tests did not establish a passing result');
    result.sourceAfterBuild = await assertPatchedSource(checkout, manifest);
    result.passed = true;
  });
} catch (error) {
  result.failure = { code: error.code || 'PATCHED_HOST_VERIFICATION_FAILED' };
  if (error.code === 'PATCHED_SOURCE_MISMATCH') result.failure.source = { expected: error.expected, actual: error.actual };
  process.exitCode = 1;
} finally {
  result.elapsedMs = Date.now() - started;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
