import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonical, invariant, parseNativeJson, TOOL_RECEIPT_OBSERVATION_CONTRACT } from '@kingsoftcloud/agentkit-harness-core';
import { codexToolBindings, prepareLocalResourceContext } from '../../local-runtime.mjs';
import { nativeAgentPolicyDecision, nativeAgentPolicyFromSpec } from '../../native-agent-policy.mjs';
import { engineHostTools, nativeHostToolCallId } from '../../providers/native-engine-runtime.mjs';
import { MANAGED_SESSION_DELIVERY_LIMIT } from './native-managed-session-delivery.mjs';

const PATH = '/_agentkit/managed-host/v1';
const CONTRACT = 'agentkit.managed-host-resources/v1';
const LIMIT = 2 * 1024 ** 2;
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const buildMatches = (binding, revision) => binding.agentRevision === revision.agentRevision
  && (binding.buildId ?? null) === (revision.buildId ?? null);

/** Serve the resources of the exact persisted Session/Build admitted by the
 * independent engine. The ticket carries identity, not resource credentials. */
export function registerStudioManagedHostResources(ctx, { scope, token, resolveBinding, resourceAdapters, sessionDelivery, createA2aPort } = {}) {
  invariant(object(scope) && Object.keys(scope).sort().join(',') === 'agentId,tenantId,userId,workspaceId'
    && Object.values(scope).every(text) && typeof token === 'string' && token.length >= 32
    && typeof resolveBinding === 'function' && resourceAdapters, 'MANAGED_HOST_RESOURCE_CONFIG_INVALID');
  scope = Object.freeze({ ...scope });
  const scopeBytes = canonical(scope), lifetime = new AbortController(), a2aPorts = new Map();
  const sign = value => createHmac('sha256', token).update(value).digest('base64url');
  const seal = claims => {
    const encoded = Buffer.from(canonical(claims)).toString('base64url');
    return encoded + '.' + sign(encoded);
  };
  const open = ref => {
    invariant(typeof ref === 'string' && ref.length <= 8192 && /^[\w-]+\.[\w-]+$/.test(ref), 'MANAGED_HOST_BINDING_INVALID');
    const [encoded, proof] = ref.split('.');
    invariant(equal(sign(encoded), proof), 'MANAGED_HOST_BINDING_INVALID');
    return parseNativeJson(Buffer.from(encoded, 'base64url').toString('utf8'));
  };
  ctx.effect(() => async () => {
    lifetime.abort();
    const closing = [...a2aPorts.values()].map(({ port }) => port.close());
    a2aPorts.clear();
    await Promise.allSettled(closing);
  }, 'agentkit-studio: managed Harness resource callbacks');
  ctx.inject(['webServer'], webCtx => {
    const release = webCtx.webServer.register({ kind: 'prefix', path: PATH, handler });
    webCtx.effect(() => release, 'agentkit-studio: managed Harness resource transport');
  });

  async function bindingFor(sessionId, signal, allowAbsent = false) {
    signal.throwIfAborted();
    const binding = await resolveBinding(sessionId);
    signal.throwIfAborted();
    if (allowAbsent && binding == null) return null;
    invariant(binding?.agent?.session?.id === sessionId && binding?.record?.metadata?.id === scope.agentId
      && Number.isSafeInteger(binding.agentRevision) && binding.agentRevision > 0,
    'MANAGED_HOST_SESSION_UNAVAILABLE');
    return binding;
  }

  function a2aPort(binding) {
    const bindings = binding.record.spec?.bindings?.a2a;
    if (!createA2aPort || !Array.isArray(bindings) || !bindings.length) return null;
    const key = canonical([binding.agentRevision, binding.buildId ?? null, binding.scopedPresetId ?? null, bindings]);
    if (!a2aPorts.has(key)) {
      const port = createA2aPort({ agentId: scope.agentId, agentRevision: binding.agentRevision,
        buildId: binding.buildId ?? null, scopedPresetId: binding.scopedPresetId, bindings, signal: lifetime.signal,
        assertManagedAuthority: exec => exec.assertManagedAuthority() });
      a2aPorts.set(key, { port, controls: { a2aTaskHistory: port.taskHistory, controlA2aTask: port.controlTask } });
    }
    return a2aPorts.get(key);
  }

  async function catalog(binding, toolCatalog, { skills, a2a = false, signal }) {
    invariant(object(toolCatalog) && Array.isArray(toolCatalog.reserved) && toolCatalog.reserved.length <= 512
      && toolCatalog.reserved.every(text) && toolCatalog.pattern === '^[A-Za-z][A-Za-z0-9_-]{0,63}$',
    'MANAGED_HOST_TOOL_CATALOG_INVALID');
    const { record, agent } = binding;
    const bindings = record.spec?.bindings || record.bindings || {};
    const selected = { mcpServers: bindings.mcpServers, ...(skills ? {
      skills: bindings.skills, plugins: bindings.plugins?.filter(item => item?.config?.binding?.resource?.kind === 'skill-space'),
    } : {}) };
    const adapter = await resourceAdapters;
    signal.throwIfAborted();
    const prepared = await prepareLocalResourceContext({
      record: { ...record, spec: { ...record.spec, bindings: selected } }, agent, agentId: scope.agentId,
      userId: scope.userId, resourceAdapter: adapter,
    });
    signal.throwIfAborted();
    const policy = nativeAgentPolicyFromSpec(record.spec);
    const port = a2a ? a2aPort(binding)?.port : null;
    const a2aTools = port?.definitions.map(tool => ({ ...tool, _source: 'a2a', _resourceId: port.binding.digest })) ?? [];
    const pairs = codexToolBindings([...a2aTools, ...prepared.tools.filter(tool => tool._source === 'mcp')])
      .filter(({ tool }) => nativeAgentPolicyDecision(policy, tool.name, tool._source === 'a2a' && tool.readOnly === true) !== 'deny');
    const wire = engineHostTools(pairs.map(({ spec, tool }) => tool._source === 'a2a' ? { ...spec, timeoutMs: tool.timeoutMs,
      ...(tool.name === 'call_a2a_agent' && toolCatalog.receiptObservation === TOOL_RECEIPT_OBSERVATION_CONTRACT
        ? { receiptObservation: true } : {}),
      readOnly: tool.readOnly && nativeAgentPolicyDecision(policy, tool.name, true) !== 'ask' } : spec), toolCatalog);
    const tools = wire.tools;
    const routes = new Map(pairs.map(pair => [pair.name, pair.tool]));
    const identity = tools.map(tool => {
      const route = routes.get(wire.originalName(tool.name));
      return { definition: tool, name: route.name, resource: route._resourceId };
    });
    return { adapter, policy, tools, routes, wire, port, digest: digest(canonical(identity)), context: prepared.resourceContext };
  }

  async function admit(body, signal) {
    const { sessionId, runId, toolCatalog } = body;
    const binding = await bindingFor(sessionId, signal);
    const resources = await catalog(binding, toolCatalog, { skills: true, a2a: true, signal });
    invariant(buildMatches(await bindingFor(sessionId, signal), binding), 'MANAGED_HOST_BUILD_CHANGED');
    const receiptTool = resources.tools.find(tool => tool.receiptObservation === true);
    const ref = seal({ sessionId, runId, agentRevision: binding.agentRevision, buildId: binding.buildId ?? null,
      catalog: resources.digest, toolCatalog, ...(resources.port ? { a2a: true } : {}),
      ...(receiptTool ? { a2aReceipt: { name: receiptTool.name, binding: resources.port.binding.digest } } : {}) });
    invariant(ref.length <= 8192, 'MANAGED_HOST_BINDING_INVALID');
    const hostInstructions = [binding.record.spec?.instructions?.system, binding.record.spec?.instructions?.task,
      resources.context].filter(Boolean).join('\n\n');
    return { ref, hostInstructions, hostTools: resources.tools, ...(sessionDelivery ? { sessionDelivery: true } : {}) };
  }

  async function receipt(body, signal) {
    const { sessionId, runId, callId, name, arguments: args, originalOperationKey, observationId } = body;
    const claims = open(body.ref);
    invariant(claims.sessionId === sessionId && claims.runId === runId && claims.a2aReceipt?.name === name
      && text(callId) && text(originalOperationKey) && object(args)
      && (observationId === undefined || text(observationId)), 'MANAGED_HOST_RECEIPT_INVALID');
    const binding = await bindingFor(sessionId, signal), session = binding.agent.session;
    invariant(buildMatches(binding, claims), 'MANAGED_HOST_BUILD_CHANGED');
    const port = a2aPort(binding)?.port;
    invariant(port && port.binding.digest === claims.a2aReceipt.binding, 'MANAGED_HOST_RECEIPT_INVALID');
    return port.observeOwnedReceipt({ sessionId, callId: nativeHostToolCallId(runId, originalOperationKey), args, signal,
      observationId, assertCurrent: () => binding.agent.session === session
        && session.id === sessionId });
  }

  async function call(body, signal) {
    const { sessionId, runId, callId, name, arguments: args, effect } = body;
    const claims = open(body.ref);
    invariant(claims.sessionId === sessionId && claims.runId === runId && text(callId) && text(name) && object(args)
      && (effect === undefined || object(effect) && text(effect.operationKey)
        && typeof effect.approved === 'boolean' && typeof effect.canRequestApproval === 'boolean'), 'MANAGED_HOST_TOOL_INVALID');
    const binding = await bindingFor(sessionId, signal);
    if (!buildMatches(binding, claims)) return { status: 'error', content: { code: 'managed_host_build_changed', executed: false } };
    const resources = await catalog(binding, claims.toolCatalog, { a2a: claims.a2a === true, signal });
    if (resources.digest !== claims.catalog)
      return { status: 'error', content: { code: 'managed_host_tool_catalog_changed', executed: false } };
    const definition = resources.tools.find(tool => tool.name === name);
    const route = definition && resources.routes.get(resources.wire.originalName(name));
    invariant(route && (definition.readOnly === true || effect), 'MANAGED_HOST_TOOL_INVALID');
    const current = await bindingFor(sessionId, signal);
    if (!buildMatches(current, claims)) return { status: 'error', content: { code: 'managed_host_build_changed', executed: false } };
    const readOnly = route._source === 'a2a' && route.readOnly === true;
    const policy = nativeAgentPolicyDecision(resources.policy, route.name, readOnly);
    const session = current.agent.session;
    const needsApproval = () => policy === 'ask' || !readOnly
      && !['workspace-write', 'danger-full-access'].includes(current.permissionMode?.());
    if (policy === 'deny' || !effect?.approved && !effect?.canRequestApproval && needsApproval())
      return { status: 'error', content: { code: 'policy_denied', executed: false } };
    if (!effect?.approved && needsApproval()) return { status: 'approval_required' };
    if (route._source === 'a2a') {
      return resources.port.execute(route.name, args, { name: route.name, arguments: args,
        agent: current.agent, callId: nativeHostToolCallId(runId, effect?.operationKey ?? callId), signal,
        assertManagedAuthority() {
          signal.throwIfAborted();
          invariant(current.agent.session === session && session.id === sessionId && (effect?.approved || !needsApproval()),
            'MANAGED_HOST_TOOL_AUTHORITY_CHANGED');
        } });
    }
    try {
      signal.throwIfAborted();
      const content = await resources.adapter.callMcpTool(route._resourceId, route.name, args, { signal });
      return { status: 'ok', content: content ?? null };
    } catch {
      return { status: 'uncertain', content: { code: 'managed_host_mcp_outcome_unknown' } };
    }
  }

  async function deliver(action, body, signal) {
    const claims = open(body.ref);
    invariant(claims.sessionId === body.sessionId && claims.runId === body.runId, 'MANAGED_HOST_BINDING_INVALID');
    const binding = await bindingFor(body.sessionId, signal);
    return sessionDelivery[action](binding.agent, body, signal);
  }

  async function handler(request, response) {
    const disconnected = new AbortController();
    const closed = () => disconnected.abort();
    const signal = AbortSignal.any([lifetime.signal, disconnected.signal]);
    const abort = () => response.destroy();
    response.once('close', closed);
    lifetime.signal.addEventListener('abort', abort, { once: true });
    const json = (status, value) => {
      const body = canonical({ contract: CONTRACT, ...value });
      invariant(Buffer.byteLength(body) <= LIMIT, 'MANAGED_HOST_RESPONSE_TOO_LARGE');
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
    };
    try {
      signal.throwIfAborted();
      if (!equal(request.headers.authorization ?? '', 'Bearer ' + token)) return json(401, { error: 'unauthorized' });
      const paths = sessionDelivery ? ['admit', 'tool', 'receipt', 'claim', 'finish'] : ['admit', 'tool', 'receipt'];
      const action = request.url?.slice(PATH.length + 1);
      if (request.method !== 'POST' || !paths.includes(action) || request.url !== PATH + '/' + action)
        return json(404, { error: 'unsupported' });
      const limit = action === 'finish' || action === 'claim' ? MANAGED_SESSION_DELIVERY_LIMIT : LIMIT;
      const chunks = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > limit) {
          response.setHeader('connection', 'close');
          return json(400, { error: 'request_too_large' });
        }
        chunks.push(chunk);
      }
      const body = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      invariant(body?.contract === CONTRACT && canonical(body.scope) === scopeBytes
        && text(body.sessionId) && text(body.runId), 'MANAGED_HOST_SCOPE_INVALID');
      const result = await (action === 'admit' ? admit(body, signal)
        : action === 'tool' ? call(body, signal) : action === 'receipt' ? receipt(body, signal) : deliver(action, body, signal));
      signal.throwIfAborted();
      json(200, result);
    } catch {
      if (!signal.aborted && !response.headersSent) json(503, { error: 'managed_host_request_unavailable' });
      else if (!response.destroyed) response.destroy();
    } finally {
      response.off('close', closed);
      lifetime.signal.removeEventListener('abort', abort);
    }
  }

  return { async resolveA2aBinding(sessionId, signal) {
    const binding = await bindingFor(sessionId, signal, true);
    const tools = binding && a2aPort(binding)?.controls;
    if (!tools) return null;
    return { contract: 'agentkit.studio-dsh-a2a-binding/v1', agentId: scope.agentId,
      runtime: 'native-engine', local: true, agentRevision: binding.agentRevision, buildId: binding.buildId ?? null, tools };
  } };
}
