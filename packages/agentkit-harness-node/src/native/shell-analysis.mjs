import { parseBashSyntax } from '../../dist/native-command-plan.mjs';

/** Syntax facts only: no expansion, evaluation, filesystem reads or permission
 * decision. Called inside the bounded policy worker. Comments and quoted
 * heredoc bodies are data; executable substitutions have their own AST nodes.
 * Plan mode uses this same parser through the bundled ZCode classifier.
 */
export function analyzeShellSource(source) {
  const script = parseBashSyntax(source);
  const commands = [], backgrounds = [], scripts = [], lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineAt = position => {
    let lo = 0, hi = lineStarts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= position) lo = mid; else hi = mid; }
    return lo + 1;
  };
  const pending = [{ node: script, depth: 0 }];
  let hasParseErrors = false, hasBashCombinedRedirects = false;
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (depth > 128) throw Error('command_policy_nesting_limit');
    if (node.type === 'Script') scripts.push(node);
    if (['&>', '&>>'].includes(node.operator)) hasBashCombinedRedirects = true;
    if (['AndOr', 'Pipeline'].includes(node.type) && node.operators.length !== node.commands.length - 1) hasParseErrors = true;
    if ((node.type === 'Statement' && node.background) || node.type === 'Coproc') backgrounds.push(lineAt(node.pos));
    if (node.type === 'Command' && node.name) {
      const input = node.redirects.filter(redirect => (redirect.fileDescriptor ?? 0) === 0
        && ['<', '<&', '<<', '<<-', '<<<'].includes(redirect.operator)).at(-1);
      commands.push({ argv: [node.name, ...node.suffix].map(word => word.value), line: lineAt(node.pos),
        stdin: input && ['<<', '<<-', '<<<'].includes(input.operator)
          ? input.operator === '<<<' ? input.target.value : input.content : null });
    }
    // Traverse structural children, including assignments, redirects, compound
    // bodies and command/process/arithmetic substitutions. Never parse raw text
    // payloads a second time: the parser already distinguishes them from code.
    for (const value of Object.values(node).reverse()) {
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) pending.push({ node: value[i], depth: depth + 1 });
      }
      else if (value && typeof value === 'object') pending.push({ node: value, depth: depth + 1 });
    }
    // unbash resolves Word.parts lazily through a non-enumerable getter.
    // Materialize it explicitly, including words outside Command.argv.
    if (!Object.hasOwn(node, 'parts') && Array.isArray(node.parts))
      pending.push({ node: node.parts, depth: depth + 1 });
  }
  if (scripts.some(script => script.errors?.length)) hasParseErrors = true;
  return { commands, backgrounds, hasParseErrors, hasBashCombinedRedirects };
}
