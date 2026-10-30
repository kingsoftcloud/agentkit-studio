/** Locate the pinned official CLI without depending on a system Node/Codex installation. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { win32 } from 'node:path';

const require = createRequire(import.meta.url);
const WINDOWS_TRIPLES = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };
const unpackedPath = value => value.replace(/([\/\\])app\.asar([\/\\])/, '$1app.asar.unpacked$2');

// Windows gives a console-subsystem child of a GUI process its own visible
// console window. The npm wrapper re-spawns the native Codex binary with
// inherited stdio and without CREATE_NO_WINDOW, so hiding only the wrapper
// still flashes a window. Resolve the native binary instead; the spawn site
// then asks Windows to create it without a console.
function windowsNativeCodex({ script, platformPackage, resolve, exists, arch }) {
  const path = win32;
  const triple = WINDOWS_TRIPLES[arch === 'arm64' ? 'arm64' : 'x64'];
  const packageRoot = path.dirname(path.dirname(script)); // node_modules\@openai\codex
  const candidates = [];
  try { candidates.push(path.join(path.dirname(resolve(`@openai/${platformPackage}/package.json`)), 'vendor', triple, 'bin', 'codex.exe')); } catch {}
  candidates.push(path.join(packageRoot, '..', platformPackage, 'vendor', triple, 'bin', 'codex.exe'));
  candidates.push(path.join(packageRoot, 'vendor', triple, 'bin', 'codex.exe'));
  for (const candidate of candidates) {
    for (const value of [candidate, unpackedPath(candidate)]) if (exists(value)) return value;
  }
  return null;
}

export function resolveCodexCommand({ executable, env = process.env, resolve = spec => require.resolve(spec), node = process.execPath, exists = existsSync, platform = process.platform, arch = process.arch } = {}) {
  const configured = String(executable || env.AGENTKIT_CODEX_BIN || '').trim();
  if (configured) return { executable: configured, prefixArgs: [] };
  try {
    const script = resolve('@openai/codex/bin/codex.js');
    if (platform === 'win32') {
      const native = windowsNativeCodex({ script, platformPackage: arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64', resolve, exists, arch });
      if (native) return { executable: native, prefixArgs: [] };
    }
    const direct = unpackedPath(script);
    return { executable: node, prefixArgs: [direct !== script && exists(direct) ? direct : script] };
  }
  catch { return { executable: 'codex', prefixArgs: [] }; }
}
