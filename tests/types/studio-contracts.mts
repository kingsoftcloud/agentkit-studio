import { STUDIO_OPERATIONS } from '../../src/contracts/definitions.mjs';
import { createOperationClient } from '../../src/contracts/wire.mjs';
import type { StudioOperationId } from '../../src/contracts/operations.mjs';
const client = createOperationClient({ rpc: { call: async () => ({ ok: true }) } });
const operation: StudioOperationId = 'schedules/delivery-targets';
void client.call(operation, { agentId: 'fixture' }, new AbortController().signal);
void client.methods['agents/list']({ limit: 10 });
STUDIO_OPERATIONS[operation].input(operation, { agentId: 'fixture' });
// @ts-expect-error Operation IDs come from the canonical registry.
void client.call('agents/misspelled', {});
// @ts-expect-error Generated methods cannot drift from the registry.
void client.methods['agents/misspelled']({});
// @ts-expect-error Signals travel outside JSON payloads.
void client.call('agents/list', {}, { signal: new AbortController().signal });
// @ts-expect-error Wire payloads are JSON, not executable functions.
void client.call('agents/list', () => 1);
