import type { RunConfiguration, RunSnapshot, ToolCall, ToolDefinition, ToolResult } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { toolInputRejection } from './tool-input.mjs';

export const DELIVERY_SCOPE_POLICY = 'declared-deliverables/v1';
export const RESULT_DELIVERY_POLICY = 'answer-artifacts/v2';
export const DECLARE_DELIVERABLES = 'declare_deliverables';
export type DeliveryArtifact = { path: string; kind: 'file' | 'web'; root?: string };
export interface DeliveryManifest {
  goalRevision: number; revision: number; artifacts: DeliveryArtifact[];
}
const pathSchema = { type: 'string', minLength: 1, maxLength: 2048 };
export const deliveryArtifactsSchema = { type: 'array', maxItems: 32, items: {
  type: 'object', additionalProperties: false, required: ['path', 'kind'], properties: {
    path: pathSchema, kind: { enum: ['file', 'web'] }, root: pathSchema } } };
export function deliveryScopeEnabled(config: Pick<RunConfiguration, 'deliveryScopePolicy'>): boolean {
  return config.deliveryScopePolicy === DELIVERY_SCOPE_POLICY || config.deliveryScopePolicy === RESULT_DELIVERY_POLICY;
}

/** A proposal of delivery subjects, never a claim of acceptance or a permission grant. */
export function deliveryToolDefinitions(policy: RunConfiguration['deliveryScopePolicy'] = DELIVERY_SCOPE_POLICY): ToolDefinition[] {
  return [{ name: DECLARE_DELIVERABLES,
    description: (policy === RESULT_DELIVERY_POLICY
      ? 'Optionally select delivery artifacts early for intermediate checks. You can instead include artifacts with your final answer in submit_final_output; a separate declaration is unnecessary. '
      : 'Declare the complete set of workspace artifacts you are delivering before finalizing workspace work. ')
      + 'Exclude downloaded reference sources and temporary files. Use an empty artifacts list when the delivery is your text answer. A file artifact is a document or source file; a web artifact is a runnable page with its workspace-relative entry path and project root. This version accepts one runnable page plus any file artifacts. Declaring artifacts does not verify them. Replace the declaration when the intended delivery changes; do not change the delivery just to satisfy an unavailable verifier.',
    parameters: { type: 'object', additionalProperties: false, required: ['artifacts'], properties: {
      artifacts: deliveryArtifactsSchema } },
    permissions: [], timeoutMs: 1000, readOnly: false, concurrentSafe: false,
    contextRole: 'task_planning', observationRole: 'none', progressObservation: false, contextRetention: 'normal' }];
}

function relativePath(value: unknown, root = false): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
    && !/[\\\u0000-\u001f\u007f:]/u.test(value) && !value.startsWith('/')
    && (root && value === '.' || value.split('/').every(part => part && part !== '.' && part !== '..'));
}
export function deliveryArtifacts(value: unknown): DeliveryArtifact[] {
  invariant(Array.isArray(value) && value.length <= 32, 'invalid_delivery_artifacts');
  invariant(new TextEncoder().encode(canonical(value)).byteLength <= 16384, 'delivery_scope_too_large');
  const seen = new Set<string>(); let pages = 0;
  for (const item of value) {
    invariant(item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).every(key => ['path', 'kind', 'root'].includes(key))
      && relativePath(item.path) && !seen.has(item.path)
      && ['file', 'web'].includes(item.kind), 'invalid_delivery_artifact');
    if (item.kind === 'web') invariant(++pages <= 1 && relativePath(item.root, true)
      && (item.root === '.' || item.path.startsWith(item.root + '/')), 'invalid_web_delivery_scope');
    else invariant(item.root === undefined, 'invalid_file_delivery_scope');
    seen.add(item.path);
  }
  return copy(value);
}
export function isDeliveryCall(config: RunConfiguration, call: Pick<ToolCall, 'name'>): boolean {
  return deliveryScopeEnabled(config) && call.name === DECLARE_DELIVERABLES;
}
export function validateDeliveryConfiguration(config: RunConfiguration): void {
  invariant(config.deliveryScopePolicy === undefined || deliveryScopeEnabled(config), 'invalid_delivery_scope_policy');
  if (!config.deliveryScopePolicy) return;
  invariant(config.tools.some(tool => canonical(tool) === canonical(deliveryToolDefinitions(config.deliveryScopePolicy)[0])), 'delivery_tool_binding_invalid');
}
export function executeDelivery(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall): ToolResult {
  invariant(isDeliveryCall(config, call), 'delivery_policy_unavailable');
  const rejection = toolInputRejection(config.tools.find(tool => tool.name === call.name)!, call);
  if (rejection) return { status: 'error', content: rejection };
  let artifacts;
  try { artifacts = deliveryArtifacts(call.arguments.artifacts); }
  catch { return { status: 'error', content: { code: 'invalid_delivery_scope', executed: false,
    message: 'Use unique workspace-relative paths. A web entry needs its containing project root; at most one web entry is supported.' } }; }
  return { status: 'ok', content: { artifacts, goalRevision: snapshot.goalRevision,
    revision: (snapshot.deliveryManifest?.revision ?? 0) + 1, acceptance: 'unverified' } };
}
export function reduceDelivery(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall, result: ToolResult): Partial<RunSnapshot> {
  if (!isDeliveryCall(config, call) || result.status !== 'ok') return {};
  invariant(result.content && typeof result.content === 'object' && !Array.isArray(result.content), 'invalid_delivery_receipt');
  const artifacts = deliveryArtifacts(result.content.artifacts);
  invariant(canonical(artifacts) === canonical(deliveryArtifacts(call.arguments.artifacts))
    && result.content.goalRevision === snapshot.goalRevision
    && result.content.revision === (snapshot.deliveryManifest?.revision ?? 0) + 1
    && result.content.acceptance === 'unverified', 'invalid_delivery_receipt');
  return deliveryManifestChanges(snapshot, artifacts);
}

/** Used by both optional early declarations and the atomic final-answer reducer. */
export function deliveryManifestChanges(snapshot: RunSnapshot, values: unknown): Partial<RunSnapshot> {
  const artifacts = deliveryArtifacts(values);
  return { deliveryManifest: { artifacts, goalRevision: snapshot.goalRevision, revision: (snapshot.deliveryManifest?.revision ?? 0) + 1 },
    verification: null, verificationToolCalls: null,
    ...(artifacts.some(item => item.kind === 'web') && snapshot.lastWorkspaceMutationToolCall != null
      ? { lastWebMutationToolCall: snapshot.lastWorkspaceMutationToolCall } : {}) };
}
export function currentDeliveryManifest(snapshot: RunSnapshot): DeliveryManifest | null {
  const manifest = snapshot.deliveryManifest;
  if (!manifest || manifest.goalRevision !== snapshot.goalRevision) return null;
  deliveryArtifacts(manifest.artifacts);
  return manifest;
}
export function webDelivery(snapshot: RunSnapshot): DeliveryArtifact | null {
  return currentDeliveryManifest(snapshot)?.artifacts.find(item => item.kind === 'web') ?? null;
}
