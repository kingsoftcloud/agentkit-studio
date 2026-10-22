import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSkillService } from '../src/providers/native-skill-service.mjs';

function makeServerClient(responder) {
  const calls = [];
  const skillAction = async (action, params, { signal } = {}) => {
    calls.push({ action, params, aborted: signal?.aborted });
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'REQUEST_CANCELLED' });
    const response = typeof responder === 'function' ? responder(action, params, calls.length) : responder;
    if (response?.throw) throw response.throw;
    return response;
  };
  return { skillAction, calls };
}

function makeSkillItem(name, { skillId, versionId, version, status, contentHash, aliases, tags, examples, inputSchema, runtimeRequirements } = {}) {
  return {
    Name: name, SkillId: skillId || `sk-${name}`, VersionId: versionId || `v1-${name}`,
    Version: version || '1.0.0', Status: status || 'active',
    ContentHash: contentHash || `sha256:hash-${name}`,
    Aliases: aliases || [], Tags: tags || [], Examples: examples || [],
    Description: `Skill ${name}`,
    ...(inputSchema ? { InputSchema: inputSchema } : {}),
    ...(runtimeRequirements ? { RuntimeRequirements: runtimeRequirements } : {}),
  };
}

// --- review counter-examples (must now fail correctly) ---

test('page 1 has 2 duplicate skillId+versionId, TotalCount=2 → pagination_repeated, not complete', async () => {
  const client = makeServerClient({ data: { Skills: [
    makeSkillItem('a', { skillId: 'sk1', versionId: 'v1' }),
    makeSkillItem('b', { skillId: 'sk1', versionId: 'v1' }), // duplicate id+version
  ], SkillSpaceId: 's1', TotalCount: 2 } });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.truncated, true);
  assert.equal(result.paginationWarning, 'pagination_repeated');
  assert.equal(result.activeSkills.length, 0, 'no skills accepted from a repeated page');
});

test('page 2 has foreign SkillSpaceId → directory_changed, not accepted', async () => {
  const client = makeServerClient((action, params) => {
    if (params.PageNumber === 1) return { data: { Skills: Array.from({ length: 100 }, (_, i) => makeSkillItem(`s${i}`, { skillId: `sk${i}`, versionId: `v${i}` })), SkillSpaceId: 's1', TotalCount: 101 } };
    return { data: { Skills: [makeSkillItem('s100', { skillId: 'sk100', versionId: 'v100' })], SkillSpaceId: 'foreign', TotalCount: 101 } };
  });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.truncated, true);
  assert.equal(result.paginationWarning, 'directory_changed');
  assert.equal(result.allSkills.length, 100, 'only page 1 skills kept');
});

test('100 skills with no TotalCount, page 2 has 1 skill → continues to page 2, then completes', async () => {
  const client = makeServerClient((action, params) => {
    if (params.PageNumber === 1) return { data: { Skills: Array.from({ length: 100 }, (_, i) => makeSkillItem(`s${i}`, { skillId: `sk${i}`, versionId: `v${i}` })), SkillSpaceId: 's1' } };
    return { data: { Skills: [makeSkillItem('s100', { skillId: 'sk100', versionId: 'v100' })], SkillSpaceId: 's1' } };
  });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.truncated, false, 'short page 2 means complete');
  assert.equal(result.allSkills.length, 101);
  assert.equal(client.calls.length, 2, 'fetched 2 pages');
});

test('page 1 has 101 skills, TotalCount=100 → directory_changed, not complete', async () => {
  const client = makeServerClient({ data: { Skills: Array.from({ length: 101 }, (_, i) => makeSkillItem(`s${i}`, { skillId: `sk${i}`, versionId: `v${i}` })), SkillSpaceId: 's1', TotalCount: 100 } });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.truncated, true);
  assert.equal(result.paginationWarning, 'directory_changed');
});

// --- pagination: full page with no total continues ---

test('full page (100) with no TotalCount → continues to next page', async () => {
  const client = makeServerClient((action, params) => {
    if (params.PageNumber === 1) return { data: { Skills: Array.from({ length: 100 }, (_, i) => makeSkillItem(`s${i}`, { skillId: `sk${i}`, versionId: `v${i}` })), SkillSpaceId: 's1' } };
    return { data: { Skills: [makeSkillItem('s100', { skillId: 'sk100', versionId: 'v100' })], SkillSpaceId: 's1' } };
  });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(client.calls.length, 2, 'continued to page 2');
  assert.equal(result.truncated, false);
});

test('full page (100) with no TotalCount, maxPages=1 → page_budget_exhausted', async () => {
  const client = makeServerClient({ data: { Skills: Array.from({ length: 100 }, (_, i) => makeSkillItem(`s${i}`, { skillId: `sk${i}`, versionId: `v${i}` })), SkillSpaceId: 's1' } });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', { maxPages: 1 });
  assert.equal(result.truncated, true);
  assert.equal(result.paginationWarning, 'page_budget_exhausted');
  assert.equal(result.nextPage, 2);
});

// --- pagination with total ---

test('multi-page until total reached', async () => {
  const allSkills = Array.from({ length: 150 }, (_, i) => makeSkillItem(`s${i}`, { skillId: `sk${i}`, versionId: `v${i}` }));
  const client = makeServerClient((action, params) => {
    const page = params.PageNumber;
    const start = (page - 1) * 100;
    return { data: { Skills: allSkills.slice(start, start + 100), SkillSpaceId: 's1', TotalCount: 150 } };
  });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.activeSkills.length, 150);
  assert.equal(result.truncated, false);
  assert.equal(client.calls.length, 2);
});

test('directory_changed when total drifts between pages', async () => {
  const client = makeServerClient((action, params) => {
    const page = params.PageNumber;
    return { data: { Skills: page === 1 ? Array.from({ length: 100 }, (_, i) => makeSkillItem(`s${i}`, { skillId: `sk${i}`, versionId: `v${i}` })) : [makeSkillItem('s100', { skillId: 'sk100', versionId: 'v100' })], SkillSpaceId: 's1', TotalCount: page === 1 ? 150 : 151 } };
  });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.paginationWarning, 'directory_changed');
});

test('directory_changed when TotalCount goes from null to value', async () => {
  const client = makeServerClient((action, params) => {
    const page = params.PageNumber;
    if (page === 1) return { data: { Skills: Array.from({ length: 100 }, (_, i) => makeSkillItem(`s${i}`, { skillId: `sk${i}`, versionId: `v${i}` })), SkillSpaceId: 's1' } };
    return { data: { Skills: [makeSkillItem('s100', { skillId: 'sk100', versionId: 'v100' })], SkillSpaceId: 's1', TotalCount: 200 } };
  });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.paginationWarning, 'directory_changed');
});

test('directory_incomplete when short page with remaining total', async () => {
  const client = makeServerClient((action, params) => {
    if (params.PageNumber === 1) return { data: { Skills: [makeSkillItem('a')], SkillSpaceId: 's1', TotalCount: 5 } };
    return { data: { Skills: [] } };
  });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.truncated, true);
  assert.equal(result.paginationWarning, 'directory_incomplete');
  assert.equal(client.calls.length, 1, 'did not fetch next page for incomplete');
});

test('page budget exhausted with unique skills', async () => {
  const client = makeServerClient((action, params) => {
    const page = params.PageNumber;
    const start = (page - 1) * 100;
    const skills = Array.from({ length: 100 }, (_, i) => makeSkillItem(`s${start + i}`, { skillId: `sk${start + i}`, versionId: `v${start + i}` }));
    return { data: { Skills: skills, SkillSpaceId: 's1', TotalCount: 500 } };
  });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', { maxPages: 3 });
  assert.equal(result.paginationWarning, 'page_budget_exhausted');
  assert.equal(result.nextPage, 4);
  assert.equal(client.calls.length, 3);
});

test('rejects mismatched spaceId on page 1', async () => {
  const client = makeServerClient({ data: { Skills: [], SkillSpaceId: 'wrong' } });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.paginationWarning, 'directory_changed');
});

test('validates maxPages range', async () => {
  const svc = createNativeSkillService(makeServerClient({ data: {} }));
  await assert.rejects(svc.listSkillsBySpaceId('s1', { maxPages: 0 }), /page budget/);
  await assert.rejects(svc.listSkillsBySpaceId('s1', { maxPages: 1001 }), /page budget/);
});

// --- is_active filtering ---

test('filters non-active skills', async () => {
  const client = makeServerClient({ data: { Skills: [
    makeSkillItem('active', { status: 'active' }),
    makeSkillItem('disabled', { status: 'disabled' }),
    makeSkillItem('nostatus', { status: '' }),
    makeSkillItem('available', { status: 'available' }),
  ], SkillSpaceId: 's1' } });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.activeSkills.length, 3);
  assert.equal(result.allSkills.length, 4);
  assert.ok(!result.activeSkills.some(s => s.name === 'disabled'));
});

// --- SkillRef parsing ---

test('parses inputSchema and runtimeRequirements', async () => {
  const client = makeServerClient({ data: { Skills: [makeSkillItem('alpha', {
    skillId: 'sk-a', versionId: 'v2', version: '2.0.0', contentHash: 'sha256:abc123',
    aliases: ['a1'], tags: ['tag1'], examples: ['ex1'],
    inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    runtimeRequirements: { python: '3.11' },
  })], SkillSpaceId: 's1' } });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  const skill = result.activeSkills[0];
  assert.deepEqual(skill.inputSchema, { type: 'object', properties: { x: { type: 'string' } } });
  assert.deepEqual(skill.runtimeRequirements, { python: '3.11' });
  assert.equal(skill.contentHash, 'sha256:abc123');
  assert.match(skill.cacheKey, /sk-a__v2/);
});

test('rejects array items in skills list', async () => {
  const client = makeServerClient({ data: { Skills: [makeSkillItem('a'), 'not-an-object'], SkillSpaceId: 's1' } });
  const svc = createNativeSkillService(client);
  await assert.rejects(svc.listSkillsBySpaceId('s1', {}), /items must be objects/);
});

test('rejects non-array skills field', async () => {
  const client = makeServerClient({ data: { Skills: 'not-an-array', SkillSpaceId: 's1' } });
  const svc = createNativeSkillService(client);
  await assert.rejects(svc.listSkillsBySpaceId('s1', {}), /must be an array/);
});

test('null TotalCount treated as unknown, not error', async () => {
  const client = makeServerClient({ data: { Skills: [makeSkillItem('a')], SkillSpaceId: 's1', TotalCount: null } });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.totalCount, null);
  assert.equal(result.truncated, false);
});

test('rejects negative TotalCount', async () => {
  const client = makeServerClient({ data: { Skills: [], SkillSpaceId: 's1', TotalCount: -1 } });
  const svc = createNativeSkillService(client);
  await assert.rejects(svc.listSkillsBySpaceId('s1', {}), /total count is invalid/);
});

test('accepts TotalCount as numeric string', async () => {
  const client = makeServerClient({ data: { Skills: [makeSkillItem('a')], SkillSpaceId: 's1', TotalCount: '1' } });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillsBySpaceId('s1', {});
  assert.equal(result.totalCount, 1);
  assert.equal(result.truncated, false);
});

// --- guards ---

test('assertCurrent between pages', async () => {
  let callCount = 0;
  const client = makeServerClient((action, params) => {
    callCount++;
    if (params.PageNumber === 1) return { data: { Skills: Array.from({ length: 100 }, (_, i) => makeSkillItem(`s${i}`, { skillId: `sk${i}`, versionId: `v${i}` })), SkillSpaceId: 's1', TotalCount: 101 } };
    return { data: { Skills: [makeSkillItem('s100', { skillId: 'sk100', versionId: 'v100' })], SkillSpaceId: 's1', TotalCount: 101 } };
  });
  const svc = createNativeSkillService(client);
  let assertCount = 0;
  await assert.rejects(svc.listSkillsBySpaceId('s1', { assertCurrent: () => { assertCount++; return assertCount <= 3; } }), { code: 'SKILL_AUTHORIZATION_EXPIRED' });
  assert.ok(callCount >= 1);
  assert.ok(assertCount > 3, 'assertCurrent called more than 3 times');
});

test('signal between pages', async () => {
  const controller = new AbortController();
  let callCount = 0;
  const client = makeServerClient((action, params) => {
    callCount++;
    if (callCount === 2) controller.abort();
    if (params.PageNumber === 1) return { data: { Skills: Array.from({ length: 100 }, (_, i) => makeSkillItem(`s${i}`, { skillId: `sk${i}`, versionId: `v${i}` })), SkillSpaceId: 's1', TotalCount: 101 } };
    return { data: { Skills: [makeSkillItem('s100', { skillId: 'sk100', versionId: 'v100' })], SkillSpaceId: 's1', TotalCount: 101 } };
  });
  const svc = createNativeSkillService(client);
  await assert.rejects(svc.listSkillsBySpaceId('s1', { signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
});

test('pre-aborted signal rejects all methods', async () => {
  const svc = createNativeSkillService(makeServerClient({ data: {} }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(svc.listSkillSpaces({ signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
  await assert.rejects(svc.listSkillsBySpaceId('s1', { signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
  await assert.rejects(svc.listAvailablePremadeSkills({ signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
  await assert.rejects(svc.downloadSkillArchive({ skillId: 'sk1' }, { signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
});

// --- listSkillSpaces ---

test('listSkillSpaces passes PageNumber/PageSize and returns raw envelope', async () => {
  const client = makeServerClient({ data: { SkillSpaces: [{ SkillSpaceId: 's1' }] }, requestId: 'r1' });
  const svc = createNativeSkillService(client);
  const result = await svc.listSkillSpaces({ signal: new AbortController().signal });
  assert.equal(client.calls[0].action, 'ListSkillSpaces');
  assert.equal(client.calls[0].params.PageNumber, 1);
  assert.ok(result.data.SkillSpaces);
});

// --- listAvailablePremadeSkills ---

test('listAvailablePremadeSkills returns public skills', async () => {
  const client = makeServerClient({ data: { Skills: [makeSkillItem('pub-a'), makeSkillItem('pub-b')], SkillSpaceId: 'public' } });
  const svc = createNativeSkillService(client);
  const result = await svc.listAvailablePremadeSkills({});
  assert.equal(result.spaceId, 'public');
  assert.equal(result.activeSkills.length, 2);
  assert.equal(result.truncated, false);
});

test('listAvailablePremadeSkills truncated when totalCount > skills', async () => {
  const client = makeServerClient({ data: { Skills: [makeSkillItem('pub-a')], TotalCount: 5, SkillSpaceId: 'public' } });
  const svc = createNativeSkillService(client);
  const result = await svc.listAvailablePremadeSkills({});
  assert.equal(result.truncated, true);
  assert.equal(result.paginationWarning, 'pagination_unavailable');
});

// --- downloadSkillArchive ---

test('downloadSkillArchive returns verified HTTPS URL + skill', async () => {
  const client = makeServerClient({ data: { DownloadUrl: 'https://fixture.invalid/sk-alpha' } });
  const svc = createNativeSkillService(client);
  const result = await svc.downloadSkillArchive({ skillId: 'sk-alpha', versionId: 'v1-alpha', name: 'alpha' }, {});
  assert.equal(result.url, 'https://fixture.invalid/sk-alpha');
  assert.equal(result.skill.skillId, 'sk-alpha');
  assert.equal(client.calls[0].action, 'GetSkillDownloadUrl');
});

test('downloadSkillArchive uses GetPremadeSkillDownloadUrl when no versionId', async () => {
  const client = makeServerClient({ data: { DownloadUrl: 'https://fixture.invalid/premade' } });
  const svc = createNativeSkillService(client);
  await svc.downloadSkillArchive({ skillId: 'sk-premade', name: 'premade' }, {});
  assert.equal(client.calls[0].action, 'GetPremadeSkillDownloadUrl');
});

test('downloadSkillArchive rejects HTTP (HTTPS only)', async () => {
  const client = makeServerClient({ data: { DownloadUrl: 'http://fixture.invalid/sk1' } });
  const svc = createNativeSkillService(client);
  await assert.rejects(svc.downloadSkillArchive({ skillId: 'sk1' }, {}), { code: 'SKILL_DOWNLOAD_URL_INVALID' });
});

test('downloadSkillArchive rejects URL with credentials', async () => {
  const client = makeServerClient({ data: { DownloadUrl: 'https://user:pass@fixture.invalid/sk1' } });
  const svc = createNativeSkillService(client);
  await assert.rejects(svc.downloadSkillArchive({ skillId: 'sk1' }, {}), { code: 'SKILL_DOWNLOAD_URL_INVALID' });
});

test('downloadSkillArchive rejects URL with fragment', async () => {
  const client = makeServerClient({ data: { DownloadUrl: 'https://fixture.invalid/sk1#frag' } });
  const svc = createNativeSkillService(client);
  await assert.rejects(svc.downloadSkillArchive({ skillId: 'sk1' }, {}), { code: 'SKILL_DOWNLOAD_URL_INVALID' });
});

test('downloadSkillArchive rejects missing URL', async () => {
  const svc = createNativeSkillService(makeServerClient({ data: {} }));
  await assert.rejects(svc.downloadSkillArchive({ skillId: 'sk1' }, {}), { code: 'SKILL_DOWNLOAD_URL_MISSING' });
});

test('downloadSkillArchive requires skillId', async () => {
  const svc = createNativeSkillService(makeServerClient({ data: {} }));
  await assert.rejects(svc.downloadSkillArchive({}, {}), /skillId is required/);
});

test('downloadSkillArchive checks signal and assertCurrent', async () => {
  const svc = createNativeSkillService(makeServerClient({ data: { DownloadUrl: 'https://x' } }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(svc.downloadSkillArchive({ skillId: 'sk1' }, { signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
  await assert.rejects(svc.downloadSkillArchive({ skillId: 'sk1' }, { assertCurrent: () => false }), { code: 'SKILL_AUTHORIZATION_EXPIRED' });
});

// --- invalid serverClient ---

test('createNativeSkillService rejects missing serverClient', () => {
  assert.throws(() => createNativeSkillService(null), /skillAction is required/);
  assert.throws(() => createNativeSkillService({}), /skillAction is required/);
});

test('a page larger than the requested limit is incomplete even when TotalCount matches', async () => {
  const client = makeServerClient({ data: { Skills: Array.from({ length: 101 }, (_, i) => makeSkillItem('s' + i)), TotalCount: 101 } });
  const result = await createNativeSkillService(client).listSkillsBySpaceId('space');
  assert.equal(result.truncated, true); assert.equal(result.paginationWarning, 'directory_changed');
  assert.equal(result.allSkills.length, 0);
});

test('a new version of the same Skill on a later page cannot be treated as a stable directory', async () => {
  const client = makeServerClient((_action, params) => ({ data: { TotalCount: 101, Skills: params.PageNumber === 1
    ? Array.from({ length: 100 }, (_, i) => makeSkillItem('s' + i, { skillId: 'id-' + i, versionId: 'version-1' }))
    : [makeSkillItem('s0', { skillId: 'id-0', versionId: 'version-2' })] } }));
  const result = await createNativeSkillService(client).listSkillsBySpaceId('space');
  assert.equal(result.truncated, true); assert.equal(result.paginationWarning, 'directory_changed');
  assert.equal(result.allSkills.length, 100);
});

test('a rejected asynchronous authority cannot call the service or escape as an unhandled rejection', async () => {
  const client = makeServerClient({ data: { Skills: [] } });
  await assert.rejects(createNativeSkillService(client).listSkillsBySpaceId('space', {
    assertCurrent: async () => { throw new Error('not synchronous'); },
  }), { code: 'SKILL_AUTHORIZATION_EXPIRED' });
  assert.equal(client.calls.length, 0);
  await new Promise(resolve => setImmediate(resolve));
});
