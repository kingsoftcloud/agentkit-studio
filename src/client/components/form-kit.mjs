// Studio form primitives. Each helper is a plain element builder
// `(props, ...children)` rather than a React component, so the Agent form
// renders native DOM elements that both React and the source behavior tests
// see directly. Styling lives in styles/agent-form.css.mjs on DSH alias tokens.
export function createFormKit({ React: { createElement: h } }) {
  const cx = (...names) => names.filter(Boolean).join(' ');
  const own = props => props || {};

  const HelpTip = text => h('i', { className: 'af-help', role: 'img', 'aria-label': text, title: text }, 'i');

  function Section(props, ...children) {
    const { title, help, meta, action, className, ...rest } = own(props);
    return h('section', { className: cx('af-section', className), ...rest },
      title || action ? h('div', { className: 'af-section-head' },
        h('h3', { className: 'af-section-title' }, title, help ? HelpTip(help) : null),
        meta || action ? h('div', { className: 'af-section-side' }, meta ? h('span', { className: 'af-section-meta' }, meta) : null, action || null) : null) : null,
      ...children);
  }

  // `footer` spans the row below its text and controls, for a progress bar.
  function Row(props, ...children) {
    const { title, desc, help, footer, ...rest } = own(props);
    return h('div', { className: cx('af-row', footer ? 'af-row-with-footer' : undefined), ...rest },
      h('div', { className: 'af-row-text' },
        h('span', { className: 'af-row-title' }, title, help ? HelpTip(help) : null),
        desc ? h('span', { className: 'af-row-desc' }, desc) : null),
      h('div', { className: 'af-row-control' }, ...children),
      footer || null);
  }

  function Field(props, ...children) {
    const { label, help, hint, className, ...rest } = own(props);
    return h('label', { className: cx('af-field', className), ...rest },
      h('span', { className: 'af-field-label' }, label, help ? HelpTip(help) : null),
      ...children,
      hint ? h('span', { className: 'af-field-hint' }, hint) : null);
  }

  const Input = props => { const { className, ...rest } = own(props); return h('input', { ...rest, className: cx('af-input', className) }); };
  const TextArea = props => { const { className, ...rest } = own(props); return h('textarea', { ...rest, className: cx('af-textarea', className) }); };
  const Select = (props, ...children) => { const { className, ...rest } = own(props); return h('select', { ...rest, className: cx('af-select', className) }, ...children); };

  function Switch(props) {
    const { label, ...rest } = own(props);
    return h('label', { className: 'af-switch' }, h('input', { type: 'checkbox', ...rest }), label ? h('span', null, label) : null);
  }

  function Choice(props) {
    const { selected, title, desc, ...rest } = own(props);
    return h('button', { type: 'button', className: 'af-choice', 'aria-pressed': selected ? 'true' : 'false', ...rest },
      h('span', { className: 'af-choice-text' },
        h('span', { className: 'af-choice-title' }, title),
        desc ? h('span', { className: 'af-choice-desc' }, desc) : null));
  }

  function CheckCard(props) {
    const { checked, title, desc, onChange, disabled, inputProps, ...rest } = own(props);
    return h('label', { className: 'af-check', 'data-checked': checked ? 'true' : undefined, title: desc || undefined, ...rest },
      h('input', { type: 'checkbox', checked, disabled, onChange, ...inputProps }),
      h('span', { className: 'af-check-text' }, h('strong', null, title), desc ? h('span', { className: 'af-check-desc' }, desc) : null));
  }

  function Button(props, ...children) {
    const { variant, size, className, ...rest } = own(props);
    return h('button', { type: 'button', ...rest, className: cx('af-btn', className), 'data-variant': variant, 'data-size': size }, ...children);
  }

  const Note = (props, ...children) => { const { tone, className, ...rest } = own(props); return h('p', { className: cx('af-note', className), 'data-tone': tone, ...rest }, ...children); };

  /** A spinner for work with no known duration. */
  const Spinner = ({ label = '处理中' } = {}) => h('span', { className: 'af-spinner', role: 'status', 'aria-label': label });

  /** A progress bar; `indeterminate` animates while the total is unknown. */
  function Progress({ value = 0, max = 100, indeterminate = false, label } = {}) {
    const percent = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;
    return h('div', {
      className: 'af-progress', role: 'progressbar',
      'aria-label': label, ...(indeterminate ? { 'data-indeterminate': '' } : { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }),
    }, h('div', { className: 'af-progress-bar', style: { width: `${percent}%` } }));
  }

  function Collapsible(props, ...children) {
    const { summary, ...rest } = own(props);
    return h('details', { className: 'af-details', ...rest }, h('summary', null, summary), h('div', { className: 'af-details-body' }, ...children));
  }

  const Summary = ({ rows }) => h('div', { className: 'af-summary' }, rows.map(([label, value]) =>
    h('div', { key: label, className: 'af-summary-row' }, h('span', null, label), h('strong', null, value))));

  return { cx, HelpTip, Section, Row, Field, Input, TextArea, Select, Switch, Choice, CheckCard, Button, Note, Spinner, Progress, Collapsible, Summary };
}
