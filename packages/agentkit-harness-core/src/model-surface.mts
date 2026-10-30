import type { ArtifactRef, Message, RunConfiguration, VerificationReport } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';

/** Facts are supplied by the execution owner, never inferred from prompt prose. */
export interface WorkspaceBrowserCapability {
  contract: 'agentkit.workspace-browser-capability/v1'; toolName: 'browser_inspect_workspace';
  availability: 'available' | 'unavailable'; networkPolicy: 'workspace-origin/v1';
  servedFiles: 'entry-directory/v1'; externalNetwork: false; viewport: [1280, 720];
}
export interface ModelSurface {
  contract: 'bound-model-surface/v1';
  verificationProjection?: 'readable-evidence/v1';
  executionCapabilities?: WorkspaceBrowserCapability[];
  environment: {
    workspaceRoot: string; cwd: string; platform: string; date: string;
    commandBackend: 'local_process' | 'e2b' | 'none';
    commandCwd?: string; environmentNames?: string[];
    commandResources?: {
      contract: 'agentkit.local-resource-profile/v1'; profile: 'bounded/v1' | 'local-development/v1';
      requestedLimits: { cpuSeconds: number; addressSpaceBytes: number; maxProcesses: number;
        maxOpenFiles: number; maxFileBytes: number; wallSeconds: number };
    };
    supportsImages: boolean;
  };
}
const bytes = (value: unknown): number => new TextEncoder().encode(canonical(value)).length;
export function validateModelSurface(surface: ModelSurface | undefined): void {
  if (surface === undefined) return;
  invariant(surface && surface.contract === 'bound-model-surface/v1'
    && Object.keys(surface).every(key => ['contract', 'environment', 'verificationProjection', 'executionCapabilities'].includes(key))
    && (surface.verificationProjection === undefined || surface.verificationProjection === 'readable-evidence/v1'), 'invalid_model_surface');
  const env = surface.environment;
  if (surface.executionCapabilities !== undefined) {
    invariant(Array.isArray(surface.executionCapabilities) && surface.executionCapabilities.length <= 64
      && new Set(surface.executionCapabilities.map(item => item?.toolName)).size === surface.executionCapabilities.length
      && surface.executionCapabilities.every(item => item
        && Object.keys(item).sort().join(',') === 'availability,contract,externalNetwork,networkPolicy,servedFiles,toolName,viewport'
        && item.contract === 'agentkit.workspace-browser-capability/v1' && item.toolName === 'browser_inspect_workspace'
        && ['available', 'unavailable'].includes(item.availability) && item.networkPolicy === 'workspace-origin/v1'
        && item.servedFiles === 'entry-directory/v1' && item.externalNetwork === false
        && Array.isArray(item.viewport) && item.viewport.length === 2
        && item.viewport[0] === 1280 && item.viewport[1] === 720), 'invalid_execution_capabilities');
  }
  invariant(env && Object.keys(env).every(key => ['workspaceRoot', 'cwd', 'platform', 'date', 'commandBackend',
    'commandCwd', 'environmentNames', 'commandResources', 'supportsImages'].includes(key))
    && ['workspaceRoot', 'cwd', 'platform', 'date'].every(key => typeof env[key as keyof typeof env] === 'string'
      && String(env[key as keyof typeof env]).trim().length > 0)
    && ['local_process', 'e2b', 'none'].includes(env.commandBackend) && typeof env.supportsImages === 'boolean'
    && /^\d{4}-\d{2}-\d{2}$/.test(env.date)
    && (env.commandCwd === undefined || typeof env.commandCwd === 'string' && !!env.commandCwd.trim())
    && (env.environmentNames === undefined || Array.isArray(env.environmentNames) && env.environmentNames.length <= 256
      && new Set(env.environmentNames).size === env.environmentNames.length
      && env.environmentNames.every(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    && bytes(surface) <= 16384, 'invalid_model_environment');
  const resources = env.commandResources;
  if (resources !== undefined) {
    const keys = ['cpuSeconds', 'addressSpaceBytes', 'maxProcesses', 'maxOpenFiles', 'maxFileBytes', 'wallSeconds'];
    invariant(env.commandBackend === 'local_process' && resources
      && Object.keys(resources).sort().join(',') === 'contract,profile,requestedLimits'
      && resources.contract === 'agentkit.local-resource-profile/v1'
      && ['bounded/v1', 'local-development/v1'].includes(resources.profile)
      && resources.requestedLimits && Object.keys(resources.requestedLimits).sort().join(',') === [...keys].sort().join(',')
      && Object.values(resources.requestedLimits).every(value => Number.isSafeInteger(value) && value > 0),
    'invalid_model_command_resources');
  }
}

/** A model sees only evidence addresses its artifact tools can actually read.
 * Private verifier payloads and locators stay in the ledger. */
export function verificationModelView(report: VerificationReport | null, readable: ArtifactRef[]) {
  if (!report) return null;
  const granted = new Map(readable.map(ref => [ref.uri, ref]));
  return { status: report.status, reason: report.reason, candidateId: report.candidateId ?? null,
    contractRevision: report.contractRevision ?? null, workspaceRevision: report.workspaceRevision,
    checks: report.checks.map(check => ({ id: check.id, status: check.status, safeSummary: check.safeSummary ?? '',
      repairable: check.repairable === true,
      readableEvidence: (check.evidenceRefs ?? []).filter(uri => granted.has(uri)).map(uri => {
        const ref = granted.get(uri)!;return {uri:ref.uri,digest:ref.digest,mediaType:ref.mediaType,sizeBytes:ref.sizeBytes};
      }) })) };
}

export interface CatalogEntry { name: string; description: string; id?: string }
/** Share discovery budgeting across tool and Skill directories. Prefer all names over an arbitrary first page. */
export function boundedCapabilityCatalog(entries: CatalogEntry[], maxBytes = 4096): {
  total: number; omitted: number; mode: 'descriptions' | 'names'; entries: CatalogEntry[];
} {
  invariant(Number.isSafeInteger(maxBytes) && maxBytes >= 256 && Array.isArray(entries)
    && entries.every(entry => entry && typeof entry.name === 'string' && typeof entry.description === 'string'
      && Object.keys(entry).every(key => ['name', 'description', 'id'].includes(key))
      && (entry.id === undefined || typeof entry.id === 'string')), 'invalid_capability_catalog');
  const ordered = copy(entries).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const catalogBytes = (value: unknown) => new TextEncoder().encode(canonical(value)
    .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')).length;
  const described = ordered.map(entry => ({ ...entry, description: Array.from(entry.description).slice(0, 250).join('') }));
  const envelope = (visible: CatalogEntry[], mode: 'descriptions' | 'names') => ({ total: entries.length,
    omitted: entries.length - visible.length, mode, entries: visible });
  if (catalogBytes(envelope(described, 'descriptions')) <= maxBytes) return envelope(described, 'descriptions');
  const visible: CatalogEntry[] = [];
  for (const entry of ordered) {
    const candidate = { ...entry, description: '' };
    if (catalogBytes(envelope([...visible, candidate], 'names')) <= maxBytes) visible.push(candidate);
  }
  return envelope(visible, 'names');
}

/** One frozen assembly, stored in the transcript and therefore used by counting, dispatch and recovery alike. */
export function modelSurfaceMessages(config: RunConfiguration): Message[] {
  if (!config.modelSurface) return [];
  validateModelSurface(config.modelSurface);
  const tools = config.tools.filter(tool => config.contract.allowedToolNames === null || config.contract.allowedToolNames.includes(tool.name));
  const names = new Set(tools.map(tool => tool.name));
  const guidance: string[] = [];
  for (const item of new Set(tools.flatMap(tool => tool.modelGuidance ?? []))) {
    if (bytes([...guidance, item]) <= 3072) guidance.push(item);
  }
  if (config.toolDiscoveryPolicy && names.has('ToolSearch')) guidance.push(config.profile.discoveredToolExposure === 'direct-after-search/v1'
    || config.profile.providerToolSearchPolicy === 'anthropic-deferred/v1'
    ? 'ToolSearch loads authorized definitions. On the next model request call loaded tools directly by exact name; search cannot grant new tools.'
    : 'ToolSearch discovers authorized deferred tools. Use the advertised calling convention; search cannot grant new tools.');
  if (config.profile.providerFamily === 'anthropic-messages') guidance.push('Use only the current tool definitions and tool references. Wait for a result before issuing a dependent action.');
  else if (config.profile.providerFamily === 'openai-chat' || config.profile.providerFamily === 'openai-responses')
    guidance.push('Use structured tool arguments matching the current schema. Batch independent observations; dependent reads and edits must be separate calls.');
  return [{ role: 'system', kind: 'runtime_environment', persistent: true,
    content: canonical({ schemaVersion: 'agentkit.execution-environment/v1', ...config.modelSurface.environment }) },
  { role: 'system', kind: 'capability_directory', persistent: true, content: canonical({
    schemaVersion: 'agentkit.model-capabilities/v1', metadataTrust: 'discovery_data',
    residentToolCount: tools.filter(tool => !tool.discovery).length,
    catalog: boundedCapabilityCatalog(tools.filter(tool => tool.discovery).map(tool => ({ name: tool.name,
      description: tool.discovery?.searchHint || tool.description })), Math.max(256, Math.min(4096, config.profile.contextWindow * 2))),
    discovery: config.toolDiscoveryPolicy && names.has('ToolSearch') ? 'ToolSearch' : null,
    imageInput: config.modelSurface.environment.supportsImages, guidance,
    ...(config.modelSurface.executionCapabilities === undefined ? {} : {
      executionCapabilities: config.modelSurface.executionCapabilities.filter(capability => names.has(capability.toolName)) }),
  }) }];
}
