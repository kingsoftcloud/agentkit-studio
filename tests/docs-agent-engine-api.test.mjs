import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The cloud Agent API page enumerates every Action the Host is allowed to call
// on the AgentEngine control plane. That list is generated from
// `src/server-client.mjs`, but the page also states a *count* in prose, and the
// request-body section names fields. Both drift silently when an Action is
// added, so this gate makes the two lists one contract:
//
//   * the page must enumerate exactly the Actions in SERVER_ACTIONS +
//     SKILL_SERVICE_ACTIONS, in the same order;
//   * the stated total must equal that size;
//   * the two locales must agree row for row.
//
// Reference: docs-site/scripts/extract-reference.mjs (pageAgentEngineApi).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(REPO_ROOT, 'src', 'server-client.mjs');
const PAGE_ZH = join(REPO_ROOT, 'docs-site', 'content', 'docs', 'reference', 'agent-engine-api.mdx');
const PAGE_EN = join(REPO_ROOT, 'docs-site', 'content', 'docs', 'reference', 'agent-engine-api.en.mdx');

/** Read one `const NAME = new Set([...])` literal without importing the module. */
function actionSet(source, name) {
  const match = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(source);
  assert.ok(match, `${name} is not a \`new Set([...])\` literal in src/server-client.mjs; update this gate.`);
  return [...match[1].matchAll(/'([A-Za-z]+)'/g)].map((entry) => entry[1]);
}

function expectedActions() {
  const client = readFileSync(CLIENT, 'utf8');
  const server = actionSet(client, 'SERVER_ACTIONS');
  const skill = actionSet(client, 'SKILL_SERVICE_ACTIONS');
  return { server, skill, all: [...server, ...skill] };
}

/** Action ids the page lists in its `## Action` table, in document order. */
function documentedActions(source) {
  const ids = [];
  for (const line of source.split('\n')) {
    // Table rows look like: | 域 | `ActionName` | 路由 | ...
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const id = /^`([A-Za-z]+)`$/.exec(cells[2] ?? '');
    if (id) ids.push(id[1]);
  }
  return ids;
}

test('the cloud API page lists every AgentEngine Action and nothing else', () => {
  const { all } = expectedActions();
  const zh = documentedActions(readFileSync(PAGE_ZH, 'utf8'));
  const en = documentedActions(readFileSync(PAGE_EN, 'utf8'));

  assert.ok(all.length > 0, 'No Actions were found in src/server-client.mjs.');

  const missing = all.filter((name) => !zh.includes(name));
  const extra = zh.filter((name) => !all.includes(name));
  assert.deepEqual(
    missing,
    [],
    `Actions missing from reference/agent-engine-api.mdx: ${missing.join(', ')}. Run \`node docs-site/scripts/extract-reference.mjs\`.`,
  );
  assert.deepEqual(
    extra,
    [],
    `The page documents Actions the client no longer sends: ${extra.join(', ')}.`,
  );
  assert.deepEqual(
    zh,
    all,
    'The Action table order must follow SERVER_ACTIONS then SKILL_SERVICE_ACTIONS so reviewers can diff it against the source.',
  );
  assert.deepEqual(en, zh, 'The English Action table must list the same Actions in the same order.');
});

test('the stated Action total matches the client', () => {
  const { server, skill, all } = expectedActions();
  // The intro table states "`37` 个 Action + `5` 个 Skill 服务 Action" in Chinese
  // and "`37` Actions + `5` skill-service Actions" in English.
  const expectations = [
    ['zh', PAGE_ZH, new RegExp(`\`${server.length}\` 个 Action`, 'u'), new RegExp(`\`${skill.length}\` 个 Skill`, 'u')],
    ['en', PAGE_EN, new RegExp(`\`${server.length}\` Actions`, 'u'), new RegExp(`\`${skill.length}\` skill-service Actions`, 'u')],
  ];
  for (const [label, file, serverPattern, skillPattern] of expectations) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, serverPattern, `${label}: the page must state the AgentEngine Action count as ${server.length}.`);
    assert.match(source, skillPattern, `${label}: the page must state the skill-service Action count as ${skill.length}.`);
    // The summary line above the table repeats the combined total.
    assert.ok(
      source.includes(String(all.length)),
      `${label}: the page must mention the combined total ${all.length}.`,
    );
  }
});

test('both locales keep the same heading structure', () => {
  const headings = (file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /^#{2,4}\s/u.test(line))
      .map((line) => line.match(/^#{2,4}/u)[0].length);
  assert.deepEqual(headings(PAGE_EN), headings(PAGE_ZH), 'Chinese and English pages must share their heading structure.');
});

test('the page never publishes an internal endpoint or a credential value', () => {
  const forbidden = [
    ['internal KOP host', /\.inner\.api\.ksyun\.com/iu],
    ['internal KOP host', /\.internal\.api\.ksyun\.com/iu],
    ['real access key', /\bAKIA[0-9A-Z]{16}\b/u],
    ['provider token', /\b(?:ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{24,})\b/u],
    ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ];
  for (const file of [PAGE_ZH, PAGE_EN]) {
    const source = readFileSync(file, 'utf8');
    for (const [name, pattern] of forbidden) {
      assert.ok(!pattern.test(source), `${name} leaked into ${file}`);
    }
  }
});
