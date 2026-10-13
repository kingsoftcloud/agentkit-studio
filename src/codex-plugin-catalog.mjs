/** Project the official App Server plugin catalog without exposing local paths or account metadata. */
import { open } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';

function httpsIcon(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
async function localIcon(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return '';
  const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(path).toLowerCase()];
  if (!type) return '';
  let file;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 128 * 1024) return '';
    const bytes = Buffer.alloc(128 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 128 * 1024) return '';
    const signature = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    return signature ? `data:${type};base64,${bytes.subarray(0, bytesRead).toString('base64')}` : '';
  } catch { return ''; } finally { await file?.close().catch(() => {}); }
}

export async function projectCodexPluginCatalog(result) {
  if (!Array.isArray(result?.marketplaces)) throw new Error('Codex plugin catalog is invalid');
  const featured = new Set(result.featuredPluginIds || []);
  const items = [];
  for (const market of result.marketplaces) {
    for (const row of market.plugins || []) {
      const metadata = row.interface || {};
      const pluginId = String(row.id || `${row.name}@${market.name}`);
      const iconUrl = httpsIcon(metadata.composerIconUrl) || httpsIcon(metadata.logoUrl);
      // Only installed packages need local icon reads; remote catalog rows use their published URL.
      const iconDataUrl = !iconUrl && row.installed ? await localIcon(metadata.logo || metadata.composerIcon) : '';
      const denied = row.availability && row.availability !== 'AVAILABLE' || row.installPolicy === 'NOT_AVAILABLE';
      items.push({ pluginId, name: String(row.name || ''), displayName: String(metadata.displayName || row.name || ''),
        description: String(metadata.shortDescription || metadata.longDescription || ''),
        version: String(row.localVersion || row.version || ''), marketplace: String(market.name), marketplaceName: String(market.name),
        source: row.installed ? 'codex-installed' : 'codex-available', installed: row.installed === true, enabled: row.enabled === true,
        status: row.installed ? row.enabled ? 'enabled' : 'disabled' : 'available', kind: 'codex', lifecycleAvailable: true,
        category: String(metadata.category || ''), author: String(metadata.developerName || ''),
        featured: featured.has(pluginId) || featured.has(row.remotePluginId),
        ...(iconUrl ? { iconUrl } : iconDataUrl ? { iconDataUrl } : {}),
        ...(denied ? { readOnlyReason: 'codex-unavailable' } : !row.installed && row.mustShowInstallationInterstitial ? { readOnlyReason: 'codex-install-confirmation' } : {}),
      });
    }
  }
  return { items, source: 'codex-app-server', ...(result.marketplaceLoadErrors?.length ? { error: { code: 'CODEX_MARKETPLACE_PARTIAL', message: `${result.marketplaceLoadErrors.length} 个 Codex 市场未能读取，请检查 Codex 登录和市场配置。` } } : {}) };
}
