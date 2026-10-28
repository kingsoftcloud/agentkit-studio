import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

// Exact readonly reference schema @355059d, not an implementation-derived
// schema or Python execution. Provenance/hash recorded in native-managed-kernel.md.
const schema = JSON.parse(readFileSync(new URL('./native-managed-runtime-v2.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
export function assertManagedRuntimeFacts(facts) {
  for (const fact of facts.filter(fact => fact.family === 'runtime')) {
    assert.equal(validate(fact.payload), true, JSON.stringify({ type: fact.event_type, errors: validate.errors }));
    assert.equal(fact.seq, fact.payload.seq); assert.equal(fact.event_id, fact.payload.event_id);
    assert.equal(Date.parse(fact.timestamp) / 1000, fact.payload.timestamp);
  }
}
