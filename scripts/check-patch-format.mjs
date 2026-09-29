#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const patchRoot = resolve(repoRoot, process.argv[2] ?? 'patches/dsh-v0.2.0-rc.2')

function fail(message) {
  console.error(`patch-format: ${message}`)
  process.exitCode = 1
}

if (!statSync(patchRoot, { throwIfNoEntry: false })?.isDirectory()) {
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
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const headerIndex = lines.findIndex((line) => line.startsWith('--- a/'))
    const hasUnifiedHeader = headerIndex >= 0 &&
      lines[headerIndex + 1]?.startsWith('+++ b/') &&
      lines.slice(0, headerIndex).every((line) => line.startsWith('diff --git ') ||
        line.startsWith('index ') || line === '')
    const hasHunk = lines.some((line) => line.startsWith('@@ '))

    if (!hasUnifiedHeader) {
      fail(`${name}: expected a standard unified diff header (--- a/ then +++ b/)`)
    }
    if (!hasHunk) {
      fail(`${name}: expected at least one unified diff hunk (@@)`)
    }
    if (lines.some((line) => line.includes('*** Begin Patch') || line.includes('*** End Patch'))) {
      fail(`${name}: apply_patch wrapper markers are not valid patch contents`)
    }
  }

  if (!process.exitCode) {
    console.log(`patch-format: ${files.length} unified patches passed (${patchRoot})`)
  }
}
