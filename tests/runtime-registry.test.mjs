import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// `src/runtime-contract.mjs` is the single place that names `runtime.type`
// values. Before it owned the vocabulary, eighteen modules each hardcoded their
// own array, so adding a runtime meant editing eleven files and every missed
// file became a silent behaviour difference.
//
// This gate makes the registry load-bearing:
//
//   1. the seven sets stay consistent with each other;
//   2. every member has a UI label;
//   3. the capability matrix covers exactly the public set;
//   4. no source module restates a runtime list.
//
// A failure here names the file and line that drifted, so the fix is mechanical
// rather than a search.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const CONTRACT_FILE = join(SRC_ROOT, 'runtime-contract.mjs');
const CONTRACT_REL = 'src/runtime-contract.mjs';
// The sets are declared in a dependency-free module so the browser bundle can
// import them; the contract re-exports them next to the capability matrix.
const VOCABULARY_REL = 'src/runtime-types.mjs';
const REGISTRY_RELS = new Set([CONTRACT_REL, VOCABULARY_REL]);

const toPosix = value => value.split(sep).join('/');

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.name.endsWith('.mjs')) files.push(absolute);
  }
  return files.sort();
}

const contract = await import(CONTRACT_FILE);

const {
  STUDIO_RUNTIME_TYPES,
  STUDIO_EXPERIMENTAL_RUNTIME_TYPES,
  STUDIO_ROUTABLE_RUNTIME_TYPES,
  STUDIO_MANAGED_RUNTIME_TYPES,
  STUDIO_TEAM_RUNTIME_TYPES,
  STUDIO_PROCESS_RUNTIME_TYPES,
  STUDIO_NATIVE_TURN_RUNTIME_TYPES,
  STUDIO_INVOCATION_CONTEXT_RUNTIME_TYPES,
  STUDIO_RUNTIME_SETS,
  STUDIO_RUNTIME_CAPABILITY_MATRIX,
  STUDIO_RUNTIME_CONTRACT_VERSION,
} = contract;

/**
 * The registry, restated here on purpose.
 *
 * This test is the artefact that has to be edited when a set is added or renamed;
 * a silently growing registry is exactly the drift it guards against. The keys
 * are the *questions* the sets answer, not the array names.
 */
const EXPECTED_SETS = {
  public: STUDIO_RUNTIME_TYPES,
  experimental: STUDIO_EXPERIMENTAL_RUNTIME_TYPES,
  routable: STUDIO_ROUTABLE_RUNTIME_TYPES,
  managed: STUDIO_MANAGED_RUNTIME_TYPES,
  team: STUDIO_TEAM_RUNTIME_TYPES,
  process: STUDIO_PROCESS_RUNTIME_TYPES,
  nativeTurn: STUDIO_NATIVE_TURN_RUNTIME_TYPES,
  invocationContext: STUDIO_INVOCATION_CONTEXT_RUNTIME_TYPES,
};

const PREDICATES = {
  public: contract.isStudioRuntimeType,
  routable: contract.isRoutableRuntimeType,
  managed: contract.isManagedRuntimeType,
  team: contract.isTeamRuntimeType,
  process: contract.isProcessRuntimeType,
  nativeTurn: contract.isNativeTurnRuntimeType,
  invocationContext: contract.isInvocationContextRuntimeType,
};

const contains = (superset, subset) => subset.every(value => superset.includes(value));

test('the registry exposes exactly the documented sets', () => {
  assert.deepEqual(
    Object.keys(STUDIO_RUNTIME_SETS).sort(),
    Object.keys(EXPECTED_SETS).sort(),
    `${CONTRACT_REL} exports STUDIO_RUNTIME_SETS with an unexpected shape. A new set needs a documented question in the registry comment and an entry here.`,
  );
  for (const [name, value] of Object.entries(EXPECTED_SETS)) {
    assert.ok(Array.isArray(value), `Set "${name}" must be a plain array so .includes() and JSON Schema enums work.`);
    assert.ok(Object.isFrozen(value), `Set "${name}" must be frozen; a mutable shared set lets one caller change every other caller.`);
    assert.ok(value.length > 0, `Set "${name}" must not be empty.`);
    const duplicates = value.filter((type, index) => value.indexOf(type) !== index);
    assert.deepEqual(duplicates, [], `Set "${name}" repeats a runtime type: ${duplicates.join(', ')}`);
    assert.strictEqual(STUDIO_RUNTIME_SETS[name], value, `STUDIO_RUNTIME_SETS.${name} must be the same frozen array, not a copy.`);
  }
});

test('the seven sets stay consistent with each other', () => {
  // Membership is not free-form: a runtime is in a set only when it has that
  // capability, so every relation below is a product invariant, not a style rule.
  assert.ok(contains(STUDIO_ROUTABLE_RUNTIME_TYPES, STUDIO_RUNTIME_TYPES), 'Every public runtime must be routable.');
  assert.ok(contains(STUDIO_ROUTABLE_RUNTIME_TYPES, STUDIO_EXPERIMENTAL_RUNTIME_TYPES), 'The experimental engine is routable even though it is not public.');
  assert.deepEqual(
    [...STUDIO_ROUTABLE_RUNTIME_TYPES].sort(),
    [...STUDIO_RUNTIME_TYPES, ...STUDIO_EXPERIMENTAL_RUNTIME_TYPES].sort(),
    'The routable set must be exactly public ∪ experimental; anything else is a runtime the Host can reach but nobody declared.',
  );
  assert.deepEqual(
    STUDIO_RUNTIME_TYPES.filter(type => STUDIO_EXPERIMENTAL_RUNTIME_TYPES.includes(type)),
    [],
    'A runtime cannot be both public and experimental.',
  );
  assert.ok(contains(STUDIO_RUNTIME_TYPES, STUDIO_MANAGED_RUNTIME_TYPES), 'Only a public runtime can be deployed as a managed runtime.');
  assert.ok(contains(STUDIO_RUNTIME_TYPES, STUDIO_TEAM_RUNTIME_TYPES), 'Only a public runtime can back an expert-team role.');
  assert.ok(contains(STUDIO_ROUTABLE_RUNTIME_TYPES, STUDIO_PROCESS_RUNTIME_TYPES), 'A process runtime must be routable.');
  assert.ok(contains(STUDIO_ROUTABLE_RUNTIME_TYPES, STUDIO_NATIVE_TURN_RUNTIME_TYPES), 'A native-turn runtime must be routable.');
  assert.ok(contains(STUDIO_ROUTABLE_RUNTIME_TYPES, STUDIO_INVOCATION_CONTEXT_RUNTIME_TYPES), 'An invocation-context runtime must be routable.');
  assert.deepEqual(
    [...new Set(['dsh-native', ...STUDIO_PROCESS_RUNTIME_TYPES, ...STUDIO_NATIVE_TURN_RUNTIME_TYPES])].sort(),
    [...STUDIO_ROUTABLE_RUNTIME_TYPES].sort(),
    'Every routable runtime executes either in the DSH loop itself, in its own process, or over the native turn port.',
  );
  assert.ok(
    !STUDIO_PROCESS_RUNTIME_TYPES.includes('dsh-native') && !STUDIO_NATIVE_TURN_RUNTIME_TYPES.includes('dsh-native'),
    'dsh-native runs in the DSH loop itself: it is neither a child process nor a native-turn port.',
  );
});

test('every runtime type has a UI label', () => {
  const theme = readFileSync(join(SRC_ROOT, 'client', 'theme.mjs'), 'utf8');
  const themeLines = theme.split('\n');
  const missing = [...new Set([...STUDIO_RUNTIME_TYPES, ...STUDIO_EXPERIMENTAL_RUNTIME_TYPES])]
    .filter(type => !themeLines.some(line => new RegExp(`['"]?${type}['"]?\\s*:`).test(line)));
  assert.deepEqual(
    missing,
    [],
    `RUNTIME_LABELS is missing an entry for: ${missing.join(', ')}. Adding a runtime means adding its label in src/client/theme.mjs.`,
  );
});

test('the capability matrix covers exactly the public runtime set', () => {
  assert.strictEqual(STUDIO_RUNTIME_CONTRACT_VERSION, 'agentkit.studio.runtime/v1', 'The contract version is part of the public wire surface.');
  assert.deepEqual(
    Object.keys(STUDIO_RUNTIME_CAPABILITY_MATRIX).sort(),
    [...STUDIO_RUNTIME_TYPES].sort(),
    `${CONTRACT_REL} must describe exactly the public runtimes. The experimental engine is not in the frozen matrix.`,
  );
  for (const [type, entry] of Object.entries(STUDIO_RUNTIME_CAPABILITY_MATRIX)) {
    assert.ok(entry.owner, `Matrix entry "${type}" needs an owner.`);
    assert.ok(entry.execution, `Matrix entry "${type}" needs an execution model.`);
    assert.ok(entry.contract, `Matrix entry "${type}" needs a contract id.`);
    assert.ok(Array.isArray(entry.capabilities) && entry.capabilities.length, `Matrix entry "${type}" needs capabilities.`);
  }
});

test('predicates agree with their sets', () => {
  const all = [...new Set([...STUDIO_RUNTIME_TYPES, ...STUDIO_EXPERIMENTAL_RUNTIME_TYPES])];
  for (const [name, predicate] of Object.entries(PREDICATES)) {
    assert.strictEqual(typeof predicate, 'function', `Predicate for "${name}" must be exported.`);
    for (const type of all) {
      assert.strictEqual(
        predicate(type),
        EXPECTED_SETS[name].includes(type),
        `Predicate for "${name}" disagrees with its set for "${type}".`,
      );
    }
    for (const value of [undefined, null, '', 'unknown', 'DSH-NATIVE']) {
      assert.strictEqual(predicate(value), false, `Predicate for "${name}" must reject ${JSON.stringify(value)}.`);
    }
  }
});

/**
 * Runtime-list literals that are deliberately *not* the registry.
 *
 * `deployment-storage.mjs` validates the frameworks a Server declares inside its
 * `agentengine.container-storage/v1` capability. That is the platform's own
 * statement about which runtimes may request persistent container storage — it
 * is not a Studio runtime list, and naming it here would invent a semantic the
 * source does not document. Keep the exception narrow and justified.
 */
const LITERAL_EXCEPTIONS = new Map([
  ['src/deployment-storage.mjs', ["['harness', 'codex']"]],
]);

const RUNTIME_VOCABULARY = new Set([...STUDIO_RUNTIME_TYPES, ...STUDIO_EXPERIMENTAL_RUNTIME_TYPES]);
const STRING_LITERAL = /'([^'\\]*)'|"([^"\\]*)"/g;

/** Every `[ ... ]` block whose members are all runtime types, with its line. */
function runtimeListLiterals(source) {
  const found = [];
  for (const match of source.matchAll(/\[([^[\]]*)\]/g)) {
    const members = [...match[1].matchAll(STRING_LITERAL)].map(entry => entry[1] ?? entry[2]);
    if (members.length < 2 || !members.every(member => RUNTIME_VOCABULARY.has(member))) continue;
    const line = source.slice(0, match.index).split('\n').length;
    found.push({ literal: match[0], line });
  }
  return found;
}

test('no source module restates a runtime list', () => {
  const offenders = [];
  for (const file of walk(SRC_ROOT)) {
    const relativePath = toPosix(relative(REPO_ROOT, file));
    if (REGISTRY_RELS.has(relativePath)) continue;
    const source = readFileSync(file, 'utf8');
    const allowed = LITERAL_EXCEPTIONS.get(relativePath) ?? [];
    for (const { literal, line } of runtimeListLiterals(source)) {
      if (allowed.includes(literal)) continue;
      offenders.push(`${relativePath}:${line} hardcodes ${literal}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A runtime list is hardcoded outside the registry. Import the set or predicate from ${CONTRACT_REL} instead, or add a justified entry to LITERAL_EXCEPTIONS.\n${offenders.join('\n')}`,
  );
});
