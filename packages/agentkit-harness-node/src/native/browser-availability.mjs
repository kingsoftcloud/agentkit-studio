import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { chromium } from 'playwright-core';

function executable(path) {
  try { return isAbsolute(path) && statSync(path).isFile() && (accessSync(path, constants.X_OK), true); }
  catch { return false; }
}

/** Use an installed executable with a fresh browser profile. Discovery performs
 * no download, browser launch, user-profile access or permission grant. */
export function resolveNativeBrowserExecutable({ env = process.env, platform = process.platform,
  bundledPath = chromium.executablePath(), canExecute = executable } = {}) {
  const explicit = env.KSADK_BROWSER_EXECUTABLE_PATH;
  if (explicit) return isAbsolute(explicit) && canExecute(explicit) ? explicit : null;
  const candidates = [bundledPath,
    ...(platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'] : []),
    ...(platform === 'linux' ? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'] : []),
  ];
  return candidates.find(path => typeof path === 'string' && isAbsolute(path) && canExecute(path)) ?? null;
}
