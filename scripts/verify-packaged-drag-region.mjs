#!/usr/bin/env node
/**
 * Verify the Windows drag-region repair actually shipped in a packaged Studio app.
 *
 * The release lane packs this plugin, installs it into the DSH Desktop runtime and
 * produces `app.asar`. A green source checkout is not evidence: the previous
 * Windows package carried the old `[data-windows-titlebar]` drag rule even though
 * a branch contained the repair. This script inspects the final archive and fails
 * when the shipped plugin is not the repaired build.
 *
 * Usage:
 *   node scripts/verify-packaged-drag-region.mjs <app.asar | plugin-dir> [--expect-version 0.0.13] [--json report.json]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_NAME = '@kingsoftcloud/agentkit-studio';
const DRAG_STRIP_MARKER = 'data-studio-window-drag-strip';
const WINDOW_REGION_MARKER = 'data-studio-window-region';
const WINDOWS_ROOT_MARKER = 'data-windows-titlebar';
const MACOS_SCOPE = "html[data-platform='darwin']";
const MIN_BUNDLE_BYTES = 500_000;

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const target = args.find((value, index) => !value.startsWith('--') && args[index - 1] !== '--json' && args[index - 1] !== '--expect-version');
if (!target) {
  console.error('usage: node scripts/verify-packaged-drag-region.mjs <app.asar | plugin-dir> [--expect-version <version>] [--json <path>]');
  process.exit(2);
}
const targetPath = resolve(target);
const expectedVersion = option('--expect-version')
  ?? JSON.parse(readFileSync(join(SCRIPT_ROOT, 'package.json'), 'utf8')).version;
const jsonPath = option('--json');

/** One assertion result. */
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail) });

/** Remove block comments so the CSS parser sees only rules. */
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Split on a separator that is not inside parentheses or attribute brackets. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/** The last compound selector, which names the element a rule paints. */
function subjectOf(selector) {
  let depth = 0;
  let cut = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(character)) cut = index + 1;
  }
  return selector.slice(cut).trim();
}

/** The declared app-region value of a declaration block, or null. */
function appRegion(body) {
  for (const declaration of body.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator === -1) continue;
    const property = declaration.slice(0, separator).trim();
    if (!/^(-webkit-)?app-region$/.test(property)) continue;
    return declaration.slice(separator + 1).trim().replace(/\s*!important$/, '');
  }
  return null;
}

/** Every (selector, app-region) pair in a stylesheet. */
function appRegionSelectors(css) {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectorText, body]) => {
    const value = appRegion(body);
    if (value === null) return [];
    return splitTopLevel(selectorText.trim(), ',').map(selector => ({ selector, value }));
  });
}

/** Read a packaged file listing and a reader for one target. */
function openTarget(path) {
  const info = statSync(path);
  if (!info.isDirectory()) {
    let asar;
    try {
      asar = createRequire(import.meta.url)('@electron/asar');
    } catch (error) {
      throw new Error(`@electron/asar is required to inspect an app.asar (${error.message})`);
    }
    const listing = asar.listPackage(path).map(entry => entry.replace(/^\/+/, ''));
    return {
      kind: 'asar', size: info.size, files: listing,
      read(relative) {
        if (!listing.includes(relative)) throw new Error(`missing from archive: ${relative}`);
        return asar.extractFile(path, relative);
      },
    };
  }
  const root = resolve(path);
  return {
    kind: 'directory', size: 0, files: [],
    read(relative) { return readFileSync(join(root, relative)); },
  };
}

/** Locate every packaged copy of the product plugin. */
function pluginDirectories(packageFiles) {
  const suffix = `/node_modules/${PLUGIN_NAME}`;
  const found = packageFiles
    .filter(file => file.endsWith(`${suffix}/package.json`))
    .map(file => file.slice(0, -'/package.json'.length));
  return [...new Set(found)];
}

const opened = openTarget(targetPath);
const directories = opened.kind === 'directory' ? ['.'] : pluginDirectories(opened.files);
check('plugin package is present', directories.length > 0,
  directories.length ? `${directories.length} copy/copies` : `no ${PLUGIN_NAME} package.json in ${targetPath}`);

for (const directory of directories) {
  const prefix = directory === '.' ? '' : `${directory}/`;
  let manifest;
  try {
    manifest = JSON.parse(opened.read(`${prefix}package.json`).toString('utf8'));
  } catch (error) {
    check(`manifest readable (${directory})`, false, error.message);
    continue;
  }
  check(`plugin name (${directory})`, manifest.name === PLUGIN_NAME, manifest.name);
  check(`plugin version (${directory})`, manifest.version === expectedVersion,
    `expected ${expectedVersion}, shipped ${manifest.version}`);

  try {
    const plugin = JSON.parse(opened.read(`${prefix}studio.plugin.json`).toString('utf8'));
    check(`studio.plugin.json version (${directory})`, plugin.version === expectedVersion,
      `expected ${expectedVersion}, shipped ${plugin.version}`);
  } catch (error) {
    check(`studio.plugin.json version (${directory})`, false, error.message);
  }

  let css;
  try {
    const asset = opened.read(`${prefix}src/client/styles/drag-region.css.mjs`).toString('utf8');
    const match = asset.match(/^export default String\.raw`([\s\S]*)`;\s*$/);
    if (!match) throw new Error('drag-region.css.mjs is not a static CSS module');
    css = match[1];
  } catch (error) {
    check(`drag-region source (${directory})`, false, error.message);
  }
  if (css !== undefined) {
    const declarations = appRegionSelectors(css);
    const drag = declarations.filter(entry => entry.value === 'drag');
    const noDrag = declarations.filter(entry => entry.value === 'no-drag');
    check(`drag sheet has a drag surface (${directory})`, drag.length > 0, `${drag.length} drag selector(s)`);
    check(`[${WINDOWS_ROOT_MARKER}] is never a drag subject (${directory})`,
      drag.every(entry => !subjectOf(entry.selector).includes(WINDOWS_ROOT_MARKER)),
      drag.filter(entry => subjectOf(entry.selector).includes(WINDOWS_ROOT_MARKER)).map(entry => entry.selector).join(', '));
    const stripDrag = drag.filter(entry => subjectOf(entry.selector) === `[${DRAG_STRIP_MARKER}]`);
    check(`the caption strip is the one Windows drag surface (${directory})`,
      stripDrag.length === 1 && stripDrag[0].selector === `html[${WINDOWS_ROOT_MARKER}] [${DRAG_STRIP_MARKER}]`,
      stripDrag.map(entry => entry.selector).join(', ') || 'missing');
    check(`macOS chrome rows stay scoped to darwin (${directory})`,
      drag.every(entry => entry.selector === `html[${WINDOWS_ROOT_MARKER}] [${DRAG_STRIP_MARKER}]`
        || entry.selector.startsWith(MACOS_SCOPE)),
      drag.map(entry => entry.selector).filter(selector => selector !== `html[${WINDOWS_ROOT_MARKER}] [${DRAG_STRIP_MARKER}]`
        && !selector.startsWith(MACOS_SCOPE)).join(', '));
    check(`html[${WINDOWS_ROOT_MARKER}] subtracts the root box (${directory})`,
      noDrag.some(entry => subjectOf(entry.selector) === `html[${WINDOWS_ROOT_MARKER}]`),
      noDrag.map(entry => entry.selector).join(', '));
    check(`the Windows body also subtracts itself (${directory})`,
      noDrag.some(entry => entry.selector === `html[${WINDOWS_ROOT_MARKER}] body`),
      noDrag.map(entry => entry.selector).join(', '));
  }

  let doc;
  try {
    doc = opened.read(`${prefix}src/client/dsh/product-document.mjs`).toString('utf8');
  } catch (error) {
    check(`product-document source (${directory})`, false, error.message);
  }
  if (doc !== undefined) {
    check(`runtime inline no-drag override (${directory})`,
      /setProperty\(\s*['"]-webkit-app-region['"]\s*,\s*['"]no-drag['"]\s*\)/.test(doc)
      && doc.includes(WINDOW_REGION_MARKER),
      'product-document must write -webkit-app-region: no-drag on the document elements');
    check(`runtime drag strip implementation (${directory})`,
      doc.includes(DRAG_STRIP_MARKER) && /left:320px/.test(doc) && /right:160px/.test(doc) && /height:40px/.test(doc),
      'the explicit caption strip is missing or its blank-band geometry changed');
    check(`drag strip only mounts on Windows (${directory})`,
      /isWindowsDesktopDocument/.test(doc) && /Electron/i.test(doc) && /Windows/i.test(doc),
      'the strip must not mount on macOS or in a plain browser');
  }

  let bundle;
  try {
    bundle = opened.read(`${prefix}dist/client.js`).toString('utf8');
  } catch (error) {
    check(`client bundle (${directory})`, false, error.message);
  }
  if (bundle !== undefined) {
    check(`client bundle is not a stub (${directory})`, bundle.length > MIN_BUNDLE_BYTES, `${bundle.length} bytes`);
    check(`bundle ships the runtime no-drag override (${directory})`, bundle.includes(WINDOW_REGION_MARKER));
    check(`bundle ships the drag strip (${directory})`, bundle.includes(DRAG_STRIP_MARKER));
    check(`bundle ships the root no-drag rule (${directory})`,
      new RegExp(`html\\[${WINDOWS_ROOT_MARKER}\\]`).test(bundle)
      && /(?:-webkit-)?app-region\s*:\s*no-drag/.test(bundle),
      'the minified stylesheet lost the html[data-windows-titlebar] no-drag rule');
    check(`bundle never makes [${WINDOWS_ROOT_MARKER}] a drag subject (${directory})`,
      !new RegExp(`(?<!html)\\[${WINDOWS_ROOT_MARKER}\\][^{}]*\\{[^{}]*(?:-webkit-)?app-region\\s*:\\s*drag`).test(bundle),
      'the old whole-client-area caption rule is still in the shipped bundle');
    check(`bundle never captions the html root (${directory})`,
      !new RegExp(`html\\[${WINDOWS_ROOT_MARKER}\\]\\s*\\{[^{}]*(?:-webkit-)?app-region\\s*:\\s*drag`).test(bundle),
      'a drag rule on <html> covers the whole client area');
    check(`bundle carries the blank-band strip geometry (${directory})`,
      /left:320px/.test(bundle) && /right:160px/.test(bundle) && /height:40px/.test(bundle));
  }
}

const failed = checks.filter(entry => !entry.ok);
const report = {
  target: targetPath,
  kind: opened.kind,
  bytes: opened.size,
  sha256: opened.kind === 'asar' ? createHash('sha256').update(readFileSync(targetPath)).digest('hex') : undefined,
  expectedVersion,
  pluginDirectories: directories,
  checks,
  ok: failed.length === 0,
};

console.log(`verify-packaged-drag-region: ${targetPath}`);
console.log(`  archive: ${opened.kind}${opened.kind === 'asar' ? `, ${opened.size} bytes, sha256 ${report.sha256}` : ''}`);
console.log(`  expected plugin version: ${expectedVersion}`);
for (const entry of checks) {
  const detail = entry.detail && (!entry.ok || entry.name.includes('version')) ? ` — ${entry.detail}` : '';
  console.log(`  ${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${detail}`);
}
console.log(failed.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed.length} check(s) failed)`);
if (jsonPath) writeFileSync(resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
