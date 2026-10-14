export function createSettingsLauncher({ ui, window = globalThis.window }) {
  const { React, IconSettingsOutlineMedium, Tooltip } = ui;
  const { createElement: h, useEffect } = React;
  function StudioSettingsLauncher({ wide, settingsOpen, settingsShortcut, openSettings, openOnboarding, t }) {
    const label = t('trigger');
    useEffect(() => {
      const open = () => openSettings?.();
      const guide = () => openOnboarding?.('agentkit-studio-credential');
      window.addEventListener('agentkit-studio:open-settings', open);
      window.addEventListener('agentkit-studio:credential-onboarding', guide);
      return () => {
        window.removeEventListener('agentkit-studio:open-settings', open);
        window.removeEventListener('agentkit-studio:credential-onboarding', guide);
      };
    }, [openSettings, openOnboarding]);
    return h(Tooltip, { disabled: settingsOpen, label, shortcutKeys: settingsShortcut?.keys },
      h('button', {
        type: 'button', className: 'agentkit-settings-launcher', 'data-wide': wide,
        'aria-label': label, 'aria-keyshortcuts': settingsShortcut?.aria,
        'aria-haspopup': 'dialog', 'aria-expanded': settingsOpen, onClick: openSettings,
      }, h(IconSettingsOutlineMedium, { size: wide ? 16 : 18 }), wide && h('span', null, label)));
  }
  return { StudioSettingsLauncher };
}
