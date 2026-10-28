import test from 'node:test';
import assert from 'node:assert/strict';
import { installProductCopy, resolveProductCopy } from '../src/product-copy.mjs';

test('product copy preserves the original Chinese and English branding cases and templates', () => {
  const copy = resolveProductCopy();
  assert.deepEqual(copy.chat.zh, { 'chat.deepDiving': '正在执行', 'chat.deepDivingFor': '正在执行，用时 {duration} ···', 'message.turnProcess.worked': '本轮已结束', 'message.turnProcess.took': '本轮已结束，用时 ' });
  assert.deepEqual(copy.chat.en, { 'chat.deepDiving': 'Working', 'chat.deepDivingFor': 'Working for {duration} ···', 'message.turnProcess.worked': 'Turn ended', 'message.turnProcess.took': 'Turn ended in ' });
  assert.equal(copy.conversation.zh['placeholder.hero'], '发消息或创建任务, / 调用指令, @ 文件或对话');
  assert.match(copy.deliverables.zh['changes.title'], /可能含并发修改/);
  for (const locale of ['en', 'zh']) {
    assert.equal(copy.conversation[locale]['hero.headline'], 'AgentKit Studio');
    assert.equal(copy.conversation[locale]['hero.preview'], '');
  }
});

test('each product owner releases only its contributions and rolls back partial installation', () => {
  const active = new Set();
  const locale = { override(namespace) { const token = { namespace }; active.add(token); return () => active.delete(token); } };
  const first = installProductCopy(locale), second = installProductCopy(locale);
  assert.equal(active.size, 6);
  first(); first(); assert.equal(active.size, 3);
  second(); assert.equal(active.size, 0);
  let calls = 0;
  assert.throws(() => installProductCopy({ override(namespace) { if (++calls === 2) throw new Error('second namespace rejected'); return locale.override(namespace); } }));
  assert.equal(active.size, 0);
});

test('native copy remains untouched when the optional product extension is absent', () => {
  const dictionary = Object.freeze({ 'hero.headline': 'Native headline' });
  const locale = Object.freeze({
    dictionary,
    register() { assert.fail('A product must not replace the native dictionary owner'); },
  });
  const dispose = installProductCopy(locale);
  dispose(); dispose();
  assert.equal(locale.dictionary, dictionary);
  assert.equal(locale.dictionary['hero.headline'], 'Native headline');
});
