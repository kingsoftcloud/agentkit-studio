export function createStatusText(h) {
  return function StatusText({ tone = 'neutral', children, ...props }) {
    return h('span', { ...props, className: 'studio-st', 'data-tone': tone === 'accent' ? 'ok' : tone === 'signal' ? 'warn' : tone }, children);
  };
}
