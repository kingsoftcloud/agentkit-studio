import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { diagnoseModelEfforts } from '../src/model-effort-probe.mjs';

async function gateway(replyFor) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const { status, payload } = replyFor(parsed);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload ?? {}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

const OK = { status: 200, payload: { choices: [{ message: { role: 'assistant', content: 'OK' } }] } };

test('a control rejected with generic wording (参数非法) no longer aborts the run', async () => {
  // GLM answers an invalid effort with a bare 400 that names no effort field.
  // The old logic reported every level untested; now each level is measured.
  const server = await gateway(body => {
    const effort = body.reasoning_effort;
    if (effort === 'low') return OK;
    return { status: 400, payload: { error: { message: '参数非法' } } };
  });
  try {
    const result = await diagnoseModelEfforts({ baseUrl: server.baseUrl, apiKey: 'k', modelName: 'glm-5.3', levels: ['low', 'high'], wire: 'openai-chat' });
    assert.equal(result.control, 'inconclusive');
    assert.equal(result.outcomes.find(row => row.level === 'low').outcome, 'accepted');
    // high 400s after low ran, so it is unsupported even without effort wording.
    assert.equal(result.outcomes.find(row => row.level === 'high').outcome, 'rejected');
  } finally { await server.close(); }
});

test('an inconclusive control still lets a clean 200 count as accepted', async () => {
  const server = await gateway(body => {
    if (body.reasoning_effort === 'invalid-studio-effort') return { status: 400, payload: { error: { message: '参数非法' } } };
    return OK;
  });
  try {
    const result = await diagnoseModelEfforts({ baseUrl: server.baseUrl, apiKey: 'k', modelName: 'glm-5.3', levels: ['low', 'high'], wire: 'openai-chat' });
    assert.deepEqual(result.outcomes, [{ level: 'low', outcome: 'accepted' }, { level: 'high', outcome: 'accepted' }]);
  } finally { await server.close(); }
});

test('a blocked control (bad credential) still aborts with untested outcomes', async () => {
  const server = await gateway(() => ({ status: 401, payload: { error: { message: 'invalid api key' } } }));
  try {
    const result = await diagnoseModelEfforts({ baseUrl: server.baseUrl, apiKey: 'bad', modelName: 'glm-5.3', levels: ['low'], wire: 'openai-chat' });
    assert.deepEqual(result.outcomes, [{ level: 'low', outcome: 'untested' }]);
  } finally { await server.close(); }
});
