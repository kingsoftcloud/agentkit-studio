/** Versioned Studio requirements evaluated against the current Host services. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const HOST_CONTRACT_VERSION = 1;
const requirements = Object.freeze({
  'agent-presets': ['preset-composition', 'agent-loop-origin'],
  automation: ['preset-composition', 'agent-loop-origin', 'session-controller', 'automation-policy'],
  'frozen-runtime': ['preset-composition', 'agent-loop-origin', 'session-controller', 'automation-policy', 'request-fingerprint'],
});
const methods = (service, names) => names.every(name => typeof service?.[name] === 'function');

/** Re-read services for every inspection: a previous Host or registry generation
 * cannot establish compatibility for a replacement. No probe creates a Session.
 */
export function createHostCompatibility({ getService, dshVersion, requiredDsh, requestIsAgentLoop, requiredContractVersion = HOST_CONTRACT_VERSION }) {
  const inspect = () => {
    const registry = getService('agentPresets'), controller = getService('sessionController');
    const capabilities = {
      'preset-composition': methods(registry, ['register', 'pluginsFor']) ? 1 : 0,
      'agent-loop-origin': typeof requestIsAgentLoop === 'function' ? 1 : 0,
      'session-controller': methods(controller, ['create', 'selectModel', 'resolveAgent', 'prompt', 'page', 'projections']) ? 1 : 0,
      'automation-policy': methods(getService('agents'), ['withoutInitiator']) && methods(getService('permissionPresets'), ['set']) && methods(getService('approval'), ['setPolicy']) ? 1 : 0,
      'request-fingerprint': controller?.promptFingerprintVersion === 1 && methods(controller, ['prompt']) ? 1 : 0,
    };
    const baseline = { required: requiredDsh, actual: dshVersion ?? null, compatible: typeof dshVersion === 'string' && dshVersion === requiredDsh };
    const contract = { required: requiredContractVersion, actual: HOST_CONTRACT_VERSION, compatible: requiredContractVersion === HOST_CONTRACT_VERSION };
    const features = Object.fromEntries(Object.entries(requirements).map(([feature, required]) => {
      const missing = required.filter(id => capabilities[id] !== 1);
      return [feature, { available: baseline.compatible && contract.compatible && !missing.length,
        requiredCapabilities: Object.fromEntries(required.map(id => [id, 1])), missingCapabilities: missing }];
    }));
    return { baseline, contract, capabilities, features };
  };
  const requireFeature = feature => {
    const report = inspect(), state = report.features[feature];
    if (!state) throw new TypeError(`Unknown Studio Host feature: ${feature}`);
    if (state.available) return;
    const reason = !report.baseline.compatible ? 'DSH baseline' : !report.contract.compatible ? 'compatibility contract' : state.missingCapabilities.join(', ');
    throw Object.assign(new Error(`Studio ${feature} is unavailable: ${reason}. Install the compatible Studio Host.`), {
      code: 'STUDIO_HOST_INCOMPATIBLE', status: 503,
      details: { status: 503, feature, baseline: report.baseline, contract: report.contract, missingCapabilities: state.missingCapabilities },
    });
  };
  return Object.freeze({ inspect, require: requireFeature, isAgentLoopRequest(request) {
    requireFeature('agent-presets');
    return requestIsAgentLoop(request) === true;
  } });
}

/** The installed Host entry that is serving this process.
 *
 * Studio may be loaded from a source checkout, and that checkout's dependency
 * graph is not the Host's: nothing in Studio's own `package.json` depends on
 * `@deepseek-ai/dsh-app-boot`, while `@deepseek-ai/dsh-llm` is hoisted there
 * as a *second* copy. Resolving from Studio therefore reports the running Host
 * as an unknown baseline and hands back a different `isAgentLoopRequest`
 * WeakSet — both are facts about Studio's location, not about the Host.
 *
 * Anchor on the entry the Host is actually running so the public Host modules
 * come from the same module graph the Host itself uses.
 */
export function hostModuleAnchor({ argv = process.argv, env = process.env } = {}) {
  // Electron puts the app binary first and flags before the entry, so every
  // argument is a candidate; a flag is not an absolute path and is skipped.
  for (const candidate of [env.AGENTKIT_DSH_HOST_ENTRY, ...argv.slice(1)]) {
    if (typeof candidate !== 'string' || !candidate) continue;
    try {
      createRequire(candidate).resolve('@deepseek-ai/dsh-app-boot');
      return candidate;
    } catch { /* not the running Host entry */ }
  }
  return undefined;
}

/** Import a public Host module from the running Host's module graph.
 *
 * The resolved URL is the one the Host itself imports, so Node's ESM cache
 * returns the Host's instance rather than a copy. Falls back to Studio's own
 * resolution when no Host anchor exists (tests, embedders).
 */
export async function importHostModule(specifier, anchor) {
  if (anchor) {
    try { return await import(pathToFileURL(createRequire(anchor).resolve(specifier)).href); }
    catch { /* fall back to Studio's own resolution below */ }
  }
  return import(specifier);
}

/** Read the running DSH package through its public boot API. Display-version
 * environment overrides and Studio's own manifest never establish Host identity.
 */
export async function loadHostCompatibility(ctx, { anchor = hostModuleAnchor() } = {}) {
  const manifest = JSON.parse(await readFile(new URL('../../studio.plugin.json', import.meta.url), 'utf8'));
  let dshVersion, requestIsAgentLoop;
  try {
    const boot = await importHostModule('@deepseek-ai/dsh-app-boot', anchor);
    dshVersion = boot.getDshRuntimeVersion?.();
  } catch {
    // An unreadable or absent boot package cannot authorize native execution.
    // The diagnostic intentionally excludes local paths and import error text.
  }
  try {
    // Resolve the public helper from the running Host package graph. A copied
    // implementation would have a different WeakSet and reject real requests.
    requestIsAgentLoop = (await importHostModule('@deepseek-ai/dsh-llm', anchor)).isAgentLoopRequest;
  } catch {
    // Diagnostics remain available; native features require this capability.
  }
  return createHostCompatibility({ getService: name => ctx.get(name), dshVersion,
    requestIsAgentLoop, requiredDsh: manifest.requiredDsh, requiredContractVersion: manifest.requiredHostContract ?? null });
}
