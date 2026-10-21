import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { canonical, invariant, parseNativeJson, requiresExactJsonWire, stringifyModelJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeWorkspaceTools } from '../../packages/agentkit-harness/src/native/workspace-tools.mjs';
import { projectNativeDshContent } from './native-input.mjs';
import { NATIVE_DSH_OUTPUT_SCHEMA, nativeDshBuiltinOutput, renderNativeDshBuiltinOutput } from './native-output.mjs';
import { createNativeDshBrowserTools } from './native-dsh-browser.mjs';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const names = values => (values ?? []).map(value => typeof value === 'string' ? value : value?.resourceId || value?.name || value?.id).filter(Boolean);

/** One preset's tools; only a Native ledger request can enter a Node builtin. */
export function createNativeDshTools({ ctx, config, workspaceRoot, stateDir, createBrowser, browserExecutablePath }) {
  invariant(typeof ctx.tools?.register === 'function' && typeof ctx.tools?.execute === 'function', 'studio_native_tools_unavailable');
  const argumentEncoding = ctx.tools.argumentEncodings?.includes('dsh.raw-json-number/v1') ? 'dsh.raw-json-number/v1' : null;
  const workspace = resolve(workspaceRoot), states = new WeakMap(), calls = new Map();
  const pinnedRoot = realpathSync(workspace), hasSkills = Boolean(config.skillDefinitions?.length);
  // DSH's complete pre/guard/around/post pipeline owns authorization. This
  // callback runs only inside an accepted registry invocation bound below.
  const state = agent => {
    invariant(agent?.session?.id, 'studio_native_tool_agent_missing');
    invariant(realpathSync(workspace) === pinnedRoot, 'workspace_root_changed');
    if (!states.has(agent)) states.set(agent, createNativeWorkspaceTools({ workspaceRoot: workspace,
      stateDir, sessionId: String(agent.session.id), authorize: async () => 'allow' }));
    return states.get(agent);
  };
  const template = createNativeWorkspaceTools({ workspaceRoot: workspace, stateDir: join(stateDir, 'definitions'), sessionId: 'definitions' });
  const formal = new Map(template.definitions.map(definition => [definition.name, definition]));
  const browserTools = createNativeDshBrowserTools({ workspaceRoot: workspace, createBrowser, browserExecutablePath,
    evidenceRoot: join(stateDir, 'browser-evidence') });
  const browserName = browserTools.definition.name;
  formal.set(browserName, browserTools.definition);
  const declared = config.toolContracts ?? [];
  const contracts = new Map(declared.filter(contract => contract.enabled !== false).map(contract => [contract.name, contract]));
  const boundNames = names(config.toolBindings).flatMap(ref => {
    const matching = declared.filter(contract => contract.name === ref || contract.resourceId === ref);
    return matching.length ? matching.filter(contract => contract.enabled !== false).map(contract => contract.name) : [ref];
  });
  const allowed = new Set([...boundNames, ...contracts.keys()]);
  const builtin = [...allowed].filter(name => contracts.get(name)?.executor === 'builtin'
    || formal.has(name) && contracts.get(name)?.executor !== 'mcp');
  const builtinNames = new Set(builtin);
  let closed = false, closing, disposers = [];
  const close = () => {
    if (closing) return closing;
    closed = true;
    const unregistering = disposers.map(dispose => {
      try { return Promise.resolve(dispose?.()); } catch (error) { return Promise.reject(error); }
    });
    disposers = [];
    return closing = Promise.allSettled([...unregistering, browserTools.close()]).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    });
  };
  const install = () => {
    disposers = builtin.map(name => {
      const definition = formal.get(name) ?? contracts.get(name);
      return ctx.tools.register({ name, description: definition.description, parameters: definition.parameters,
        output: { schema: NATIVE_DSH_OUTPUT_SCHEMA, render: renderNativeDshBuiltinOutput },
        execute: async (args, exec) => {
          const invocation = calls.get(String(exec.callId));
          invariant(!closed, 'studio_native_tools_closed');
          invariant(invocation && invocation.agent === exec.agent && invocation.request.call.name === name
            && canonical(invocation.argumentEncoding ? parseNativeJson(JSON.stringify(args)) : args)
              === canonical(invocation.request.call.arguments), 'studio_native_tool_authority_missing');
          exec.signal.throwIfAborted();
          invariant(!invocation.dispatched, 'studio_native_tool_already_dispatched');
          invocation.dispatched = true;
          let outcome;
          if (invocation.verificationDispatch) {
            const observation = await invocation.verificationDispatch(exec.signal);
            invocation.observation = structuredClone(observation);
            const content = { entry_path: args.path, status: observation.status, status_code: observation.statusCode,
              body_text_preview: Array.from(observation.text).slice(0, 2000).join(''),
              page_errors: observation.pageErrors, console: observation.console, request_failures: observation.networkFailures };
            outcome = { status: observation.status, content, context: { content: canonical(content),
              ...(observation.screenshot ? { media: [observation.screenshot.contentBlock] } : {}) } };
          } else outcome = name === browserName ? await browserTools.forSession(String(exec.agent.session.id)).execute({ ...invocation.request, signal: exec.signal })
            : formal.has(name) ? await state(exec.agent).execute({ ...invocation.request, signal: exec.signal })
            : { status: 'error', content: { code: 'STUDIO_NATIVE_BUILTIN_UNAVAILABLE', name } };
          invocation.outcome = structuredClone(outcome);
          return nativeDshBuiltinOutput(outcome, { signal: exec.signal, attachments: () => ctx.get?.('attachments') });
        },
      });
    });
    return close;
  };
  ctx.effect(install, 'agentkit-studio: Native builtin tool bindings');
  return {
    close,
    argumentEncoding,
    /** Trusted verifier only: every concrete cold action still runs the DSH permission pipeline. */
    async verifyBrowserPage(agent, request) {
      invariant(!closed && builtinNames.has(browserName), 'studio_native_browser_verification_unavailable');
      const sessionId = String(agent.session.id);
      invariant(request.sessionId === sessionId, 'studio_native_tool_not_bound');
      return browserTools.forSession(sessionId).verifyPage({ ...request, executeAction: async ({ entryPath, action }, dispatch) => {
        request.signal.throwIfAborted();
        invariant(['navigate', 'screenshot', 'click'].includes(action.kind), 'studio_native_browser_verification_action_unavailable');
        const arguments_ = { path: entryPath, wait_ms: 0, actions: action.kind === 'click'
          ? [{ type: 'click', selector: action.selector }] : [] };
        const callId = `ak-native-verify-${hash({ scope: request.scope, runId: request.runId,
          operationKey: request.operationKey, candidateId: request.candidateId, actionId: action.actionId })}`;
        invariant(!calls.has(callId), 'studio_native_tool_already_executing');
        const invocation = { agent, request: { ...request, call: { callId, name: browserName, arguments: arguments_ } }, verificationDispatch: dispatch };
        calls.set(callId, invocation);
        try {
          const result = await ctx.tools.execute({ callId, name: browserName, arguments: arguments_, signal: request.signal, agent });
          request.signal.throwIfAborted();
          invariant(result?.isError === false && !result.concludesTurn && invocation.dispatched && invocation.observation,
            'studio_native_browser_verification_policy_blocked');
          return invocation.observation;
        } finally { calls.delete(callId); }
      } });
    },
    definitions(agent, assemblyTools) {
      const schemas = new Map((assemblyTools ?? []).map(schema => [schema.name, schema]));
      const selected = new Set(allowed);
      if (hasSkills) {
        for (const name of ['skill', 'bash', 'pwsh']) if (schemas.has(name)) selected.add(name);
      }
      return [...selected].map(name => {
        const schema = schemas.get(name);
        invariant(schema, `studio_native_tool_schema_missing:${name}`);
        const exact = builtinNames.has(name) ? formal.get(name) : null;
        return exact ? structuredClone(exact) : {
          name, description: schema.description || '', parameters: structuredClone(schema.parameters),
          // Unknown external effects are serialized and never granted safe-read
          // recovery from a catalog hint. Actual permissions remain in DSH.
          readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 60_000,
          contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
        };
      });
    },
    forAgent(agent) {
      const sessionId = String(agent.session.id);
      return { workspace: { observe: request => state(agent).observe(request) },
        ...(builtinNames.has(browserName) ? { browser: { recoverSessions: request => browserTools.forSession(sessionId).recoverSessions(request) } } : {}),
        tools: { execute: async request => {
        invariant(!closed, 'studio_native_tools_closed');
        invariant(request.sessionId === sessionId && (allowed.has(request.call.name)
          || hasSkills && ['skill', 'bash', 'pwsh'].includes(request.call.name)),
        'studio_native_tool_not_bound');
        request.signal.throwIfAborted();
        const exactNumbers = requiresExactJsonWire(request.call.arguments);
        if (exactNumbers && !argumentEncoding) return { status: 'error', content: {
          code: 'STUDIO_NATIVE_EXACT_NUMBER_UNSUPPORTED', executed: false,
          message: 'The current DSH tool boundary cannot preserve this exact numeric value. The tool was not executed.',
        } };
        const callId = `ak-native-${hash({ scope: request.scope, runId: request.runId, operationKey: request.operationKey, callId: request.call.callId })}`;
        invariant(!calls.has(callId), 'studio_native_tool_already_executing');
        const invocation = { agent, request, argumentEncoding: exactNumbers ? argumentEncoding : null };
        calls.set(callId, invocation);
        try {
          // Numeric raw tokens retain their intrinsic brand through the negotiated
          // SDK snapshot. The Native request remains the owned builtin's source.
          const args = exactNumbers ? JSON.parse(stringifyModelJson(request.call.arguments), (_key, value, context) => {
            if (typeof value !== 'number' || Number.isFinite(value) && !requiresExactJsonWire(value)) return value;
            invariant(typeof context?.source === 'string', 'studio_native_raw_number_source_missing');
            return JSON.rawJSON(context.source);
          }) : structuredClone(request.call.arguments);
          const result = await ctx.tools.execute({ callId, name: request.call.name,
            arguments: args, ...(exactNumbers ? { argumentEncoding } : {}), signal: request.signal, agent });
          request.signal.throwIfAborted();
          invariant(typeof result?.isError === 'boolean' && Array.isArray(result.content), 'studio_native_tool_result_invalid');
          const afterWriteFailure = result?.isError && invocation.outcome?.status === 'ok' && !formal.get(request.call.name)?.readOnly;
          // Without an owned builtin receipt an external failure cannot prove
          // whether its effect ran. Never infer safe retry from isError alone.
          const externalFailure = result?.isError && !builtinNames.has(request.call.name);
          const status = invocation.outcome?.status === 'uncertain' || afterWriteFailure || externalFailure || result?.concludesTurn ? 'uncertain'
            : invocation.outcome?.status === 'error' || result?.isError ? 'error' : 'ok';
          const options = { signal: request.signal, attachments: () => ctx.get?.('attachments'),
            fileRequestText: async ref => {
              const llm = ctx.get?.('llm');
              invariant(typeof llm?.fileRequestText === 'function', 'STUDIO_FILE_ATTACHMENT_UNAVAILABLE');
              return llm.fileRequestText(ref);
            } };
          const context = await projectNativeDshContent(result.content, options), additionalContexts = [];
          for (const message of result.additionalContexts ?? []) {
            invariant(message?.role === 'user', 'studio_native_tool_context_invalid');
            const projected = await projectNativeDshContent(message.content, options);
            if (message.source) projected.presentation.source = message.source.kind === 'tool'
              ? { ...structuredClone(message.source), callId: request.call.callId } : structuredClone(message.source);
            additionalContexts.push(projected);
          }
          // Host facts (including browser interaction diagnostics) need their
          // original typed receipt. Model/display views still use the complete
          // post-policy DSH output above; native context cannot bypass it.
          const content = invocation.outcome ? structuredClone(invocation.outcome.content) : result?.additionalContexts?.length
            ? { content: result.content, additionalContexts: result.additionalContexts } : result.content;
          return { ...invocation.outcome, status, content,
          context, ...(additionalContexts.length ? { additionalContexts } : {}) };
        } finally { calls.delete(callId); }
      } } };
    },
  };
}
