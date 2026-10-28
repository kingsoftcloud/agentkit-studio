import { createHash } from 'node:crypto';

/** Shared with context injection: explicit tools must address the same facts. */
export function memorySubjectId(collectionId, userId, agentId = '') {
  const encoded = JSON.stringify(['memory-partition/v1', String(collectionId || ''), String(agentId || ''),
    String(userId || 'studio-anonymous').trim() || 'studio-anonymous']);
  return `mp1-${createHash('sha256').update(encoded).digest('hex').slice(0, 60)}`;
}

export function memorySessionId(sessionId) {
  const raw = String(sessionId || '').trim();
  return raw ? createHash('sha256').update(`memory-session/v1|${raw}`).digest('hex') : '';
}
