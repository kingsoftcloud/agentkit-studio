/** Opt-in live-model acceptance: real Codex writes and audits a pelican SVG after a >180s tool round. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexRuntime } from '../src/providers/codex-runtime.mjs';

if (!process.argv.includes('--execute')) {
  console.log('Use --execute [--model ID] [--output DIR] for a real Codex task; consumes model usage and takes at least 190 seconds.');
} else {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const root = resolve(option('--output') || `.artifacts/codex-long-task-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const model = option('--model') || 'gpt-6-astra';
  const nonce = randomUUID();
  const events = [], audits = [];
  const started = Date.now();
  const runtime = createCodexRuntime({ cwd: root, sandbox: 'workspace-write', timeoutMs: 900_000 });
  let result;
  try {
    for await (const event of runtime.stream({
      model,
      input: 'Generate an SVG of a pelican riding a bicycle. Save it as pelican.svg in the working directory, run audit_pelican, then add the returned verification token in an XML comment in the SVG. Verify the final file and report its path. Finish all steps in this task.',
      systemPrompt: 'Use native file or command tools for creating and inspecting files. For this code artifact no desktop UI is needed. The audit tool performs a slow external check: await its result and continue the task. Recover from correctable tool errors and inspect the final artifact before reporting success.',
      dynamicTools: [{ name: 'audit_pelican', description: 'Inspect the actual pelican.svg file and perform a slow external audit, returning a verification token needed for final delivery.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
      toolHandler: async ({ name, signal }) => {
        assert.equal(name, 'audit_pelican');
        const svg = await readFile(join(root, 'pelican.svg'), 'utf8');
        assert.match(svg, /<svg\b/); assert.match(svg, /<\/svg>/);
        audits.push({ at: new Date().toISOString(), bytes: Buffer.byteLength(svg) });
        console.log('Live audit started; waiting 190 seconds to cross the previous timeout.', new Date().toISOString());
        await delay(190_000, undefined, { signal });
        return { accepted: true, verificationToken: nonce, instruction: 'Add this token to an XML comment in pelican.svg, inspect it, then deliver the path.' };
      },
    })) {
      events.push(event);
      if (event.type === 'tool') console.log(`tool ${event.phase}: ${event.name}`);
      if (event.type === 'text') process.stdout.write(event.text);
    }
    const svg = await readFile(join(root, 'pelican.svg'), 'utf8');
    assert.ok(Date.now() - started > 180_000);
    assert.ok(audits.length > 0);
    assert.ok(svg.includes(nonce), 'the agent must continue after the slow tool and incorporate its unpredictable result');
    assert.ok(events.some(event => event.type === 'tool' && event.name === 'audit_pelican' && event.phase === 'completed'));
    result = { accepted: true, realCodex: true, realModel: model, syntheticModel: false,
      elapsedMs: Date.now() - started, delayedToolMs: 190_000, audits: audits.length,
      artifact: join(root, 'pelican.svg'), sha256: createHash('sha256').update(svg).digest('hex'),
      continuedAfterSlowTool: true, completedAt: new Date().toISOString(),
      boundary: 'Live single-turn model/tool task; does not claim process-crash restoration or cross-turn native thread resume.' };
  } catch (error) {
    result = { accepted: false, realCodex: true, realModel: model, elapsedMs: Date.now() - started, code: error.code, error: error.message };
    process.exitCode = 1;
  }
  await writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log('\n' + JSON.stringify(result, null, 2));
}
