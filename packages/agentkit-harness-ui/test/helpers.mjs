// Test helpers for traversing the plain view-model element tree. These mirror
// the queries a React testing library would expose, but operate on the
// serializable tree so node:test can assert structure without a DOM.

import { isElement } from "../src/view.mjs";

function walk(node, visit) {
  if (node == null || node === false) return;
  if (typeof node !== "object") { visit(node); return; }
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

export function findByTestId(node, testid) {
  let found = null;
  walk(node, n => {
    if (found) return;
    if (isElement(n) && n.props["data-testid"] === testid) found = n;
  });
  return found;
}

export function findAllByTestId(node, testid) {
  const found = [];
  walk(node, n => { if (isElement(n) && n.props["data-testid"] === testid) found.push(n); });
  return found;
}

export function findByRole(node, role) {
  let found = null;
  walk(node, n => {
    if (found) return;
    if (isElement(n) && n.props.role === role) found = n;
  });
  return found;
}

export function findAllByRole(node, role) {
  const found = [];
  walk(node, n => { if (isElement(n) && n.props.role === role) found.push(n); });
  return found;
}

export function attr(node, name) {
  return isElement(node) ? node.props[name] : undefined;
}

export function textOf(node) {
  let text = "";
  walk(node, n => { if (typeof n === "string") text += n; });
  return text;
}

export function hasText(node, str) {
  return textOf(node).includes(str);
}

export function childCount(node) {
  return isElement(node) ? (node.children || []).length : 0;
}
