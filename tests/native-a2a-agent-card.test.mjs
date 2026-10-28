/** Tests for A2A AgentCard builder. Pure, no I/O, no dependencies. */
import test from 'node:test';
import assert from 'node:assert/strict';

test('parent review: JSON-unsafe extensions are rejected without executing getters/toJSON or silently discarding values', () => {
  let executions = 0;
  const accessor = {}; Object.defineProperty(accessor, 'secret', { enumerable: true, get() { executions++; return 'private'; } });
  const cyclic = {}; cyclic.self = cyclic;
  for (const extension of [undefined, () => {}, Symbol('x'), 1n, NaN, Infinity, cyclic, new Date(), accessor,
    { toJSON() { executions++; return {}; } }]) {
    assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://example.test', skills: [{ id: 'x', name: 'X', extension }] }),
      { code: 'A2A_AGENT_CARD_INVALID' });
  }
  assert.equal(executions, 0);
});

test('parent review: empty query/hash and ambiguous URL whitespace are rejected; all trailing slashes are removed', () => {
  for (const baseUrl of ['https://example.test?', 'https://example.test#', 'https://exam\nple.test', 'https:example.test'])
    assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl }), { code: 'A2A_AGENT_CARD_INVALID' });
  assert.equal(buildA2aAgentCard({ name: 'a', baseUrl: 'https://example.test/prefix///' }).supportedInterfaces[0].url,
    'https://example.test/prefix/a2a/jsonrpc');
});

test('parent review: unknown own __proto__ JSON property remains data and long skill arrays are preserved', () => {
  const skill = JSON.parse('{"id":"x","name":"X","__proto__":{"test":true}}');
  const built = buildA2aAgentCard({ name: 'a', baseUrl: 'https://example.test', skills: [skill] }).skills[0];
  assert.equal(Object.getPrototypeOf(built), Object.prototype); assert.equal(Object.hasOwn(built, '__proto__'), true);
  assert.equal(built.test, undefined);
  const tags = Array.from({ length: 100 }, (_, index) => 'tag-' + index);
  assert.deepEqual(buildA2aAgentCard({ name: 'a', baseUrl: 'https://example.test', skills: [{ id: 'x', name: 'X', tags }] }).skills[0].tags, tags);
});

test('parent review: title handles cased Unicode, digits and uncased letter boundaries', () => {
  assert.deepEqual(buildA2aAgentCard({ name: 'a', baseUrl: 'https://example.test', skills: ['éCOLE', '123ABC', 'ßETA'] }).skills.map(skill => skill.name),
    ['École', '123Abc', 'Sseta']);
});
import { buildA2aAgentCard, A2A_PROTOCOL_VERSION, JSONRPC_PATH, REST_PATH_PREFIX } from '../src/providers/native-a2a-agent-card.mjs';

const FAIL = 'A2A_AGENT_CARD_INVALID';

// ---- constants -------------------------------------------------------------

test('constants match Python reference', () => {
  assert.equal(A2A_PROTOCOL_VERSION, '1.0');
  assert.equal(JSONRPC_PATH, '/a2a/jsonrpc');
  assert.equal(REST_PATH_PREFIX, '/a2a/v1');
});

// ---- basic card construction -----------------------------------------------

test('minimal card with defaults', () => {
  const card = buildA2aAgentCard({ name: 'my-agent', baseUrl: 'https://example.com' });
  assert.equal(card.name, 'my-agent');
  assert.equal(card.description, 'my-agent agent powered by ksadk');
  assert.equal(card.version, '1.0.0');
  assert.equal(card.supportedInterfaces.length, 2);
  assert.equal(card.supportedInterfaces[0].url, 'https://example.com/a2a/jsonrpc');
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(card.supportedInterfaces[1].url, 'https://example.com/a2a/v1');
  assert.equal(card.supportedInterfaces[1].protocolBinding, 'HTTP+JSON');
  assert.equal(card.capabilities.streaming, true);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.deepEqual(card.defaultInputModes, ['text/plain']);
  assert.deepEqual(card.defaultOutputModes, ['text/plain']);
  assert.equal(card.skills.length, 1);
  assert.equal(card.skills[0].id, 'general');
  assert.equal(card.skills[0].name, 'General');
  assert.equal(card.skills[0].description, 'General purpose agent powered by ksadk');
  assert.deepEqual(card.skills[0].tags, ['general']);
  assert.equal(card.provider, undefined);
  assert.ok(Object.isFrozen(card));
  assert.equal(card.capabilities.extensions, undefined);
});

test('custom description and version', () => {
  const card = buildA2aAgentCard({ name: 'agent', baseUrl: 'https://x.com', description: 'Custom', version: '2.0.0' });
  assert.equal(card.description, 'Custom');
  assert.equal(card.version, '2.0.0');
});

test('http base URL accepted', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'http://localhost:8080' });
  assert.equal(card.supportedInterfaces[0].url, 'http://localhost:8080/a2a/jsonrpc');
});

test('trailing slash stripped from baseUrl', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com/' });
  assert.equal(card.supportedInterfaces[0].url, 'https://x.com/a2a/jsonrpc');
});

test('streaming=false reflected in capabilities', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', streaming: false });
  assert.equal(card.capabilities.streaming, false);
});

// ---- string skills ---------------------------------------------------------

test('string skills converted with pythonTitle', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: ['my_skill', 'other'] });
  assert.equal(card.skills[0].id, 'my_skill');
  assert.equal(card.skills[0].name, 'My Skill');
  assert.equal(card.skills[0].description, 'Skill: my_skill');
  assert.deepEqual(card.skills[0].tags, ['my_skill']);
  assert.equal(card.skills[1].id, 'other');
  assert.equal(card.skills[1].name, 'Other');
});

test('pythonTitle: HELLO_WORLD → Hello World (not HELLO WORLD)', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: ['HELLO_WORLD'] });
  assert.equal(card.skills[0].name, 'Hello World');
});

test('pythonTitle: mixed_case → Mixed Case', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: ['mixed_case_example'] });
  assert.equal(card.skills[0].name, 'Mixed Case Example');
});

// ---- object skills: complete field preservation ----------------------------

test('object skill preserves ALL fields including unknown extensions', () => {
  const skill = {
    id: 'custom', name: 'Custom Skill', description: 'A custom skill', tags: ['custom', 'special'],
    examples: ['example1', 'example2'], inputModes: ['text/plain', 'application/json'], outputModes: ['text/plain'],
    customField: 'preserved', nestedObject: { key: 'value' }, numericArray: [1, 2, 3],
  };
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [skill] });
  assert.equal(card.skills[0].id, 'custom');
  assert.equal(card.skills[0].name, 'Custom Skill');
  assert.equal(card.skills[0].description, 'A custom skill');
  assert.deepEqual(card.skills[0].tags, ['custom', 'special']);
  assert.deepEqual(card.skills[0].examples, ['example1', 'example2']);
  assert.deepEqual(card.skills[0].inputModes, ['text/plain', 'application/json']);
  assert.deepEqual(card.skills[0].outputModes, ['text/plain']);
  assert.equal(card.skills[0].customField, 'preserved');
  assert.deepEqual(card.skills[0].nestedObject, { key: 'value' });
  assert.deepEqual(card.skills[0].numericArray, [1, 2, 3]);
});

test('object skill with minimal required fields', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ id: 'x', name: 'X' }] });
  assert.equal(card.skills[0].id, 'x');
  assert.equal(card.skills[0].name, 'X');
  assert.equal(card.skills[0].description, undefined);
  assert.equal(card.skills[0].tags, undefined);
});

test('object skill with only id and name preserves those', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ id: 'x', name: 'X', description: 'D' }] });
  assert.equal(card.skills[0].description, 'D');
  assert.equal(card.skills[0].tags, undefined);
});

// ---- mutation isolation ----------------------------------------------------

test('object skill is deep-cloned — mutating input does not affect card', () => {
  const skill = { id: 'mut', name: 'Mut', tags: ['t'], nested: { val: 1 } };
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [skill] });
  skill.id = 'changed';
  skill.tags.push('injected');
  skill.nested.val = 999;
  assert.equal(card.skills[0].id, 'mut');
  assert.deepEqual(card.skills[0].tags, ['t']);
  assert.equal(card.skills[0].nested.val, 1);
});

test('card is frozen — top-level mutation throws', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com' });
  assert.ok(Object.isFrozen(card));
  assert.throws(() => { 'use strict'; card.name = 'x'; }, TypeError);
});

// ---- skill validation ------------------------------------------------------

test('duplicate skill ids rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: ['dup', 'dup'] }), { code: FAIL });
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ id: 'd', name: 'D' }, { id: 'd', name: 'D2' }] }), { code: FAIL });
});

test('empty skills array produces default general skill', () => {
  assert.equal(buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [] }).skills[0].id, 'general');
});

test('null/undefined skills produces default general skill', () => {
  assert.equal(buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: null }).skills[0].id, 'general');
  assert.equal(buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: undefined }).skills[0].id, 'general');
});

test('object skill missing id rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ name: 'X' }] }), { code: FAIL });
});

test('object skill missing name rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ id: 'x' }] }), { code: FAIL });
});

test('object skill with non-string tags rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ id: 'x', name: 'X', tags: 'not-array' }] }), { code: FAIL });
});

test('object skill with empty tag string rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ id: 'x', name: 'X', tags: ['ok', ''] }] }), { code: FAIL });
});

test('object skill with non-array examples rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ id: 'x', name: 'X', examples: 'not-array' }] }), { code: FAIL });
});

test('object skill with non-string example element rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ id: 'x', name: 'X', examples: ['ok', 42] }] }), { code: FAIL });
});

test('object skill with non-array inputModes rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ id: 'x', name: 'X', inputModes: 'not-array' }] }), { code: FAIL });
});

test('object skill with non-array outputModes rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [{ id: 'x', name: 'X', outputModes: 'not-array' }] }), { code: FAIL });
});

test('non-array skills rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: 'not-array' }), { code: FAIL });
});

test('empty string skill rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: [''] }), { code: FAIL });
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: ['  '] }), { code: FAIL });
});

// ---- provider --------------------------------------------------------------

test('provider included when provided', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', provider: { organization: 'Org', url: 'https://org.com' } });
  assert.equal(card.provider.organization, 'Org');
  assert.equal(card.provider.url, 'https://org.com');
});

test('provider with missing fields defaults to empty strings', () => {
  assert.deepEqual(buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', provider: {} }).provider, { organization: '', url: '' });
});

test('provider null → omitted', () => {
  assert.equal(buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', provider: null }).provider, undefined);
});

test('non-object provider rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', provider: 'string' }), { code: FAIL });
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', provider: ['array'] }), { code: FAIL });
});

test('provider organization over 256 chars rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', provider: { organization: 'x'.repeat(257) } }), { code: FAIL });
});

// ---- publicToolNames extension ---------------------------------------------

test('publicToolNames non-empty declares tool-activity extension', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', publicToolNames: ['tool_a', 'tool_b'] });
  assert.equal(card.capabilities.extensions.length, 1);
  assert.equal(card.capabilities.extensions[0].uri, 'urn:ksadk:a2a:tool-activity:v1');
  assert.equal(card.capabilities.extensions[0].required, false);
  assert.ok(card.capabilities.extensions[0].description);
});

test('publicToolNames empty → no extension', () => {
  assert.equal(buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', publicToolNames: [] }).capabilities.extensions, undefined);
});

test('publicToolNames default → no extension', () => {
  assert.equal(buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com' }).capabilities.extensions, undefined);
});

// ---- baseUrl validation ----------------------------------------------------

test('non-http(s) baseUrl rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'ftp://x.com' }), { code: FAIL });
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'ws://x.com' }), { code: FAIL });
});

test('baseUrl with credentials rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://user:pass@x.com' }), { code: FAIL });
});

test('baseUrl with query rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com?foo=bar' }), { code: FAIL });
});

test('baseUrl with hash rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com#frag' }), { code: FAIL });
});

test('empty baseUrl rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: '' }), { code: FAIL });
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: '   ' }), { code: FAIL });
});

test('non-string baseUrl rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 42 }), { code: FAIL });
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: null }), { code: FAIL });
});

// ---- name validation -------------------------------------------------------

test('empty name rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: '', baseUrl: 'https://x.com' }), { code: FAIL });
  assert.throws(() => buildA2aAgentCard({ name: '   ', baseUrl: 'https://x.com' }), { code: FAIL });
});

test('non-string name rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 42, baseUrl: 'https://x.com' }), { code: FAIL });
  assert.throws(() => buildA2aAgentCard({ name: null, baseUrl: 'https://x.com' }), { code: FAIL });
});

// ---- other validation -----------------------------------------------------

test('non-string description rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', description: 42 }), { code: FAIL });
});

test('non-string version rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', version: 42 }), { code: FAIL });
});

test('empty version rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', version: '' }), { code: FAIL });
});

test('non-boolean streaming rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', streaming: 'yes' }), { code: FAIL });
});

test('non-array publicToolNames rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', publicToolNames: 'not-array' }), { code: FAIL });
});

test('publicToolNames with non-string element rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', publicToolNames: ['ok', 42] }), { code: FAIL });
});

test('publicToolNames with empty string element rejected', () => {
  assert.throws(() => buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', publicToolNames: ['ok', ''] }), { code: FAIL });
});

// ---- non-object input rejected with fixed code ------------------------------

test('null input rejected with A2A_AGENT_CARD_INVALID', () => {
  assert.throws(() => buildA2aAgentCard(null), { code: FAIL });
});

test('undefined input rejected with A2A_AGENT_CARD_INVALID', () => {
  assert.throws(() => buildA2aAgentCard(undefined), { code: FAIL });
});

test('array input rejected with A2A_AGENT_CARD_INVALID', () => {
  assert.throws(() => buildA2aAgentCard(['not', 'an', 'object']), { code: FAIL });
});

test('string input rejected with A2A_AGENT_CARD_INVALID', () => {
  assert.throws(() => buildA2aAgentCard('not-an-object'), { code: FAIL });
});

test('number input rejected with A2A_AGENT_CARD_INVALID', () => {
  assert.throws(() => buildA2aAgentCard(42), { code: FAIL });
});

// ---- JSON serializable + frozen --------------------------------------------

test('card is JSON-serializable and frozen', () => {
  const card = buildA2aAgentCard({ name: 'a', baseUrl: 'https://x.com', skills: ['s1'], publicToolNames: ['t1'], provider: { organization: 'O' } });
  assert.ok(Object.isFrozen(card));
  const parsed = JSON.parse(JSON.stringify(card));
  assert.equal(parsed.name, 'a');
  assert.equal(parsed.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(parsed.capabilities.extensions[0].uri, 'urn:ksadk:a2a:tool-activity:v1');
  assert.equal(parsed.skills[0].id, 's1');
  assert.equal(parsed.provider.organization, 'O');
});
