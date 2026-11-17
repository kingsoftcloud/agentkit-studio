import test from 'node:test';
import assert from 'node:assert/strict';

import { DSH_CURATED_PLUGINS, dshCuratedEntries, dshCuratedPlugin } from '../src/dsh-plugin-catalog.mjs';

test('built-in catalog rows carry display metadata and host-owned probes', () => {
  const entries = dshCuratedEntries();
  assert.equal(entries.length, DSH_CURATED_PLUGINS.length);
  const teams = entries.find(entry => entry.id === '@deepseek-ai/dsh-experimental-agent-team-profile');
  assert.equal(teams.category, '协作');
  assert.ok(teams.tags.length);
  assert.deepEqual(teams.expectedEntries, ['agent-team', 'tool-agent-team', 'ui-agent-team']);
  assert.equal(teams.service.name, 'agentTeams');
  // Copies must not share arrays with the frozen manifest.
  teams.tags.push('泄漏');
  assert.equal(dshCuratedEntries().find(entry => entry.id === teams.id).tags.includes('泄漏'), false);
});

test('the official plugin index bundle is curated with its service probe', () => {
  const entry = dshCuratedPlugin('@deepseek-ai/dsh-experimental-plugin-market-bundle');
  assert.ok(entry);
  assert.equal(entry.displayName, '自定义插件索引');
  assert.deepEqual(entry.expectedEntries, ['plugin-market', 'ui-plugin-market']);
  assert.equal(entry.service.name, 'pluginMarket');
  assert.deepEqual(entry.service.methods, ['listIndexes', 'search', 'setIndexes']);
  assert.equal(entry.defaultEnabled, false);
  assert.equal(dshCuratedPlugin('  @deepseek-ai/dsh-experimental-plugin-market-bundle  ').id, entry.id);
  assert.equal(dshCuratedPlugin(''), undefined);
  assert.equal(dshCuratedPlugin('missing'), undefined);
});

test('every curated row names an installable spec and its readiness surface', () => {
  const ids = new Set();
  for (const entry of DSH_CURATED_PLUGINS) {
    assert.match(entry.id, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u, `invalid id: ${entry.id}`);
    assert.equal(ids.has(entry.id), false, `duplicate id: ${entry.id}`);
    ids.add(entry.id);
    assert.equal(entry.installSpec, entry.id, `${entry.id} installs its own package`);
    assert.ok(entry.displayName && entry.description, `${entry.id} needs display copy`);
    assert.ok(Array.isArray(entry.expectedEntries) && entry.expectedEntries.length > 0, `${entry.id} needs probe rows`);
    assert.ok(entry.service?.name, `${entry.id} needs a host service`);
    assert.ok(entry.service.methods.length > 0, `${entry.id} needs service methods`);
    assert.equal(entry.defaultEnabled, false, `${entry.id} starts disabled`);
  }
});
