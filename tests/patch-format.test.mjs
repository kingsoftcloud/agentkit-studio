import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePatchFormat } from '../scripts/check-patch-format.mjs';

const added = 'diff --git a/example.txt b/example.txt\nnew file mode 100644\n--- /dev/null\n+++ b/example.txt\n@@ -0,0 +1 @@\n+example\n';
const deleted = 'diff --git a/example.txt b/example.txt\ndeleted file mode 100644\n--- a/example.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-example\n';

test('Git text diffs can create, modify and delete files without a checkout', () => {
  for (const diff of [added, deleted, '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n']) {
    assert.doesNotThrow(() => validatePatchFormat(diff));
  }
});

test('wrapper markers and malformed hunks cannot pass the format gate', () => {
  assert.throws(() => validatePatchFormat(`*** Begin Patch\n${added}*** End Patch\n`), /wrapper/);
  assert.throws(() => validatePatchFormat(added.replace('@@ -0,0 +1 @@', '@@ -0,zero +1 @@')), /Git rejected/);
  assert.throws(() => validatePatchFormat('diff --git a/example.txt b/example.txt\nold mode 100644\nnew mode 100755\n'), /unified text diff/);
});
