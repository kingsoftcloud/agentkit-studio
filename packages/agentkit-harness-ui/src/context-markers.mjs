/** Place committed context notices at their original transcript boundary.
 * Unloaded anchors stay hidden until history arrives, never moved to the end. */
export function contextTimelineItems(items, markers = []) {
  const boundaries = new Map();
  for (const marker of markers) {
    let index = -1;
    if (marker.after.kind === 'start') {
      index = 0; while (index < items.length && items[index].role === 'user') index++;
    } else {
      for (let i = items.length - 1; i >= 0; i--) {
        if (marker.after.kind === 'tool' ? items[i].callId === marker.after.id : items[i].sourceMessageId === marker.after.id) { index = i + 1; break; }
      }
    }
    if (index < 0) continue;
    const group = boundaries.get(index) ?? [];
    group.push({ kind: 'context-marker', ...marker }); boundaries.set(index, group);
  }
  return items.flatMap((item, index) => [...boundaries.get(index) ?? [], item]).concat(boundaries.get(items.length) ?? []);
}
