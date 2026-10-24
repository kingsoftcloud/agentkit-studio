/** Legacy load_memory/save_memory services. Actual invocation authority and
 * Native/DSH ownership come from the Host ports, never model tool arguments.
 */
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { canonical, copy, invariant, toolInputRejection } from '../packages/agentkit-harness-core/dist/index.mjs';
import { hostFetch } from './http-fetch.mjs';
import { createAicpResourceConnection } from './aicp-resource-connection.mjs';
import { memorySubjectId, memorySessionId } from './memory-identity.mjs';
import { LegacyMemoryEffects } from './legacy-memory-effects.mjs';
import { LegacyLocalMemory } from './legacy-memory-local.mjs';
import { nativeMemorySensitiveLabels } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { formatLegacyMemoryEntries, parseLegacySdkMemoryEntries } from './legacy-memory-format.mjs';

export const LEGACY_MEMORY_TOOLS = 'agentkit.legacy-memory-tools/v1';
export const LEGACY_MEMORY_BINDINGS = 'agentkit.legacy-memory-bindings/v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const text = value => typeof value === 'string' && !!value.trim();
const persisted = () => ({ status: 'ok', content: { ok: true, status: 'persisted', message: '记忆已保存。' } });
const errorResult = (code, executed = false) => ({ status: 'error', content: { ok: false, status: 'failed',
  error_type: code, message: '记忆调用失败。', ...(executed === false ? { executed: false } : {}) } });

export function legacyMemoryBindings(spec = {}) {
  const collectionIds = (spec.bindings?.plugins ?? []).filter(plugin => plugin.enabled !== false)
    .map(plugin => plugin.config?.binding?.resource).filter(resource => resource?.kind === 'memory-instance')
    .map(resource => resource.id || resource.resourceId);
  invariant(collectionIds.every(text), 'legacy_memory_binding_invalid');
  return { contract: LEGACY_MEMORY_BINDINGS, collectionIds: [...new Set(collectionIds)] };
}

export function legacyMemoryToolDefinitions() {
  return [['load_memory', 'query', true], ['save_memory', 'content', false]].map(([name, field, readOnly]) => ({ name,
    description: readOnly ? 'Search long-term memory for the current user.' : 'Save a durable fact for the current user.',
    parameters: { type: 'object', additionalProperties: false, required: [field], properties: { [field]: { type: 'string' } } },
    readOnly, concurrentSafe: readOnly, permissions: [], timeoutMs: 120000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' }));
}

export const createLegacyMemoryConnection = options => createAicpResourceConnection({ ...options,
  prefix: 'KSADK_LTM', contract: LEGACY_MEMORY_TOOLS });

function step(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
    if (signal.aborted) abort();
  });
}

function sdkReply(reply, receipt = false) {
  let data = reply?.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { invariant(false, 'legacy_memory_response_invalid'); } }
  invariant(object(data) && data.Success !== false && !data.Error
    && (!('Code' in data) || [0, 200, '0', '200'].includes(data.Code))
    && (data.ResponseMetadata === undefined || object(data.ResponseMetadata) && !data.ResponseMetadata.Error)
    && (!receipt || text(reply.requestId) || text(data.RequestId) || text(data.ResponseMetadata?.RequestId)),
  'legacy_memory_response_invalid');
  return data;
}

/** root is a Host-private state directory outside the workspace. Bound cloud
 * collections use Studio's existing hashed user/Session partition. Environment
 * SDK collections retain the legacy explicit user/Session identifiers.
 */
export function createLegacyMemoryTools({ agentId, root, workspaceRoot, bindings = legacyMemoryBindings(), env = {}, connection, fetchImpl = hostFetch }) {
  invariant(text(agentId) && bindings?.contract === LEGACY_MEMORY_BINDINGS && Array.isArray(bindings.collectionIds)
    && bindings.collectionIds.every(text) && Object.keys(bindings).every(key => ['contract', 'collectionIds'].includes(key)),
  'legacy_memory_binding_invalid');
  const bound = bindings.collectionIds.length > 0, backend = bound ? 'sdk' : String(env.KSADK_LTM_BACKEND ?? 'local'),
    index = String(env.KSADK_LTM_INDEX || env.KSADK_LTM_APP_NAME || 'default_app'),
    collectionIds = [...new Set(bound ? bindings.collectionIds : [String(env.KSADK_LTM_NAMESPACE || index)])],
    topK = Number(env.KSADK_LTM_TOP_K ?? 5), sceneId = String(env.KSADK_LTM_SCENE_ID || '_sys_general'),
    volatile = /^(true|1)$/i.test(String(env.KSADK_LTM_FORCE_INMEMORY ?? ''));
  invariant(['local', 'http', 'sdk'].includes(backend) && Number.isSafeInteger(topK) && topK > 0, 'legacy_memory_settings_invalid');
  invariant(backend !== 'sdk' || typeof connection?.client?.action === 'function' && /^[a-f0-9]{64}$/.test(connection.bindingDigest),
    'legacy_memory_connection_unavailable');
  const action = connection?.client?.action?.bind(connection.client), token = String(env.KSADK_LTM_HTTP_TOKEN ?? ''),
    rawSource = String(env.KSADK_TRAFFIC_SOURCE ?? ''), trafficSource = rawSource.trim() || 'agentkit';
  const databasePath = backend === 'local' && !volatile ? String(env.KSADK_MEMORY_DB_PATH ?? '') : '';
  if (workspaceRoot) {
    const workspace = resolve(workspaceRoot), state = resolve(root), database = databasePath && databasePath !== ':memory:' ? resolve(databasePath) : null;
    const inside = (path, parent) => path === parent || path.startsWith(parent + sep);
    invariant(!inside(state, workspace) && !inside(workspace, state) && (!database || !inside(database, workspace)), 'legacy_memory_workspace_overlap');
  }
  invariant(!/[^\x20-\x7e]/u.test(rawSource), 'legacy_memory_traffic_source_invalid');
  let baseUrl;
  if (backend === 'http' && env.KSADK_LTM_HTTP_URL) {
    baseUrl = new URL(env.KSADK_LTM_HTTP_URL);
    invariant(['http:', 'https:'].includes(baseUrl.protocol) && !baseUrl.username && !baseUrl.password
      && !baseUrl.search && !baseUrl.hash, 'legacy_memory_http_url_invalid');
    if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  }
  const binding = { contract: LEGACY_MEMORY_TOOLS, agentId, backend, bound, collectionIds: backend === 'sdk' ? collectionIds : [],
    index, topK, sceneId, volatile, ...(backend === 'local' ? { storageDigest: hash({ root: resolve(root), databasePath: databasePath === ':memory:'
      ? databasePath : databasePath ? resolve(databasePath) : '', volatile }) } : {}), connectionDigest: backend === 'sdk' ? connection.bindingDigest
      : hash({ backend, url: baseUrl?.href ?? '', token, trafficSource }) };
  const effects = new LegacyMemoryEffects(join(root, 'effects')),
    ephemeral = new Map(), lifetime = new AbortController(), active = new Set(), definitions = legacyMemoryToolDefinitions();
  let local;
  try { local = backend === 'local' && !volatile ? new LegacyLocalMemory(join(root, 'local'), { databasePath }) : null; }
  catch (error) { effects.close(); throw error; }
  let closing;
  const http = async (path, payload, signal, authority) => {
    invariant(baseUrl, 'legacy_memory_not_configured'); authority();
    const response = await step(() => { authority(); return fetchImpl(new URL(path, baseUrl), { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Traffic-Source': trafficSource, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) }); }, signal);
    authority(); invariant(response.ok, 'legacy_memory_http_failed'); return response;
  };
  const sdk = async (name, payload, signal, authority, requestId) => {
    authority(); const reply = await step(() => { authority(); return action(name, copy(payload),
      { apiVersion: '2025-11-14', signal, preserveEnvelope: true, ...(requestId ? { requestId } : {}) }); }, signal); authority(); return reply;
  };
  const sdkQuery = async (target, query, limit, signal, authority) => {
    const data = sdkReply(await sdk('QueryMemorySdk', { MemoryCollectionId: target.MemoryCollectionId,
      AgentUserId: target.AgentUserId, Query: query, Limit: limit, SceneId: sceneId }, signal, authority));
    // The current Studio transport also accepts an SDK envelope whose Data
    // contains Memories. Retain that product shape alongside Python Data[].
    return parseLegacySdkMemoryEntries(object(data.Data) ? data.Data : data);
  };
  const sessionStatus = async (target, signal, authority) => {
    const seen = new Set(); let previousTotal;
    for (let page = 1; page <= 20; page++) {
      const reply = sdkReply(await sdk('ListSessions', { MemoryCollectionId: target.MemoryCollectionId,
        AgentUserId: target.AgentUserId, Page: page, PageSize: 20 }, signal, authority)), payload = reply.Data, items = payload?.Items;
      invariant(object(payload) && Array.isArray(items) && items.length <= 20
        && items.every(item => object(item) && text(item.SessionId)), 'legacy_memory_status_invalid');
      const integer = value => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
      const total = integer(payload.TotalCount ?? payload.Total);
      invariant((payload.TotalCount === undefined || payload.Total === undefined || integer(payload.TotalCount) === integer(payload.Total))
        && (total === undefined || Number.isSafeInteger(total) && total >= 0)
        && (page === 1 || total === previousTotal), 'legacy_memory_status_directory_changed');
      previousTotal = total;
      const ids = items.map(item => item.SessionId);
      invariant(new Set(ids).size === ids.length && ids.every(id => !seen.has(id)), 'legacy_memory_status_repeated');
      for (const id of ids) seen.add(id);
      for (const item of items) {
        if (item.SessionId === target.SessionId) {
          invariant((item.AgentUserId === undefined || item.AgentUserId === target.AgentUserId)
            && (item.MemoryCollectionId === undefined || item.MemoryCollectionId === target.MemoryCollectionId), 'legacy_memory_status_scope_mismatch');
          return { session_id: item.SessionId, session_state: item.State ?? null };
        }
      }
      if (total !== undefined && seen.size >= total) { invariant(seen.size === total, 'legacy_memory_status_directory_changed'); return {}; }
      if (items.length < 20) { invariant(total === undefined, 'legacy_memory_status_incomplete'); return {}; }
    }
    invariant(false, 'legacy_memory_status_page_budget');
  };
  return Object.freeze({ contract: LEGACY_MEMORY_TOOLS, get binding() { return copy(binding); },
    get definitions() { return copy(definitions); },
    close() { if (!closing) { lifetime.abort(); closing = Promise.allSettled([...active]).then(() => { effects.close(); local?.close(); }); } return closing; },
    async execute(name, args, { signal: callerSignal, assertCurrent, context, owner }) {
      invariant(callerSignal instanceof AbortSignal && typeof assertCurrent === 'function', 'legacy_memory_execution_unbound');
      const signal = AbortSignal.any([callerSignal, lifetime.signal, AbortSignal.timeout(120000)]);
      const originalBody = canonical({ name, args, context, owner });
      const pending = (async () => {
        const definition = definitions.find(item => item.name === name); invariant(definition, 'legacy_memory_tool_unknown');
        const authority = () => { signal.throwIfAborted(); const current = assertCurrent();
          if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
          invariant(current === true && canonical({ name, args, context, owner }) === originalBody,
            'legacy_memory_authority_lost'); signal.throwIfAborted(); };
        authority(); const invalid = toolInputRejection(definition, { name, arguments: args, callId: 'legacy-memory-validation' });
        if (invalid) return { status: 'error', content: invalid };
        if (!context || context.agentId !== agentId || !text(context.userId) || !text(context.sessionId) || !text(context.runnerType))
          return name === 'load_memory' ? { status: 'error', content: '长期记忆检索失败: 缺少运行时上下文。' }
            : { status: 'error', content: { ok: false, status: 'failed', message: '记忆保存失败: 缺少运行时上下文。' } };
        if (backend === 'http' && !baseUrl) return errorResult('legacy_memory_not_configured');
        if (name === 'save_memory' && backend === 'local' && !volatile && nativeMemorySensitiveLabels(args.content).length)
          return errorResult('legacy_memory_content_rejected');
        const request = { name, arguments: copy(args), context: copy(context) }, operationKey = hash({ kind: owner.kind, identity: owner.identity });
        return effects.execute({ owner, request, binding, signal, assertCurrent: authorityTrue,
          prepare() {
            authority(); const metadata = { agent_id: agentId, session_id: context.sessionId, runner_type: context.runnerType, flush: true };
            const event = JSON.stringify({ role: 'user', parts: [{ text: args.content }], metadata });
            return name === 'load_memory' ? { query: args.query } : backend === 'http'
              ? { payload: { index, user_id: context.userId, events: [event], metadata, session_id: context.sessionId, flush: true } }
              : backend === 'local' ? { id: `mem_${randomUUID().replaceAll('-', '').slice(0, 24)}`, content: args.content || event,
                userId: context.userId, createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), operationKey, event }
              : { requestIds: collectionIds.map(() => randomUUID()), targets: collectionIds.map(id => ({ MemoryCollectionId: id, AgentUserId: bound ? memorySubjectId(id, context.userId, agentId) : context.userId,
                SessionId: bound ? memorySessionId(context.sessionId) : context.sessionId, AgentId: agentId, SceneId: sceneId,
                DataType: 'conversation', Flush: true, Data: { Conversation: args.content ? [{ Role: 'user', CreatedAt: Date.now(), MessageId: randomUUID(),
                  Content: [{ Type: 'input_text', Text: args.content }] }] : [] } })) };
          },
          async dispatch(prepared, current) {
            if (name === 'load_memory') {
              let entries;
              if (backend === 'local') {
                if (volatile) {
                  const query = prepared.query.toLowerCase(), terms = query.split(/\s+/u).filter(Boolean);
                  entries = (ephemeral.get(context.userId) ?? []).map((entry, order) => ({ entry, order,
                    score: (entry.toLowerCase().includes(query) ? 10 : 0) + terms.filter(term => entry.toLowerCase().includes(term)).length }))
                    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, topK).map(item => item.entry);
                } else entries = local.search({ userId: context.userId, query: prepared.query, topK });
              } else if (backend === 'http') {
                const response = await http('memories/search', { index, user_id: context.userId, query: prepared.query, top_k: topK }, signal, current);
                const body = await step(() => response.json(), signal); current();
                invariant(object(body) && Array.isArray(body.memories) && body.memories.every(item => typeof item === 'string'), 'legacy_memory_response_invalid');
                entries = body.memories;
              } else {
                entries = [];
                for (const id of collectionIds) entries.push(...await sdkQuery({ MemoryCollectionId: id,
                  AgentUserId: bound ? memorySubjectId(id, context.userId, agentId) : context.userId }, prepared.query, topK, signal, current));
              }
              current(); return { status: 'ok', content: formatLegacyMemoryEntries(entries) };
            }
            if (backend === 'local') {
              current();
              if (volatile) { const entries = ephemeral.get(context.userId) ?? []; entries.push(prepared.event); ephemeral.set(context.userId, entries); }
              else local.save(prepared);
              current(); return persisted();
            }
            if (backend === 'http') {
              const response = await http('memories', prepared.payload, signal, current);
              await step(() => response.arrayBuffer(), signal); current(); return persisted();
            }
            for (const [index, target] of prepared.targets.entries()) if (target.Data.Conversation.length)
              sdkReply(await sdk('CreateMemorySdk', target, signal, current, prepared.requestIds[index]), true);
            for (const target of prepared.targets) {
              if (!(await sdkQuery(target, args.content, 1, signal, current)).length) {
                let status = {};
                try { status = await sessionStatus(target, signal, current); } catch { current(); }
                return { status: 'ok', content: { ok: false, status: 'accepted_not_extracted',
                  message: '记忆保存请求已被后端受理，但尚未抽取成可检索记忆。', session_id: target.SessionId, ...status } };
              }
            }
            current(); return persisted();
          } });
        function authorityTrue() { authority(); return true; }
      })();
      active.add(pending); try { return await pending; } finally { active.delete(pending); }
    },
  });
}
