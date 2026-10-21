import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeMcpOutcome } from '../src/providers/native-mcp-output.mjs';

const text = value => ({ type: 'text', text: value });
test('plain MCP text and only the exact FastMCP string mirror flatten without discarding the receipt', () => {
  const reply = { content: [text('hello')], structuredContent: { result: 'hello' }, isError: false };
  const outcome = nativeMcpOutcome(reply);
  assert.equal(outcome.context.content, 'hello'); assert.deepEqual(outcome.content, reply);
  outcome.content.structuredContent.result = 'mutated'; assert.equal(reply.structuredContent.result, 'hello');
  assert.equal(nativeMcpOutcome({ content: [text('one'), text('two')] }).context.content, 'one\n\ntwo');
  assert.match(nativeMcpOutcome({ ...reply, structuredContent: { result: 'hello', count: 7 } }).context.content, /"count":7/);
});
test('structured-only results and scalar false or zero remain model observations', () => {
  for (const structuredContent of [false, 0, { ids: [9007199254740993n] }]) {
    const outcome = nativeMcpOutcome({ content: [], structuredContent, _meta: { privateAudit: 'hidden' } });
    assert.equal(outcome.status, 'ok'); assert.equal(outcome.context.content.includes('hidden'), false);
    assert.ok(outcome.context.content.includes('"structuredContent":'));
    if (typeof structuredContent === 'object') assert.match(outcome.context.content, /9007199254740993/);
  }
});
test('media is explicit, mirrored binary strings are omitted from text, and embedded URIs are never fetched', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  const reply = { content: [text('before'), { type: 'image', data: png, mimeType: 'image/png' },
    { type: 'resource', resource: { uri: 'http://untrusted.invalid', text: 'embedded text' } },
    { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' }, { type: 'resource_link', uri: 'file:///secret' }],
  structuredContent: { imageCopy: png, audioCopy: 'YXVkaW8=' } };
  const outcome = nativeMcpOutcome(reply);
  assert.equal(outcome.context.media.length, 1); assert.match(outcome.context.media[0].image_url.url, /^data:image\/png;base64,/);
  assert.match(outcome.context.content, /before[\s\S]*embedded text/);
  assert.equal(outcome.context.content.includes(png), false); assert.equal(outcome.context.content.includes('YXVkaW8='), false);
  assert.match(outcome.context.content, /mcp_media_unobserved/); assert.deepEqual(outcome.content, reply);
});
test('invalid images remain explicitly unobserved and known MCP failures retain error status', () => {
  const outcome = nativeMcpOutcome({ content: [{ type: 'image', data: 'bm90LXB uZw==', mimeType: 'image/png' }], isError: true });
  assert.equal(outcome.status, 'error'); assert.equal(outcome.context.media, undefined);
  assert.match(outcome.context.content, /mcp_media_unobserved/);
  assert.throws(() => nativeMcpOutcome({ content: [], structuredContent: Infinity }), /non_json_number/);
});
