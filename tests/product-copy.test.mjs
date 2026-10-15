import test from 'node:test';
import assert from 'node:assert/strict';
import { installProductCopy, resolveProductCopy } from '../src/product-copy.mjs';

test('product copy preserves the original Chinese and English branding cases and templates', () => {
  const copy = resolveProductCopy();
  assert.deepEqual(copy.chat.zh, { 'chat.deepDiving': '正在思考中', 'chat.deepDivingFor': '正在思考中，用时 {duration} ···' });
  assert.deepEqual(copy.chat.en, { 'chat.deepDiving': 'Thinking', 'chat.deepDivingFor': 'Thinking for {duration} ···' });
  assert.equal(copy.conversation.zh['placeholder.hero'], '发消息或创建任务, / 调用指令, @ 文件或对话');
  for (const locale of ['en', 'zh']) {
    assert.equal(copy.conversation[locale]['hero.headline'], 'AgentKit Studio');
    assert.equal(copy.conversation[locale]['hero.preview'], '');
  }
});

test('each product owner releases only its contributions and rolls back partial installation', () => {
  const active = new Set();
  const locale = { override(namespace) { const token = { namespace }; active.add(token); return () => active.delete(token); } };
  const first = installProductCopy(locale), second = installProductCopy(locale);
  assert.equal(active.size, 4);
  first(); first(); assert.equal(active.size, 2);
  second(); assert.equal(active.size, 0);
  let calls = 0;
  assert.throws(() => installProductCopy({ override(namespace) { if (++calls === 2) throw new Error('second namespace rejected'); return locale.override(namespace); } }));
  assert.equal(active.size, 0);
  assert.throws(() => installProductCopy({}), { code: 'DSH_CAPABILITY_UNAVAILABLE' });
});
