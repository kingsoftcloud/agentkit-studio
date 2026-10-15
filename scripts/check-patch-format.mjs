#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const patchRoot = resolve(repoRoot, process.argv[2] ?? 'patches/dsh-v0.2.0-rc.2')

/** Validate text diffs, including file creation and deletion, with Git's parser. */
export function validatePatchFormat(source) {
  const lines = source.split(/\r?\n/)
  if (lines.some(line => line.includes('*** Begin Patch') || line.includes('*** End Patch'))) {
    throw new Error('apply_patch wrapper markers are not valid patch contents')
  }
  const header = lines.findIndex(line => /^(?:--- a\/|--- \/dev\/null$)/.test(line))
  if (header < 0 || !/^(?:\+\+\+ b\/|\+\+\+ \/dev\/null$)/.test(lines[header + 1] ?? '')
    || !lines.some(line => line.startsWith('@@ '))) {
    throw new Error('expected a unified text diff with file headers and hunks')
  }
  const parsed = spawnSync('git', ['apply', '--numstat', '--'], { input: source, encoding: 'utf8' })
  if (parsed.error) throw parsed.error
  if (parsed.status !== 0 || !parsed.stdout.trim()) throw new Error('Git rejected the unified diff syntax')
}

function fail(message) {
  console.error(`patch-format: ${message}`)
  process.exitCode = 1
}

if (process.argv[1] !== fileURLToPath(import.meta.url)) {
  // Importing the validator does not inspect a checkout or run the CLI.
} else if (!statSync(patchRoot, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`patch directory does not exist: ${patchRoot}`)
} else {
  const files = readdirSync(patchRoot)
    .filter((name) => name.endsWith('.patch'))
    .sort()

  if (files.length === 0) {
    fail(`no .patch files found in ${patchRoot}`)
  }

  for (const name of files) {
    const file = join(patchRoot, name)
    try { validatePatchFormat(readFileSync(file, 'utf8')) }
    catch (error) { fail(`${name}: ${error.message}`) }
  }

  if (!process.exitCode) {
    console.log(`patch-format: ${files.length} unified patches passed (${patchRoot})`)
  }
}
