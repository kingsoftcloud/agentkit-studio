import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENTKIT_STUDIO_BRAND, AGENTKIT_STUDIO_MARK_BODY, AGENTKIT_STUDIO_MARK_SVG } from '../src/brand.js';

test('brand contract is scoped and has a legible canonical mark', () => {
  assert.equal(AGENTKIT_STUDIO_BRAND.name, 'AgentKit Studio');
  assert.equal(AGENTKIT_STUDIO_BRAND.style, 'dsh-native');
  assert.equal(AGENTKIT_STUDIO_BRAND.mark, 'Nexus');
  assert.match(AGENTKIT_STUDIO_MARK_BODY, /fill="#78dfec"/);
  for (const name of ['agentkit-studio.svg', 'agentkit-studio-mark.svg']) {
    assert.equal(readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8').trim(), AGENTKIT_STUDIO_MARK_SVG);
  }
  assert.equal(AGENTKIT_STUDIO_BRAND.colors.accent, '#1858d6');
  assert.equal(AGENTKIT_STUDIO_BRAND.colors.surface, '#ffffff');
});
