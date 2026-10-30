import { SqliteNativeMemoryProvider } from '@kingsoftcloud/agentkit-harness-node/native/memory-store';

const [filename, mode, raw] = process.argv.slice(2), input = JSON.parse(raw);
const provider = new SqliteNativeMemoryProvider(filename, { principal: input.principal,
  ...(mode === 'before-commit' ? { beforeCommit: () => process.exit(37) } : {}) });
const execute = () => {
  const result = provider.applyCandidate(input.request);
  if (mode === 'after-commit') process.exit(38);
  provider.close(); process.send?.({ result }); process.disconnect?.();
};
if (mode === 'concurrent') { process.once('message', execute); process.send({ ready: true }); }
else execute();
