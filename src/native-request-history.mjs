/** Read the exact accepted request through public DSH history paging. */
export async function readNativeRequestEvents(controller, sessionId, requestId, signal) {
  const projection = await controller.projections({ sessionId }, signal);
  const throughSeq = projection?.asOfSeq ?? -1;
  let beforeSeq, events = [];
  while (true) {
    signal.throwIfAborted();
    const page = await controller.page({ address: { kind: 'session', sessionId }, throughSeq, maxMessages: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, signal);
    const batch = (page?.records || []).filter(item => item.type === 'event').map(item => item.event);
    events = [...batch, ...events];
    const userIndex = events.findIndex(event => event.type === 'user/message' && event.data?.source?.rpcId === requestId);
    if (userIndex >= 0) {
      const start = events.slice(0, userIndex + 1).findLastIndex(event => event.type === 'turn/start');
      if (start >= 0) {
        const turn = events[start].data.turn;
        const end = events.findIndex((event, index) => index > userIndex && event.type === 'turn/end' && event.data?.turn === turn);
        if (end < 0) throw Object.assign(new Error('渠道请求尚无完整运行终态'), { code: 'CHANNEL_TURN_INCOMPLETE' });
        return events.slice(start, end + 1);
      }
    }
    if (!page?.hasMore || !batch.length || (beforeSeq !== undefined && batch[0].seq >= beforeSeq)) break;
    beforeSeq = batch[0].seq;
  }
  throw Object.assign(new Error('原生历史中未找到本次渠道请求'), { code: 'CHANNEL_REQUEST_NOT_FOUND' });
}
