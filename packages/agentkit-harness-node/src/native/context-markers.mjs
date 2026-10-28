import { nativeDeliveryId } from './delivery-timeline.mjs';

/** Read-only timeline facts; proposals and summary model calls never mean adoption. */
export function nativeContextMarkerFacts(record, { driving = false } = {}) {
  const { snapshot, events = [] } = record;
  let anchor = { kind: 'start' }, active = null, adopted = 0;
  const markers = [];
  for (const event of events) {
    if (event.kind === 'model.completed' && event.eventId) anchor = {
      kind: 'message', id: nativeDeliveryId(snapshot.scope, snapshot.runId, `response:${event.eventId}`),
    };
    if (event.kind === 'tool.completed' && event.payload.callId) anchor = {
      kind: 'tool', id: nativeDeliveryId(snapshot.scope, snapshot.runId, `call:${event.payload.callId}`),
    };
    if (event.kind !== 'context.planned') continue;
    const count = event.payload.compactions;
    if (Number.isSafeInteger(count) && count > adopted) {
      if (active) { active.marker.status = 'completed'; active.settledSeq = event.seq; active = null; }
      // Never invent a missing historical start or position.
      adopted = count;
    }
    if (event.payload.action === 'blocked' && active) { active.marker.status = 'failed'; active.settledSeq = event.seq; active = null; }
    if (event.payload.action === 'compact' && !active && event.eventId) {
      active = { marker: { id: nativeDeliveryId(snapshot.scope, snapshot.runId, `context:${event.eventId}`),
        status: 'running', origin: 'auto', after: { ...anchor } }, settledSeq: null };
      markers.push(active);
    }
  }
  if (active && !driving) {
    active.marker.status = snapshot.phase === 'failed' ? 'failed' : 'interrupted';
    if (['completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase)) active.settledSeq = snapshot.eventSeq;
  }
  return markers;
}

export function nativeContextMarkers(record, options) {
  return nativeContextMarkerFacts(record, options).map(fact => fact.marker);
}
