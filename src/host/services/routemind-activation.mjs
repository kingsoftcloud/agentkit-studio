/** Check the effective state of RouteMind in the current DSH profile. */
export async function isRouteMindPluginActive(pluginInventory) {
  try {
    const snapshot = await pluginInventory?.list();
    return snapshot?.entries?.some(entry =>
      entry.moduleName === 'routemind-studio' && entry.enabled === true && entry.fiberPhase === 'active') === true;
  } catch {
    // Pricing and scores are optional even when the loader is unavailable.
    return false;
  }
}
