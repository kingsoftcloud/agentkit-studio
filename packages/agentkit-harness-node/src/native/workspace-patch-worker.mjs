import { parentPort, workerData } from 'node:worker_threads';
import { derivePatchedContent } from '@kingsoftcloud/agentkit-harness-core/patch-apply';

try {
  let bytes = 0;
  const changes = workerData.map(item => {
    const text = item.section.type === 'update' ? derivePatchedContent(item.text, item.section.chunks).content
      : item.section.type === 'add' ? item.section.contents : '';
    bytes += Buffer.byteLength(text);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024 || bytes > 16 * 1024 * 1024)
      throw Object.assign(Error('Patched output exceeds the 2 MiB per-file or 16 MiB total limit'), { code: 'patch_budget_exceeded' });
    return text;
  });
  parentPort.postMessage({ contract: 'zcode-patch/v1', changes });
} catch (error) {
  parentPort.postMessage({ contract: 'zcode-patch/v1', error: String(error.message), code: error.code ?? 'apply_patch_hunk_not_found' });
}
