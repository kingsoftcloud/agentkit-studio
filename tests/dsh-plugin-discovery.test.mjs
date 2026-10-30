import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDshPluginDiscovery,
  DSH_CURATED_DISCOVERY,
  discoveryCategory,
  githubRepoOf,
  mergeDiscovery,
  normalizeGithubDiscovery,
  normalizeNpmDiscovery,
} from '../src/dsh-plugin-discovery.mjs';

const npmSearch = objects => ({ total: 10522, objects });
const npmObject = (name, extra = {}) => ({
  package: {
    name,
    description: extra.description ?? `${name} description`,
    version: extra.version ?? '0.1.0',
    keywords: extra.keywords ?? ['dsh-plugin'],
    date: extra.date ?? '2026-10-01T00:00:00Z',
    links: { npm: `https://www.npmjs.com/package/${name}`, repository: extra.repository, homepage: extra.homepage },
    publisher: { username: 'author' },
  },
  downloads: extra.downloads ?? { monthly: 1000, weekly: 250 },
});
const githubSearch = items => ({ total_count: 100, items });
const githubObject = (fullName, extra = {}) => ({
  full_name: fullName,
  description: extra.description ?? 'A plugin for DeepSeek Harness',
  topics: extra.topics ?? ['dsh-plugin'],
  stargazers_count: extra.stars ?? 42,
  html_url: `https://github.com/${fullName}`,
  owner: { login: fullName.split('/')[0] },
});

function fakeFetch({ npm = npmSearch([npmObject('dsh-cost-meter')]), github = githubSearch([githubObject('owner/repo')]), registry = {} } = {}) {
  const calls = [];
  const impl = async url => {
    calls.push(url);
    const respond = value => ({ ok: true, json: async () => value });
    if (String(url).includes('/-/v1/search')) {
      if (npm instanceof Error) throw npm;
      return respond(npm);
    }
    if (String(url).includes('api.github.com')) {
      if (github instanceof Error) throw github;
      return respond(github);
    }
    const name = decodeURIComponent(String(url).split('registry.npmjs.org/')[1] || '');
    if (Object.hasOwn(registry, name)) return respond(registry[name]);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

test('npm rows keep installability, downloads and https-only links', () => {
  const item = normalizeNpmDiscovery(npmObject('dsh-cost-meter', {
    description: 'cost meter\nplugin',
    homepage: 'https://example.com/cost',
    repository: 'git+https://github.com/Owner/Cost-Meter.git',
    downloads: { monthly: 115702, weekly: 30000 },
  }), { github: new Map([['owner/cost-meter', { stars: 88 }]]) });
  assert.equal(item.id, 'dsh-cost-meter');
  assert.equal(item.installSpec, 'dsh-cost-meter');
  assert.equal(item.description, 'cost meter plugin');
  assert.equal(item.repository, 'https://github.com/Owner/Cost-Meter');
  assert.equal(item.stats.monthlyDownloads, 115702);
  assert.equal(item.stats.stars, 88);
  assert.equal(item.source, 'npm');
  assert.equal(normalizeNpmDiscovery(npmObject('Not A Package')), null);
  assert.equal(normalizeNpmDiscovery(npmObject('dsh-http', { homepage: 'http://insecure.example' })).homepage, '');
});

test('github rows qualify only DSH-family repositories and install through git specs', () => {
  const item = normalizeGithubDiscovery(githubObject('acme/dsh-tool', { stars: 7 }));
  assert.equal(item.installSpec, 'github:acme/dsh-tool');
  assert.equal(item.source, 'github');
  assert.equal(item.stats.stars, 7);
  assert.equal(normalizeGithubDiscovery(githubObject('acme/random-tool', { description: 'unrelated', topics: ['topic'] })), null);
  assert.equal(normalizeGithubDiscovery({ full_name: '../escape' }), null);
});

test('repository URLs reduce to owner/repo only for GitHub', () => {
  assert.equal(githubRepoOf('git+https://github.com/a/b.git'), 'a/b');
  assert.equal(githubRepoOf('https://github.com/a/b'), 'a/b');
  assert.equal(githubRepoOf('https://gitlab.com/a/b'), '');
  assert.equal(githubRepoOf('https://github.com/a'), '');
});

test('categories come from the first matching rule', () => {
  assert.equal(discoveryCategory({ name: 'dsh-cost-meter', description: 'token 费用统计' }), '成本与用量');
  assert.equal(discoveryCategory({ name: 'dsh-better-sidebar', description: '侧栏增强' }), '界面增强');
  assert.equal(discoveryCategory({ name: 'dsh-mnemon', description: 'context memory' }), '记忆与上下文');
  assert.equal(discoveryCategory({ name: 'dsh-totally-unknown', description: '' }), '其他');
});

test('curated entries stay featured and win over duplicate npm rows', () => {
  const curated = normalizeNpmDiscovery(npmObject('dsh-free-search', { description: 'free search' }), {
    curated: { name: 'dsh-free-search', category: '搜索与联网', tags: ['精选'] }
  });
  const npm = normalizeNpmDiscovery(npmObject('dsh-free-search', { description: 'different' }));
  const items = mergeDiscovery({ curated: [curated], npm: [npm] });
  assert.equal(items.length, 1);
  assert.equal(items[0].curated, true);
  assert.equal(items[0].featured, true);
  assert.equal(items[0].category, '搜索与联网');
  assert.ok(items[0].tags.includes('精选'));
});

test('github-only repositories are appended once and never shadow npm packages', () => {
  const npm = normalizeNpmDiscovery(npmObject('dsh-pet', { repository: 'https://github.com/acme/pet' }));
  const githubOnly = normalizeGithubDiscovery(githubObject('acme/pet'));
  const other = normalizeGithubDiscovery(githubObject('acme/other-dsh-tool'));
  const items = mergeDiscovery({ curated: [], npm: [npm], githubOnly: [githubOnly, other] });
  assert.equal(items.filter(item => item.repo?.toLowerCase() === 'acme/pet').length, 1);
  assert.ok(items.some(item => item.id === 'github:acme/other-dsh-tool'));
});

test('aggregation merges npm, github stars and curated seeds, then caches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovery-'));
  const cacheFile = join(directory, 'cache.json');
  const fetchImpl = fakeFetch({ registry: { 'dsh-free-search': { name: 'dsh-free-search', description: 'free', 'dist-tags': { latest: '1.2.0' }, versions: { '1.2.0': {} } } } });
  const discovery = createDshPluginDiscovery({ fetchImpl, cacheFile, cacheTtlMs: 60000 });
  const first = await discovery.discover();
  assert.ok(first.items.length >= DSH_CURATED_DISCOVERY.length);
  const curated = first.items.find(item => item.id === 'dsh-free-search');
  assert.equal(curated.featured, true);
  assert.equal(curated.version, '1.2.0');
  const before = fetchImpl.calls.length;
  await discovery.discover();
  assert.equal(fetchImpl.calls.length, before);
  const disk = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.ok(disk.value.items.length >= DSH_CURATED_DISCOVERY.length);
  await rm(directory, { recursive: true, force: true });
});

test('a failed refresh keeps the last good catalog as stale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovery-stale-'));
  const cacheFile = join(directory, 'cache.json');
  let failing = false;
  const ok = fakeFetch();
  const fetchImpl = async (url) => {
    if (failing) throw new Error('network down');
    return ok(url);
  };
  const discovery = createDshPluginDiscovery({ fetchImpl, cacheFile, cacheTtlMs: 0 });
  const first = await discovery.discover();
  failing = true;
  const second = await discovery.discover({ force: true });
  assert.equal(second.info.stale, true);
  assert.deepEqual(second.items.map(item => item.id), first.items.map(item => item.id));
  await rm(directory, { recursive: true, force: true });
});

test('one unavailable source degrades to a warning instead of an empty market', async () => {
  const discovery = createDshPluginDiscovery({
    fetchImpl: fakeFetch({ github: new Error('github down') }),
    cacheFile: join(tmpdir(), `dsh-discovery-${process.pid}.json`),
  });
  const result = await discovery.discover();
  assert.ok(result.items.length > 0);
  assert.ok(result.info.warnings.some(warning => warning.code === 'github'));
  assert.equal(result.info.warnings.some(warning => warning.code === 'npm'), false);
});
