import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
export function browserExecutable() {
  if (process.env.AGENTKIT_NATIVE_TEST_CHROMIUM) return process.env.AGENTKIT_NATIVE_TEST_CHROMIUM;
  const expected = chromium.executablePath(); if (existsSync(expected)) return expected;
  const root = platform() === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright')
    : platform() === 'win32' ? join(homedir(), 'AppData/Local/ms-playwright') : join(homedir(), '.cache/ms-playwright');
  try {
    for (const name of readdirSync(root).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))) {
      for (const suffix of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe']) {
        const value = join(root, name, suffix); if (existsSync(value)) return value;
      }
    }
  } catch {}
  throw new Error('Real cached Chromium or AGENTKIT_NATIVE_TEST_CHROMIUM is required; no download or silent skip.');
}
