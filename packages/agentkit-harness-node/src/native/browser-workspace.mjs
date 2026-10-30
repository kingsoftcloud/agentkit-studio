/** Studio's run-owned browser capability. Backend and authorization are Host supplied. */
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, scopeKey, matchesToolExecutionContract } from '@kingsoftcloud/agentkit-harness-core';
import { validateBrowserAction, validateBrowserObservation, validateBrowserRecovery, validateBrowserSessionRef,
  browserObservationDigest } from '@kingsoftcloud/agentkit-harness-core/browser-contract';
import { createBrowserWorkspaceServer, resolveBrowserWorkspaceEntry } from './browser-workspace-server.mjs';
import { parseWorkspaceBrowserInput, studioBrowserDefinition } from './browser-workspace-protocol.mjs';
import { publishWorkspaceBytes, realpathExisting } from './workspace-paths.mjs';
import { admitBrowserActionObservation } from './browser-action-observation.mjs';
import { WORKSPACE_BROWSER_BOUNDARY, workspaceBrowserCapability } from './browser-workspace-policy.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const same = (left, right) => canonical(left) === canonical(right);
const within = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const pointerWarning = 'The root document of this element is not valid for pointer lock.';
const warning = value => [pointerWarning, `error: ${pointerWarning}`].includes(value.trim());
const safeInput = new Set(['workspace_path_invalid', 'workspace_path_outside_scope', 'browser_entry_not_found',
  'screenshot_path_invalid', 'browser_actions_invalid', 'browser_action_invalid', 'browser_input_invalid',
  'browser_wait_invalid', 'browser_action_time_budget_exceeded', 'browser_served_file_limit_exceeded']);

function screenshotTarget(root, value) {
  const target = realpathExisting(resolve(root, value));
  if (!within(root, target) || extname(target).toLowerCase() !== '.png') fail('screenshot_path_invalid');
  return target;
}
function launchLabel(value) {
  let label = value.trim();
  for (let count = 0; count < 4 && /^[\p{P}\p{S}]/u.test(label); count++) label = [...label].slice(1).join('').trimStart();
  label = label.replace(/\s+/gu, ' ').toLowerCase();
  return ['start', 'start game', 'new game', 'play', '开始'].includes(label)
    || /^(?:新(?:的|建)?|开始(?:新(?:的|建)?)?|进入)(?:游戏|世界)$/u.test(label)
    || /^进入(?!设置|帮助|选项|商店|社区|账号|登录|房间|服务器)[\u4e00-\u9fff]{1,10}(?:\s*[▶→])?$/u.test(label);
}

export async function createStudioBrowserWorkspacePort({ scope: rawScope, root, runtimeId, createBrowser,
  reobserveAfterLoss = false, evidenceRoot, serverFactory = createBrowserWorkspaceServer,
  toolTimeoutMs = 110000,
  sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  scopeKey(rawScope);
  if (!Number.isSafeInteger(toolTimeoutMs) || toolTimeoutMs < 110000) fail('browser_owner_timeout_invalid');
  const definition = { ...studioBrowserDefinition(), timeoutMs: toolTimeoutMs };
  if (typeof reobserveAfterLoss !== 'boolean' || typeof createBrowser !== 'function'
    || typeof runtimeId !== 'string' || !runtimeId.trim() || !isAbsolute(root ?? '')) fail('browser_owner_configuration_invalid');
  const scope = structuredClone(rawScope), workspace = realpathSync(root), workspaceRevision = hash(workspace);
  let evidence;
  if (evidenceRoot !== undefined) {
    if (typeof evidenceRoot !== 'string' || !isAbsolute(evidenceRoot)) fail('browser_verification_evidence_unavailable');
    evidence = realpathExisting(evidenceRoot);
    if (within(workspace, evidence)) fail('browser_verification_evidence_must_be_outside_workspace');
    mkdirSync(evidence, { recursive: true }); evidence = realpathSync(evidence);
  }
  const pages = new Map(), lost = new Map(), locks = new Map(), targets = new Map(), retired = new Set();
  const lifetime = new AbortController(); let closed = false, closing, verificationAttempt = 0;
  const owns = ref => same(ref.scope, scope) && ref.runtimeId === runtimeId && ref.workspaceRevision === workspaceRevision;
  const browser = await createBrowser({ scope: structuredClone(scope), runtimeId, workspaceRevision,
    viewport: [...WORKSPACE_BROWSER_BOUNDARY.viewport],
    networkPolicy(ref, url) {
      const page = pages.get(ref.runId), target = targets.get(ref.runId);
      let current = true;
      try { current = target?.assertCurrent?.() !== false; } catch { current = false; }
      return current && !closed && !!page && !page.revoked && same(page.ref, ref) && page.server.allows(url);
    },
    artifactSink(ref, payload, mime) {
      const page = pages.get(ref.runId), target = targets.get(ref.runId);
      if (closed || !page || page.revoked || !same(page.ref, ref) || !owns(ref) || !target || target.signal.aborted || mime !== 'image/png'
        || !(payload instanceof Uint8Array)) fail('screenshot_target_unavailable');
      if (target.assertCurrent && target.assertCurrent() !== true) fail('browser_authority_stale');
      const boundedRoot = target.evidence ? evidence : workspace;
      if (!boundedRoot || !within(boundedRoot, realpathExisting(target.path))) fail('screenshot_path_invalid');
      publishWorkspaceBytes(target.path, Buffer.from(payload));
      if (!target.evidence) page.server.markGenerated(target.path);
      return `sha256:${hash(Buffer.from(payload))}`;
    },
  });
  for (const name of ['open', 'act', 'recover', 'restart', 'close']) if (typeof browser?.[name] !== 'function') fail('browser_backend_contract_invalid');

  const combine = signal => signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  async function serialMany(runIds, signal, callback) {
    if (closed) fail('browser_owner_closed');
    if (runIds.some(runId => typeof runId !== 'string' || !runId.trim())) fail('browser_run_identity_invalid');
    const ids = [...new Set(runIds)], previous = ids.map(runId => locks.get(runId) ?? Promise.resolve());
    let release; const barrier = new Promise(resolve => { release = resolve; });
    for (const runId of ids) locks.set(runId, barrier);
    await Promise.all(previous);
    try { if (closed) fail('browser_owner_closed'); signal.throwIfAborted(); return await callback(); }
    finally { release(); for (const runId of ids) if (locks.get(runId) === barrier) locks.delete(runId); }
  }
  const serial = (runId, signal, callback) => serialMany([runId], signal, callback);
  async function closePage(runId, { closeBrowser = true, signal, confirmClosed = false } = {}) {
    const page = pages.get(runId); pages.delete(runId); targets.delete(runId);
    if (!page) return;
    try { if (closeBrowser) await browser.close(page.ref, { signal, confirmClosed }); }
    finally { await page.server.close(); }
  }
  async function openPage(runId, input, operationKey, signal, prior) {
    const server = await serverFactory({ root: workspace, path: input.path, signal });
    try {
      const ref = prior ? validateBrowserRecovery(await browser.restart(prior, { signal })).sessionRef
        : validateBrowserSessionRef(await browser.open(runId, { operationKey, signal }));
      if (!owns(ref) || ref.runId !== runId || prior && !same(ref, { ...prior,
        generation: prior.generation + 1, leaseEpoch: prior.leaseEpoch + 1 })) fail('browser_backend_identity_mismatch');
      const page = { server, ref, sourceRevision: server.initialRevision, actionObservations: new Map() };
      pages.set(runId, page); return page;
    } catch (error) { await server.close(); throw error; }
  }
  async function act(page, operationKey, index, kind, signal, arguments_ = {}, executeAction) {
    signal.throwIfAborted();
    const action = validateBrowserAction({ actionId: `${operationKey}:${index}`, kind,
      timeoutMs: ['navigate', 'click', 'fill', 'press', 'move'].includes(kind) ? 30000 : 20000,
      ...(kind === 'navigate' ? { url: page.server.url } : {}), ...arguments_ });
    const dispatch = actionSignal => browser.act(page.ref, action, {
      signal: actionSignal ? AbortSignal.any([signal, actionSignal]) : signal,
      observeAction(value) {
        const fact = admitBrowserActionObservation(value, action);
        if (!fact || closed || page.revoked) return;
        page.actionObservations.set(action.actionId, fact);
        while (page.actionObservations.size > 32) page.actionObservations.delete(page.actionObservations.keys().next().value);
      },
    });
    const observation = validateBrowserObservation(await (executeAction ? executeAction({
      entryPath: relative(workspace, page.server.entry).split(sep).join('/'), action: structuredClone(action),
    }, dispatch) : dispatch()));
    if (!same(observation.sessionRef, page.ref) || observation.actionId !== action.actionId) fail('browser_backend_identity_mismatch');
    return observation;
  }
  async function result(observations, page, target, actions, navigationReason, request) {
    const latest = observations.at(-1), all = key => observations.flatMap(row => row[key]);
    const consoleErrors = all('console').filter(value => /^(error:|assert:)/.test(value));
    const pageErrors = all('pageErrors'), networkFailures = all('networkFailures');
    const rendered = !!(latest.text || latest.controls.length || latest.screenshot);
    const ok = observations.every(row => row.status === 'ok' && row.complete)
      && (latest.statusCode === null || latest.statusCode < 400) && rendered
      && ![...consoleErrors, ...pageErrors].some(value => !warning(value)) && !networkFailures.length
      && actions.every(row => row.ok);
    const actionObservations = observations.flatMap(row => page.actionObservations.get(row.actionId) ?? []);
    const diagnostic = actionObservations.findLast(row => row.outcome !== 'ok');
    const content = { ok, browser_channel: browser.browserChannel ?? 'unknown', browser_version: browser.browserVersion ?? 'unknown',
      ...(diagnostic ? { browser_action_diagnostic: { phase: diagnostic.phase, outcome: diagnostic.outcome,
        dispatch_started: diagnostic.dispatchStarted, dispatch_completed: diagnostic.dispatchCompleted, elapsed_ms: diagnostic.elapsedMs } } : {}),
      entry_path: relative(workspace, page.server.entry).split(sep).join('/'), page_navigation_reason: navigationReason,
      title: latest.title, status_code: latest.statusCode, rendered, body_text_preview: [...latest.text].slice(0, 2000).join(''),
      dom_changed_during_capture: latest.domChangedDuringCapture, scroll_x: latest.scrollX, scroll_y: latest.scrollY,
      console_errors: consoleErrors.filter(value => !warning(value)).slice(0, 20), page_errors: pageErrors.filter(value => !warning(value)).slice(0, 20),
      page_error_locations: all('pageErrorLocations').slice(0, 20), environment_warnings: [...consoleErrors, ...pageErrors].filter(warning).slice(0, 20),
      request_failures: networkFailures.slice(0, 20), actions_ok: actions.every(row => row.ok), actions,
      browser_session_id: latest.sessionRef.sessionId, browser_action_seq: latest.actionSeq, error_code: latest.errorCode,
      pointer_lock_active: latest.pointerLockActive, controls: latest.controls.slice(0, 20).map(control => ({
        tag: control.tag, role: control.role, label: control.label, selector: control.selector, element_ref: control.elementRef,
        clickable: control.clickable, hit_test_reachable: control.hitTestReachable, duplicate_id: control.duplicateId,
      })), ...(latest.screenshot ? { screenshot_path: relative(workspace, target).split(sep).join('/') } : {}) };
    const uncertain = observations.some(row => row.status === 'uncertain');
    const browserIsolation = uncertain ? await isolateUnknownPage(page, request) : undefined;
    if (browserIsolation) content.resource_continuity = isolationObservation();
    return { status: uncertain ? 'uncertain' : ok ? 'ok' : 'error', content,
      ...(browserIsolation ? { browserIsolation } : {}),
      browserSessionRef: structuredClone(latest.sessionRef), browserObservation: structuredClone(latest),
      metadata: { progressObservationDigest: browserObservationDigest(latest, hash),
        ...(actionObservations.length ? { browserActionObservations: actionObservations } : {}) },
      context: { content: canonical(content), ...(latest.screenshot ? { media: [structuredClone(latest.screenshot.contentBlock)] } : {}) } };
  }

  const isolationObservation = () => ({ status: 'lost', original_action_outcome: 'unknown',
    old_page_fenced: true, old_actions_replayed: false, fresh_observation_required: true,
    required_actions: [{ type: 'reload' }] });
  async function isolateUnknownPage(page, request) {
    page.revoked = true; lost.set(page.ref.runId, structuredClone(page.ref));
    if (!reobserveAfterLoss || request.definition.recoveryPolicy !== 'ephemeral-browser/v1') return;
    try {
      const signal = combine(request.signal); signal.throwIfAborted();
      if (request.assertCurrent && request.assertCurrent() !== true) return;
      await closePage(page.ref.runId, { signal, confirmClosed: true });
      signal.throwIfAborted();
      if (request.assertCurrent && request.assertCurrent() !== true) return;
      return { contract: 'agentkit.browser-isolation/v1', sessionRef: structuredClone(page.ref),
        operationKey: request.operationKey, fenced: true, externalEffects: false, oldActionsReplayed: false };
    } catch { /* Without completed owner cleanup, uncertainty still stops the Run. */ }
  }

  return {
    get capability() { return workspaceBrowserCapability(); },
    get definition() { return structuredClone(definition); },
    async execute(request) {
      if (!same(request.scope, scope) || request.call?.name !== 'browser_inspect_workspace'
        || !matchesToolExecutionContract(request.definition, definition)) return { status: 'error', content: { code: 'scope_or_tool_mismatch', executed: false } };
      const signal = combine(request.signal); signal.throwIfAborted();
      const checkOwned = () => {
        signal.throwIfAborted();
        if (request.assertCurrent && request.assertCurrent() !== true) fail('browser_authority_stale');
        return true;
      };
      checkOwned();
      let input, entry, target;
      try {
        input = parseWorkspaceBrowserInput(request.call.arguments, request.operationKey);
        entry = resolveBrowserWorkspaceEntry(workspace, input.path).entry;
        target = screenshotTarget(workspace, input.screenshotPath);
      } catch (error) { return { status: 'error', content: { code: safeInput.has(error.code) ? error.code : 'browser_entry_not_found' } }; }
      return serial(request.runId, signal, async () => {
        checkOwned();
        if (retired.has(request.runId)) return { status: 'error', content: { code: 'browser_run_retired', executed: false } };
        const prior = lost.get(request.runId);
        if (prior && (input.actions.length !== 1 || input.actions[0].kind !== 'reload')) return {
          status: 'error', content: { code: 'browser_session_lost', required_actions: [{ type: 'reload' }] }, browserSessionRef: structuredClone(prior) };
        let page = pages.get(request.runId), first = !page || page.server.entry !== entry || !!prior;
        let navigationReason = prior ? 'session_restarted' : !page ? 'initial_open'
          : page.server.entry !== entry ? 'entry_changed' : 'none';
        if (page && first) { await closePage(request.runId, { closeBrowser: !prior }); checkOwned(); page = null; }
        if (!page) {
          try { page = await openPage(request.runId, input, request.operationKey, signal, prior); }
          catch { signal.throwIfAborted(); return { status: 'error', content: { code: 'browser_start_failed' },
            ...(prior ? { browserSessionRef: structuredClone(prior) } : {}) }; }
          checkOwned(); lost.delete(request.runId);
        }
        let sourceRevision;
        try { sourceRevision = page.server.revision(); }
        catch (error) { return { status: 'error', content: { code: safeInput.has(error.code) ? error.code : 'browser_served_revision_unavailable' }, browserSessionRef: structuredClone(page.ref) }; }
        const changed = sourceRevision !== page.sourceRevision;
        if (changed && !first) navigationReason = 'source_changed';
        targets.set(request.runId, { path: target, evidence: false, signal, assertCurrent: checkOwned });
        const observations = [], actionResults = [], actions = prior ? [] : input.actions;
        let dispatched = false;
        try {
          dispatched = true;
          const initial = await act(page, request.operationKey, 0, first || changed ? 'navigate' : 'screenshot', signal);
          checkOwned();
          observations.push(initial);
          if (initial.status !== 'ok' || !initial.complete) return result(observations, page, target, actionResults, navigationReason, request);
          page.sourceRevision = sourceRevision;
          if (input.waitMs) { await sleep(input.waitMs, signal); checkOwned(); }
          for (const [index, action] of actions.entries()) {
            checkOwned();
            if (action.kind === 'wait') { await sleep(action.ms, signal); checkOwned(); actionResults.push({ index, type: 'wait', ok: true }); continue; }
            const { kind, actionId: _, timeoutMs: __, ...fields } = action;
            const seen = await act(page, request.operationKey, index + 1, kind === 'reload' ? 'navigate' : kind, signal,
              Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)));
            checkOwned();
            observations.push(seen); actionResults.push({ index, type: kind, ok: seen.status === 'ok' });
            if (seen.status !== 'ok' || !seen.complete) return result(observations, page, target, actionResults, navigationReason, request);
          }
          observations.push(await act(page, request.operationKey, actions.length + 1, 'screenshot', signal));
          checkOwned();
          return result(observations, page, target, actionResults, navigationReason, request);
        } catch (error) {
          const browserIsolation = dispatched ? await isolateUnknownPage(page, { ...request, signal }) : undefined;
          const content = { code: 'browser_action_outcome_unknown', ...(browserIsolation ? { resource_continuity: isolationObservation() } : {}) };
          return { status: dispatched ? 'uncertain' : 'error', content, browserSessionRef: structuredClone(page.ref),
            ...(browserIsolation ? { browserIsolation, context: { content: canonical(content) } } : {}) };
        }
      });
    },
    /** Host-only capability retirement. This local resource serves only static
     * GET/HEAD files, and its sink checks the live owner namespace. Removing the
     * namespace fences late network/artifact work even after a lost context.
     * It cannot assert that the original browser action succeeded. */
    async retireResources({ scope: requestedScope, sessionId, runId, refs, signal: rawSignal }) {
      const signal = combine(rawSignal); signal.throwIfAborted();
      if (!same(requestedScope, scope) || typeof sessionId !== 'string' || !sessionId.trim()
        || !Array.isArray(refs) || !refs.length || refs.length > 16) fail('browser_retirement_invalid');
      const checked = refs.map(validateBrowserSessionRef);
      if (checked.some(ref => !owns(ref) || ref.runId !== runId)) fail('browser_reference_scope_mismatch');
      return serial(runId, signal, async () => {
        retired.add(runId);
        const page = pages.get(runId);
        if (page) await closePage(runId, { signal, confirmClosed: true });
        else for (const ref of checked) {
          const report = validateBrowserRecovery(await browser.recover(ref, { signal }));
          if (!same(report.sessionRef, ref) || report.status === 'restarted') fail('browser_recovery_reference_mismatch');
          if (report.status === 'reconnected') await browser.close(ref, { signal, confirmClosed: true });
        }
        signal.throwIfAborted(); lost.delete(runId); targets.delete(runId);
        return { contract: 'agentkit.resource-fence/v1', resourceKind: 'ephemeral-browser',
          scope: structuredClone(scope), runId, sessionId, refs: structuredClone(checked),
          fenced: true, externalEffects: false, oldActionsReplayed: false };
      });
    },
    async recoverSessions({ refs, runId, signal: rawSignal }) {
      const signal = combine(rawSignal); signal.throwIfAborted();
      if (!Array.isArray(refs)) fail('invalid_browser_recovery');
      const checked = [];
      for (let index = 0; index < refs.length; index++) {
        if (!Object.hasOwn(refs, index)) fail('invalid_browser_recovery');
        const ref = validateBrowserSessionRef(refs[index]);
        if (!owns(ref) || runId !== undefined && ref.runId !== runId) fail('browser_reference_scope_mismatch'); checked.push(ref);
      }
      return serialMany(checked.map(ref => ref.runId), signal, async () => {
        const reports = [];
        for (const ref of checked) {
          if (retired.has(ref.runId)) { reports.push({ status: 'lost', sessionRef: ref,
            lastActionSeq: 0, reason: 'resource_retired', reobserveAvailable: false }); continue; }
          let report = validateBrowserRecovery(await browser.recover(ref, { signal }));
          if (!same(report.sessionRef, ref) || report.status === 'restarted') fail('browser_recovery_reference_mismatch');
          const page = pages.get(ref.runId);
          if (report.status === 'reconnected' && (!page || page.revoked || !same(page.ref, ref) || !page.server.allows(page.server.url))) report = {
            status: 'lost', sessionRef: ref, lastActionSeq: report.lastActionSeq,
            reason: page?.revoked ? 'browser_action_outcome_unknown' : 'page_binding_unavailable', reobserveAvailable: false };
          if (report.status === 'lost') report = { ...report, reobserveAvailable: reobserveAfterLoss };
          reports.push(report);
        }
        signal.throwIfAborted();
        for (const report of reports) if (report.status === 'lost') lost.set(report.sessionRef.runId, structuredClone(report.sessionRef));
        return reports;
      });
    },
    /** Trusted VerificationPort only. Fresh context and external image are observations,
     * never a verdict that the complete user objective or visual quality passed. */
    async verifyPage({ runId, entryPath, candidateId, signal: rawSignal, executeAction }) {
      if (!evidence) fail('browser_verification_evidence_unavailable');
      if (typeof candidateId !== 'string' || !candidateId.trim()) fail('browser_candidate_identity_invalid');
      if (executeAction !== undefined && typeof executeAction !== 'function') fail('browser_verification_authority_invalid');
      const input = parseWorkspaceBrowserInput({ path: entryPath, wait_ms: 0 }, `verify:${candidateId}`);
      resolveBrowserWorkspaceEntry(workspace, input.path);
      const signal = combine(rawSignal);
      return serial(runId, signal, async () => {
        if (retired.has(runId)) fail('browser_run_retired');
        const verificationRunId = `${runId}:host-verify:${hash(candidateId).slice(0, 16)}:${++verificationAttempt}`;
        const operationKey = `verify:${candidateId}:${verificationAttempt}`;
        let page;
        try {
          page = await openPage(verificationRunId, input, operationKey, signal);
          targets.set(verificationRunId, { path: join(evidence, `${hash(`${runId}\0${candidateId}\0${verificationAttempt}`)}.png`), evidence: true, signal });
          const verifyAct = (index, kind, args = {}) => act(page, operationKey, index, kind, signal, args, executeAction);
          const first = await verifyAct(0, 'navigate');
          if (first.status !== 'ok') return first;
          await sleep(1000, signal);
          const settled = await verifyAct(1, 'screenshot'), observations = [first, settled];
          if (settled.controls.some(control => control.clickable && control.duplicateId && launchLabel(control.label))) return {
            ...settled, status: 'error', errorCode: 'browser_launch_control_ambiguous' };
          const launch = settled.controls.filter(control => control.clickable && control.selector && launchLabel(control.label));
          if (settled.status === 'ok' && launch.length === 1) {
            const launched = await verifyAct(2, 'click', { selector: launch[0].selector }); observations.push(launched);
            if (launched.status === 'ok') { await sleep(1000, signal); observations.push(await verifyAct(3, 'screenshot')); }
          }
          return { ...observations.at(-1), ...Object.fromEntries(['console', 'pageErrors', 'pageErrorLocations', 'networkFailures']
            .map(key => [key, observations.flatMap(row => row[key])])) };
        } finally { if (page) await closePage(verificationRunId); }
      });
    },
    close() {
      if (closing) return closing;
      closed = true; lifetime.abort(new Error('browser_owner_closed'));
      closing = (async () => {
        await Promise.allSettled([...locks.values()]);
        const results = await Promise.allSettled([...pages.keys()].map(runId => closePage(runId)));
        try { if (typeof browser.dispose === 'function') await browser.dispose(); else await browser.aclose?.(); }
        finally { lost.clear(); targets.clear(); }
        const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
      })();
      return closing;
    },
  };
}
