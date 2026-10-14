import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioPrimitives } from '../src/client/components/primitives.mjs';
test('eye toggles only typed input and resets visibility after save clears it',()=>{
  let visible=false, tree, value='typed-fixture';
  const effects=[];
  const h=(type,props,...children)=>({type,props,children});
  const useState=()=>[visible,next=>{visible=typeof next==='function'?next(visible):next;}];
  const useEffect=callback=>effects.push(callback);
  const { SecretInput: Component } = createStudioPrimitives({ React: { createElement: h, useState, useEffect } });
  const render=()=>{tree=Component({value,label:'API Key'});effects.splice(0).forEach(fn=>fn());return tree;};
  render();assert.equal(tree.children[0].props.type,'password');
  assert.equal(tree.children[1].props['aria-label'],'显示 API Key');
  tree.children[1].props.onClick();render();assert.equal(tree.children[0].props.type,'text');
  assert.equal(tree.children[1].props['aria-pressed'],true);
  value='';render();render();assert.equal(tree.children[0].props.type,'password');
  assert.equal(tree.children[1].props.disabled,true);
});
