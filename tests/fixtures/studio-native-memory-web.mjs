/** Only a legacy-loop sentinel. Agents, turns and Memory use production UI/Host. */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'studio-native-memory-web-proof';
export const inject = ['llm', 'studioHostCompatibility'];
export function apply(ctx, { directory }) {
  ctx.llm.registerAdapter(['agentkit-studio-fixture', 'agentkit-studio-fixture-hidden'], {
    providerInfo: provider => ({ id: provider, name: 'Local Memory proof' }),
    providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'pinned', name: 'pinned' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => {
      appendFileSync(join(directory, 'legacy-loop.jsonl'), JSON.stringify({ entered: true }) + '\n');
      throw Error('Memory Web acceptance entered the legacy DSH model loop');
    },
  });
}
