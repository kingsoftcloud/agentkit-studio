/**
 * Report which reasoning levels every model of a gateway actually accepts.
 *
 * The profile picker offers `low/medium/high/xhigh/max`, but "the gateway
 * accepts the level" is a per-model fact: `glm-5.3` refuses `minimal`, and
 * `kimi-k3.1-pro` accepts it on Chat while refusing it on Responses. This
 * script asks the gateway, per model and per wire.
 *
 * Read-only: one 8-token probe per (model, level). Credentials are read from
 * `--api-key` or the environment and are never echoed.
 *
 * Usage:
 *   node scripts/verify-model-efforts.mjs --base-url http://kspmas.ksyun.com/v1 --api-key "$AGENTKIT_MODEL_API_KEY"
 *   node scripts/verify-model-efforts.mjs --base-url … --api-key … --model kimi-k3.1-pro
 *   node scripts/verify-model-efforts.mjs --help
 */
import { probeModelEfforts } from '../src/model-effort-probe.mjs';
import { probeModelWire } from '../src/model-wire-probe.mjs';

const HELP = `Report which reasoning levels a gateway accepts, per model and per wire.

  --base-url <url>   gateway base URL (default: $AGENTKIT_MODEL_BASE_URL)
  --api-key <key>    bearer credential (default: $AGENTKIT_MODEL_API_KEY)
  --model <id>       probe only this model (repeatable; default: the catalog)
  --level <id>       probe only this level (repeatable)
  --help             show this message
`;

const DEFAULT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function parseArgs(argv) {
  const options = { models: [], levels: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`缺少 ${flag} 的取值`);
    index += 1;
    if (flag === '--base-url') options.baseUrl = value;
    else if (flag === '--api-key') options.apiKey = value;
    else if (flag === '--model') options.models.push(value);
    else if (flag === '--level') options.levels.push(value);
    else throw new Error(`未知参数 ${flag}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) { process.stdout.write(HELP); process.exit(0); }

const baseUrl = String(options.baseUrl || process.env.AGENTKIT_MODEL_BASE_URL || '').trim();
const apiKey = String(options.apiKey || process.env.AGENTKIT_MODEL_API_KEY || '').trim();
if (!baseUrl) { process.stderr.write('缺少 --base-url（或 $AGENTKIT_MODEL_BASE_URL）\n'); process.exit(2); }
if (!apiKey) { process.stderr.write('缺少 --api-key（或 $AGENTKIT_MODEL_API_KEY）\n'); process.exit(2); }
const levels = options.levels.length ? options.levels : DEFAULT_LEVELS;

const models = options.models.length
  ? options.models
  : ((await (await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error' })).json())?.data || [])
    .map(item => item?.id).filter(Boolean);

const MARK = { accepted: '✅', rejected: '❌', unknown: '·' };
const rows = [];
for (const model of models) {
  const wire = await probeModelWire({ baseUrl, apiKey, modelName: model });
  const wireLabel = wire === 'openai-responses' ? 'responses' : wire === 'openai-completions' ? 'chat' : '?';
  const efforts = await probeModelEfforts({ baseUrl, apiKey, modelName: model, levels, wire: wire === 'unknown' ? 'openai-chat' : wire });
  rows.push({ model, wire: wireLabel, efforts });
  process.stdout.write(`${model.padEnd(36)} wire=${wireLabel.padEnd(9)} ${efforts.map(row => `${row.level.slice(0, 3)}:${MARK[row.outcome]}`).join('  ')}\n`);
}

process.stdout.write('\n');
const accepted = new Map(levels.map(level => [level, rows.filter(row => row.efforts.find(item => item.level === level)?.outcome === 'accepted').length]));
for (const level of levels) process.stdout.write(`${level.padEnd(9)} 被 ${accepted.get(level)}/${rows.length} 个模型接受\n`);

const unknown = rows.filter(row => row.efforts.every(item => item.outcome === 'unknown'));
if (unknown.length === rows.length) {
  process.stderr.write('\n所有探测都没有结论 —— 检查 base URL 与凭据。\n');
  process.exit(1);
}
