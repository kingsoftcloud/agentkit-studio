import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENTKIT_STUDIO_BRAND, AGENTKIT_STUDIO_MARK_PATH } from '../src/brand.js';

test('brand contract is scoped and has a legible canonical mark', () => {
  assert.equal(AGENTKIT_STUDIO_BRAND.name, 'AgentKit Studio');
  assert.equal(AGENTKIT_STUDIO_BRAND.style, 'industrial-cloud');
  assert.match(AGENTKIT_STUDIO_MARK_PATH, /^M32 6/);
  assert.equal(existsSync(fileURLToPath(new URL('../assets/agentkit-studio-mark.svg', import.meta.url))), true);
  assert.equal(AGENTKIT_STUDIO_BRAND.colors.accent, '#0aa6a6');
  assert.equal(AGENTKIT_STUDIO_BRAND.colors.surface, '#ffffff');
});
