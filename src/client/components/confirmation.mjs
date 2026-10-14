/** Closing the owning scope cancels only its pending dialogs. */
export function createConfirmation({ document = globalThis.document } = {}) {
  let closed = false;
  const pending = new Set();
  function confirmDialog(options = {}) {
    if (closed || !document?.body) return Promise.resolve(false);
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(10,14,18,0.55);backdrop-filter:blur(2px)';
      const card = document.createElement('div');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('data-studio-controls', 'true');
      card.style.cssText = 'width:min(420px,calc(100vw - 48px));border:1px solid var(--dsw-alias-border-l3,#d4d4d4);border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1,#fff);padding:20px;box-shadow:0 18px 50px rgba(10,14,18,0.28);font-family:inherit';
      const title = document.createElement('strong');
      title.textContent = options.title || '确认操作';
      title.style.cssText = 'display:block;color:var(--dsw-alias-label-primary,#0d0d0d);font-size:15px';
      card.append(title);
      if (options.detail) {
        const detail = document.createElement('p');
        detail.textContent = options.detail;
        detail.style.cssText = 'color:var(--dsw-alias-label-secondary,#676767);font-size:14px;line-height:1.6;margin:10px 0 0;white-space:pre-wrap';
        card.append(detail);
      }
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = options.cancelLabel || '取消';
      cancel.style.cssText = 'font:inherit;cursor:pointer;height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);border:.5px solid var(--dsw-alias-border-l3,#d4d4d4);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0d0d0d)';
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.textContent = options.confirmLabel || '确定';
      confirm.autofocus = true;
      const danger = options.danger !== false;
      confirm.style.cssText = 'font:inherit;cursor:pointer;height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);border:.5px solid transparent;color:' + (danger ? 'var(--dsw-static-neutral-00,#fff)' : 'var(--dsw-alias-label-primary-foreground,#fff)') + ';background:' + (danger ? 'var(--dsw-alias-state-danger-primary,#c2402a)' : 'var(--dsw-alias-button-primary-fill,#0b0b0d)');
      let settled = false;
      const settle = value => { if (settled) return; settled = true; pending.delete(cancelPending); overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
      const cancelPending = () => settle(false);
      pending.add(cancelPending);
      const onKey = event => { if (event.key === 'Escape') settle(false); if (event.key === 'Enter') settle(true); };
      cancel.addEventListener('click', () => settle(false));
      confirm.addEventListener('click', () => settle(true));
      overlay.addEventListener('click', event => { if (event.target === overlay) settle(false); });
      document.addEventListener('keydown', onKey);
      actions.append(cancel, confirm);
      card.append(actions);
      overlay.append(card);
      document.body.append(overlay);
      confirm.focus();
    });
  }
  return { confirm: confirmDialog, dispose() { closed = true; for (const cancel of [...pending]) cancel(); } };
}
