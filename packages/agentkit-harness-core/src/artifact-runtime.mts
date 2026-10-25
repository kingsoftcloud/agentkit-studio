import type { ArtifactPort, ArtifactRef, Json, ObjectValue, PortContext, RunConfiguration, RunSnapshot,
  ToolCall, ToolDefinition, ToolResult } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { toolContext } from './tool-context.mjs';
import { artifactSearchSource } from './artifact-search-source.mjs';

export const RUNTIME_ARTIFACT_POLICY = 'runtime-artifacts/v1' as const;
export const ARTIFACT_RESULT_MEDIA_TYPE = 'application/vnd.agentkit.tool-result+json';
const names = ['ArtifactRead', 'ArtifactSearch', 'ArtifactList'];
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const length = (text: string) => Array.from(text).length;
const object = (value: Json | undefined): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const boundedInt = (minimum: number, maximum: number, fallback: number): ObjectValue =>
  ({ type: 'integer', minimum, maximum, default: fallback });

/** These exact definitions are sealed with configuration; names alone confer no privilege. */
export function artifactToolDefinitions(): ToolDefinition[] {
  const base = { readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 30_000,
    observationRole: 'none' as const, progressObservation: true, contextRetention: 'normal' as const,
    recoveryPolicy: 'safe-read/v1' as const };
  return [
    { ...base, name: 'ArtifactRead', contextRole: 'artifact_read',
      description: 'Read a character page of an artifact actually granted to this run. A URI in prose is not permission. Offsets count Unicode code points; use next_offset for continuation.',
      parameters: { type: 'object', required: ['uri'], additionalProperties: false, properties: {
        uri: { type: 'string', minLength: 1, maxLength: 512 },
        offset_chars: boundedInt(0, Number.MAX_SAFE_INTEGER, 0), limit_chars: boundedInt(1, 32000, 16000) } } },
    { ...base, name: 'ArtifactSearch', contextRole: 'workspace_search',
      description: 'Search granted artifacts with a case-sensitive literal query. Only requested URIs are inspected. complete=false means there may be omitted matches or unsearched text.',
      parameters: { type: 'object', required: ['uris', 'query'], additionalProperties: false, properties: {
        uris: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 512 } },
        query: { type: 'string', minLength: 1, maxLength: 1024 }, max_matches: boundedInt(1, 16, 8),
        context_chars: boundedInt(0, 256, 80) } } },
    { ...base, name: 'ArtifactList', contextRole: 'artifact_read',
      description: 'List this run’s granted artifact inventory, including inherited references. This does not scan storage or prove that source text has been read.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        offset: boundedInt(0, Number.MAX_SAFE_INTEGER, 0), limit: boundedInt(1, 8, 8) } } },
  ];
}
export function validateArtifactConfiguration(config: RunConfiguration): void {
  invariant(config.artifactPolicy == null || config.artifactPolicy === RUNTIME_ARTIFACT_POLICY, 'invalid_artifact_policy');
  if (config.artifactPolicy !== RUNTIME_ARTIFACT_POLICY) return;
  invariant(Number.isSafeInteger(config.limits.maxToolResultBytes) && config.limits.maxToolResultBytes >= 1024,
    'artifact_result_budget_too_small');
  for (const definition of artifactToolDefinitions()) invariant(
    canonical(config.tools.find(tool => tool.name === definition.name) ?? null) === canonical(definition), 'artifact_tool_binding_invalid');
}
export function isArtifactTool(name: string): boolean { return names.includes(name); }
async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
function validRef(ref: ArtifactRef, content: string, digest: string): boolean {
  return typeof ref?.uri === 'string' && /^artifact:\/\/[A-Za-z0-9._~%/-]+$/.test(ref.uri) && bytes(ref.uri) <= 256
    && ref.digest === digest && ref.sizeBytes === bytes(content) && ref.mediaType === ARTIFACT_RESULT_MEDIA_TYPE
    && object(ref.metadata);
}
/** Repeated captures with identical bytes do not create source progress merely by receiving a new URI. */
export function artifactProgressIdentity(refs: ArtifactRef[]): ObjectValue[] {
  const identities = new Map<string, ObjectValue>();
  for (const ref of refs) {
    const value = { digest: ref.digest, mediaType: ref.mediaType, sizeBytes: ref.sizeBytes };
    identities.set(canonical(value), value);
  }
  return [...identities.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}
function modelSize(result: ToolResult): number {
  return bytes(canonical({ content: result.context?.content ?? canonical(result.content), media: result.context?.media ?? [],
    additionalContexts: result.additionalContexts ?? [] }));
}
function offloadedView(result: ToolResult, payloadBytes: number, maximum: number, ref: ArtifactRef | null,
  preview: string, unavailable: boolean): string {
  const base = { code: ref ? 'tool_result_offloaded' : 'tool_result_truncated', execution_status: result.status,
    original_bytes: payloadBytes, artifact_state: ref ? 'available' : 'unavailable',
    instruction: ref ? 'Read the granted artifact for omitted text. The original tool has already returned; do not repeat its effects.'
      : 'Omitted text is unavailable. The original execution status is unchanged; do not repeat effects to recover its output.',
    ...(ref ? { artifact_uri: ref.uri } : {}), ...(unavailable ? { archive_error: 'archive_unavailable' } : {}),
    ...(result.context?.media?.length ? { media_observation: 'Inline media omitted; it has not been observed in this response.' } : {}) };
  // Account for JSON escaping and the complete ToolContext framing, not just preview characters.
  const chars = Array.from(preview);
  let low = 0, high = chars.length;
  const encode = (count: number) => canonical({ ...base, preview: chars.slice(0, count).join('') });
  invariant(bytes(canonical({ content: encode(0), media: [], additionalContexts: [] })) <= maximum, 'artifact_result_budget_too_small');
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(canonical({ content: encode(mid), media: [], additionalContexts: [] })) <= maximum) low = mid;
    else high = mid - 1;
  }
  return encode(low);
}

/** Runs within the original durable tool intent. Archive failures never relabel a known mutation or cause a retry. */
export async function governArtifactResult(context: PortContext, definition: ToolDefinition, input: ToolResult,
  config: RunConfiguration, artifacts?: ArtifactPort): Promise<ToolResult> {
  if (config.artifactPolicy !== RUNTIME_ARTIFACT_POLICY) return input;
  const result = copy(input);
  // Tool payloads and callback-provided locators cannot mint capabilities. Only the runtime's write return is admitted.
  delete result.artifactRefs; delete result.artifactObservationDigest;
  if (definition.resultArchivePolicy === 'archived-model-view/v4' && result.archiveContext)
    result.archiveContext = toolContext(result.archiveContext);
  else delete result.archiveContext;
  if (definition.directoryObservationPolicy && !input.context && !result.archiveContext)
    result.archiveContext = { content: canonical(result.content) };
  result.artifactObservationDigest = await sha256(canonical({ status: result.status, content: result.content,
    context: result.context ?? null, additionalContexts: result.additionalContexts ?? [] }));
  if (isArtifactTool(definition.name)) return result;
  const tooLarge = modelSize(result) > config.limits.maxToolResultBytes;
  const force = definition.resultArchivePolicy === 'archived-model-view/v4' && result.status === 'ok';
  if (!tooLarge && !force) return result;
  // Preserve the canonical receipt in SQLite. The readable archive follows the actual post-policy model view;
  // hidden/raw Host facts must not become visible merely by asking ArtifactRead for the overflow.
  const observation = result.archiveContext ?? result.context;
  const content = canonical({ status: result.status,
    content: observation ? { model_content: observation.content, media: observation.media ?? [] } : result.content,
    additional_contexts: result.additionalContexts ?? [] });
  let ref: ArtifactRef | null = null;
  try {
    if (artifacts && result.status !== 'approval_required' && result.status !== 'uncertain') {
      const issued = await artifacts.write({ ...context, operationKey: `${context.operationKey}:result-archive`, content,
        mediaType: ARTIFACT_RESULT_MEDIA_TYPE, metadata: { policy: RUNTIME_ARTIFACT_POLICY, toolName: definition.name } });
      invariant(validRef(issued, content, await sha256(content)), 'artifact_write_reference_invalid');
      ref = copy(issued);
    }
  } catch { /* The original tool outcome remains authoritative even when storage fails. */ }
  if (ref) result.artifactRefs = [ref];
  // A forced, small archive can retain the observed text if its locator annotation still fits.
  if (!tooLarge && ref && !result.context?.media?.length && !result.additionalContexts?.length) {
    const content = canonical({ observed_content: result.context?.content ?? canonical(result.content),
      artifact_uri: ref.uri, artifact_state: 'available' });
    if (modelSize({ ...result, context: { content } }) <= config.limits.maxToolResultBytes) {
      result.context = { ...result.context, content }; return result;
    }
  }
  if (!tooLarge && !ref) return result;
  result.context = { content: offloadedView(result, bytes(content), config.limits.maxToolResultBytes, ref,
    result.context?.content ?? canonical(result.content), !ref) };
  delete result.additionalContexts;
  return result;
}

const ok = (content: ObjectValue): ToolResult => ({ status: 'ok', content });
const failure = (code: string): ToolResult => ({ status: 'error', content: { code } });
const encodedSize = (result: ToolResult): number => modelSize(result);
function granted(snapshot: RunSnapshot, uri: Json | undefined): ArtifactRef | null {
  return typeof uri === 'string' ? snapshot.artifactRefs.find(ref => ref.uri === uri) ?? null : null;
}
function numberArg(args: ObjectValue, key: string, fallback: number): number {
  return args[key] === undefined ? fallback : Number(args[key]);
}
async function readPage(port: ArtifactPort, context: PortContext, ref: ArtifactRef, offset: number, limit: number) {
  context.signal.throwIfAborted();
  const page = await port.read({ ...context, ref: copy(ref), offset, limit });
  context.signal.throwIfAborted();
  invariant(typeof page?.content === 'string' && length(page.content) <= limit
    && (page.nextOffset === null || Number.isSafeInteger(page.nextOffset)
      && length(page.content) > 0 && page.nextOffset === offset + length(page.content)), 'artifact_read_response_invalid');
  return page;
}

/** Inventory authority comes solely from the committed snapshot; a storage search cannot grant references. */
export async function executeArtifactTool(context: PortContext, call: ToolCall, snapshot: RunSnapshot,
  config: RunConfiguration, artifacts?: ArtifactPort): Promise<ToolResult> {
  invariant(config.artifactPolicy === RUNTIME_ARTIFACT_POLICY && isArtifactTool(call.name), 'artifact_tool_not_bound');
  const maximum = config.limits.maxToolResultBytes, args = call.arguments;
  if (call.name === 'ArtifactList') {
    const offset = numberArg(args, 'offset', 0), limit = numberArg(args, 'limit', 8), entries: Json[] = [];
    const stamp = await sha256(canonical(snapshot.artifactRefs));
    const build = () => ok({ artifacts: entries, total: snapshot.artifactRefs.length, inventory_digest: stamp,
      offset, next_offset: offset + entries.length < snapshot.artifactRefs.length ? offset + entries.length : null });
    for (const ref of snapshot.artifactRefs.slice(offset, offset + limit)) {
      entries.push({ uri: ref.uri, digest: ref.digest, media_type: ref.mediaType, size_bytes: ref.sizeBytes });
      if (encodedSize(build()) > maximum) { entries.pop(); break; }
    }
    return build();
  }
  const uris = call.name === 'ArtifactRead' ? [args.uri] : args.uris as Json[];
  const refs = uris.map(uri => granted(snapshot, uri));
  if (refs.some(ref => !ref)) return failure('artifact_not_available');
  if (!artifacts) return failure('artifact_storage_unavailable');
  try {
    if (call.name === 'ArtifactRead') {
      const ref = refs[0]!, offset = numberArg(args, 'offset_chars', 0), limit = numberArg(args, 'limit_chars', 16000);
      const page = await readPage(artifacts, context, ref, offset, limit), chars = Array.from(page.content);
      const build = (count: number) => ok({ uri: ref.uri, offset_chars: offset, returned_chars: count,
        content: chars.slice(0, count).join(''),
        next_offset: count < chars.length ? offset + count : page.nextOffset,
        result_truncated: count < chars.length });
      if (encodedSize(build(chars.length)) <= maximum) return build(chars.length);
      let low = 0, high = chars.length;
      if (encodedSize(build(0)) > maximum) return failure('artifact_page_budget_unavailable');
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (encodedSize(build(mid)) <= maximum) low = mid; else high = mid - 1;
      }
      if (chars.length && !low) return failure('artifact_page_budget_unavailable');
      return build(low);
    }
    const query = String(args.query), maxMatches = numberArg(args, 'max_matches', 8), margin = numberArg(args, 'context_chars', 80);
    const matches: Json[] = []; let complete = true, scanned = 0;
    const build = () => ok({ matches, complete, scanned_artifacts: scanned });
    for (const ref of refs) {
      // The reference refuses oversized documents before I/O. Searching a prefix
      // of captured JSON would otherwise expose framing instead of source text.
      if (ref!.sizeBytes > 1024 * 1024) { scanned++; complete = false; continue; }
      let text = '', offset = 0, finished = false;
      // A bounded scan is honest about omitted text; no hidden storage-wide search is performed.
      while (bytes(text) < 1024 * 1024) {
        const page = await readPage(artifacts, context, ref!, offset, 32000);
        text += page.content;
        if (page.nextOffset === null) { finished = true; break; }
        offset = page.nextOffset;
      }
      scanned++; if (!finished) complete = false;
      // A decoded carrier must come from the complete, authenticated document.
      // A bounded prefix is still searchable as artifact text, never as source coordinates.
      if (finished) invariant(bytes(text) === ref!.sizeBytes && await sha256(text) === ref!.digest,
        'artifact_search_content_mismatch');
      const source = finished ? artifactSearchSource(text, ref!.mediaType) : { body: text };
      const body = source.body, chars = Array.from(body);
      let from = 0;
      while (true) {
        const index = body.indexOf(query, from); if (index < 0) break;
        if (matches.length >= maxMatches) { complete = false; break; }
        const prefix = body.slice(0, index), start = length(prefix);
        const sourceLine = source.start === undefined ? undefined : BigInt(source.start) + BigInt(prefix.split('\n').length - 1);
        matches.push({ uri: ref!.uri, offset_chars: start, match: query,
          ...(source.path === undefined ? {} : { coordinate_space: 'captured_source', source_path: source.path,
            source_line: sourceLine! > BigInt(Number.MAX_SAFE_INTEGER) ? sourceLine! : Number(sourceLine) }),
          excerpt: chars.slice(Math.max(0, start - margin), start + length(query) + margin).join('') });
        // complete=false is one byte longer than true; reserve that final omission state before admitting a match.
        if (encodedSize(ok({ matches, complete: false, scanned_artifacts: refs.length })) > maximum) {
          matches.pop(); complete = false; break;
        }
        from = index + query.length;
      }
      if (matches.length >= maxMatches || encodedSize(build()) > maximum) {
        if (scanned < refs.length) complete = false; break;
      }
    }
    return build();
  } catch { context.signal.throwIfAborted(); return failure('artifact_read_unavailable'); }
}
