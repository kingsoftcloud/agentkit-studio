import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { canonical, invariant, parseNativeJson, requiresExactJsonWire, stringifyModelJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeWorkspaceTools } from '../../packages/agentkit-harness/src/native/workspace-tools.mjs';
import { NATIVE_PYTHON_SYNTAX } from '../../packages/agentkit-harness/src/native/python-syntax.mjs';
import { createNativeLocalCommandTools, localCommandToolDefinitions, LOCAL_COMMAND_TOOLS_CONTRACT } from '../../packages/agentkit-harness/src/native/local-command-tools.mjs';
import { createOwnedCommandResolver } from '../../packages/agentkit-harness/src/native/owned-command.mjs';
import { createBackgroundCommandPort } from '../../packages/agentkit-harness/src/native/background-command-port.mjs';
import { createNativeArtifactStore } from '../../packages/agentkit-harness/src/native/artifact-store.mjs';
import { buildScriptEnvironment, localControlSettings, LOCAL_PROCESS_CONTRACT } from '../../packages/agentkit-harness/src/native/local-process.mjs';
import { LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY } from '../../packages/agentkit-harness/src/native/local-command-policy.mjs';
import { projectNativeDshContent } from './native-input.mjs';
import { NATIVE_DSH_OUTPUT_SCHEMA, nativeDshBuiltinOutput, renderNativeDshBuiltinOutput } from './native-output.mjs';
import { createNativeDshBrowserTools } from './native-dsh-browser.mjs';
import { nativeMcpOutcome } from './native-mcp-output.mjs';
import { NATIVE_MCP_JSON_CODEC } from './native-mcp-json.mjs';
import { bindNativeMcpSchema, NATIVE_MCP_SCHEMA_CONTRACT } from './native-mcp-schema.mjs';
import { authorizeNativeBuiltin, STUDIO_NATIVE_TOOL_PERMISSION_CONTRACT } from './native-tool-policy.mjs';
import { nativeChildToolDefinitions, NATIVE_CHILD_TOOLS_CONTRACT } from '../../packages/agentkit-harness/src/native/child-tools.mjs';
import { nativeChildReaderDefinitions } from '../../packages/agentkit-harness/src/native/child-readers.mjs';
import { nativeChildRoles } from './native-subagents.mjs';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const names = values => (values ?? []).map(value => typeof value === 'string' ? value : value?.resourceId || value?.name || value?.id).filter(Boolean);

/** One preset's tools; only a Native ledger request can enter a Node builtin. */
export function createNativeDshTools({ ctx, config, workspaceRoot, stateDir, createBrowser, browserExecutablePath, executeMcpTool,
  commandSettings = {}, commandEnvironment = process.env }) {
  invariant(typeof ctx.tools?.register === 'function' && typeof ctx.tools?.execute === 'function', 'studio_native_tools_unavailable');
  const argumentEncoding = ctx.tools.argumentEncodings?.includes('dsh.raw-json-number/v1') ? 'dsh.raw-json-number/v1' : null;
  const workspace = resolve(workspaceRoot), states = new WeakMap(), calls = new Map();
  const pinnedRoot = realpathSync(workspace), hasSkills = Boolean(config.skillDefinitions?.length);
  // DSH's complete pre/guard/around/post pipeline owns authorization. This
  // callback runs only inside an accepted registry invocation bound below.
  const state = (agent, sessionId = String(agent.session.id)) => {
    invariant(agent?.session?.id, 'studio_native_tool_agent_missing');
    invariant(realpathSync(workspace) === pinnedRoot, 'workspace_root_changed');
    if (!states.has(agent)) states.set(agent, new Map());
    const sessions = states.get(agent);
    if (!sessions.has(sessionId)) sessions.set(sessionId, createNativeWorkspaceTools({ workspaceRoot: workspace,
      stateDir, sessionId, authorize: async () => 'allow' }));
    return sessions.get(sessionId);
  };
  const template = createNativeWorkspaceTools({ workspaceRoot: workspace, stateDir: join(stateDir, 'definitions'), sessionId: 'definitions' });
  const formal = new Map(template.definitions.map(definition => [definition.name, definition]));
  const controls = localControlSettings(commandSettings), commandEnv = buildScriptEnvironment(commandEnvironment, { settings: controls });
  const commandNames = new Set(localCommandToolDefinitions(controls).map(definition => {
    formal.set(definition.name, definition); return definition.name;
  }));
  const browserTools = createNativeDshBrowserTools({ workspaceRoot: workspace, createBrowser, browserExecutablePath,
    evidenceRoot: join(stateDir, 'browser-evidence') });
  const browserName = browserTools.definition.name;
  formal.set(browserName, browserTools.definition);
  const childRoles = nativeChildRoles({ subAgents: config.subAgents ?? [] });
  const childNames = new Set(childRoles.length ? [...nativeChildToolDefinitions(childRoles.map(role => role.name),
    Math.max(120000, ...childRoles.map(role => role.timeoutSeconds * 1000 + 15000))),
    ...nativeChildReaderDefinitions()].map(definition => {
    formal.set(definition.name, definition); return definition.name;
  }) : []);
  const declared = structuredClone(config.toolContracts ?? []);
  const contracts = new Map(declared.filter(contract => contract.enabled !== false).map(contract => [contract.name, contract]));
  const boundNames = names(config.toolBindings).flatMap(ref => {
    const matching = declared.filter(contract => contract.name === ref || contract.resourceId === ref);
    return matching.length ? matching.filter(contract => contract.enabled !== false).map(contract => contract.name) : [ref];
  });
  const allowed = new Set([...boundNames, ...contracts.keys(), ...childNames]);
  invariant([...childNames].every(name => !contracts.has(name)), 'studio_native_child_tool_collision');
  const builtin = [...allowed].filter(name => contracts.get(name)?.executor === 'builtin'
    || formal.has(name) && contracts.get(name)?.executor !== 'mcp');
  const builtinNames = new Set(builtin);
  const mcpContracts = new Map([...contracts].filter(([name, contract]) => allowed.has(name) && contract.executor === 'mcp'
    && String(contract.mcpResourceId || contract.resourceId || '').trim()));
  invariant(!mcpContracts.size || typeof executeMcpTool === 'function', 'studio_native_mcp_executor_unavailable');
  const mcpSchemas = new Map([...mcpContracts].filter(([, contract]) => contract.nativeMcpSchema !== undefined)
    .map(([name, contract]) => [name, bindNativeMcpSchema(contract.nativeMcpSchema)]));
  const memoryNames = new Set();
  let memoryBinding = null;
  let closed = false, closing, disposers = [];
  const close = () => {
    if (closing) return closing;
    closed = true;
    const unregistering = disposers.map(dispose => {
      try { return Promise.resolve(dispose?.()); } catch (error) { return Promise.reject(error); }
    });
    disposers = [];
    // Dispose the bound Memory owner's own registrations; the provider lifetime
    // is released by the Host's releaseResources, not here.
    const memoryDispose = memoryBinding?._dispose;
    memoryBinding = null;
    const memoryUnregistering = memoryDispose ? [Promise.resolve(memoryDispose())] : [];
    return closing = Promise.allSettled([...unregistering, ...memoryUnregistering, browserTools.close()]).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    });
  };
  const install = () => {
    disposers = [...builtin, ...mcpContracts.keys()].map(name => {
      const definition = mcpContracts.has(name) ? mcpContracts.get(name) : formal.get(name) ?? contracts.get(name);
      return ctx.tools.register({ name, description: definition.description ?? '',
        parameters: structuredClone(mcpSchemas.get(name)?.registryParameters ?? definition.parameters ?? { type: 'object', properties: {} }),
        output: { schema: NATIVE_DSH_OUTPUT_SCHEMA, render: renderNativeDshBuiltinOutput },
        execute: async (args, exec) => {
          const invocation = calls.get(String(exec.callId));
          invariant(!closed, 'studio_native_tools_closed');
          invariant(invocation && invocation.agent === exec.agent && invocation.request.call.name === name
            && canonical(invocation.argumentEncoding ? parseNativeJson(JSON.stringify(args)) : args)
              === canonical(invocation.request.call.arguments), 'studio_native_tool_authority_missing');
          exec.signal.throwIfAborted();
          invariant(!invocation.dispatched, 'studio_native_tool_already_dispatched');
          if (formal.has(name) && !mcpContracts.has(name)) {
            try { await authorizeNativeBuiltin(ctx, exec, formal.get(name)); }
            catch (error) {
              invocation.outcome = { status: 'error', content: { code: error.code || 'STUDIO_NATIVE_PERMISSION_DENIED', executed: false } };
              throw error;
            }
          }
          exec.signal.throwIfAborted();
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
          } else if (mcpContracts.has(name)) {
            const contract = mcpContracts.get(name);
            outcome = nativeMcpOutcome(await executeMcpTool({ agentId: config.agentId,
              resourceId: String(contract.mcpResourceId || contract.resourceId).trim(), name,
              arguments: args, signal: exec.signal, callId: exec.callId, agent: exec.agent, resultFormat: 'mcp-result/v1' }),
              { validateOutput: mcpSchemas.get(name)?.validateOutput });
          } else if (childNames.has(name)) {
            invariant(typeof invocation.children?.execute === 'function', 'studio_native_child_ledger_unavailable');
            outcome = await invocation.children.execute({ ...invocation.request, signal: exec.signal });
          } else if (commandNames.has(name)) {
            invariant(typeof invocation.commands === 'function', 'studio_native_command_ledger_unavailable');
            outcome = await (await invocation.commands()).execute({ ...invocation.request, signal: exec.signal });
          } else outcome = name === browserName ? await browserTools.forSession(String(exec.agent.session.id)).execute({ ...invocation.request, signal: exec.signal })
            : formal.has(name) ? await invocation.workspaceTools.execute({ ...invocation.request, signal: exec.signal })
            : { status: 'error', content: { code: 'STUDIO_NATIVE_BUILTIN_UNAVAILABLE', name } };
          invocation.outcome = structuredClone(outcome);
          return nativeDshBuiltinOutput(mcpContracts.has(name) ? { ...outcome, content: outcome.context.content } : outcome,
            { signal: exec.signal, attachments: () => ctx.get?.('attachments') });
        },
      });
    });
    return close;
  };
  ctx.effect(install, 'agentkit-studio: Native builtin tool bindings');
  /** Trusted Memory binding entry. The parent composes the per-Build Memory
   * owner (definitions + provider + consent + planner) and binds it here so
   * the Memory tools enter the real DSH pre/guard/around/post pipeline. The
   * Host never executes Memory directly: every call still goes through
   * ``ctx.tools.execute``, the standing Node builtin policy runs, and the
   * Memory tool body owns its own exact-call consent. Returns a disposer the
   * caller runs from ``releaseResources``; it unregisters only the names this
   * binding registered (an older owner's disposer cannot delete a newer
   * owner's Memory tools) and leaves the provider lifetime to the caller's
   * ``close``. */
  const bindMemory = memoryHost => {
    invariant(!closed && memoryHost?.port && Array.isArray(memoryHost.port.definitions)
      && memoryHost.dispatchRef, 'studio_native_memory_binding_invalid');
    // Each binding owns its own names and registrations; a disposer only ever
    // removes what its binding added, so rebinding a new owner cannot let the
    // old owner's disposer delete the new owner's Memory tools.
    const ownedNames = [];
    let ownedDisposers = [];
    const dispose = () => {
      for (const name of ownedNames) { formal.delete(name); allowed.delete(name); builtinNames.delete(name); memoryNames.delete(name); }
      ownedNames.length = 0;
      for (const dispose of ownedDisposers) { try { dispose?.(); } catch { /* best-effort unregister */ } }
      ownedDisposers = [];
      if (memoryBinding === memoryHost) memoryBinding = null;
    };
    // Rebinding replaces a prior owner: dispose it first so its names are free
    // and its provider is released by the caller, before registering the new.
    if (memoryBinding) memoryBinding._dispose?.();
    for (const definition of memoryHost.port.definitions) {
      invariant(!formal.has(definition.name) && !contracts.has(definition.name) && !childNames.has(definition.name),
        'studio_native_memory_tool_collision');
      formal.set(definition.name, definition);
      allowed.add(definition.name);
      builtinNames.add(definition.name);
      memoryNames.add(definition.name);
      ownedNames.push(definition.name);
    }
    memoryBinding = memoryHost;
    memoryBinding._dispose = dispose;
    ownedDisposers = memoryHost.port.definitions.map(definition => ctx.tools.register({
      name: definition.name, description: definition.description ?? '',
      parameters: structuredClone(definition.parameters),
      output: { schema: NATIVE_DSH_OUTPUT_SCHEMA, render: renderNativeDshBuiltinOutput },
      execute: async (args, exec) => {
        const invocation = calls.get(String(exec.callId));
        invariant(!closed, 'studio_native_tools_closed');
        invariant(invocation && invocation.agent === exec.agent && invocation.request.call.name === definition.name
          && canonical(invocation.argumentEncoding ? parseNativeJson(JSON.stringify(args)) : args)
            === canonical(invocation.request.call.arguments), 'studio_native_tool_authority_missing');
        exec.signal.throwIfAborted();
        invariant(!invocation.dispatched, 'studio_native_tool_already_dispatched');
        // The complete DSH pre/guard/around/post pipeline already authorized
        // this call. Enforce the standing Node builtin policy (memory:write is
        // not a workspace write; the Memory tool's own consent runs below).
        try { await authorizeNativeBuiltin(ctx, exec, formal.get(definition.name)); }
        catch (error) {
          invocation.outcome = { status: 'error', content: { code: error.code || 'STUDIO_NATIVE_PERMISSION_DENIED', executed: false } };
          throw error;
        }
        exec.signal.throwIfAborted();
        invocation.dispatched = true;
        // Per-call dispatch context: read-only Memory tools (read_memory /
        // search_memory) are concurrentSafe and may run in parallel, so the
        // consent and token planner must observe THIS call's agent/signal, not
        // a shared mutable ref overwritten by a sibling call. Save and restore
        // so a parallel call cannot leave a stale agent/signal for the next.
        const priorAgent = memoryHost.dispatchRef.agent, priorSignal = memoryHost.dispatchRef.signal;
        memoryHost.dispatchRef.agent = exec.agent;
        memoryHost.dispatchRef.signal = exec.signal;
        try {
          const outcome = await memoryHost.port.execute({ ...invocation.request, signal: exec.signal });
          invocation.outcome = structuredClone(outcome);
          return nativeDshBuiltinOutput(outcome, { signal: exec.signal, attachments: () => ctx.get?.('attachments') });
        } finally {
          memoryHost.dispatchRef.agent = priorAgent;
          memoryHost.dispatchRef.signal = priorSignal;
        }
      } }));
    return dispose;
  };
  return {
    close,
    bindMemory,
    argumentEncoding,
    permissionContract: STUDIO_NATIVE_TOOL_PERMISSION_CONTRACT,
    childBinding: childRoles.length ? { contract: NATIVE_CHILD_TOOLS_CONTRACT, roles: structuredClone(childRoles) } : null,
    childCapabilities: { skills: hasSkills, mcp: mcpContracts.size > 0 },
    workspaceSyntax: builtinNames.has('lint_workspace_file') ? NATIVE_PYTHON_SYNTAX : null,
    commandBinding: [...commandNames].some(name => builtinNames.has(name)) ? {
      contract: LOCAL_COMMAND_TOOLS_CONTRACT, controls: { contract: LOCAL_PROCESS_CONTRACT, settings: controls },
      risk: [LOCAL_COMMAND_POLICY, GOVERNED_COMMAND_POLICY], backend: 'local_process', environmentDigest: hash(commandEnv),
    } : null,
    mcpResultContract: mcpContracts.size ? 'mcp-result/v1' : null,
    mcpJsonCodec: mcpContracts.size ? NATIVE_MCP_JSON_CODEC : null,
    mcpSchemaContract: mcpSchemas.size ? NATIVE_MCP_SCHEMA_CONTRACT : null,
    mcpBindingDigest: mcpContracts.size ? hash([...mcpContracts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, contract]) => ({
      name, resourceId: String(contract.mcpResourceId || contract.resourceId).trim(),
      schema: contract.nativeMcpSchema ?? { parameters: contract.parameters ?? { type: 'object', properties: {} } },
    }))) : null,
    releaseSession: request => browserTools.releaseSession(request),
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
        // A locked builtin (workspace, browser, Memory) pins its own formal
        // definition; it does not borrow a schema from the prompt assembly.
        // Memory tools are registered for the Build during turn binding, after
        // the assembly is built, so they may be absent from ``assemblyTools``.
        const exact = builtinNames.has(name) ? formal.get(name) : null;
        if (exact) return structuredClone(exact);
        const schema = schemas.get(name);
        invariant(schema, `studio_native_tool_schema_missing:${name}`);
        const mcpSchema = mcpSchemas.get(name);
        if (mcpSchema) invariant(canonical(schema.parameters) === canonical(mcpSchema.registryParameters), 'studio_native_mcp_schema_binding_changed');
        return {
          name, description: schema.description || '', parameters: structuredClone(mcpSchema?.input ?? schema.parameters),
          // Unknown external effects are serialized and never granted safe-read
          // recovery from a catalog hint. Actual permissions remain in DSH.
          readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 60_000,
          contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
        };
      });
    },
    forChild(agent, authority) {
      invariant(authority?.scope && authority.store && typeof authority.sessionId === 'string' && authority.sessionId,
        'studio_native_child_tool_binding_missing');
      invariant(Array.isArray(authority.toolNames) && authority.toolNames.every(name => allowed.has(name)
        && formal.get(name)?.readOnly === true && !mcpContracts.has(name) && !memoryNames.has(name)),
        'studio_native_child_tools_not_bound');
      const bound = this.forAgent(agent, { ...authority, childSessionId: authority.sessionId });
      return { tools: bound.tools, workspace: bound.workspace };
    },
    forAgent(agent, commandAuthority) {
      const sessionId = commandAuthority?.childSessionId ?? String(agent.session.id);
      const workspaceTools = state(agent, sessionId);
      let commandsPromise;
      const commands = () => commandsPromise ||= (async () => {
        invariant(commandAuthority?.scope && commandAuthority?.store, 'studio_native_command_ledger_unavailable');
        const artifacts = await createNativeArtifactStore({ directory: join(stateDir, 'command-artifacts'), scope: commandAuthority.scope });
        return createNativeLocalCommandTools({ workspaceRoot: workspace, stateRoot: join(stateDir, 'background-commands'), sessionId,
          settings: controls, sourceEnv: commandEnv, artifacts, authorize: async () => 'allow',
          captureWorkspace: request => state(agent).capture(request),
          resolveOwnedCommand: createOwnedCommandResolver(commandAuthority) });
      })();
      return { workspace: { observe: request => workspaceTools.observe(request) },
        ...(commandAuthority?.children ? { children: commandAuthority.children.owner } : {}),
        ...(commandAuthority && [...commandNames].some(name => builtinNames.has(name)) ? {
          background: createBackgroundCommandPort({ ...commandAuthority,
            readers: { local_process: async request => (await commands()).reader(request) } }),
        } : {}),
        ...(builtinNames.has(browserName) ? { browser: { recoverSessions: request => browserTools.forSession(sessionId).recoverSessions(request) } } : {}),
        tools: { execute: async request => {
        invariant(!closed, 'studio_native_tools_closed');
        invariant(request.sessionId === sessionId && (allowed.has(request.call.name)
          || hasSkills && ['skill', 'bash', 'pwsh'].includes(request.call.name)),
        'studio_native_tool_not_bound');
        if (commandAuthority?.childSessionId) invariant(canonical(request.scope) === canonical(commandAuthority.scope)
          && commandAuthority.toolNames.includes(request.call.name), 'studio_native_child_tool_not_bound');
        request.signal.throwIfAborted();
        const exactNumbers = requiresExactJsonWire(request.call.arguments);
        if (exactNumbers && !argumentEncoding) return { status: 'error', content: {
          code: 'STUDIO_NATIVE_EXACT_NUMBER_UNSUPPORTED', executed: false,
          message: 'The current DSH tool boundary cannot preserve this exact numeric value. The tool was not executed.',
        } };
        const callId = `ak-native-${hash({ scope: request.scope, runId: request.runId, operationKey: request.operationKey, callId: request.call.callId })}`;
        invariant(!calls.has(callId), 'studio_native_tool_already_executing');
        const invocation = { agent, request, workspaceTools, children: commandAuthority?.children,
          argumentEncoding: exactNumbers ? argumentEncoding : null, commands };
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
          const readOnlyBuiltin = builtinNames.has(request.call.name) && formal.get(request.call.name)?.readOnly;
          const afterWriteFailure = result?.isError && invocation.outcome?.status === 'ok' && !readOnlyBuiltin;
          // Without an owned builtin receipt an external failure cannot prove
          // whether its effect ran. Never infer safe retry from isError alone.
          const externalFailure = result?.isError && !builtinNames.has(request.call.name) && !invocation.outcome
            && (!mcpContracts.has(request.call.name) || invocation.dispatched);
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
