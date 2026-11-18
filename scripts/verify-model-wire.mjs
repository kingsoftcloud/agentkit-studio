/**
 * Report which wire every model of a configured gateway speaks.
 *
 * 星流 serves 59 models and only 17 of them implement `/v1/responses`, while
 * `/v1/models` declares nothing about it. This script answers the question the
 * catalog cannot: for each model, is `protocol: openai-responses` a working
 * choice, or does the profile have to stay on Chat Completions?
 *
 * Read-only: it sends one 8-token probe per model and never writes a
 * configuration. Credentials are read from `--api-key` or the environment, and
 * are never echoed.
 *
 * Usage:
 *   node scripts/verify-model-wire.mjs --base-url http://kspmas.ksyun.com/v1 --api-key "$AGENTKIT_MODEL_API_KEY"
 *   node scripts/verify-model-wire.mjs --base-url … --api-key … --json
 *   node scripts/verify-model-wire.mjs --help
 */
import { probeModelWires } from '../src/model-wire-probe.mjs';

const HELP = `Report which wire every model of a gateway speaks.

  --base-url <url>     gateway base URL (default: $AGENTKIT_MODEL_BASE_URL)
  --api-key <key>      bearer credential (default: $AGENTKIT_MODEL_API_KEY)
  --header <k:v>       extra request header, repeatable
  --model <id>         probe only this model, repeatable (default: the catalog)
  --concurrency <n>    parallel probes (default: 5)
  --json               print the machine-readable rows only
  --help               show this message
`;

function parseArgs(argv) {
  const options = { headers: {}, models: [], concurrency: 5, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    if (flag === '--json') { options.json = true; continue; }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`缺少 ${flag} 的取值`);
    index += 1;
    if (flag === '--base-url') options.baseUrl = value;
    else if (flag === '--api-key') options.apiKey = value;
    else if (flag === '--model') options.models.push(value);
    else if (flag === '--header') {
      const at = value.indexOf(':');
      if (at <= 0) throw new Error('--header 需要 name:value 形式');
      options.headers[value.slice(0, at).trim()] = value.slice(at + 1).trim();
    } else if (flag === '--concurrency') options.concurrency = Number(value);
    else throw new Error(`未知参数 ${flag}`);
  }
  return options;
}

async function catalogModels({ baseUrl, apiKey, headers }) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: { ...headers, Authorization: `Bearer ${apiKey}` }, redirect: 'error' });
  if (!response.ok) throw new Error(`读取模型目录失败：HTTP ${response.status}`);
  const body = await response.json();
  return (body?.data || []).map(item => item?.id).filter(Boolean);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) { process.stdout.write(HELP); process.exit(0); }

const baseUrl = String(options.baseUrl || process.env.AGENTKIT_MODEL_BASE_URL || '').trim();
const apiKey = String(options.apiKey || process.env.AGENTKIT_MODEL_API_KEY || '').trim();
if (!baseUrl) { process.stderr.write('缺少 --base-url（或 $AGENTKIT_MODEL_BASE_URL）\n'); process.exit(2); }
if (!apiKey) { process.stderr.write('缺少 --api-key（或 $AGENTKIT_MODEL_API_KEY）\n'); process.exit(2); }

const models = options.models.length ? options.models : await catalogModels({ baseUrl, apiKey, headers: options.headers });
if (!models.length) { process.stderr.write('目录为空，无事可做\n'); process.exit(0); }

const rows = await probeModelWires({ baseUrl, apiKey, headers: options.headers, models, concurrency: options.concurrency });

if (options.json) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else {
  // `openai-completions` is the routing decision ("do not ask for Responses"),
  // not a claim that the model is a chat model — the image/video/embedding
  // models answer 404 on both wires. Label it as the decision it is.
  const label = { 'openai-responses': 'Responses ✅', 'openai-completions': '不支持 Responses', unknown: '未知' };
  process.stdout.write(`${baseUrl} — ${rows.length} 个模型\n\n`);
  for (const row of rows) process.stdout.write(`${row.modelName.padEnd(38)} ${label[row.wire]}\n`);
  const counts = rows.reduce((tally, row) => ({ ...tally, [row.wire]: (tally[row.wire] || 0) + 1 }), {});
  process.stdout.write(`\nResponses ${counts['openai-responses'] || 0} · Chat ${counts['openai-completions'] || 0} · 未知 ${counts.unknown || 0}\n`);
  const responses = rows.filter(row => row.wire === 'openai-responses').map(row => row.modelName);
  if (responses.length) process.stdout.write(`\n可在 profile 里设 protocol: openai-responses 的模型：\n  ${responses.join(', ')}\n`);
}

// A gateway that answers no probe at all is a failure (bad credential, wrong
// base URL), not a report full of "unknown".
if (rows.every(row => row.wire === 'unknown')) {
  process.stderr.write('\n所有探测都没有结论 —— 检查 base URL 与凭据。\n');
  process.exit(1);
}
