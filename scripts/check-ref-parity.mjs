#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const defaults = {
  leftRemote: process.env.PARITY_LEFT_REMOTE || 'origin',
  leftRef: process.env.PARITY_LEFT_REF || 'refs/heads/master',
  rightRemote: process.env.PARITY_RIGHT_REMOTE || 'github',
  rightRef: process.env.PARITY_RIGHT_REF || 'refs/heads/main',
};

export function resolveRemoteRef(remote, ref, run = execFileSync) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)
    || !/^refs\/heads\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref)) {
    throw new Error('parity requires a named remote and an exact branch ref');
  }
  let output;
  try {
    output = run('git', ['ls-remote', '--refs', '--exit-code', remote, ref], {
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch { throw new Error(`unable to read branch ref: ${remote} ${ref}`); }
  const rows = output.split(/\r?\n/).filter(Boolean).map(row => row.split(/\s+/));
  if (rows.length !== 1 || rows[0][1] !== ref || rows[0].length !== 2
    || !/^[0-9a-f]{40}$/i.test(rows[0][0])) {
    throw new Error(`remote ref not found or invalid: ${remote} ${ref}`);
  }
  const sha = rows[0][0];
  return sha.toLowerCase();
}

export function assertParity(left, right) {
  if (left.sha !== right.sha) {
    throw new Error([
      'remote ref parity failed',
      `  ${left.remote} ${left.ref}: ${left.sha}`,
      `  ${right.remote} ${right.ref}: ${right.sha}`,
      'The sync job must stop; do not force-push either protected branch.',
    ].join('\n'));
  }
  return left.sha;
}

function usage() {
  console.log(`Usage: node scripts/check-ref-parity.mjs [options]

Options:
  --left-remote <name>   Canonical forge remote (default: ${defaults.leftRemote})
  --left-ref <ref>       Canonical branch ref (default: ${defaults.leftRef})
  --right-remote <name>  Mirror forge remote (default: ${defaults.rightRemote})
  --right-ref <ref>      Mirror branch ref (default: ${defaults.rightRef})
`);
}

export function parseOptions(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'left-remote': { type: 'string' },
      'left-ref': { type: 'string' },
      'right-remote': { type: 'string' },
      'right-ref': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  return {
    help: values.help === true,
    leftRemote: values['left-remote'] || defaults.leftRemote,
    leftRef: values['left-ref'] || defaults.leftRef,
    rightRemote: values['right-remote'] || defaults.rightRemote,
    rightRef: values['right-ref'] || defaults.rightRef,
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    usage();
    return 0;
  }
  const left = { remote: options.leftRemote, ref: options.leftRef };
  const right = { remote: options.rightRemote, ref: options.rightRef };
  left.sha = resolveRemoteRef(left.remote, left.ref);
  right.sha = resolveRemoteRef(right.remote, right.ref);
  const sha = assertParity(left, right);
  console.log(`remote ref parity passed: ${left.remote} ${left.ref} == ${right.remote} ${right.ref} @ ${sha}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
