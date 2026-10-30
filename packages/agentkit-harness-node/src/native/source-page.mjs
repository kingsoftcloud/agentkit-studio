import { canonical, invariant, workspaceSourceModelReply, archivedSourceObservation } from '@kingsoftcloud/agentkit-harness-core';
import { estimateNativeText, NATIVE_CONTEXT_COUNTER_ID } from './context-counter.mjs';

export function validateSourcePageBudget(budget) {
  invariant(budget?.policy === 'agentkit.source-page-budget/v1' && budget.counterId === NATIVE_CONTEXT_COUNTER_ID
    && typeof budget.quoteDigest === 'string' && budget.quoteDigest && typeof budget.tokenizerDigest === 'string' && budget.tokenizerDigest
    && ['maxSourceUnits', 'maxResultUnits', 'maxResultBytes', 'sourceGroupSize'].every(key => Number.isSafeInteger(budget[key]) && budget[key] > 0)
    && budget.maxResultBytes >= 1024, 'source_read_budget_unavailable');
  return budget;
}
const maximumUri = 'artifact://' + 'a'.repeat(245);
const modelBytes = text => Buffer.byteLength(canonical({ content: text, media: [], additionalContexts: [] }));

/** Shape the exact bytes already selected by the filesystem reader. No I/O,
 * artifact publication, read-state grant or secondary source read occurs here. */
export function budgetWorkspaceSourcePage(info, content, requestedLimit, inputBudget) {
  const budget = validateSourcePageBudget(inputBudget), chars = Array.from(content);
  const requested = Math.max(1000, Math.min(Number(requestedLimit ?? 20000), 100000));
  const carrier = { path: info.path, read_range: { start: info.start_line, end: info.end_line }, content };
  const fullCount = info.line_count;
  let low = 0, high = Math.min(chars.length, requested);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateNativeText(chars.slice(0, mid).join('')) <= budget.maxSourceUnits) low = mid; else high = mid - 1;
  }
  const prefix = chars.slice(0, low).join('');
  let visible = prefix, count = fullCount, truncated = low < chars.length;
  if (truncated) {
    const complete = chars[low] === '\n', boundary = prefix.lastIndexOf('\n');
    count = complete ? prefix.split('\n').length : boundary >= 0 ? prefix.slice(0, boundary).split('\n').length : 0;
    visible = complete || !count ? prefix : prefix.slice(0, boundary);
  }
  const window = (returned, text) => {
    const last = returned ? info.start_line + returned - 1 : null;
    return { content: text, preview_chars: Array.from(text).length, end_line: last, line_count: returned,
      read_range: last === null ? null : { start: info.start_line, end: last },
      source_read_range: carrier.read_range, next_start_line: last === null ? null : last + 1,
      suggested_action: last === null
        ? 'The source line or result metadata exceeds the output window. Use bound search or another permitted inspection tool; the unread remainder cannot be skipped.'
        : `Continue with read_workspace_file(path='${info.path}', start_line=${last + 1}); the remaining lines were not returned.`,
      ...(returned ? {} : { partial_line: info.start_line }) };
  };
  let result = { ...info, content: visible, preview_chars: Array.from(visible).length, original_chars: chars.length,
    truncated, partial: info.partial || truncated, requested_source: carrier,
    source_output_budget: { version: 'host-source-page/v2', counter_id: budget.counterId,
      max_units: budget.maxSourceUnits, max_result_units: budget.maxResultUnits },
    ...(truncated ? window(count, visible) : {}) };
  const fits = page => {
    const projected = workspaceSourceModelReply(page) ?? canonical({ status: 'ok', content: page });
    const text = archivedSourceObservation(projected, maximumUri);
    return estimateNativeText(canonical(text)) <= budget.maxResultUnits && modelBytes(text) <= budget.maxResultBytes;
  };
  let sourceLines;
  const candidate = returned => ({ ...result, ...window(returned, (sourceLines ??= content.split('\n')).slice(0, returned).join('\n')),
    truncated: true, partial: true, ...(returned ? {} : { artifact_only: true }) });
  if (!fits(result)) {
    if (!content) return { ok: false, path: info.path, error_message: 'source_read_envelope_over_budget' };
    low = 0; high = count;
    if (!fits(candidate(0))) return { ok: false, path: info.path, error_message: 'source_read_envelope_over_budget' };
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(candidate(mid))) low = mid; else high = mid - 1;
    }
    result = candidate(low);
  }
  if (content && result.line_count === 0) {
    // Retaining a source, including a partial first line, is not evidence of a
    // live read. The latest reference policy returns a saved-unread envelope.
    result = { ...result, ...window(0, ''), artifact_only: true, truncated: true, partial: true };
    if (!fits(result)) return { ok: false, path: info.path, error_message: 'source_read_envelope_over_budget' };
  }
  return result;
}
