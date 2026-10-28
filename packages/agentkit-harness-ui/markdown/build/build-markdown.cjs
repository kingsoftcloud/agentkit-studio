// Build-time dependency bundling. The browser uses only its host's React.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'markdown/source');
const dist = path.join(root, 'markdown/dist');
const requireBuild = createRequire(path.join(root, 'package.json'));
const esbuild = requireBuild('esbuild');
const externals = ['react', 'react-dom', 'react/jsx-runtime'];
const nodePaths = [];
for (let dir = root;; dir = path.dirname(dir)) {
  nodePaths.push(path.join(dir, 'node_modules'));
  if (path.dirname(dir) === dir) break;
}

async function main() {
  fs.mkdirSync(dist, {recursive: true});
  const result = await esbuild.build({
    absWorkingDir: source, entryPoints: [path.join(source, 'markdown-factory.mjs')],
    bundle: true, format: 'cjs', platform: 'neutral', conditions: ['import', 'module', 'default'],
    mainFields: ['module', 'main'], target: ['es2022'], minify: true,
    define: {'process.env.NODE_ENV': '"production"'}, external: externals,
    nodePaths, write: false, metafile: true, legalComments: 'inline',
  });
  for (const output of Object.values(result.metafile.outputs))
    for (const entry of output.imports) if (entry.external && !externals.includes(entry.path))
      throw Error('Unexpected Markdown runtime dependency: ' + entry.path);
  for (const file of Object.keys(result.metafile.inputs))
    if (/(?:^|\/)node_modules\/(?:react|react-dom|react-is)\//.test(file))
      throw Error('A React implementation was bundled: ' + file);
  const css = await esbuild.build({
    absWorkingDir: source, entryPoints: [path.join(source, 'markdown.css')], bundle: true,
    nodePaths, write: false, minify: true, legalComments: 'inline',
  });
  const bundled = result.outputFiles[0].text;
  const stylesheet = css.outputFiles[0].text;
  const factory = `// Generated from markdown/source; see THIRD_PARTY_LICENSES.txt.\nexport const markdownStyles = ${JSON.stringify(stylesheet)};\nexport function createMarkdownComponents(React, ReactDOM) {\n  if (!React?.createElement || !ReactDOM?.createPortal) throw new TypeError('The host React and ReactDOM are required');\n  const module = {exports:{}};\n  const jsx = (type, props, key) => React.createElement(type, key === undefined ? props : {...props, key});\n  const jsxs = (type, props, key) => { const {children, ...rest} = props || {}; return React.createElement(type, key === undefined ? rest : {...rest, key}, ...(Array.isArray(children) ? children : [children])); };\n  const runtime = {jsx, jsxs, jsxDEV:(type, props, key, staticChildren) => (staticChildren ? jsxs : jsx)(type, props, key), Fragment:React.Fragment};\n  const require = id => {\n    if (id === 'react') return React;\n    if (id === 'react-dom') return ReactDOM;\n    if (id === 'react/jsx-runtime') return runtime;\n    throw new Error('Unexpected Markdown runtime import: ' + id);\n  };\n${bundled}\n  return module.exports.createMarkdownComponents(React, ReactDOM);\n}\n`;
  fs.writeFileSync(path.join(dist, 'markdown.mjs'), factory);
  fs.writeFileSync(path.join(dist, 'markdown.css'), stylesheet);
  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    let dir = path.dirname(path.resolve(source, input));
    while (dir.includes('node_modules')) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) {
        const item = JSON.parse(fs.readFileSync(manifest));
        if (item.name) packages.set(item.name + '@' + item.version, {dir, item});
        break;
      }
      dir = path.dirname(dir);
    }
  }
  let notices = 'Bundled Markdown dependencies\n\n';
  for (const [name, {dir, item}] of [...packages].sort(([a],[b]) => a.localeCompare(b))) {
    const licenses = fs.readdirSync(dir).filter(name => /^licen[sc]e(?:[._-].*)?$/i.test(name) && fs.statSync(path.join(dir,name)).isFile());
    notices += '\n===== ' + name + ' (' + String(item.license || 'see upstream notice') + ') =====\n';
    for (const file of licenses) notices += '\n' + fs.readFileSync(path.join(dir,file),'utf8') + '\n';
    if (!licenses.length) notices += 'Copyright/license notices are retained inline in markdown.mjs.\n';
  }
  fs.writeFileSync(path.join(dist, 'THIRD_PARTY_LICENSES.txt'), notices);
  fs.mkdirSync(path.join(root, '.artifacts'), {recursive: true});
  fs.writeFileSync(path.join(root, '.artifacts/markdown-meta.json'), JSON.stringify(result.metafile,null,2));
  console.log(`Markdown: ${Buffer.byteLength(factory)} JS bytes, ${Buffer.byteLength(stylesheet)} CSS bytes, ${packages.size} dependency notices; React supplied by host.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
