/** This entrypoint runs in the independent Harness process. */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [directory, ...args] = process.argv.slice(2);
const fromRelease = file => import(pathToFileURL(join(directory, 'src/native', file)).href);
const [{ createEngineService }, { engineStartupFromArgs }] = await Promise.all([
  fromRelease('engine-service.mjs'), fromRelease('engine-server.mjs'),
]);
const service = createEngineService({
  startup: engineStartupFromArgs(args, process.env),
  token: process.env.AGENTKIT_ENGINE_SERVICE_TOKEN,
});
let closing;
const close = () => closing ??= service.close().then(() => process.exit(0), () => process.exit(1));
process.once('disconnect', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);
service.server.once('error', () => process.exit(1));
service.server.listen(0, '127.0.0.1', () => process.send?.({ port: service.server.address().port }));
