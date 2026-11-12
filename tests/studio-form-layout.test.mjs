import test from 'node:test';
import assert from 'node:assert/strict';

import agentFormStyles from '../src/client/styles/agent-form.css.mjs';
import deliveryStyles from '../src/client/styles/delivery.css.mjs';
import modelSettingsStyles from '../src/client/styles/model-settings.css.mjs';
import sharedStyles from '../src/client/styles/forms.css.mjs';
import responsiveStyles from '../src/client/styles/responsive.css.mjs';

/** The declaration block of the first rule that matches `pattern`. */
function rule(pattern, styles = agentFormStyles) {
  const match = styles.match(pattern);
  assert.ok(match, `missing rule: ${pattern}`);
  return match[1];
}

test('a disabled primary button keeps its label readable', () => {
  const disabled = rule(/\.af-btn\[data-variant="primary"\]:disabled \{([^}]*)\}/);
  assert.doesNotMatch(disabled, /button-primary-dimmed/);
  assert.match(disabled, /background: var\(--dsw-alias-button-primary-fill/);
  assert.match(disabled, /color: var\(--dsw-alias-label-primary-foreground/);
  assert.match(disabled, /opacity: \.4/);
});

test('unavailable runtime names and Studio placeholders retain readable token colors', () => {
  const runtime = rule(/\.af-runtime-option:disabled \{([^}]*)\}/);
  assert.match(runtime, /opacity: 1/);
  assert.match(runtime, /color: var\(--dsw-alias-label-tertiary\)/);
  const placeholder = rule(/::placeholder \{([^}]*)\}/, responsiveStyles);
  assert.match(placeholder, /color: var\(--dsw-alias-label-secondary\)/);
  assert.match(placeholder, /opacity: 1/);
});

test('template descriptions wrap to two lines instead of inheriting catalog nowrap', () => {
  const description = rule(/\.studio-template-surface :is\(\.ec-card-copy p,\.rl-card p,\.sq-team-card p\) \{([^}]*)\}/, sharedStyles);
  assert.match(description, /white-space: normal/);
  assert.match(description, /-webkit-line-clamp: 2/);
  assert.match(description, /min-height: 40px/);
});

test('the agent form uses a capped body and vertical step rail', () => {
  const layout = rule(/\.af-layout \{([^}]*)\}/);
  assert.match(layout, /grid-template-columns: 184px minmax\(0,640px\)/);
  const bodyRule = agentFormStyles.match(/\.af-body \{[^}]*\}/)[0];
  const body = Number(bodyRule.match(/max-width: (\d+)px/)[1]);
  assert.equal(body, 640);
  assert.match(rule(/\.af-steps \{([^}]*)\}/), /flex-direction: column; gap: 16px/);
  assert.doesNotMatch(agentFormStyles, /\.af-step\[aria-current="step"\] \{[^}]*background:/);
  assert.match(agentFormStyles, /@container studio-agent-form \(max-width: 720px\)/);
  const block = agentFormStyles.slice(agentFormStyles.indexOf('@container studio-agent-form (max-width: 720px)'));
  assert.match(block, /\.af-layout \{ grid-template-columns: minmax\(0,1fr\)/, 'the rail must fold into a row');
  assert.match(block, /\.af-steps \{ position: static; flex-direction: row/, 'the rail must become a horizontal step strip');
  assert.match(block, /\.af-row-control \{ width: 100%/, 'row controls must stop sharing the line with their label');
});

test('the delivery page stacks its rows and actions on a narrow shell', () => {
  const block = deliveryStyles.slice(deliveryStyles.indexOf('@container studio-delivery (max-width: 820px)'));
  assert.ok(block.length > 0, 'missing the narrow-shell container query');
  assert.match(deliveryStyles, /container-name: studio-delivery/, 'the delivery container must be named');
  assert.match(block, /\.af-row \{ flex-wrap: wrap/, 'rows must wrap');
  assert.match(block, /\.af-row-control \{ width: 100%/, 'controls must take the full row');
  assert.match(block, /\.ad-actions \{ justify-content: flex-start/, 'actions must not stay pinned right');
});

test('the form centres its column instead of hugging the left edge of a wide window', () => {
  assert.match(agentFormStyles, /\[data-studio-agent-form\] > \[data-studio-heading\],[\s\S]{0,80}\[data-studio-agent-form\] > \.af-layout \{ max-width: 848px; margin-inline: auto; \}/);
  assert.match(agentFormStyles, /\[data-studio-agent-form\] > \.af-layout/, 'the layout must be centred');
  assert.match(rule(/\.af-field-label \{([^}]*)\}/), /margin-bottom: 8px; font-size: 14px; font-weight: 500/);
  assert.match(rule(/\.af-field \{([^}]*)\}/), /margin: 0 0 20px/);
  assert.match(rule(/\.af-footer \{([^}]*)\}/), /justify-content: flex-end/);
});

test('the model settings column is centred like the other capped surfaces', () => {
  const form = modelSettingsStyles.match(/\.ms-form \{([^}]*)\}/)[1];
  assert.match(form, /max-width: 1040px/);
  assert.match(form, /margin-inline: auto/, 'a capped width pinned to the left edge leaves a dead column on the right');
});
