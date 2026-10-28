import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createContextStatus } from '../src/context-status.mjs';
const Component = createContextStatus(React);
const value = { contract: 'agentkit.native-context-status/v1', runId: 'r', enabled: true, thresholdRatio: .72,
  contextWindow: 10000, reservedOutputTokens: 1000, lastRequestInputTokens: 2000, compactions: 2, state: 'idle' };
const render = props => renderToStaticMarkup(React.createElement(Component, props));
test('a context quote is clickable in place and exposes no compression completion before adoption', () => {
  const html = render({ value, runId: 'r' });
  assert.match(html, /<details/); assert.match(html, /2,000 \/ 10,000/); assert.match(html, /72%/);
  assert.match(html, /Compactions completed 2/); assert.doesNotMatch(html, /<button/);
  assert.equal(render({ value, runId: 'other' }), '');
});
test('unknown usage and interrupted compression are explicit', () => {
  assert.match(render({ value: { ...value, lastRequestInputTokens: null }, runId: 'r' }), /Not measured/);
  assert.match(render({ value: { ...value, state: 'interrupted' }, runId: 'r' }), /compaction interrupted/);
});
