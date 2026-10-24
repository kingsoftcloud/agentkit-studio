/** Model-facing knowledge lookup. Independent of Native and DSH lifecycles. */
import { copy, invariant, toolInputRejection } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createAicpResourceConnection } from './aicp-resource-connection.mjs';

export const STUDIO_KNOWLEDGE_TOOLS = 'agentkit.studio-knowledge-tools/v1';
export const STUDIO_KNOWLEDGE_BINDINGS = 'agentkit.studio-knowledge-bindings/v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Public, immutable admission data; credentials stay in the Host closure. */
export function knowledgeBindings(spec = {}) {
  const datasetIds = (spec.bindings?.plugins ?? []).filter(plugin => plugin.enabled !== false)
    .map(plugin => plugin.config?.binding?.resource).filter(resource => resource?.kind === 'knowledge-base')
    .map(resource => resource.id || resource.resourceId);
  invariant(datasetIds.every(id => typeof id === 'string' && id.trim() && id.length <= 8192), 'knowledge_binding_invalid');
  return { contract: STUDIO_KNOWLEDGE_BINDINGS, datasetIds: [...new Set(datasetIds)] };
}

export function knowledgeToolDefinitions() {
  return [{ name: 'search_knowledge_base', description: 'Search this Agent\'s bound knowledge base and return actual excerpts, document sources and answers.',
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string', minLength: 1 }, top_k: { type: 'integer', minimum: 1 } } },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 120000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' }];
}

/** Snapshot the real Node control-plane transport at Host activation. */
export const createKnowledgeConnection = options => createAicpResourceConnection({ ...options,
  prefix: 'KSADK_KB', contract: STUDIO_KNOWLEDGE_TOOLS });

function step(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
    if (signal.aborted) abort();
  });
}

function knowledgeRecords(reply) {
  let data = reply?.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { invariant(false, 'knowledge_response_invalid'); } }
  invariant(object(data) && (!('Code' in data) || [0, 200, '0', '200'].includes(data.Code))
    && !data.Error && (data.ResponseMetadata === undefined || object(data.ResponseMetadata) && !data.ResponseMetadata.Error)
    && Array.isArray(data.Records), 'knowledge_response_invalid');
  return data.Records.map(record => {
    const segment = record?.Segment, document = segment?.Document;
    invariant(object(record) && object(segment) && (document === undefined || object(document))
      && (segment.Content === undefined || typeof segment.Content === 'string')
      && (segment.Answer === undefined || typeof segment.Answer === 'string')
      && (document?.Name === undefined || typeof document.Name === 'string'), 'knowledge_response_invalid');
    return { content: segment.Content ?? '', answer: segment.Answer ?? '', documentName: document?.Name ?? '' };
  });
}

export function createStudioKnowledgeTools({ agentId, bindings = knowledgeBindings(), connection, env = {} }) {
  invariant(typeof agentId === 'string' && agentId.trim() && bindings?.contract === STUDIO_KNOWLEDGE_BINDINGS
    && Object.keys(bindings).every(key => ['contract', 'datasetIds'].includes(key)) && Array.isArray(bindings.datasetIds)
    && bindings.datasetIds.length <= 100 && bindings.datasetIds.every(id => typeof id === 'string' && id.trim() && id.length <= 8192)
    && typeof connection?.client?.action === 'function' && /^[a-f0-9]{64}$/.test(connection.bindingDigest), 'knowledge_tools_binding_invalid');
  const datasetIds = [...new Set(bindings.datasetIds.length ? bindings.datasetIds : [String(env.KSADK_KB_DATASET_ID ?? '').trim()].filter(Boolean))];
  const topK = Number(env.KSADK_KB_TOP_K ?? 5), searchMethod = String(env.KSADK_KB_SEARCH_METHOD ?? 'intelligence_search');
  const score = String(env.KSADK_KB_SCORE_THRESHOLD ?? ''), reranking = /^(true|1|yes)$/i.test(String(env.KSADK_KB_RERANKING_ENABLE ?? 'false'));
  invariant(Number.isSafeInteger(topK) && topK > 0 && searchMethod.length > 0 && (!score || Number.isFinite(Number(score))), 'knowledge_settings_invalid');
  const retrieval = { SearchMethod: searchMethod, TopK: topK, RerankingEnable: reranking,
    ...(score ? { ScoreThresholdEnabled: true, ScoreThreshold: Number(score) } : {}) };
  const binding = { contract: STUDIO_KNOWLEDGE_TOOLS, agentId, datasetIds, retrieval, connectionDigest: connection.bindingDigest };
  const definition = knowledgeToolDefinitions()[0];
  const action = connection.client.action.bind(connection.client);
  const lifetime = new AbortController(), active = new Set(); let closing;
  return Object.freeze({ contract: STUDIO_KNOWLEDGE_TOOLS, get binding() { return copy(binding); },
    get definitions() { return knowledgeToolDefinitions(); },
    close() { if (!closing) { lifetime.abort(); closing = Promise.allSettled([...active]).then(() => {}); } return closing; },
    async execute(name, args, { signal: callerSignal, assertCurrent }) {
      invariant(callerSignal instanceof AbortSignal && typeof assertCurrent === 'function', 'knowledge_execution_unbound');
      const signal = AbortSignal.any([callerSignal, lifetime.signal, AbortSignal.timeout(definition.timeoutMs)]);
      const pending = (async () => {
      const authority = () => { signal.throwIfAborted(); const current = assertCurrent();
        if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
        invariant(current === true, 'knowledge_authority_lost'); signal.throwIfAborted(); };
      authority(); invariant(name === definition.name, 'knowledge_tool_unknown');
      const invalid = toolInputRejection(definition, { name, callId: 'knowledge-validation', arguments: args });
      if (invalid) return { status: 'error', content: invalid };
      if (!args.query.trim()) return { status: 'error', content: { ok: false, error_type: 'knowledge_query_empty', executed: false } };
      if (!datasetIds.length) return { status: 'error', content: { ok: false, error_type: 'knowledge_not_configured', executed: false } };
      const query = args.query, model = { ...retrieval, ...(args.top_k === undefined ? {} : { TopK: args.top_k }) };
      const records = [];
      for (const datasetId of datasetIds) {
        authority();
        let reply;
        try {
          reply = await step(() => { authority(); return action('RetrieveKnowledge',
            { DatasetId: datasetId, Query: query, RetrievalModel: copy(model) }, { apiVersion: '2025-11-14', signal }); }, signal);
          authority(); records.push(...knowledgeRecords(reply));
        } catch (error) {
          authority();
          // Never turn malformed/failed responses into a successful empty
          // search or echo transport errors which might contain credentials.
          return { status: 'error', content: { ok: false, error_type: error?.code === 'knowledge_response_invalid'
            ? 'knowledge_response_invalid' : 'knowledge_search_failed' } };
        }
      }
      authority();
      return { status: 'ok', content: records.length ? records.map((record, index) => `[${index + 1}] ${record.documentName
        ? `(来源: ${record.documentName}) ` : ''}${record.content}${record.answer ? `\n    答案: ${record.answer}` : ''}`).join('\n\n') : '未找到相关知识库内容。' };
      })();
      active.add(pending); try { return await pending; } finally { active.delete(pending); }
    },
  });
}
