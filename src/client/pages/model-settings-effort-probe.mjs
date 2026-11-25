import { STUDIO_REASONING_LEVELS } from '../../model-reasoning.mjs';

export const REASONING_LABELS = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
export const formatEffortLevels = levels => levels.map(level => REASONING_LABELS[level]).join(' / ');

const WIRE_LABELS = { 'openai-responses': 'Responses', 'openai-completions': 'Chat Completions', 'anthropic-messages': 'Messages', unknown: '接口待确认' };
const OUTCOME_LABELS = { confirmed: '服务回显', accepted: '请求通过', rejected: '拒绝', timeout: '超时', untested: '未测', unknown: '无结论' };
const untestedReport = { outcomes: STUDIO_REASONING_LEVELS.map(level => ({ level, outcome: 'untested' })) };

export function renderEffortReport(h, report) {
  if (!report) return null;
  const statuses = Object.entries(OUTCOME_LABELS).map(([outcome, label]) => {
    const levels = report.outcomes.filter(row => row.outcome === outcome).map(row => row.level);
    return levels.length ? label + ' ' + formatEffortLevels(levels) : '';
  });
  const control = report.control === 'timeout' ? '对照请求超时'
    : report.control === 'inconclusive' ? '对照请求未确认' : '';
  return h('p', { className: 'ms-effort-report ms-hint', 'data-model-effort-report': true, role: 'status' },
    [WIRE_LABELS[report.wire], control, ...statuses].filter(Boolean).join(' · '));
}

/** Keep the probe bound to the open editor and report one model at a time. */
export function createUseEffortProbe({ useState, useRef, useEffect }) {
  return function useEffortProbe(scope) {
    const [progress, setProgress] = useState(null);
    const [results, setResults] = useState(null);
    const active = typeof useRef === 'function' ? useRef(null) : { current: null };
    const cancel = () => {
      active.current?.abort();
      active.current = null;
    };
    useEffect(() => cancel, [scope]);
    const stop = () => { cancel(); setProgress(null); };
    const run = async (jobs, probe) => {
      if (active.current || !jobs.length) return;
      const controller = new AbortController();
      active.current = controller;
      const { signal } = controller;
      const total = jobs.length;
      setResults({ scope, reports: new Map(jobs.map(job => [job.key, untestedReport])) });
      setProgress({ scope, done: 0, total });
      try {
        for (const [index, job] of jobs.entries()) {
          let report = untestedReport;
          try {
            const result = await probe(job, signal);
            if (Array.isArray(result?.outcomes)) report = result;
          } catch {
            // Leave the planned levels marked as untested.
          }
          if (signal.aborted) return;
          setResults(current => ({ scope, reports: new Map(current.reports).set(job.key, report) }));
          setProgress({ scope, done: index + 1, total });
        }
      } finally {
        if (active.current === controller) { active.current = null; setProgress(null); }
      }
    };
    return {
      run, stop, progress: progress?.scope === scope ? progress : null,
      reportFor: key => results?.scope === scope ? results?.reports.get(key) : undefined,
    };
  };
}

export function renderModelEffortSettings(h, { efforts, value, levels, protocol, provisional, probing, canProbe, report, onProbe, onChange }) {
  const wire = value ? efforts[value] : '';
  const parameter = protocol === 'openai-responses' ? 'reasoning.effort' : protocol === 'anthropic-messages' ? 'output_config.effort' : 'reasoning_effort';
  const hint = probing ? '正在发送测试请求…' : [
    levels?.length ? `可选档位 · ${formatEffortLevels(levels)}` : '',
    wire ? `实际发送 ${parameter}=${wire}` : '',
  ].filter(Boolean).join(' · ');
  return h('div', { className: 'ms-field' },
    h('div', { className: 'ms-field-head' },
      h('span', { className: 'ms-label' }, '思考等级'),
      h('button', { type: 'button', className: 'ms-btn', 'data-size': 'sm', onClick: onProbe, disabled: !canProbe },
        probing ? '停止探测' : '探测档位')),
    h('select', {
      className: 'ms-select', 'aria-label': '思考等级', 'data-model-reasoning': wire,
      title: provisional ? '未识别的提供商使用低、高两档作为候选。可探测模型实际接受的档位。' : undefined,
      value, disabled: probing, onChange: event => onChange(event.target.value),
    }, h('option', { value: '' }, '沿用服务默认'),
    Object.keys(efforts).map(level => h('option', { key: level, value: level }, `${REASONING_LABELS[level] || level} → ${efforts[level]}`))),
    hint ? h('span', { role: 'status', className: 'ms-hint' }, hint) : null,
    !probing && renderEffortReport(h, report));
}
