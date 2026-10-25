import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync, renameSync, cpSync, realpathSync as rps } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createStudioNativeSkillSource, loadConfiguredNativeSkills, SKILL_SOURCE_CONTRACT } from '../src/providers/native-skill-source.mjs';

const sha256Str = v => 'sha256:' + createHash('sha256').update(v).digest('hex');

// Use realpathSync on tmpdir to avoid macOS /var system alias in symlink tests.
const realTmp = rps(tmpdir());
function setupDir(t) {
  const root = mkdtempSync(join(realTmp, 'skill-src-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function throwsCode(fn, code) { assert.throws(fn, e => e.code === code, `expected ${code}`); }
async function rejectsCode(p, code) { await assert.rejects(p, e => e.code === code, `expected ${code}`); }

test('configured local Skills use immediate children in Python path order and pin complete packages', async t => {
  const root = setupDir(t);
  writeFileSync(join(root, 'SKILL.md'), 'Root is not a runtime child Skill');
  for (const [directory, name] of [['\u{10000}', 'supplementary'], ['\uE000', 'bmp'], ['.local', 'hidden'], ['upper', 'Upper-Name']]) {
    const child = join(root, directory); mkdirSync(join(child, 'scripts'), { recursive: true });
    writeFileSync(join(child, 'SKILL.md'), `---\r\nname: ${name}\r\ndescription: Local\r\n---\r\nInstructions`);
    writeFileSync(join(child, 'scripts/run.mjs'), 'console.log(42)');
  }
  mkdirSync(join(root, 'container/deep'), { recursive: true });
  writeFileSync(join(root, 'container/deep/SKILL.md'), 'Nested is not an immediate child');
  const definitions = loadConfiguredNativeSkills({ directory: root });
  assert.deepEqual(definitions.map(item => item.name), ['hidden', 'upper-name', 'bmp', 'supplementary']);
  assert.ok(definitions.every(item => item.invocation.modelInvocable));
  const first = createStudioNativeSkillSource({ definitions });
  const ref = first.source.refs.find(ref => ref.includes('bmp'));
  assert.match(await first.source.fullText(ref), /name: bmp\r\n/);
  writeFileSync(join(root, '\uE000/scripts/run.mjs'), 'console.log(43)');
  await rejectsCode(first.source.fullText(ref), 'skill_source_content_changed');
  throwsCode(() => createStudioNativeSkillSource({ definitions: loadConfiguredNativeSkills({ directory: root }),
    expectedBinding: first.binding }), 'skill_source_binding_mismatch');
});

test('configured local Skills retain optional missing roots and reject conflicts, links and special manifests', t => {
  const root = setupDir(t), bound = [{ name: 'inline', content: '' }];
  assert.deepEqual(loadConfiguredNativeSkills({ directory: join(root, 'missing'), definitions: bound }), bound);
  assert.deepEqual(loadConfiguredNativeSkills({ definitions: bound }), bound);
  const child = join(root, 'alpha'); mkdirSync(child); writeFileSync(join(child, 'SKILL.md'), '');
  const definitions = loadConfiguredNativeSkills({ directory: root, definitions: bound });
  assert.deepEqual(definitions.map(item => item.name), ['inline', 'alpha']);
  assert.equal(definitions[1].content, '');
  assert.deepEqual(loadConfiguredNativeSkills({ directory: root, definitions }), definitions, 'same source is not registered twice');
  throwsCode(() => loadConfiguredNativeSkills({ directory: root, definitions: [{ name: 'alpha', content: 'Different' }] }),
    'skill_source_alias_conflict');
  rmSync(join(child, 'SKILL.md')); mkdirSync(join(child, 'SKILL.md'));
  throwsCode(() => loadConfiguredNativeSkills({ directory: root }), 'skill_source_special');
  rmSync(join(child, 'SKILL.md'), { recursive: true });
  symlinkSync(join(root, 'SKILL.md'), join(child, 'SKILL.md'));
  throwsCode(() => loadConfiguredNativeSkills({ directory: root }), 'skill_source_manifest_symlink');
});

test('inline skill with no resourceBase', async t => {
  const def = { name: 'my-skill', content: '---\nname: my-skill\ndescription: A test\n---\nBody' };
  const { source, binding } = createStudioNativeSkillSource({ definitions: [def] });
  assert.equal(binding.skills[0].skillId, 'skill://my-skill@1.0.0');
  assert.equal(Object.keys(binding.skills[0].resourceDigests).length, 0);
  assert.equal((await source.manifest('skill://my-skill@1.0.0')).summary, 'A test');
  assert.equal(await source.fullText('skill://my-skill@1.0.0'), def.content);
});

test('directory skill with resources', async t => {
  const root = setupDir(t);
  const content = '---\nname: dir-skill\ndescription: Dir\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), content);
  writeFileSync(join(root, 'helper.py'), 'print("hi")');
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'config.json'), '{}');
  const def = { name: 'dir-skill', content, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } };
  const { source, binding } = createStudioNativeSkillSource({ definitions: [def] });
  const m = await source.manifest('skill://dir-skill@1.0.0');
  assert.ok(m.resourceRefs.includes('helper.py'));
  assert.equal((await source.resource('skill://dir-skill@1.0.0', 'helper.py')).toString(), 'print("hi")');
  assert.equal(await source.fullText('skill://dir-skill@1.0.0'), content);
});

test('manifest bytes mismatch rejects', t => {
  const root = setupDir(t);
  writeFileSync(join(root, 'SKILL.md'), '---\nname: t\n---\nActual');
  throwsCode(() => createStudioNativeSkillSource({ definitions: [{ name: 't', content: '---\nname: t\n---\nDifferent', path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] }), 'skill_source_manifest_mismatch');
});

test('group execute bit change (0750→0740) detected', t => {
  const root = setupDir(t);
  const content = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), content);
  writeFileSync(join(root, 'run.sh'), '#!/bin/sh\necho');
  chmodSync(join(root, 'run.sh'), 0o750);
  const def = { name: 't', content, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } };
  const first = createStudioNativeSkillSource({ definitions: [def] });
  chmodSync(join(root, 'run.sh'), 0o740);
  throwsCode(() => createStudioNativeSkillSource({ definitions: [def], expectedBinding: first.binding }), 'skill_source_binding_mismatch');
});

test('parent symlink to real directory rejected', t => {
  const root = setupDir(t);
  const real = mkdtempSync(join(realTmp, 'skill-real-'));
  t.after(() => rmSync(real, { recursive: true, force: true }));
  const content = '---\nname: t\n---\nBody';
  writeFileSync(join(real, 'SKILL.md'), content);
  symlinkSync(real, join(root, 'linked'));
  throwsCode(() => createStudioNativeSkillSource({ definitions: [{ name: 't', content, path: join(root, 'linked', 'SKILL.md'), resourceBase: { kind: 'directory', path: join(root, 'linked') } }] }), 'skill_source_root_symlink');
});

test('definition order independence — reverse order same binding', t => {
  const rootA = setupDir(t);
  const rootB = setupDir(t);
  const cA = '---\nname: a\n---\nA', cB = '---\nname: b\n---\nB';
  writeFileSync(join(rootA, 'SKILL.md'), cA);
  writeFileSync(join(rootB, 'SKILL.md'), cB);
  const defA = { name: 'a', content: cA, path: join(rootA, 'SKILL.md'), resourceBase: { kind: 'directory', path: rootA } };
  const defB = { name: 'b', content: cB, path: join(rootB, 'SKILL.md'), resourceBase: { kind: 'directory', path: rootB } };
  const fwd = createStudioNativeSkillSource({ definitions: [defA, defB] });
  const rev = createStudioNativeSkillSource({ definitions: [defB, defA] });
  assert.deepEqual(fwd.binding, rev.binding);
  // Canonical serialize/parse rebind succeeds from either.
  const restored = JSON.parse(canonical(fwd.binding));
  createStudioNativeSkillSource({ definitions: [defB, defA], expectedBinding: restored });
});

test('2050 empty directories exceeds entry limit', t => {
  const root = setupDir(t);
  const content = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), content);
  for (let i = 0; i < 2050; i++) mkdirSync(join(root, `d${i}`));
  throwsCode(() => createStudioNativeSkillSource({ definitions: [{ name: 't', content, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] }), 'skill_source_too_many_entries');
});

test('source.refs is frozen (caller cannot mutate)', t => {
  const { source } = createStudioNativeSkillSource({ definitions: [{ name: 'x', content: 'c' }] });
  assert.ok(Object.isFrozen(source.refs));
});

test('disabled skill filtered, not thrown', t => {
  const { source, binding } = createStudioNativeSkillSource({ definitions: [
    { name: 'active', content: '---\nname: active\n---\nA' },
    { name: 'off', content: 'c', invocation: { modelInvocable: false, userInvocable: true } },
  ] });
  assert.equal(binding.skills.length, 1);
  assert.equal(source.refs[0], 'skill://active@1.0.0');
});

test('all disabled → empty', t => {
  const { source, binding } = createStudioNativeSkillSource({ definitions: [{ name: 'd', content: 'c', invocation: { modelInvocable: false } }] });
  assert.equal(binding.skills.length, 0);
  assert.equal(source.refs.length, 0);
});

test('empty definitions → empty', t => {
  const { source, binding } = createStudioNativeSkillSource({ definitions: [] });
  assert.equal(binding.skills.length, 0);
});

test('alias conflict rejects', () => {
  throwsCode(() => createStudioNativeSkillSource({ definitions: [{ name: 's', content: 'A' }, { name: 's', content: 'B' }] }), 'skill_source_alias_conflict');
});

test('wrong expectedBinding rejects', () => {
  throwsCode(() => createStudioNativeSkillSource({ definitions: [{ name: 't', content: 'c' }], expectedBinding: { contract: 'x' } }), 'skill_source_binding_mismatch');
});

test('file change after admission detected', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  writeFileSync(join(root, 'f.py'), 'orig');
  const { source } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] });
  writeFileSync(join(root, 'f.py'), 'changed');
  await rejectsCode(source.manifest('skill://t@1.0.0'), 'skill_source_content_changed');
});

test('file added after admission detected', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  const { source } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] });
  writeFileSync(join(root, 'new.py'), 'new');
  await rejectsCode(source.manifest('skill://t@1.0.0'), 'skill_source_content_changed');
});

test('file deleted after admission detected', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  writeFileSync(join(root, 'f.py'), 'f');
  const { source } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] });
  rmSync(join(root, 'f.py'));
  await rejectsCode(source.fullText('skill://t@1.0.0'), 'skill_source_content_changed');
});

test('symlink in directory rejected', t => {
  const root = setupDir(t);
  writeFileSync(join(root, 'SKILL.md'), '---\nname: t\n---\nBody');
  writeFileSync(join(root, 't.txt'), 't');
  symlinkSync('t.txt', join(root, 'l.txt'));
  throwsCode(() => createStudioNativeSkillSource({ definitions: [{ name: 't', content: '---\nname: t\n---\nBody', path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] }), 'skill_source_symlink');
});

test('non-canonical ref rejected (../, /abs, empty, NUL, backslash)', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  writeFileSync(join(root, 'f.py'), 'x');
  const { source } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] });
  await rejectsCode(source.resource('skill://t@1.0.0', '../x'), 'skill_source_ref_invalid');
  await rejectsCode(source.resource('skill://t@1.0.0', '/x'), 'skill_source_ref_invalid');
  await rejectsCode(source.resource('skill://t@1.0.0', ''), 'skill_source_ref_invalid');
  await rejectsCode(source.resource('skill://t@1.0.0', 'a\\b'), 'skill_source_ref_invalid');
  await rejectsCode(source.resource('skill://t@1.0.0', 'a\0b'), 'skill_source_ref_invalid');
});

test('legal foo..txt accepted', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  writeFileSync(join(root, 'foo..txt'), 'content');
  const { source } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] });
  assert.equal((await source.resource('skill://t@1.0.0', 'foo..txt')).toString(), 'content');
});

test('unbound ref rejected', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  const { source } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] });
  await rejectsCode(source.resource('skill://t@1.0.0', 'nope.py'), 'skill_source_ref_unbound');
});

test('cold rebuild expectedBinding reproduces, content change rejects', t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  writeFileSync(join(root, 'f.py'), 'x');
  const def = { name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } };
  const first = createStudioNativeSkillSource({ definitions: [def] });
  const restored = JSON.parse(canonical(first.binding));
  createStudioNativeSkillSource({ definitions: [def], expectedBinding: restored });
  writeFileSync(join(root, 'f.py'), 'changed');
  throwsCode(() => createStudioNativeSkillSource({ definitions: [def], expectedBinding: restored }), 'skill_source_binding_mismatch');
});

test('empty name and missing/non-string content rejected; an empty local manifest stays a pinned empty string', async () => {
  throwsCode(() => createStudioNativeSkillSource({ definitions: [{ name: '', content: 'c' }] }), 'skill_source_name_missing');
  for (const content of [undefined, null, 0, {}])
    throwsCode(() => createStudioNativeSkillSource({ definitions: [{ name: 't', content }] }), 'skill_source_content_missing');
  const empty = createStudioNativeSkillSource({ definitions: [{ name: 't', content: '' }] });
  assert.equal(await empty.source.fullText('skill://t@1.0.0'), '');
});

test('summary from frontmatter or first body line', async t => {
  const { source: s1 } = createStudioNativeSkillSource({ definitions: [{ name: 's1', content: '---\ndescription: Desc\n---\nBody' }] });
  assert.equal((await s1.manifest('skill://s1@1.0.0')).summary, 'Desc');
  const { source: s2 } = createStudioNativeSkillSource({ definitions: [{ name: 's2', content: '# Heading\nText' }] });
  assert.equal((await s2.manifest('skill://s2@1.0.0')).summary, 'Heading');
});

test('sanitized alias for special chars', t => {
  const { source } = createStudioNativeSkillSource({ definitions: [{ name: 'My Cool!', content: 'c' }] });
  assert.equal(source.refs[0], 'skill://My-Cool@1.0.0');
});

test('resource > 32768 bytes rejected', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(32769, 0x41));
  const { source } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] });
  await rejectsCode(source.resource('skill://t@1.0.0', 'big.bin'), 'skill_source_resource_too_large');
});

test('resource bytes changed after admission rejects', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  writeFileSync(join(root, 'f.py'), 'orig');
  const { source } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] });
  writeFileSync(join(root, 'f.py'), 'changed');
  await rejectsCode(source.resource('skill://t@1.0.0', 'f.py'), 'skill_source_content_changed');
});

test('root replaced with identical-bytes new directory detected (dev+ino pin)', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  writeFileSync(join(root, 'f.py'), 'x');
  const def = { name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } };
  const { source } = createStudioNativeSkillSource({ definitions: [def] });
  // Move the root away, copy it back with identical bytes — new directory object.
  const backup = join(realTmp, 'skill-backup-' + Date.now());
  renameSync(root, backup);
  t.after(() => { try { rmSync(backup, { recursive: true, force: true }); } catch {} });
  cpSync(backup, root, { recursive: true });
  // The root is a different directory object (dev+ino changed); recheckRoot must reject.
  await rejectsCode(source.fullText('skill://t@1.0.0'), 'skill_source_root_changed');
});

test('root deleted — error does not leak host absolute path', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  const def = { name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } };
  const { source } = createStudioNativeSkillSource({ definitions: [def] });
  rmSync(root, { recursive: true, force: true });
  try {
    await source.fullText('skill://t@1.0.0');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.ok(!e.message.includes(root), 'error message must not contain the host absolute path');
    assert.ok(!e.message.includes('/var/folders/') || !e.message.includes(root), 'no host path leak');
  }
});

test('__proto__ filename is a real resource, not a prototype setter', async t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  writeFileSync(join(root, '__proto__'), 'proto-content');
  const def = { name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } };
  const { source, binding } = createStudioNativeSkillSource({ definitions: [def] });
  // __proto__ must appear in resourceDigests and resourceRefs.
  const m = await source.manifest('skill://t@1.0.0');
  assert.ok(m.resourceRefs.includes('__proto__'), '__proto__ in resourceRefs');
  assert.ok(Object.hasOwn(binding.skills[0].resourceDigests, '__proto__'), '__proto__ in resourceDigests');
  // resource() must return the actual bytes, not 'changed'.
  const res = await source.resource('skill://t@1.0.0', '__proto__');
  assert.equal(res.toString('utf-8'), 'proto-content');
});

test('manifestDigest is SHA256 of raw content, not metadata', t => {
  const c1 = '---\nname: t\ndescription: Summary A\n---\nBody';
  const c2 = '---\nname: t\ndescription: Summary B\n---\nBody';
  const { binding: b1 } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c1 }] });
  const { binding: b2 } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c2 }] });
  // Different content → different manifestDigest.
  assert.notEqual(b1.skills[0].manifestDigest, b2.skills[0].manifestDigest);
  // manifestDigest = sha256(content).
  assert.equal(b1.skills[0].manifestDigest, sha256Str(c1));
  assert.equal(b2.skills[0].manifestDigest, sha256Str(c2));
  // Repeat admission preserves the raw-content digest.
  const { binding: b3 } = createStudioNativeSkillSource({ definitions: [{ name: 't', content: c1 }] });
  assert.equal(b3.skills[0].manifestDigest, b1.skills[0].manifestDigest);
});

test('opendirSync bounded: 2049 entries rejected', t => {
  const root = setupDir(t);
  const c = '---\nname: t\n---\nBody';
  writeFileSync(join(root, 'SKILL.md'), c);
  for (let i = 0; i < 2049; i++) mkdirSync(join(root, `d${i}`));
  throwsCode(() => createStudioNativeSkillSource({ definitions: [{ name: 't', content: c, path: join(root, 'SKILL.md'), resourceBase: { kind: 'directory', path: root } }] }), 'skill_source_too_many_entries');
});
