import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const directories = ['tests', 'packages/agentkit-harness/test', 'packages/expert-catalog/test'];
const files = directories.flatMap(directory => readdirSync(directory).filter(name => name.endsWith('.test.mjs'))
  .map(name => `${directory}/${name}`));
const concurrency = process.env.AGENTKIT_TEST_CONCURRENCY;
if (concurrency !== undefined && !/^[1-9][0-9]*$/.test(concurrency)) throw Error('Invalid test concurrency');
const result = spawnSync(process.execPath, ['--test', ...(concurrency ? [`--test-concurrency=${concurrency}`] : []), ...files],
  { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
