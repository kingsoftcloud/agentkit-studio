import type { CommitBatch, Message, ObjectValue, RunConfiguration, RunSnapshot, StoredRun } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { contextMessageRef } from './context-planning.mjs';

type Digest = (value: unknown) => string;

/** Select from actual admission after the completed model claim, never the catalog. */
export function outputRecoveryMode(snapshot: RunSnapshot, config: RunConfiguration, toolsAvailable: boolean): 'suffix' | 'task_resume' {
  if (config.outputRecoveryPolicy !== 'task-or-delivery/v1' || config.contract.finalOutputFormat !== 'text') return 'suffix';
  const last = snapshot.messages.at(-1);
  // An already admitted suffix contract survives a restore and policy upgrade.
  if (last?.kind === 'continuation_observation' && (last.continuationMode ?? 'suffix') === 'suffix') return 'suffix';
  return toolsAvailable ? 'task_resume' : 'suffix';
}

function authenticatedFragment(fragment: Message, observation: Message, digest: Digest): boolean {
  return fragment.role === 'assistant' && fragment.kind === 'continuation_fragment'
    && observation.role === 'user' && observation.kind === 'continuation_observation'
    && typeof fragment.continuationResponseId === 'string' && !!fragment.continuationResponseId
    && observation.continuationResponseId === fragment.continuationResponseId
    && observation.continuationFragmentDigest === digest(fragment.content);
}

/** Only a contiguous host-sealed suffix chain can contribute to a delivery. */
export function completeContinuation(messages: Message[], suffix: string, digest: Digest): string {
  const fragments: string[] = [];
  for (let index = messages.length - 1; index >= 1; index -= 2) {
    const fragment = messages[index - 1]!, observation = messages[index]!;
    if ((observation.continuationMode ?? 'suffix') !== 'suffix' || !authenticatedFragment(fragment, observation, digest)) break;
    fragments.push(fragment.content);
  }
  return fragments.reverse().join('') + suffix;
}

/** Retire only the authenticated unfinished chain, preserving every committed effect. */
export function restartContinuation(snapshot: RunSnapshot, config: RunConfiguration, lastFragment: string, digest: Digest): Pick<RunSnapshot, 'messages' | 'contextState'> {
  const messages = copy(snapshot.messages), discarded = [lastFragment];
  while (messages.length >= 2) {
    const fragment = messages.at(-2)!, observation = messages.at(-1)!;
    if (!authenticatedFragment(fragment, observation, digest)) break;
    discarded.push(fragment.content); messages.splice(-2);
  }
  const surviving = messages.length, state = copy(snapshot.contextState);
  const history = state?.history;
  if (history) {
    // Validate the ORIGINAL seal before retiring part of its prefix. A restart
    // cannot bless prior edits, foreign refs, a changed goal or tokenizer.
    invariant(config.contextPolicy && Number.isSafeInteger(history.prefixCount) && history.prefixCount >= 0
      && history.prefixCount <= snapshot.messages.length && history.tokenizerDigest === config.contextPolicy.tokenizerDigest
      && history.contractDigest === digest(config.contract)
      && history.prefixDigest === digest(snapshot.messages.slice(0, history.prefixCount))
      && typeof history.summary === 'string' && history.summary.trim(), 'context_history_binding_mismatch');
    const refs = snapshot.messages.slice(0, history.prefixCount).map((message, index) => contextMessageRef(message, index, digest));
    invariant(Array.isArray(history.retainedRefs) && new Set(history.retainedRefs).size === history.retainedRefs.length
      && history.retainedRefs.every(ref => refs.includes(ref)), 'context_history_refs_invalid');
    invariant(!state.compaction, 'context_compaction_source_changed');
    if (surviving < history.prefixCount) {
      const retained = new Set(messages.map((message, index) => contextMessageRef(message, index, digest)));
      history.prefixCount = surviving; history.prefixDigest = digest(messages);
      history.retainedRefs = history.retainedRefs.filter(ref => retained.has(ref));
    }
  }
  messages.push({ role: 'user', kind: 'output_limit_restart_observation', content:
    'The previous response exceeded the output limit repeatedly. Its unfinished tool call was not executed. '
    + 'Use smaller independent tool calls or files; do not repeat one oversized call. '
    + `Discarded output fingerprint: ${digest(discarded.reverse().join(''))}.` });
  return { messages, contextState: state };
}

/** Store exception to append-only messages: only sealed, contiguous unfinished
 * output can retire, in the SAME original model receipt transaction. Events,
 * intents, receipts, tool observations and all preceding messages remain. */
export function isOutputRestartBatch(record: StoredRun, batch: CommitBatch): boolean {
  const before = record.snapshot, after = batch.snapshot, config = record.configuration;
  const intent = record.intents.find(item => item.operationKey === before.pendingIntent);
  const receipt = batch.receipts[0];
  if (before.phase !== 'requesting_model' || after.phase !== 'preparing_context' || !intent
    || intent.kind !== 'model' || intent.status !== 'running' || intent.payload.purpose === 'compaction'
    || before.continuations < config.profile.maxContinuations || before.outputRestarts >= config.limits.maxOutputRestarts
    || after.outputRestarts !== before.outputRestarts + 1 || after.continuations !== 0 || after.pendingIntent !== null
    || batch.consumedCommandId !== null || batch.intents.length || batch.receipts.length !== 1
    || receipt?.operationKey !== before.pendingIntent || receipt.status !== 'committed' || receipt.result.kind !== 'output_limit'
    || typeof receipt.result.text !== 'string' || after.messages.at(-1)?.role !== 'user'
    || after.messages.at(-1)?.kind !== 'output_limit_restart_observation') return false;
  const retained = after.messages.length - 1;
  if (retained < 0 || retained >= before.messages.length
    || canonical(after.messages.slice(0, retained)) !== canonical(before.messages.slice(0, retained))) return false;
  for (let index = before.messages.length - 1; index >= retained; index -= 2) {
    if (index - 1 < retained) return false;
    const fragment = before.messages[index - 1]!, observation = before.messages[index]!;
    if (fragment.role !== 'assistant' || fragment.kind !== 'continuation_fragment'
      || observation.role !== 'user' || observation.kind !== 'continuation_observation'
      || typeof fragment.continuationResponseId !== 'string' || !fragment.continuationResponseId
      || observation.continuationResponseId !== fragment.continuationResponseId
      || typeof observation.continuationFragmentDigest !== 'string' || !observation.continuationFragmentDigest) return false;
  }
  const events = batch.events.filter(event => event.kind === 'output.restarted');
  if (events.length !== 1 || canonical(events[0]!.payload) !== canonical(outputRestartPayload(before, after))) return false;
  return true;
}

/** Replay positions of retired output without publishing private provider data. */
export function outputRestartPayload(before: RunSnapshot, after: RunSnapshot): ObjectValue {
  const retained = after.messages.length - 1;
  const publicFrame = (message: Message) => ({ role: message.role, kind: message.kind ?? null, content: message.content });
  return { operationKey: before.pendingIntent, outputRestarts: after.outputRestarts, retainedMessageCount: retained,
    retiredMessages: before.messages.slice(retained).map(publicFrame), notice: publicFrame(after.messages.at(-1)!) };
}
