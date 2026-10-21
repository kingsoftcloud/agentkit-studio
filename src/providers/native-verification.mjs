import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { canonical, invariant, submissionOutputFormat } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeArtifactStore } from '../../packages/agentkit-harness/src/native/artifact-store.mjs';
import { requestedFinalShape, declaredValueSubmissionSchema, finalShapeContractDescription,
  requestedExactWorkspaceFile, encodeExactWorkspaceFile, decodeExactWorkspaceFile,
  exactByteDifference, finalShapeViolation } from './native-final-shape.mjs';
import { writtenNativeWebEntry } from './native-web-entry.mjs';

export const STUDIO_NATIVE_VERIFICATION_CONTRACT = 'agentkit.studio-native-verification/v1';
export const EVIDENCE_VERIFIER_REF = 'studio.delivery-evidence-rejection';
export const ARTIFACT_VERIFIER_REF = 'studio.exact-workspace-file-observation';
const VERSION = '1';
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const tail = relative(root, path); return tail === '' || !isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + sep); };
const fileIdentity = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
const bounded = (text, max) => Array.from(String(text)).slice(0, max).join('');

/** Installed tools grant execution capability, never acceptance authority. */
export function nativeGoalContract({ sessionId, parentRunId = null, goal }) {
  invariant(typeof sessionId === 'string' && sessionId && typeof goal === 'string' && goal.trim(), 'studio_native_goal_invalid');
  const shape = requestedFinalShape(goal), schema = declaredValueSubmissionSchema(goal), exact = requestedExactWorkspaceFile(goal);
  const revision = sha(`${sessionId}\0${parentRunId ?? ''}\0${goal}\0${EVIDENCE_VERIFIER_REF}\0${VERSION}`).slice(0, 24);
  const acceptance = [{ id: 'current_user_goal', required: true, verifierRef: EVIDENCE_VERIFIER_REF,
    verifierVersion: VERSION, verificationMethod: 'deterministic',
    description: shape ? finalShapeContractDescription(goal) : bounded(goal, 1024) }];
  if (exact) acceptance.push({ id: 'exact_workspace_file', required: true, verifierRef: ARTIFACT_VERIFIER_REF,
    verifierVersion: VERSION, verificationMethod: 'deterministic', description: encodeExactWorkspaceFile(exact) });
  return { objective: goal, revision: `studio-goal-${revision}`, constraints: [], acceptance,
    allowedToolNames: null, finalSubmissionSchema: schema, finalSubmissionPayloadKey: schema ? 'output' : null,
    finalOutputFormat: schema ? submissionOutputFormat(schema, 'output') : 'text' };
}

async function observeExactFile(root, requirement, signal) {
  const expected = Buffer.from(requirement.content, 'utf8'), path = resolve(root, requirement.relativePath);
  let fd;
  try {
    signal.throwIfAborted();
    if (!inside(root, path) || !inside(root, await realpath(path))) return { ok: false,
      summary: 'Requested file is outside the bound workspace.' };
    fd = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await fd.stat();
    if (!before.isFile()) return { ok: false, summary: 'Requested file is missing or unreadable.' };
    if (fileIdentity(before) !== fileIdentity(await stat(path)) || !inside(root, await realpath(path))) return { ok: false, blocked: true,
      summary: 'The requested file changed during observation. Verify a stable workspace again.' };
    // Only the first expected-length + 1 bytes are needed to disprove equality.
    const bytes = Buffer.alloc(Math.min(before.size, expected.length + 1));
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const actual = bytes.subarray(0, offset);
    if (fileIdentity(before) !== fileIdentity(await fd.stat()) || fileIdentity(before) !== fileIdentity(await stat(path))
      || !inside(root, await realpath(path))) return { ok: false, blocked: true,
      summary: 'The requested file changed during observation. Verify a stable workspace again.' };
    signal.throwIfAborted();
    if (before.size === expected.length && actual.equals(expected)) return { ok: true,
      summary: 'Requested file bytes match exactly.', digest: `sha256:${sha(actual)}`, sizeBytes: before.size };
    const difference = exactByteDifference(expected, actual);
    return { ok: false, summary: `Requested file bytes differ from the user's literal content at byte ${difference.firstMismatchByte}: expected ${difference.expectedByteHex}, actual ${difference.actualByteHex} (UTF-8 hex).`,
      difference: { ...difference, actualByteLength: before.size }, sizeBytes: before.size };
  } catch (error) {
    signal.throwIfAborted();
    return { ok: false, summary: 'Requested file is missing or unreadable.', errorCode: error.code ?? 'file_unavailable' };
  } finally { await fd?.close(); }
}

function environmentWarning(text) {
  return text === 'The root document of this element is not valid for pointer lock.'
    || text === 'error: The root document of this element is not valid for pointer lock.';
}

/** Observation failures can reject delivery; a cold smoke test cannot approve its semantics. */
function browserFailure(observation, entry) {
  if (observation.errorCode === 'browser_launch_control_ambiguous') return {
    summary: 'The delivered page has multiple visible start controls. Remove duplicate launch controls and inspect the current page again.' };
  if (observation.statusCode !== null && observation.statusCode >= 400) return {
    summary: `Browser could not load the delivered page: ${observation.statusCode}.` };
  if (observation.status !== 'ok' || observation.complete !== true || !observation.screenshot) return { blocked: true,
    summary: 'Browser verification is blocked by an incomplete host observation. Restore the browser and verify the same page; no delivery defect has been established.' };
  const network = observation.networkFailures ?? [], errors = [...(observation.pageErrors ?? []).filter(item => !environmentWarning(item)),
    ...(observation.console ?? []).filter(item => /^(error:|assert:)/.test(item) && !environmentWarning(item)), ...network];
  if (!errors.length) return null;
  if (network.some(item => /^(network_denied:|websocket_denied:)/.test(item))) return {
    summary: 'Browser blocked a page request under the locked network policy. Use assets served from the authorized local origin and inspect the page again.' };
  const missing = network.find(item => item.startsWith('asset_http_error:'));
  if (missing) return { summary: `Browser could not load a local script or stylesheet: ${bounded(missing, 300)}. Fix that asset and inspect again.` };
  const location = observation.pageErrorLocations?.[0];
  return { summary: `Browser reported an error in ${entry}${location ? ` at ${bounded(location, 300)}` : ''}: ${bounded(errors[0], 500)}` };
}

/** Trusted Host evidence is sealed outside the writable workspace before a report is returned. */
export async function createNativeVerification({ scope, sessionId, workspaceRoot, evidenceDirectory, verifyBrowserPage }) {
  const root = await realpath(workspaceRoot), evidence = resolve(evidenceDirectory);
  invariant(!inside(root, evidence), 'studio_native_verification_evidence_inside_workspace');
  const artifacts = await createNativeArtifactStore({ directory: evidence, scope });
  invariant(!inside(root, artifacts.rootReal), 'studio_native_verification_evidence_inside_workspace');
  const scopeIdentity = canonical(scope);
  return { async verify(request) {
    const { signal, candidate, contract, snapshot } = request;
    signal.throwIfAborted();
    invariant(canonical(request.scope) === scopeIdentity && request.sessionId === sessionId
      && snapshot.runId === request.runId && snapshot.sessionId === sessionId
      && canonical(snapshot.scope) === scopeIdentity, 'studio_native_verification_scope_mismatch');
    invariant(candidate.binding && canonical(snapshot.candidate) === canonical(candidate)
      && candidate.goalRevision === snapshot.goalRevision, 'studio_native_verification_candidate_mismatch');
    const [main, exactItem] = contract.acceptance, requirement = exactItem && decodeExactWorkspaceFile(exactItem.description);
    invariant(contract.acceptance.length >= 1 && contract.acceptance.length <= 2
      && main.id === 'current_user_goal' && main.required && main.verifierRef === EVIDENCE_VERIFIER_REF
      && main.verifierVersion === VERSION && main.verificationMethod === 'deterministic'
      && (!exactItem || requirement && exactItem.id === 'exact_workspace_file' && exactItem.required
        && exactItem.verifierRef === ARTIFACT_VERIFIER_REF && exactItem.verifierVersion === VERSION
        && exactItem.verificationMethod === 'deterministic'), 'studio_native_verification_contract_unsupported');
    const shape = requestedFinalShape(main.description), shapeFailure = candidate.purpose !== 'checkpoint' && shape && finalShapeViolation(shape, candidate.text);
    const facts = { shape, shapeFailure: shapeFailure || null, entryPath: null, browserObservation: null,
      modelObservation: snapshot.lastBrowserObservation ?? null, lastWebMutationToolCall: snapshot.lastWebMutationToolCall ?? null,
      unresolvedInteractionObservation: snapshot.unresolvedInteractionObservation ?? null, exactFile: null };
    let browserIssue = null;
    try { facts.entryPath = writtenNativeWebEntry(snapshot, root); }
    catch (error) {
      signal.throwIfAborted();
      browserIssue = { blocked: true, summary: 'The Host cannot bind a unique delivery page to the committed workspace changes. Bind and inspect the intended entry before verifying.',
        errorCode: error.code ?? 'studio_native_web_entry_unavailable' };
    }
    if (facts.entryPath) {
      try {
        invariant(typeof verifyBrowserPage === 'function', 'studio_native_browser_verification_unavailable');
        facts.browserObservation = await verifyBrowserPage({ ...request, entryPath: facts.entryPath, candidateId: candidate.candidateId });
        signal.throwIfAborted();
        browserIssue = browserFailure(facts.browserObservation, facts.entryPath);
      } catch (error) {
        signal.throwIfAborted();
        browserIssue = { blocked: true, summary: 'Browser verification is unavailable. Restore the host browser or evidence service and verify the same page; do not modify the delivery solely to clear this blocker.',
          errorCode: error.code ?? 'browser_unavailable' };
      }
      if (!browserIssue?.blocked) {
        const unresolved = snapshot.unresolvedInteractionObservation, observed = snapshot.lastBrowserObservation;
        if (unresolved?.toolName === 'browser_inspect_workspace' && unresolved.entryPath === facts.entryPath) browserIssue = {
          summary: `The browser interaction previously failed and has not been successfully rechecked: ${bounded(unresolved.error || 'browser error', 300)}` };
        if (!browserIssue && !(observed?.entryPath === facts.entryPath && Number.isSafeInteger(observed.toolCall)
          && observed.toolCall >= (snapshot.lastWebMutationToolCall ?? 0))) browserIssue = {
          summary: 'The delivered web page has not been observed through the browser tool after the latest web file change. Open and inspect the current page before finalizing.' };
      }
    }
    if (requirement) facts.exactFile = await observeExactFile(root, requirement, signal);
    const blocked = browserIssue?.blocked || facts.exactFile?.blocked || false;
    const failure = shapeFailure || browserIssue?.summary || (facts.exactFile && !facts.exactFile.ok ? facts.exactFile.summary : null);
    const mainSummary = blocked ? browserIssue?.blocked ? browserIssue.summary : facts.exactFile.summary : failure
      || (facts.browserObservation ? 'Browser smoke check observed no load or script errors. Interaction and task semantics were not verified.'
        : shape ? 'Final-answer shape passed; task semantics were not independently verified.' : 'Task semantics were not independently verified.');
    const results = [{ item: main, status: blocked ? 'blocked' : failure ? 'failed' : 'not_run', safeSummary: mainSummary }];
    if (exactItem) results.push({ item: exactItem, status: facts.exactFile.blocked ? 'blocked' : facts.exactFile.ok ? 'passed' : 'failed', safeSummary: facts.exactFile.summary });
    const binding = { candidateId: candidate.candidateId, contractRevision: contract.revision,
      binding: structuredClone(candidate.binding), workspaceRevision: candidate.workspaceRevision,
      workspaceDependency: 'required' };
    let sealed;
    try { sealed = await artifacts.write({ ...request, operationKey: `${request.operationKey}:studio-verification-evidence`,
      content: canonical({ version: STUDIO_NATIVE_VERIFICATION_CONTRACT, candidate, contract, facts,
        results: results.map(({ item, ...result }) => ({ id: item.id, ...result })) }), mediaType: 'application/json',
      metadata: { kind: STUDIO_NATIVE_VERIFICATION_CONTRACT, candidateId: candidate.candidateId, contractRevision: contract.revision } });
    } catch (error) {
      signal.throwIfAborted();
      return { ...binding, status: 'unverified', reason: 'studio_evidence_storage_blocked', repairable: false,
        checks: results.map(({ item }) => ({ id: item.id, status: 'blocked', verifierId: item.verifierRef,
          verifierVersion: item.verifierVersion, verificationMethod: item.verificationMethod, evidenceRefs: [],
          evidence: { errorCode: error.code ?? 'evidence_unavailable' },
          safeSummary: 'The Host could not persist verification evidence. Restore the evidence service and verify the same delivery again.', repairable: false })) };
    }
    signal.throwIfAborted();
    return { status: failure ? 'failed' : 'unverified', reason: blocked ? 'studio_evidence_blocked' : failure ? 'studio_delivery_rejected' : 'studio_semantics_unverified',
      ...binding,
      checks: results.map(({ item, ...result }) => ({ ...result, id: item.id, verifierId: item.verifierRef,
        verifierVersion: item.verifierVersion, verificationMethod: item.verificationMethod,
        evidenceRefs: [sealed.uri], evidence: { artifact: sealed }, repairable: result.status === 'failed' && !blocked })),
      repairable: !!failure && !blocked, failureFingerprint: failure ? sha(canonical({ shape, text: candidate.text,
        exact: facts.exactFile, browserIssue })) : '' };
  } };
}
