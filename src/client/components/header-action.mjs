export function createHeaderAction({ React, ReactDOM }) {
  const { createElement: h, useEffect, useRef, useState } = React;
  return function HeaderAction({ children }) {
    const anchor = useRef(null);
    const [target, setTarget] = useState(null);
    useEffect(() => {
      setTarget(anchor.current?.closest('[data-studio-page-frame]')?.querySelector('[data-studio-header] .studio-page-actions') || null);
    }, []);
    return h('span', { ref: anchor, style: { display: 'contents' } }, target && ReactDOM?.createPortal ? ReactDOM.createPortal(children, target) : children);
  };
}
