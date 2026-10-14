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

test('Windows tray contains independently sized valid PNG frames for native scaling', () => {
  const ico=readFileSync(new URL('../assets/agentkit-studio-tray.ico',import.meta.url));
  assert.equal(ico.readUInt16LE(2),1);
  assert.equal(ico.readUInt16LE(4),7);
  const sizes=[16,20,24,32,40,48,64];
  sizes.forEach((size,index)=>{
    const entry=6+16*index,offset=ico.readUInt32LE(entry+12),length=ico.readUInt32LE(entry+8);
    assert.equal(ico[entry],size);assert.equal(ico[entry+1],size);
    assert.ok(offset+length<=ico.length);
    const png=ico.subarray(offset,offset+length);
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);
  });
});
