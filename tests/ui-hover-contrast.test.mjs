import test from 'node:test';
import assert from 'node:assert/strict';
import responsiveCss from '../src/client/styles/responsive.css.mjs';

// Regression: primary buttons paint a white label on a dark fill. The global
// hover rule used to force the neutral light hover surface for every button,
// which made those labels invisible. Any future hover rule must either keep the
// primary label color or exclude primary buttons from the light surface.
const cssRules = css => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body: body.trim() }));

test('global button hover rules keep primary labels readable', () => {
  const rules = cssRules(responsiveCss).filter(rule => rule.selector.includes(':hover') && /(?:^|[;{\s])background(?:-color)?\s*:/.test(rule.body));
  assert.ok(rules.length >= 2, 'responsive styles define button hover rules');

  for (const rule of rules) {
    if (!rule.selector.includes('button')) continue;
    const keepsLabelColor = /(?:^|[;{\s])color\s*:/.test(rule.body);
    const excludesPrimary = /:not\(\[style\*="--dsw-alias-label-primary-foreground"\]\)/.test(rule.selector)
      && /:not\(\[style\*="--dsw-alias-button-primary-fill"\]\)/.test(rule.selector)
      && /:not\(\[data-variant="primary"\]\)/.test(rule.selector)
      && /:not\(\.sq-btn\.primary\)/.test(rule.selector);
    const isPrimaryRule = /button\[data-variant="primary"\]/.test(rule.selector)
      || /\.sq-btn\.primary/.test(rule.selector) && !/:not\(\.sq-btn\.primary\)/.test(rule.selector);
    assert.ok(keepsLabelColor || excludesPrimary, `hover rule must keep a readable label: ${rule.selector}`);
    if (isPrimaryRule) assert.match(rule.body, /color: var\(--dsw-alias-label-primary-foreground/, 'primary hover forces the white label');
  }
});

test('credential onboarding primary buttons are covered by the primary hover rule', () => {
  assert.match(responsiveCss, /\.agentkit-credential-onboarding-content\)[^{}]*button\[style\*="--dsw-alias-label-primary-foreground"\]/);
  assert.match(responsiveCss, /--dsw-alias-button-primary-hover, #303030/);
});
