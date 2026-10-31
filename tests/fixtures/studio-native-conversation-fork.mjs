/** Test transport only: invokes the same production SessionController fork used by the UI. */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function installConversationForkControls(ctx, options) {
  let timer, busy = false, last = null, closed = false;
  const requestFile = join(options.directory, 'conversation-fork-command.json');
  const tick = async () => {
    if (busy || closed || !existsSync(requestFile)) return;
    busy = true;
    try {
      const request = JSON.parse(await readFile(requestFile, 'utf8'));
      if (request.id === last) return;
      if (existsSync(join(options.directory, `conversation-fork-${request.id}.json`))) { last = request.id; return; }
      const controller = ctx.get('sessionController');
      if (!controller) return;
      last = request.id;
      try {
        const result = await controller.fork(request.payload);
        await writeFile(join(options.directory, `conversation-fork-${request.id}.json`), JSON.stringify({ ok: true, ...result, hostPid: process.pid }));
      } catch (error) {
        await writeFile(join(options.directory, `conversation-fork-${request.id}.json`), JSON.stringify({ ok: false, code: error.code, message: error.message, stack: error.stack }));
      }
    } finally { busy = false; }
  };
  ctx.effect(() => { timer = setInterval(() => { void tick(); }, 20); return () => { closed = true; clearInterval(timer); }; }, 'Conversation fork proof command transport');
}
