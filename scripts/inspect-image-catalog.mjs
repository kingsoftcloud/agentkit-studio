#!/usr/bin/env node
/**
 * Read-only inspection of Studio's cloud image catalogue.
 *
 * One signed `GetClientBootstrapConfig` per target; no writes, no IAM call and
 * no secrets in the output. Use it after any catalogue publication or database
 * repair, and as the first step of a deployment incident: an enabled `preview`
 * release outside `pre-online` is a publishing defect that older Studio builds
 * reject for the whole environment.
 *
 *   node scripts/inspect-image-catalog.mjs                # pre-online + online
 *   node scripts/inspect-image-catalog.mjs online         # one target
 *   node scripts/inspect-image-catalog.mjs online --runtime harness --json
 *
 * Exit codes: 0 clean, 1 invariant violation, 2 request/parse failure.
 */
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createAgentEngineDeploymentClient } from '../src/server-client.mjs';
import { parseStudioImageCatalog, STUDIO_IMAGE_CONFIG_KEY } from '../src/deployment-images.mjs';
import { studioVersions } from '../src/studio-version.mjs';

const TARGETS = {
  'pre-online': { cloudRegion: 'pre-online', cloudCustomSource: 'pre' },
  online: { cloudRegion: 'cn-beijing-6', cloudCustomSource: '' },
};
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const runtime = option('--runtime', 'dsh-native');
const json = flag('--json');
const only = argv.find(value => Object.hasOwn(TARGETS, value));
const targets = only ? { [only]: TARGETS[only] } : TARGETS;
const base = createGlobalConfiguration({});
const { values: source } = await base.resolve();
const { pluginVersion } = await studioVersions();

const report = [], problems = [];
for (const [name, patch] of Object.entries(targets)) {
  const configuration = { resolve: async () => ({ values: { ...source, ...patch } }) };
  const client = createAgentEngineDeploymentClient({ configuration });
  const entry = { target: name, region: patch.cloudRegion, runtime, clientVersion: pluginVersion, status: 'unknown' };
  report.push(entry);
  if (!json) console.log(`\n=== ${name} (region=${patch.cloudRegion}, source=${patch.cloudCustomSource || '-'}, runtime=${runtime}, Studio ${pluginVersion}) ===`);
  try {
    const { data } = await client.getBootstrapConfig({ region: patch.cloudRegion, runtime, clientVersion: pluginVersion });
    entry.environment = data?.Environment;
    entry.catalogueRegion = data?.Region;
    entry.source = data?.Source;
    const raw = data?.Configs?.[STUDIO_IMAGE_CONFIG_KEY];
    if (!raw) {
      entry.status = 'missing';
      if (!json) console.log(`catalogue: MISSING (Configs["${STUDIO_IMAGE_CONFIG_KEY}"])`);
      continue;
    }
    entry.catalogueScope = `${raw.environment}/${raw.region}`;
    entry.defaultReleaseId = raw.defaultReleaseId;
    entry.releases = (raw.releases || []).map(item => ({ id: item.id, channel: item.channel, enabled: item.enabled,
      minimumStudioVersion: item.minimumStudioVersion, capabilities: item.capabilities || [] }));
    const offending = entry.releases.filter(item => item.enabled && item.channel === 'preview' && raw.environment !== 'pre-online');
    entry.offending = offending.map(item => item.id);
    if (offending.length) problems.push(`${name}: ${offending.length} enabled preview release(s) outside pre-online: ${offending.map(item => item.id).join(', ')}`);
    try {
      const parsed = parseStudioImageCatalog(data, { runtime, clientVersion: pluginVersion });
      entry.parse = { ok: true, default: parsed.defaultReleaseId, usable: parsed.releases.map(item => item.id),
        retired: parsed.retiredReleases || [], outdated: parsed.outdatedReleases || [] };
      entry.status = offending.length ? 'invariant-violation' : 'ok';
    } catch (error) {
      entry.parse = { ok: false, code: error.code, message: error.message };
      entry.status = 'parse-failure';
    }
    if (!json) {
      console.log(`Environment: ${entry.environment} | Region: ${entry.catalogueRegion} | Source: ${entry.source}`);
      console.log(`catalogue: ${entry.catalogueScope} | default=${entry.defaultReleaseId} | releases=${entry.releases.length}`);
      for (const item of entry.releases) {
        const mark = offending.some(o => o.id === item.id) ? '  <== 非预发环境中的启用预发候选' : '';
        console.log(` - ${item.id} | channel=${item.channel} | enabled=${item.enabled} | minStudio=${item.minimumStudioVersion} | capabilities=${item.capabilities.join(',') || '-'}${mark}`);
      }
      console.log(entry.parse.ok
        ? `parse: OK | default=${entry.parse.default} | usable=${entry.parse.usable.join(', ') || '(none)'} | retired=${entry.parse.retired.length} | outdated=${entry.parse.outdated.length}`
        : `parse: FAILED | ${entry.parse.code} | ${entry.parse.message}`);
    }
  } catch (error) {
    entry.status = 'request-failure';
    entry.error = { code: error?.code || error?.name || 'REQUEST_FAILED', message: error?.message || String(error) };
    problems.push(`${name}: request failed (${entry.error.code})`);
    if (!json) console.log(`request failed: ${entry.error.code} - ${entry.error.message}`);
  }
}

if (json) console.log(JSON.stringify({ report, problems }, null, 2));
if (problems.length) {
  if (!json) console.log(`\nFAIL\n${problems.join('\n')}`);
  process.exit(1);
}
if (!json) console.log('\nOK');
process.exit(report.some(item => item.status === 'request-failure' || item.status === 'parse-failure') ? 2 : 0);
