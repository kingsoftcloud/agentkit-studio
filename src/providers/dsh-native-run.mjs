import { textOf } from './dsh-messages.mjs';
import { NATIVE_ENGINE_EVENT } from './native-engine-runtime.mjs';

function previousNativeRun(agent, sessionId) {
  const session = agent?.session;
  if (!sessionId || session?.id !== sessionId || typeof session.snapshotEvents !== 'function'
    || typeof session.isOwnSeq !== 'function') return null;
  const entry = session.snapshotEvents().findLast(event => event.type === NATIVE_ENGINE_EVENT
    && event.ignorable === true && session.isOwnSeq(event.seq));
  if (!entry || entry.data?.event?.kind === 'run.terminal') return null;
  return { runId: entry.data?.runId, cursor: entry.data?.event?.seq };
}

function nativeInboxGuidance(agent, messages) {
  if (!agent?.inbox || !agent.session || typeof agent.session.append !== 'function') return {};
  const { inbox, session } = agent;
  const displayed = new Set((messages ?? []).filter(message => message.role === 'user').map(message => message.id));
  return {
    nextGuidance() {
      const message = inbox.nextStep[0];
      if (message?.source?.kind !== 'user' || typeof message.id !== 'string'
        || !Array.isArray(message.content) || !message.content.every(part => part.type === 'text')) return null;
      return { id: message.id, text: textOf(message), message };
    },
    commitGuidance({ id, text, message }) {
      if (!displayed.has(id)) {
        session.append('user/message', message, { surfaceOp: 'append' });
        displayed.add(id);
      }
      if (inbox.nextStep.some(queued => queued.id === id && textOf(queued) === text)) inbox.remove(id);
    },
  };
}

export function nativeSessionRunOptions(agent, messages, sessionId) {
  return {
    ...nativeInboxGuidance(agent, messages),
    previousRun: () => previousNativeRun(agent, sessionId),
  };
}
