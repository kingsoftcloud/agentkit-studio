import test from 'node:test';
import assert from 'node:assert/strict';
import{readFileSync}from'node:fs';
import React from 'react';
import ReactDOM from 'react-dom';
import{renderToStaticMarkup}from'react-dom/server';
import ts from 'typescript';
import{createMarkdownComponents,markdownStyles}from'../markdown/dist/markdown.mjs';
const {MarkdownResponse}=createMarkdownComponents(React,ReactDOM);
const render=(text,props={})=>renderToStaticMarkup(React.createElement(MarkdownResponse,props,text));

test('injected React 18 renders GFM, CJK and stable code controls in completed mode',()=>{
  assert.match(React.version,/^18\./);
  const html=render('## 报告\n\n|区域|数量|\n|---|---|\n|东|12|\n\n```js\nconst n = 12;\n```');
  assert.match(html,/<h2[^>]*>报告/);assert.match(html,/<table/);assert.match(html,/数量/);
  assert.match(html,/class="ks-md-code"/);assert.match(html,/data-streaming="false"/);
  assert.match(html,/const n = 12;/);assert.match(html,/aria-label="Copy code"/);
  assert.match(markdownStyles,/ks-md-code/);assert.doesNotMatch(html,/node="\[object Object\]"/);
});

test('real streaming uses incomplete parsing; completion keeps exact literal source',()=>{
  const live=render('```js\nconst value =', {streaming:true});
  assert.match(live,/data-streaming="true"/);assert.match(live,/const value =/);
  const done=render('Use `./src/**/*` literally.');
  assert.match(done,/\.\/src\/\*\*\/\*/);assert.doesNotMatch(done,/literally\.\*\*/);
});

test('links preserve original traversal intent for the host; images never silently perform I/O',()=>{
  const html=render('[file](src/a.ts) [escape](src/../../secret) [web](https://example.com) ![diagram](https://example.com/p.png)',{onOpenFileLink:()=>{},onOpenExternalUrl:()=>{}});
  assert.match(html,/title="src\/a.ts"/);assert.match(html,/title="src\/\.\.\/\.\.\/secret"/);
  assert.match(html,/class="ks-md-link"/);assert.doesNotMatch(html,/<img\b|<a\b/);
  assert.match(html,/role="img" aria-label="diagram"/);
  const unsafe=render('[bad](javascript:alert%281%29)<script>alert(1)</script>');
  assert.doesNotMatch(unsafe,/<script\b|href="javascript:/);
});

test('browser artifact imports no Node or independent React and contains no dynamic code execution',()=>{
  const source=readFileSync(new URL('../markdown/dist/markdown.mjs',import.meta.url),'utf8');
  const tree=ts.createSourceFile('markdown.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const found=[];
  const visit=node=>{
    if(ts.isImportDeclaration(node))found.push('external import');
    if((ts.isCallExpression(node)||ts.isNewExpression(node))&&ts.isIdentifier(node.expression)&&['eval','Function'].includes(node.expression.text))found.push(node.expression.text);
    ts.forEachChild(node,visit);
  };visit(tree);assert.deepEqual(found,[]);
  assert.doesNotMatch(source,/node:fs|node:child_process|react\.production\.min\.js/);
  assert.throws(()=>createMarkdownComponents({},ReactDOM),/React/);
});
