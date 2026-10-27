import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DSH_CURATED_PLUGINS,
  DshPluginCatalogError,
  dshCuratedEntries,
  mergeCatalogEntries,
  normalizeCatalogDocument,
  normalizeCatalogEntry,
} from '../src/dsh-plugin-catalog.mjs';

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

test('catalog normalization rejects package specs it cannot install safely', () => {
  assert.equal(normalizeCatalogEntry({ id: 'not a package' }), null);
  assert.equal(normalizeCatalogEntry({ id: 'ok-package', installSpec: 'file:/etc/passwd' }), null);
  assert.equal(normalizeCatalogEntry({ id: '../../escape' }), null);
  assert.equal(normalizeCatalogEntry({ id: 'https://evil.example/pkg' }), null);
  assert.equal(normalizeCatalogEntry({}), null);
  const entry = normalizeCatalogEntry({ id: '@scope/pkg', installSpec: '@scope/pkg@1.2.3', displayName: '  Pkg  ', description: 'a\nb', tags: [' x ', 'x', ''], homepage: 'http://insecure.example', icon: 'data:image/png;base64,AAAA' });
  assert.equal(entry.displayName, 'Pkg');
  assert.equal(entry.description, 'a b');
  assert.deepEqual(entry.tags, ['x']);
  assert.equal(entry.homepage, undefined);
  assert.equal(entry.icon, undefined);
});

test('remote rows cannot declare host verification probes', () => {
  const entry = normalizeCatalogEntry({ id: 'dsh-remote', expectedEntries: ['x'], service: { name: 'agentTeams', methods: ['listMembers'] }, readinessNote: 'x', defaultEnabled: false }, { source: 'remote' });
  assert.equal(entry.expectedEntries, undefined);
  assert.equal(entry.service, undefined);
  assert.equal(entry.readinessNote, undefined);
  assert.equal(entry.origin, 'remote');
});

test('catalog document parsing accepts arrays and drops invalid rows without failing the list', () => {
  const parsed = normalizeCatalogDocument({ updatedAt: '2026-10-20T00:00:00Z', plugins: [{ id: 'good-one', displayName: 'Good' }, { id: 'bad id' }, null, { id: 'good-one' }] });
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.skipped, 3);
  assert.equal(parsed.updatedAt, '2026-10-20T00:00:00Z');
  const array = normalizeCatalogDocument([{ id: 'only-one' }]);
  assert.equal(array.entries.length, 1);
  assert.equal(array.updatedAt, '');
});

test('catalog document parsing rejects unsupported or oversized documents', () => {
  assert.throws(() => normalizeCatalogDocument({ schemaVersion: 99, plugins: [] }), error => error instanceof DshPluginCatalogError && error.code === 'DSH_PLUGIN_CATALOG_VERSION_UNSUPPORTED');
  assert.throws(() => normalizeCatalogDocument({ plugins: 'nope' }), error => error instanceof DshPluginCatalogError && error.code === 'DSH_PLUGIN_CATALOG_INVALID');
  assert.throws(() => normalizeCatalogDocument({ plugins: Array.from({ length: 501 }, (_, index) => ({ id: `pkg-${index}` })) }), error => error.code === 'DSH_PLUGIN_CATALOG_TOO_LARGE');
  assert.throws(() => normalizeCatalogDocument(null), error => error.code === 'DSH_PLUGIN_CATALOG_INVALID');
});

test('remote entries refresh display copy while built-in verification stays host-owned', () => {
  const merged = mergeCatalogEntries(dshCuratedEntries(), [
    normalizeCatalogEntry({ id: '@deepseek-ai/dsh-experimental-agent-team-profile', displayName: 'Agent Teams 2', description: '新说明', category: '团队' }, { source: 'remote' }),
    normalizeCatalogEntry({ id: 'extra-plugin', displayName: 'Extra' }, { source: 'remote' }),
  ]);
  const teams = merged.find(entry => entry.id === '@deepseek-ai/dsh-experimental-agent-team-profile');
  assert.equal(teams.displayName, 'Agent Teams 2');
  assert.equal(teams.origin, 'remote');
  assert.deepEqual(teams.expectedEntries, ['agent-team', 'tool-agent-team', 'ui-agent-team']);
  assert.equal(teams.service.name, 'agentTeams');
  const extra = merged.find(entry => entry.id === 'extra-plugin');
  assert.equal(extra.origin, 'remote');
  assert.equal(extra.expectedEntries, undefined);
  assert.equal(extra.service, undefined);
});
