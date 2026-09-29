/** Local evaluation framework for the Studio plugin Node host.
 *
 * Port of the legacy Studio evaluation stack: evalset parsing (native +
 * studio_suite/v0), local storage under ~/.agentkit/studio/evaluations,
 * run records with case results, and a pluggable case runner. Execution
 * against a built Agent needs a run contract (harness provider or a cloud
 * RunAgent Action); until then runs are recorded as pending and the runner
 * reports the gap.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

export class EvaluationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EvaluationError';
    this.code = code;
    this.details = details;
  }
}

const ASSERTION_TYPES = new Set([
  'response.contains', 'response.equals', 'response.notContains', 'response.jsonSchema',
  'response.startsWith', 'response.endsWith', 'response.matches',
  'runtime.maxLatencyMs', 'runtime.maxInputTokens', 'runtime.maxOutputTokens',
  'tool.called', 'tool.notCalled', 'tool.sequence',
]);

function parseEvalsetSource(raw, fileName = '') {
  let value;
  const text = String(raw || '');
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try { value = JSON.parse(text); } catch { throw new EvaluationError('EVALSET_PARSE_FAILED', '评测集 JSON 解析失败'); }
  } else {
    try { value = YAML.parse(text); } catch { throw new EvaluationError('EVALSET_PARSE_FAILED', '评测集 YAML 解析失败'); }
  }
  if (!value || typeof value !== 'object') throw new EvaluationError('EVALSET_FORMAT_INVALID', '评测集根节点必须是对象');
  if (value.apiVersion || value.api_version || value.kind) {
    const cases = Array.isArray(value.cases) ? value.cases : [];
    return { evalsetId: String(value.metadata?.name || value.metadata?.id || fileName || `evalset-${randomUUID().slice(0, 8)}`), name: String(value.metadata?.name || value.metadata?.title || fileName || '未命名评测集'), description: String(value.metadata?.description || ''), sourceFormat: 'studio_suite/v0', cases: cases.map(normalizeStudioCase) };
  }
  if (Array.isArray(value)) return { evalsetId: fileName || `evalset-${randomUUID().slice(0, 8)}`, name: fileName || '未命名评测集', description: '', sourceFormat: 'native', cases: value.map(normalizeNativeCase) };
  if (Array.isArray(value.cases)) return { evalsetId: String(value.name || value.id || fileName || `evalset-${randomUUID().slice(0, 8)}`), name: String(value.name || value.title || fileName || '未命名评测集'), description: String(value.description || ''), sourceFormat: 'native', cases: value.cases.map(normalizeNativeCase) };
  throw new EvaluationError('EVALSET_FORMAT_INVALID', '无法识别的评测集格式', { hints: ['native: [{ id, input, assertions }]', 'studio_suite/v0: { apiVersion, metadata, cases }'] });
}

function normalizeNativeCase(raw, index) {
  const item = raw || {};
  const id = String(item.id || `case-${index + 1}`);
  const input = String(item.input || item.prompt || '');
  if (!input) throw new EvaluationError('EVALSET_CASE_INVALID', `用例 ${id} 缺少 input`, { caseId: id });
  return { id, input, expectedOutput: item.expectedOutput || item.expected_output || null, assertions: normalizeAssertions(item.assertions || []), metadata: item.metadata || {} };
}

function normalizeStudioCase(raw, index) {
  const item = raw || {};
  const id = String(item.id || `case-${index + 1}`);
  const turns = Array.isArray(item.turns) ? item.turns : [{ input: String(item.input || '') }];
  const input = turns.map(turn => String(turn.input || turn?.input || '')).join('\n') || String(item.input || '');
  if (!input) throw new EvaluationError('EVALSET_CASE_INVALID', `用例 ${id} 缺少 input`, { caseId: id });
  return { id, input, expectedOutput: turns[turns.length - 1]?.expectedOutput || turns[turns.length - 1]?.expected_output || null, assertions: normalizeAssertions(item.assertions || []), metadata: item.metadata || {} };
}

function normalizeAssertions(raw) {
  const items = Array.isArray(raw) ? raw : [];
  return items.map((item, index) => {
    if (typeof item === 'string') return { type: 'response.contains', value: item, required: true };
    const type = String(item.type || item.assertion || '');
    if (!ASSERTION_TYPES.has(type)) throw new EvaluationError('EVALSET_ASSERTION_INVALID', `不支持的断言类型 ${type}`, { type, index });
    return { type, value: item.value, required: item.required !== false };
  });
}

function evaluateAssertion(assertion, result) {
  const { type, value, required } = assertion;
  const output = String(result.output || '');
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  if (type === 'response.contains') return output.includes(String(value));
  if (type === 'response.notContains') return !output.includes(String(value));
  if (type === 'response.equals') return output.trim() === String(value).trim();
  if (type === 'response.startsWith') return output.startsWith(String(value));
  if (type === 'response.endsWith') return output.endsWith(String(value));
  if (type === 'response.matches') { try { return new RegExp(String(value)).test(output); } catch { return false; } }
  if (type === 'response.jsonSchema') { try { return typeof output === 'string' && JSON.parse(output) !== null; } catch { return false; } }
  if (type === 'runtime.maxLatencyMs') return Number(result.latencyMs || 0) <= Number(value);
  if (type === 'runtime.maxInputTokens') return Number(result.tokenUsage?.inputTokens || 0) <= Number(value);
  if (type === 'runtime.maxOutputTokens') return Number(result.tokenUsage?.outputTokens || 0) <= Number(value);
  if (type === 'tool.called') return toolCalls.some(call => String(call.name || call) === String(value));
  if (type === 'tool.notCalled') return !toolCalls.some(call => String(call.name || call) === String(value));
  if (type === 'tool.sequence') { const names = toolCalls.map(call => String(call.name || call)); return JSON.stringify(names) === JSON.stringify(value); }
  return required ? false : true;
}

export function createStudioEvaluation({ storeDir, runner } = {}) {
  const evalsetsDir = join(storeDir, 'evalsets');
  const runsDir = join(storeDir, 'runs');
  const targetsDir = join(storeDir, 'targets');

  async function ensureDirs() {
    await Promise.all([mkdir(evalsetsDir, { recursive: true, mode: 0o700 }), mkdir(runsDir, { recursive: true, mode: 0o700 }), mkdir(targetsDir, { recursive: true, mode: 0o700 })]);
  }

  async function importEvalset({ content, fileName }) {
    await ensureDirs();
    const parsed = parseEvalsetSource(content, fileName);
    const id = parsed.evalsetId;
    const record = { ...parsed, id, caseCount: parsed.cases.length, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
    await writeFile(join(evalsetsDir, `${id}.json`), JSON.stringify(record, null, 2));
    return record;
  }

  async function listEvalsets() {
    await ensureDirs();
    let names;
    try { names = await readdir(evalsetsDir); } catch { return { items: [] }; }
    const items = [];
    for (const name of names.filter(item => item.endsWith('.json')).sort()) {
      try { items.push(JSON.parse(await readFile(join(evalsetsDir, name), 'utf8'))); } catch { /* skip corrupt */ }
    }
    return { items };
  }

  async function listTargets({ builds = [] } = {}) {
    // Targets are local Builds; the page shows them as evaluable targets.
    return { items: builds.map(build => ({ id: build.id, name: build.id, kind: 'studio_build', agentId: build.agentId, status: 'ready' })) };
  }

  async function listRuns({ agentId, evalsetId, status } = {}) {
    await ensureDirs();
    let names;
    try { names = await readdir(runsDir); } catch { return { items: [] }; }
    const items = [];
    for (const name of names.filter(item => item.endsWith('.json')).sort().reverse()) {
      try {
        const run = JSON.parse(await readFile(join(runsDir, name), 'utf8'));
        if ((!agentId || run.agentId === agentId) && (!evalsetId || run.evalsetId === evalsetId) && (!status || run.status === status)) items.push(run);
      } catch { /* skip corrupt */ }
    }
    return { items };
  }

  async function getRun(runId) {
    try { return JSON.parse(await readFile(join(runsDir, `${runId}.json`), 'utf8')); } catch { return null; }
  }

  async function createEvaluation({ evalsetId, target: targetId, agentId, config = {} }) {
    await ensureDirs();
    const evalsets = await listEvalsets();
    const evalset = evalsets.items.find(item => item.id === evalsetId);
    if (!evalset) throw new EvaluationError('EVALSET_NOT_FOUND', '评测集不存在', { evalsetId });
    const runId = `eval_${randomUUID().replace(/-/g, '')}`;
    const run = {
      id: runId, evalsetId, evalsetName: evalset.name, targetId, agentId,
      status: 'pending', createdAt: new Date().toISOString(), completedAt: null,
      config: { timeoutSeconds: Number(config.timeoutSeconds || 120), failFast: Boolean(config.failFast), evaluators: Array.isArray(config.evaluators) ? config.evaluators : [] },
      caseResults: [], summary: { total: evalset.cases.length, passed: 0, failed: 0, skipped: 0 },
    };
    await writeFile(join(runsDir, `${runId}.json`), JSON.stringify(run, null, 2));

    // Execute asynchronously if a runner is configured; otherwise record the
    // honest gap so the page shows a pending run, not a hidden failure.
    if (typeof runner === 'function') {
      setImmediate(() => void executeRun(runId, evalset, agentId));
    } else {
      const updated = { ...run, status: 'failed', completedAt: new Date().toISOString(), caseResults: evalset.cases.map(caseItem => ({ caseId: caseItem.id, status: 'skipped', error: '评测执行需要 run 合同（harness provider 或云端 RunAgent Action）' })) };
      updated.summary.skipped = evalset.cases.length;
      await writeFile(join(runsDir, `${runId}.json`), JSON.stringify(updated, null, 2));
    }
    return run;
  }

  async function executeRun(runId, evalset, agentId) {
    const run = await getRun(runId);
    if (!run) return;
    run.status = 'running';
    await writeFile(join(runsDir, `${runId}.json`), JSON.stringify(run, null, 2));
    const caseResults = [];
    for (const caseItem of evalset.cases) {
      const started = Date.now();
      try {
        const result = await runner({ input: caseItem.input, agentId, timeoutSeconds: run.config.timeoutSeconds });
        const assertions = caseItem.assertions.map(assertion => ({ type: assertion.type, value: assertion.value, passed: evaluateAssertion(assertion, result), message: '' }));
        const passed = assertions.every(item => item.passed);
        caseResults.push({ caseId: caseItem.id, status: passed ? 'passed' : 'failed', output: String(result.output || '').slice(0, 2048), toolCalls: result.toolCalls || [], tokenUsage: result.tokenUsage || {}, latencyMs: Date.now() - started, assertions });
        if (run.config.failFast && !passed) { for (const remaining of evalset.cases.slice(evalset.cases.indexOf(caseItem) + 1)) caseResults.push({ caseId: remaining.id, status: 'skipped', error: 'fail-fast 中止' }); break; }
      } catch (error) {
        caseResults.push({ caseId: caseItem.id, status: 'failed', error: String(error?.message || error).slice(0, 400), latencyMs: Date.now() - started });
      }
    }
    const completed = { ...run, status: caseResults.every(item => item.status === 'passed') ? 'succeeded' : (caseResults.some(item => item.status === 'passed') ? 'partial' : 'failed'), completedAt: new Date().toISOString(), caseResults, summary: { total: evalset.cases.length, passed: caseResults.filter(item => item.status === 'passed').length, failed: caseResults.filter(item => item.status === 'failed').length, skipped: caseResults.filter(item => item.status === 'skipped').length } };
    await writeFile(join(runsDir, `${runId}.json`), JSON.stringify(completed, null, 2));
  }

  return { importEvalset, listEvalsets, listTargets, listRuns, getRun, createEvaluation };
}
