import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeChildRoleDeclarations } from '../src/native-child-declarations.mjs';

test('preset admission preserves omitted budgets and explicit limits instead of freezing defaults before runtime selection', () => {
  const spec = { sub_agents: [{ name: 'reader', instructions: 'Read evidence', tools: [], inherit_skills: false },
    { name: 'bounded', instructions: 'Read bounded evidence', max_turns: 4, timeout_seconds: 120 }] };
  const roles = nativeChildRoleDeclarations(spec);
  assert.equal(Object.hasOwn(roles[0], 'maxTurns'), false); assert.equal(Object.hasOwn(roles[0], 'timeoutSeconds'), false);
  assert.equal(roles[0].inheritSkills, false); assert.equal(roles[1].maxTurns, 4); assert.equal(roles[1].timeoutSeconds, 120);
  roles[0].name = 'changed'; assert.equal(spec.sub_agents[0].name, 'reader');
  assert.throws(() => nativeChildRoleDeclarations({ subAgents: [{ name: 'invalid', instructions: 'x', maxTurns: 0 }] }), /child_role_invalid/);
});
