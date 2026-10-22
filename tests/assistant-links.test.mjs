import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantBrowserUrl, interceptAssistantLink } from '../src/client/dsh/assistant-links.mjs';

const origin = 'https://studio.example';
test('assistant browser admits absolute HTTP(S), rejects credentials, privileged protocols and direct Studio origin', () => {
  assert.equal(assistantBrowserUrl('https://docs.example/path', origin), 'https://docs.example/path');
  assert.equal(assistantBrowserUrl('http://localhost:8080/', origin), 'http://localhost:8080/');
  const credentials = new URL('https://docs.example/'); credentials.username = 'synthetic-user'; credentials.password = 'synthetic-password';
  for (const href of ['javascript:alert(1)', 'file:///private/file', 'data:text/html,hi', 'blob:https://docs.example/id', '/api', 'example.com', credentials.href, `${origin}/api`, 'https://docs.example/' + 'a'.repeat(17000), null]) {
    assert.equal(assistantBrowserUrl(href, origin), null, String(href));
  }
});
test('captured Markdown activation is handled inside the owning page, without an external launch', () => {
  const opened = [], refused = [], prevented = [];
  const anchor = { hasAttribute: () => false, getAttribute: () => 'https://docs.example/' };
  const event = { target: { closest: () => anchor }, currentTarget: { contains: () => true }, preventDefault: () => prevented.push('default'), stopPropagation: () => prevented.push('propagation') };
  const actions = { applicationOrigin: origin, open: url => opened.push(url), refuse: () => refused.push(true) };
  assert.equal(interceptAssistantLink(event, actions), true);
  assert.deepEqual(opened, ['https://docs.example/']); assert.deepEqual(prevented, ['default', 'propagation']);
  anchor.getAttribute = () => `${origin}/api`; interceptAssistantLink(event, actions);
  assert.deepEqual(refused, [true]); assert.equal(opened.length, 1);
  event.currentTarget.contains = () => false; assert.equal(interceptAssistantLink(event, actions), false);
  event.currentTarget.contains = () => true; anchor.hasAttribute = () => true; assert.equal(interceptAssistantLink(event, actions), false);
});
