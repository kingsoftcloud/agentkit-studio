import { parentPort, workerData } from 'node:worker_threads';
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { Workspace, PositionEncoding } from '@astral-sh/ruff-wasm-nodejs';
import { NATIVE_PYTHON_SYNTAX } from './python-syntax.mjs';
import { LOCAL_COMMAND_POLICY } from './local-command-policy.mjs';
import { analyzeShellSource } from './shell-analysis.mjs';
import { decodeRuffAst, ruffIdentifier, ruffNodes, ruffString, unwrapRuff } from './ruff-ast.mjs';

if (Workspace.version() !== NATIVE_PYTHON_SYNTAX.parserVersion) throw Error('command_policy_parser_version_mismatch');
const parser = new Workspace({ 'target-version': NATIVE_PYTHON_SYNTAX.targetVersion, lint: { select: [] } }, PositionEncoding.Utf32);
const blocked = new Set(['kill', 'killall', 'nohup', 'pkill', 'setsid']);
const suffixes = new Set(['.py', '.sh', '.bash']);
const subprocesses = new Set(['subprocess.call', 'subprocess.check_call', 'subprocess.check_output', 'subprocess.Popen', 'subprocess.run']);
const python = command => command === 'python' || command.startsWith('python3');
const shell = command => ['bash', 'dash', 'sh'].includes(command);
const finding = (rule, detail, path = '', line = null) => ({ rule, detail, path, line });
function limited(depth) { if (depth > 64) throw Error('command_policy_nesting_limit'); }
function expanded(path) {
  if (path.startsWith('~') && path !== '~' && !path.startsWith('~/')) throw Error('command_policy_named_home_unsupported');
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
function weakRealpath(path, depth = 0) {
  limited(depth); path = resolve(path);
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    try { if (lstatSync(path).isSymbolicLink()) return weakRealpath(resolve(dirname(path), readlinkSync(path)), depth + 1); }
    catch (nested) { if (nested.code !== 'ENOENT' && nested.code !== 'ENOTDIR') throw nested; }
    if (dirname(path) === path) throw error;
    return join(weakRealpath(dirname(path), depth + 1), basename(path));
  }
}
const roots = workerData.allowedRoots.map(path => weakRealpath(expanded(path)));
const cwd = weakRealpath(workerData.cwd);
function inside(path) {
  try { const target = weakRealpath(path); return roots.some(root => target === root || root === sep || target.startsWith(root + sep)); }
  catch { return false; }
}

// Gateway restrictions and local risks consume the same parsed invocations.
// This deliberately retains the existing policy choices, without treating
// comments or heredoc data as command arguments.
function gatewayPolicy(args) {
  for (let i = 0; i + 1 < args.length; i++) if (args[i] === 'rm'
    && args.slice(i + 1, i + 3).some(flag => flag.startsWith('-') && /[rR]/.test(flag)))
    return finding('command_rejected', 'recursive rm is not allowed without explicit approval');
  if (args.some(arg => ['sudo', 'kubectl', 'docker'].includes(arg)))
    return finding('command_rejected', `${args[0]} command is not allowed by default policy`);
  if (args[0] === 'git' && args.length > 1) {
    if (['status', 'diff', 'log', 'show', 'branch', 'ls-files'].includes(args[1])) return null;
    if (['reset', 'clean', 'push', 'checkout'].includes(args[1]))
      return finding('command_rejected', `git ${args[1]} is not allowed without explicit approval`);
  }
  if (args.join(' ').includes('169.254.169.254') || args.join(' ').includes('metadata.google.internal'))
    return finding('command_rejected', 'metadata/private endpoint access is not allowed by default policy');
  return null;
}
function executableIndex(args) {
  return args.findIndex(arg => !/^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(arg));
}
function recursiveForce(args) {
  let options = '';
  for (const arg of args) {
    if ([';', '&&', '||', '|', '--'].includes(arg)) break;
    if (arg.startsWith('-')) options += arg.replace(/^-+/, '');
  }
  return options.toLowerCase().includes('r') && options.toLowerCase().includes('f');
}
function checkTokens(args, path, line, depth, stdin = null) {
  limited(depth);
  const index = executableIndex(args); if (index < 0) return null;
  const command = basename(args[index]).toLowerCase(), rest = args.slice(index + 1);
  if (blocked.has(command)) return finding(`shell.blocked_command.${command}`, `command '${command}' is not allowed by the local-process policy`, path, line);
  if (command === 'rm' && recursiveForce(rest)) return finding('shell.recursive_force_remove', 'recursive forced removal is not allowed', path, line);
  if (stdin !== null && !rest.includes('-c') && !rest.includes('-m')
    && (!rest.length || rest[0] === '-' || shell(command) && rest.includes('-s'))) {
    const result = python(command) ? checkPython(stdin, path || '<stdin>', depth + 1)
      : shell(command) ? checkShell(stdin, path || '<stdin>', depth + 1, false, false, command === 'bash' ? 'bash' : 'posix') : null;
    if (result) return result;
  }
  const option = rest.indexOf('-c');
  if (option < 0 || option + 1 >= rest.length) return null;
  return python(command) ? checkPython(rest[option + 1], path || '<command>', depth + 1)
    : shell(command) ? checkShell(rest[option + 1], path, depth + 1, false, false, command === 'bash' ? 'bash' : 'posix') : null;
}
function checkShell(text, path, depth, governed = false, scanEntries = false, dialect = 'bash') {
  limited(depth);
  const analysis = analyzeShellSource(text);
  if (analysis.hasParseErrors) return finding('invalid_command', 'invalid shell syntax', path);
  if (dialect === 'posix' && analysis.hasBashCombinedRedirects)
    return finding('invalid_command', 'Bash combined redirection requires an explicit Bash interpreter', path);
  if (analysis.backgrounds.length) return finding('shell.background_process', 'background process syntax is not allowed', path, analysis.backgrounds[0]);
  for (const { argv, line, stdin } of analysis.commands) {
    const result = (governed ? gatewayPolicy(argv) : null) ?? checkTokens(argv, path, line, depth + 1, stdin)
      ?? (scanEntries ? scanScripts(argv) : null);
    if (result) return result;
  }
  return null;
}
function callName(value, aliases) {
  const node = unwrapRuff(value);
  if (node?.tag === 'ExprName') { const name = ruffIdentifier(node.fields.id); return aliases.get(name) ?? name; }
  if (node?.tag === 'ExprAttribute') {
    const parent = callName(node.fields.value, aliases), attr = ruffIdentifier(node.fields.attr);
    return parent ? `${parent}.${attr}` : attr;
  }
  return '';
}
function commandLiteral(value) {
  const text = ruffString(value); if (text !== null) return text;
  const node = unwrapRuff(value);
  if (!['ExprList', 'ExprTuple'].includes(node?.tag)) return null;
  const parts = node.fields.elts.map(ruffString);
  return parts.every(part => part !== null) ? parts : null;
}
function keywordTrue(args, name) {
  return args.keywords.some(item => ruffIdentifier(item.fields.arg) === name
    && unwrapRuff(item.fields.value)?.tag === 'ExprBooleanLiteral' && unwrapRuff(item.fields.value).fields.value === true);
}
function checkPython(source, path, depth) {
  limited(depth); if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw Error('command_policy_source_limit');
  let wire;
  try {
    parser.comments(source); // Grammar only, matching ast.parse rather than compile.
    if (parser.check(source).some(item => / on Python 3\.12 \(syntax was added in Python 3\.\d+\)$/.test(item.message))) return null;
    wire = parser.parse(source);
  } catch (error) {
    if (/ at byte range \d+\.\.\d+$/.test(error.message)) return null;
    throw error;
  }
  const nodes = ruffNodes(decodeRuffAst(wire)), aliases = new Map(), bytes = Buffer.from(source);
  for (const node of nodes) {
    if (node.tag === 'StmtImport' || node.tag === 'StmtImportFrom') {
      const module = node.tag === 'StmtImportFrom' ? ruffIdentifier(node.fields.module) : '';
      if (node.tag === 'StmtImportFrom' && !module) continue;
      for (const alias of node.fields.names) {
        const name = ruffIdentifier(alias.fields.name), asname = ruffIdentifier(alias.fields.asname);
        aliases.set(asname ?? name, module ? `${module}.${name}` : name);
      }
    }
  }
  for (const node of nodes) {
    if (node.tag !== 'ExprCall') continue;
    const name = callName(node.fields.func, aliases), args = node.fields.arguments.fields;
    const line = bytes.subarray(0, node.fields.range.range[0]).toString('utf8').split(/\r\n|\r|\n/).length;
    if (['os.kill', 'os.killpg', 'os.setsid'].includes(name)) return finding('python.process_control', `call to ${name} is not allowed`, path, line);
    if (['os.popen', 'os.system'].includes(name) && args.args.length) {
      const text = ruffString(args.args[0]);
      if (text !== null) { const result = checkShell(text, path, depth + 1); if (result) return result; }
    }
    if (subprocesses.has(name)) {
      if (name === 'subprocess.Popen' && keywordTrue(args, 'start_new_session'))
        return finding('python.detached_process', 'subprocess start_new_session=True is not allowed', path, line);
      const command = args.args.length ? commandLiteral(args.args[0]) : null;
      const result = Array.isArray(command) ? checkTokens(command, path, line, depth + 1)
        : typeof command === 'string' && keywordTrue(args, 'shell') ? checkShell(command, path, depth + 1) : null;
      if (result) return result;
    }
    if (name === 'shutil.rmtree' && args.args.length) {
      const value = ruffString(args.args[0]);
      if (value !== null && !inside(resolve(cwd, expanded(value))))
        return finding('path.destructive_outside_workspace', `shutil.rmtree target ${JSON.stringify(value)} is outside the allowed roots`, path, line);
    }
  }
  return null;
}
function directScript(command, rest) {
  if (suffixes.has(extname(command).toLowerCase())) return command;
  if (!(python(basename(command).toLowerCase()) || shell(basename(command).toLowerCase())) || rest.includes('-c') || rest.includes('-m')) return null;
  for (const arg of rest) {
    if (arg === '--' || arg.startsWith('-')) continue;
    return suffixes.has(extname(arg).toLowerCase()) ? arg : null;
  }
  return null;
}
function scanScripts(args) {
  const index = executableIndex(args); if (index < 0) return null;
  const script = directScript(args[index], args.slice(index + 1)); if (script === null) return null;
  let path, source;
  try {
    path = realpathSync(isAbsolute(script) ? script : resolve(cwd, script));
    if (!statSync(path).isFile() || !inside(path)) return null;
    if (statSync(path).size > 2 * 1024 * 1024) throw Error('command_policy_source_limit');
    source = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch (error) { if (error.message === 'command_policy_source_limit') throw error; return null; }
  return extname(path).toLowerCase() === '.py' ? checkPython(source, path, 0)
    : checkShell(source, path, 0, false, false, ['sh', 'dash'].includes(basename(args[index])) ? 'posix' : 'bash');
}
try {
  const { command } = workerData;
  const required = workerData.governed && (typeof command !== 'string' || !command.trim())
    ? finding('command_required', 'command is required') : null;
  parentPort.postMessage({ contract: LOCAL_COMMAND_POLICY, finding: required ?? (typeof command === 'string'
    ? checkShell(command, '', 0, workerData.governed, true) : checkTokens(command, '', null, 0) ?? scanScripts(command)) });
} finally { parser.free(); parentPort.close(); }
