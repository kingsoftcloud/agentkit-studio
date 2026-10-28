import { parentPort, workerData } from 'node:worker_threads';
import { applyZcodeEdit } from './workspace-editing.mjs';

let text = workerData.text;
const results = [];
for (const edit of workerData.edits) {
  const result = applyZcodeEdit(text, edit.old_text, edit.new_text, {
    relative: workerData.relative, replaceAll: Boolean(edit.replace_all ?? workerData.replaceAll),
    expectedReplacements: edit.expected_replacements ?? 1,
  });
  results.push(result);
  if (!result.ok) break;
  text = result.updated;
}
parentPort.postMessage({ contract: 'zcode-match/v1', results });
