import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeploymentCases, verifyDeploymentCase } from '../scripts/deployed-runtime-proof.mjs';

const manifest = { agentId: 'ar-local-1234567890abcdef', buildId: 'build_12345678901234567890',
  resources: { mcps: [], skills: [], remote: [{ kind: 'knowledge-base' }] } };
const item = { id: 'script', input: '请检查 JSON 节点数', expectedText: ['7'], expectedTools: ['bash'],
  expectedToolArguments: 'scripts/check.py', expectedToolResult: '节点数：7', expectedStreamPrefix: 'BOUND' };
const frames = () => [
  { type: 'response.output_text.delta', delta: 'BOUND' },
  { type: 'response.output_text.delta', delta: ' 7' },
  { type: 'response.tool_result', call_id: 'call-a', is_error: false, output: [{ text: '节点数：7' }] },
  { type: 'response.completed', id: 'response-a', metadata: { agentkit: { agentId: manifest.agentId, buildId: manifest.buildId } },
    output: [{ type: 'function_call', call_id: 'call-a', name: 'bash', arguments: '{"command":"python3 scripts/check.py"}' }],
    output_text: 'BOUND 7', usage: { input_tokens: 50, output_tokens: 8, total_tokens: 58 } },
];

test('deployed evidence requires the expected frozen Agent and Build even when the text is correct', () => {
  validateDeploymentCases([item], manifest);
  assert.equal(verifyDeploymentCase(frames(), item, manifest).passed, true);
  for (const identity of [{ agentId: 'another-agent', buildId: manifest.buildId }, { agentId: manifest.agentId, buildId: 'another-build' }, undefined]) {
    const copy = frames(); copy.at(-1).metadata.agentkit = identity;
    assert.throws(() => verifyDeploymentCase(copy, item, manifest), { code: 'PROBE_BUILD_IDENTITY_MISMATCH' });
  }
});

test('a correct answer cannot substitute for an executed tool and its matching successful result', () => {
  const absent = frames(); absent.at(-1).output = [];
  assert.throws(() => verifyDeploymentCase(absent, item, manifest), { code: 'PROBE_BOUND_TOOL_MISSING' });
  for (const change of [frame => { frame.is_error = true; }, frame => { frame.call_id = 'unrelated-call'; }]) {
    const copy = frames(); change(copy[2]);
    assert.throws(() => verifyDeploymentCase(copy, item, manifest), { code: 'PROBE_TOOL_SUCCESS_MISSING' });
  }
  const wrongScript = frames(); wrongScript.at(-1).output[0].arguments = '{"command":"echo 7"}';
  assert.throws(() => verifyDeploymentCase(wrongScript, item, manifest), { code: 'PROBE_SCRIPT_EXECUTION_MISSING' });
  const wrongResult = frames(); wrongResult[2].output = [{ text: 'script failed; no result' }];
  assert.throws(() => verifyDeploymentCase(wrongResult, item, manifest), { code: 'PROBE_TOOL_RESULT_MISMATCH' });
});

test('knowledge attribution rejects memory, tools, and skills as alternative sources', () => {
  const knowledge = { id: 'knowledge', input: '查验收文档', isolatedKnowledge: true };
  validateDeploymentCases([knowledge], manifest);
  for (const resources of [
    { ...manifest.resources, remote: [...manifest.resources.remote, { kind: 'memory-instance' }] },
    { ...manifest.resources, mcps: [{ resourceId: 'search' }] },
    { ...manifest.resources, skills: [{ resourceId: 'skill' }] },
  ]) assert.throws(() => validateDeploymentCases([knowledge], { ...manifest, resources }), { code: 'PROBE_KNOWLEDGE_NOT_ISOLATED' });
  assert.throws(() => verifyDeploymentCase(frames(), knowledge, manifest), { code: 'PROBE_KNOWLEDGE_EXTERNAL_TOOL' });
});

test('script evidence must belong to an expected tool, not an unrelated search result', () => {
  const copy = frames();
  copy.at(-1).output[0].arguments = '{"command":"echo unrelated"}';
  copy.at(-1).output.push({ type: 'function_call', call_id: 'search', name: 'web_search',
    arguments: '{"query":"scripts/check.py"}' });
  copy.splice(2, 0, { type: 'response.tool_result', call_id: 'search', is_error: false,
    output: [{ text: '节点数：7' }] });
  assert.throws(() => verifyDeploymentCase(copy, item, manifest), { code: 'PROBE_SCRIPT_EXECUTION_MISSING' });
});

test('successful HTTP or completed text cannot hide a failed run, missing usage, or absent incremental stream', () => {
  assert.throws(() => verifyDeploymentCase([...frames(), { type: 'response.failed' }], item, manifest), { code: 'PROBE_COMPLETION_MISSING' });
  const noUsage = frames(); delete noUsage.at(-1).usage;
  assert.throws(() => verifyDeploymentCase(noUsage, item, manifest), { code: 'PROBE_USAGE_MISSING' });
  assert.throws(() => verifyDeploymentCase(frames().slice(1), item, manifest), { code: 'PROBE_INCREMENTAL_STREAM_MISSING' });
  assert.throws(() => validateDeploymentCases([{ ...item, restart: true }], manifest), { code: 'PROBE_LIFECYCLE_CASE_UNSUPPORTED' });
});
