import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createBuildOutputRedactor } from '../scripts/build-output-redaction.mjs';

async function redact(chunks) {
  let result = '';
  for await (const chunk of Readable.from(chunks).pipe(createBuildOutputRedactor())) result += chunk.toString();
  return result;
}

test('browser auth URLs are redacted across arbitrary byte boundaries without corrupting UTF-8', async () => {
  const value = ['fixture', 'browser', 'auth'].join('-');
  const text = `构建中\r\ndsh web: http://127.0.0.1:12345/?token=${value}&profile=proof\n`;
  const bytes = Buffer.from(text);
  assert.equal(await redact([...bytes].map(byte => Buffer.from([byte]))), text.replace(value, '[redacted]'));
});

test('the final unterminated line is redacted and ordinary output stays intact', async () => {
  const value = ['fixture', 'last', 'line'].join('_');
  assert.equal(await redact([Buffer.from('ordinary token name\nhttps://example.org/?profile=x&tok'), Buffer.from(`en=${value}`)]),
    'ordinary token name\nhttps://example.org/?profile=x&token=[redacted]');
});
