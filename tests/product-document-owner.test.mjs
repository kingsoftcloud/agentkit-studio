import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductDocumentEffects } from '../src/client/dsh/product-document.mjs';

test('overlapping title owners restore the latest native title only after the last owner leaves', () => {
  const observers = new Set();
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const document = { title: 'DeepSeek Harness', querySelector: () => ({}) };
  const window = {}; window.parent = window;
  const options = { document, window, MutationObserver: Observer };
  const first = createProductDocumentEffects(options).adoptProductDocumentTitle();
  const second = createProductDocumentEffects(options).adoptProductDocumentTitle();
  assert.equal(document.title, 'AgentKit Studio');
  assert.equal(observers.size, 1);
  first(); first();
  assert.equal(document.title, 'AgentKit Studio');
  document.title = 'New Session — DeepSeek Harness';
  for (const observer of observers) observer.callback();
  assert.equal(document.title, 'New Session — AgentKit Studio');
  second();
  assert.equal(document.title, 'New Session — DeepSeek Harness');
  assert.equal(observers.size, 0);
});
