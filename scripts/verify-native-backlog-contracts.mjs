import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Focused local contracts, not the repository fullcheck or the consuming
// business platform's C1-C8 suite. Packed Host proofs run separately.
const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { only: { type: 'string' }, output: { type: 'string' } } });
const groups = {
  C1: [['tests/native-multi-session-recovery-contract.test.mjs']],
  C2: [
    ['tests/native-session-inbox.test.mjs', 'tests/native-managed-injection.test.mjs', 'tests/native-session-injection-authority.test.mjs'],
    ['--test-name-pattern=Studio C2|Studio managed injection', 'tests/native-managed-studio-binding.test.mjs'],
  ],
  C3: [
    ['tests/native-background-session-binding.test.mjs', 'tests/native-dsh-background-runtime.test.mjs',
      'tests/studio-scheduler.test.mjs', 'tests/native-automation-runner.test.mjs',
      'tests/studio-native-background-watcher.test.mjs', 'tests/native-background-lifecycle.test.mjs'],
    ['--test-name-pattern=C3: main', 'tests/studio-native-children.test.mjs'],
  ],
  C4: [
    ['--test-name-pattern=C4:|Plan native_|child Plan keeps|model arguments cannot|unsupported or unauthorized|production Studio assembly',
      'tests/studio-native-children.test.mjs'],
    ['tests/native-host-child-approval.test.mjs'],
  ],
  C5: [['tests/studio-native-hooks.test.mjs']],
};
const selected = values.only ? values.only.split(',') : Object.keys(groups);
if (!selected.length || selected.some(id => !Object.hasOwn(groups, id))) throw Error('Use --only C1,C2,C3,C4,C5');
const output = resolve(root, values.output ?? '.artifacts/native-backlog-acceptance'); mkdirSync(output, { recursive: true });
const report = { contract: 'agentkit.native-backlog-local-acceptance/v1',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version, groups: {}, limitations: [
    'Local mechanism and synthetic-session acceptance; business routing, audience isolation and Tool Gateway integration are not certified.',
    'Controlled model responses verify model routing and lifecycle, not real-model task quality.',
    'The consuming platform C1-C8 suite and 48-hour stability acceptance were not run.',
    'No main merge, GitHub push, npm publication or ezone synchronization is performed by this verifier.',
  ] };
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
report.packageArchives = Object.fromEntries(['core', 'node', 'ui'].map(name => {
  const reference = manifest.dependencies[`@kingsoftcloud/agentkit-harness-${name}`];
  return [name, { reference, sha256: createHash('sha256').update(readFileSync(join(root, reference.slice(5)))).digest('hex') }];
}));
for (const id of selected) {
  const runs = groups[id].map((args, index) => {
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...args],
      { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 120000 });
    const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const filename = `${id}-${index + 1}.log`; writeFileSync(join(output, filename), log);
    const count = key => Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(log)?.[1] ?? 0);
    return { command: ['node', '--test', ...args], log: filename, exitCode: result.status,
      tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled') };
  });
  const passed = runs.every(run => run.exitCode === 0 && run.tests > 0 && run.passed === run.tests && run.skipped === 0 && run.cancelled === 0);
  report.groups[id] = { passed, runs };
  console.log(`${id}: ${passed ? 'PASS' : 'FAIL'} (${runs.reduce((sum, run) => sum + run.tests, 0)} focused checks)`);
}
report.passed = Object.values(report.groups).every(group => group.passed);
report.fullBusinessBacklogClosed = false;
writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
if (!report.passed) process.exitCode = 1;
