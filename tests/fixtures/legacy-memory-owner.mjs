import { createLegacyMemoryTools } from '../../src/legacy-memory-tools.mjs';
const input = JSON.parse(process.argv[2]);
const service = createLegacyMemoryTools(input.service);
try {
  const result = await service.execute(input.name, input.args, { ...input.invocation,
    signal: new AbortController().signal, assertCurrent: () => true });
  await service.close(); process.send({ result });
} catch (error) { await service.close(); process.send({ error: error.code ?? error.message }); }
process.disconnect();
