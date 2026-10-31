import { nativeDeliveryId } from './delivery-timeline.mjs';
import { copy } from '@kingsoftcloud/agentkit-harness-core';

/** Read-only timeline facts; proposals and summary model calls never mean adoption. */
export function advanceNativeContextMarkerState(previous, record) {
  const { snapshot, events = [] } = record;
  const state = copy(previous ?? { anchor: { kind: 'start' }, adopted: 0, markers: [] });
  let { anchor, adopted } = state;
  const markers = state.markers;
  let active = markers.findLast(fact => fact.settledSeq === null && fact.marker.status === 'running') ?? null;
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
      if (active) { active.marker.status = 'completed'; active.settledSeq = event.seq ?? null; active = null; }
      // Never invent a missing historical start or position.
      adopted = count;
    }
    if (event.payload.action === 'blocked' && active) { active.marker.status = 'failed'; active.settledSeq = event.seq ?? null; active = null; }
    if (event.payload.action === 'compact' && !active && event.eventId) {
      active = { marker: { id: nativeDeliveryId(snapshot.scope, snapshot.runId, `context:${event.eventId}`),
        status: 'running', origin: 'auto', after: { ...anchor } }, settledSeq: null };
      markers.push(active);
    }
  }
  return { anchor, adopted, markers };
}

export function nativeContextMarkerFactsFromState(state, snapshot, { driving = false } = {}) {
  const markers = copy(state.markers);
  const active = markers.findLast(fact => fact.settledSeq === null && fact.marker.status === 'running');
  if (active && !driving) {
    active.marker.status = snapshot.phase === 'failed' ? 'failed' : 'interrupted';
    if (['completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase)) active.settledSeq = snapshot.eventSeq;
  }
  return markers;
}

export function nativeContextMarkerFacts(record, options) {
  return nativeContextMarkerFactsFromState(advanceNativeContextMarkerState(null, record), record.snapshot, options);
}

export function nativeContextMarkers(record, options) {
  return nativeContextMarkerFacts(record, options).map(fact => fact.marker);
}
