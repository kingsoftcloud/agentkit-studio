import { parentPort, workerData } from 'node:worker_threads';
import { Workspace, PositionEncoding } from '@astral-sh/ruff-wasm-nodejs';
import { NATIVE_PYTHON_SYNTAX } from './python-syntax.mjs';

if (Workspace.version() !== NATIVE_PYTHON_SYNTAX.parserVersion) throw new Error('Python parser version mismatch');
const workspace = new Workspace({ 'target-version': NATIVE_PYTHON_SYNTAX.targetVersion,
  lint: { select: [] } }, PositionEncoding.Utf32);
const bytes = Buffer.from(workerData, 'utf8');
function issueAt(start, message) {
  const lines = bytes.subarray(0, start).toString('utf8').replace(/\r\n?/g, '\n').split('\n');
  return [{ severity: 'error', line: lines.length, column: Array.from(lines.at(-1)).length + 1, message }];
}
let issues;
try {
  const nul = bytes.indexOf(0);
  if (nul !== -1) issues = issueAt(nul, 'Source code cannot contain NUL bytes.');
  // `check` also performs compile-time checks even with no lint rules selected:
  // duplicate parameters, module nonlocal, unreachable match cases, etc.
  // CPython ast.parse deliberately permits these. `comments` first calls the
  // strict grammar parser, without those later scoping/compilation checks.
  try { if (!issues) workspace.comments(workerData); }
  catch (error) {
    const match = /^(.*) at byte range (\d+)\.\.(\d+)$/s.exec(error.message);
    if (!match) throw error;
    const start = Number(match[2]);
    if (!Number.isSafeInteger(start) || start > bytes.length) throw error;
    issues = issueAt(start, match[1]);
  }
  if (!issues) {
    // Ruff exposes token kind/byte ranges as a debug string in this pinned
    // WASM API. Source lexing remains in Rust: digits in strings/comments,
    // floats, imaginaries and base-prefixed integers never count as decimal
    // integer tokens. Preserve CPython 3.12's default conversion/token limits.
    let nesting = 0, indent = 0;
    const tokens = workspace.tokens(workerData);
    for (const match of tokens.matchAll(/^\s+(Int|Lpar|Rpar|Lsqb|Rsqb|Lbrace|Rbrace|Indent|Dedent) (\d+)\.\.(\d+),?$/gm)) {
      const [, kind, from, to] = match, start = Number(from), end = Number(to);
      if (end < start || end > bytes.length) throw new Error('Python token range invalid');
      let message;
      if (kind === 'Int') {
        const token = bytes.subarray(start, end).toString('utf8');
        if (/^[0-9][0-9_]*$/.test(token) && token.replaceAll('_', '').length > NATIVE_PYTHON_SYNTAX.decimalDigitLimit)
          message = 'Decimal integer exceeds the 4300-digit limit.';
      } else if (['Lpar', 'Lsqb', 'Lbrace'].includes(kind)) {
        if (++nesting > NATIVE_PYTHON_SYNTAX.nestingLimit) message = 'Too many nested parentheses.';
      } else if (['Rpar', 'Rsqb', 'Rbrace'].includes(kind)) nesting--;
      else if (kind === 'Indent') {
        if (++indent > NATIVE_PYTHON_SYNTAX.indentLimit) message = 'Too many levels of indentation.';
      } else if (kind === 'Dedent') indent--;
      if (message) { issues = issueAt(start, message); break; }
    }
  }
  // The grammar-only API parses the latest grammar. Keep its version gates
  // from `check`, but never promote compile-time diagnostics to ast.parse.
  if (!issues) issues = workspace.check(workerData)
    .filter(item => / on Python 3\.12 \(syntax was added in Python 3\.\d+\)$/.test(item.message))
    .slice(0, 1).map(item => ({ severity: 'error', line: item.start_location.row,
      column: item.start_location.column, message: item.message }));
  parentPort.postMessage({ contract: NATIVE_PYTHON_SYNTAX.contract, issues });
} finally { workspace.free(); parentPort.close(); }
