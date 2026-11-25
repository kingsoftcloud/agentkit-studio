/** Track the Studio sources that still import the in-process Harness. */
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = new URL('../ci/harness-host-imports.txt', import.meta.url);
const implementation = /^@kingsoftcloud\/agentkit-harness-(core|node|ui)(?:\/|$)/;

function importsIn(path) {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = new Set();
  const createRequireNames = new Set();
  const constants = new Map();
  function collect(node) {
    if (ts.isImportDeclaration(node) && ['module', 'node:module'].includes(node.moduleSpecifier.text)) {
      const names = node.importClause?.namedBindings;
      if (names && ts.isNamedImports(names)) for (const item of names.elements) {
        if ((item.propertyName ?? item.name).text === 'createRequire') createRequireNames.add(item.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && node.parent.flags & ts.NodeFlags.Const) {
      const name = node.name.text;
      constants.set(name, constants.has(name) ? null : node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(file);
  const requireFactory = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && createRequireNames.has(node.expression.text);
  function literal(node, seen = new Set()) {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return literal(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const value = constants.get(node.text);
      if (value && !seen.has(value)) return literal(value, new Set([...seen, value]));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left, seen), right = literal(node.right, seen);
      if (left !== undefined && right !== undefined) return left + right;
    }
  }
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isExternalModuleReference(node)) specifier = node.expression;
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(callee) && (callee.text === 'require'
        || constants.get(callee.text) && requireFactory(constants.get(callee.text)))
        || requireFactory(callee)
        || ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve') specifier = node.arguments[0];
    }
    const name = specifier && literal(specifier);
    if (name && implementation.test(name)) imports.add(name.replace('@kingsoftcloud/agentkit-harness-', ''));
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...imports].sort();
}

const entries = ['src', 'scripts', 'host-source'].flatMap(directory => {
  const base = resolve(root, directory);
  return readdirSync(base, { recursive: true, withFileTypes: true }).flatMap(entry => {
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    const path = resolve(entry.parentPath, entry.name);
    const imports = importsIn(path);
    if (!imports.length) return [];
    return [relative(root, path).split(sep).join('/') + '\t' + imports.join(' ')];
  });
}).sort();

if (process.argv.includes('--print')) {
  console.log(entries.join('\n'));
} else {
  const expected = readFileSync(baseline, 'utf8').trimEnd().split('\n').filter(line => line && !line.startsWith('#'));
  const current = new Set(entries);
  const previous = new Set(expected);
  const added = entries.filter(entry => !previous.has(entry));
  const changed = expected.filter(entry => !current.has(entry));
  if (added.length || changed.length) {
    for (const entry of added) console.error('Current dependency: ' + entry);
    for (const entry of changed) console.error('Prior dependency:   ' + entry);
    console.error('Review the dependency diff against ci/harness-host-imports.txt.');
    process.exitCode = 1;
  } else console.log(`Reviewed Studio Harness implementation imports in ${current.size} files.`);
}
