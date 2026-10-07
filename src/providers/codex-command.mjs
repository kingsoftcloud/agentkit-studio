/** Locate the pinned official CLI without depending on a system Node/Codex installation. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function resolveCodexCommand({ executable, env = process.env, resolve = spec => require.resolve(spec), node = process.execPath, exists = existsSync } = {}) {
  const configured = String(executable || env.AGENTKIT_CODEX_BIN || '').trim();
  if (configured) return { executable: configured, prefixArgs: [] };
  try {
    const script = resolve('@openai/codex/bin/codex.js');
    const unpacked = script.replace(/([\/\\])app\.asar([\/\\])/, '$1app.asar.unpacked$2');
    return { executable: node, prefixArgs: [unpacked !== script && exists(unpacked) ? unpacked : script] };
  }
  catch { return { executable: 'codex', prefixArgs: [] }; }
}
