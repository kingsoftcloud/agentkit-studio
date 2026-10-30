// Decoder for the pinned Ruff WASM Rust Debug AST, not a Python parser.
// Python grammar and literal decoding happen in Rust. Unknown wire syntax
// fails closed; the caller checks the exact parser version in its worker.
export function decodeRuffAst(text) {
  let at = 0;
  const fail = () => { throw Error('unsupported_ruff_ast_encoding'); };
  const space = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const take = char => { space(); if (text[at++] !== char) fail(); };
  function string() {
    take('"'); let result = '';
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') return result;
      if (char !== '\\') { result += char; continue; }
      const escaped = text[at++], simple = { '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t', '0': '\0' };
      if (Object.hasOwn(simple, escaped)) { result += simple[escaped]; continue; }
      const match = escaped === 'u' ? /^\{([a-fA-F0-9]{1,6})\}/.exec(text.slice(at))
        : escaped === 'x' ? /^([a-fA-F0-9]{2})/.exec(text.slice(at)) : null;
      if (!match) fail();
      const point = parseInt(match[1], 16); if (point > 0x10ffff) fail();
      result += String.fromCodePoint(point); at += match[0].length;
    }
    fail();
  }
  function list(end, depth) {
    const items = []; space();
    while (text[at] !== end) {
      items.push(value(depth + 1)); space();
      if (text[at] !== ',') break;
      at++; space();
    }
    take(end); return items;
  }
  function value(depth) {
    if (depth > 1024) fail(); space();
    if (text[at] === '"') return string();
    if (text[at] === '[') { at++; return list(']', depth); }
    if (text[at] === '(') { at++; return { tag: 'tuple', items: list(')', depth) }; }
    const numeric = /^[+-]?(?:\d+\.\.\d+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (numeric) {
      at += numeric[0].length;
      if (numeric[0].includes('..')) return { range: numeric[0].split('..').map(Number) };
      return { numeric: numeric[0] }; // Preserve large values without rounding.
    }
    const named = /^[A-Za-z_][A-Za-z0-9_:]*/.exec(text.slice(at)); if (!named) fail();
    const tag = named[0]; at += tag.length; space();
    if (text[at] === '(') { at++; return { tag, items: list(')', depth) }; }
    if (text[at] === '{') {
      at++; const fields = Object.create(null); space();
      while (text[at] !== '}') {
        const key = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at)); if (!key || Object.hasOwn(fields, key[0])) fail();
        at += key[0].length; take(':'); fields[key[0]] = value(depth + 1); space();
        if (text[at] !== ',') break;
        at++; space();
      }
      take('}'); return { tag, fields };
    }
    return tag === 'true' ? true : tag === 'false' ? false : tag === 'None' ? null : { tag };
  }
  const root = value(0); space(); if (at !== text.length || root?.tag !== 'Module') fail();
  return root;
}

export function unwrapRuff(value) {
  while (value?.items?.length === 1) value = value.items[0];
  return value;
}
export function ruffIdentifier(value) {
  const node = unwrapRuff(value);
  return typeof node === 'string' ? node : node?.tag === 'Identifier' ? ruffIdentifier(node.fields.id) : null;
}
export function ruffString(value) {
  const node = unwrapRuff(value);
  if (node?.tag !== 'ExprStringLiteral') return null;
  const content = unwrapRuff(node.fields.value?.fields?.inner);
  return ['StringLiteral', 'ConcatenatedStringLiteral'].includes(content?.tag) && typeof content.fields?.value === 'string'
    ? content.fields.value : null;
}

// Breadth first across AST nodes, ignoring Rust enum/option/debug wrappers.
// This is used for whole-module alias collection followed by call inspection.
export function ruffNodes(root) {
  const ast = node => node?.fields && /^(Mod|Stmt|Expr|Alias$|Keyword$|Comprehension$|Parameters$|Parameter$|WithItem$|MatchCase$|ExceptHandler)/.test(node.tag);
  const children = item => {
    if (!item || typeof item !== 'object') return [];
    if (ast(item)) return [item];
    return Object.values(item).flatMap(child => children(child));
  };
  const queue = children(root), result = [];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]; result.push(node);
    for (const [key, child] of Object.entries(node.fields)) if (key !== 'node_index' && key !== 'range') queue.push(...children(child));
  }
  return result;
}
