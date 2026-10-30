import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NativeKernel, emptyUsage, canonical } from '../../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest, acceptance, verificationReport } from '../fixtures.mjs';
const [filename, boundary] = process.argv.slice(2), root = dirname(filename), file = join(root, 'ledger.ts');
const data = { requirements: [{ requirement: 'Keep zero accounts.', implementation_evidence: 'ledger.ts', verification_evidence: 'Missing host semantics.' }],
  findings: [{ issue: 'Missing zero case.', recommended_check: 'Inspect and repair.' }] };
const whole = canonical(data);
const { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })],
  deliveryReviewPolicy: { pathSuffixes: ['.ts'] }, contract: { objective: 'Keep zero accounts.', acceptance: [acceptance({ verificationMethod: 'human' })] },
  limits: { maxModelCalls: 20, maxToolCalls: 20, finalizationReserveModelCalls: 0 } });
const store = new SqliteRunStore(filename); let models = 0;
const hold = async state => { process.send({ pid: process.pid, models, boundary, review: state.deliveryReview }); await new Promise(() => {}); };
const worker = new NativeKernel({ store, digest, owner: 'killed-review-owner', ports: {
  model: { generate: async request => {
    const count = ++models;
    if (count === 2) return { kind: 'final_candidate', text: 'Candidate.', toolCalls: [], usage: emptyUsage() };
    if (count === 3) return boundary === 'suffix'
      ? { kind: 'output_limit', text: whole.slice(0, 100), textCommitVersion: 'provider-finished-text/v1', toolCalls: [], usage: emptyUsage() }
      : { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'review-control', name: 'submit_delivery_review', arguments: data }], usage: emptyUsage() };
    return { kind: 'tool_calls', text: '', toolCalls: [{ callId: `write-${count}`, name: 'write', arguments: { text: count === 1 ? 'broken' : 'fixed' } }], usage: emptyUsage() };
  } }, tools: { execute: async request => {
    appendFileSync(join(root, 'effects.jsonl'), JSON.stringify(request.call) + '\n'); writeFileSync(file, request.call.arguments.text);
    if (boundary === 'applied' && request.call.arguments.text === 'fixed') await hold(store.load(scope, 'run').snapshot);
    return { status: 'ok', content: 'written', workspaceChangedPaths: ['ledger.ts'] };
  } }, workspace: { observe: async () => ({ status: 'ok', revision: digest(existsSync(file) ? readFileSync(file, 'utf8') : null),
    changedPaths: existsSync(file) ? ['ledger.ts'] : [] }) },
  verification: { verify: async request => verificationReport(request, { status: 'unverified', checks: [{ id: 'test', status: 'not_run', verifierId: 'fixture',
    verifierVersion: '1', verificationMethod: 'human', safeSummary: 'No semantic verifier.', evidenceRefs: ['fixture://public-test'] }] }) },
}, onCheckpoint: async state => {
  if (['pending', 'cancel'].includes(boundary) && state.deliveryReview?.status === 'pending') await hold(state);
  if (boundary === 'suffix' && state.deliveryReview?.continuationMessages.length) await hold(state);
} });
worker.start(snapshot, config); await worker.runUntilIdle(scope, 'run');
throw Error('Expected parent SIGKILL at review boundary');
