/** Local Codex plugin inventory for the Studio plugin Node host.
 *
 * The legacy Studio Host listed the Codex ecosystem from the local Codex
 * home. Codex caches installed plugins under ~/.codex/plugins/cache:
 * - openai-curated-remote/<plugin>/.codex-remote-plugin-install.json + version dirs with skills/
 * - openai-bundled/<plugin>/<version>/.mcp.json
 * This module projects those directories into the marketplace item shape.
 */
import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';

export class StudioCodexPluginsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioCodexPluginsError';
    this.code = code;
    this.details = details;
  }
}

function parseFrontmatter(source) {
  const text = String(source || '');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const metadata = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match) metadata[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return metadata;
}

export function createStudioCodexPlugins({ codexHome = process.env.CODEX_HOME, executable = process.env.AGENTKIT_CODEX_BIN || 'codex', execImpl = promisify(execFile) } = {}) {
  const cacheRoot = codexHome ? join(codexHome, 'plugins', 'cache') : join(homedir(), '.codex', 'plugins', 'cache');
  function cliOptions(timeout) { return { timeout, windowsHide: true, ...(codexHome ? { env: { ...process.env, CODEX_HOME: codexHome } } : {}) }; }

  async function readJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
  }

  async function listCodex() {
    // `codex plugin list --json` is the authoritative inventory: structured
    // rows with installed/enabled flags and marketplace names. The CLI also
    // exposes add/remove for the lifecycle actions.
    try {
      const { stdout } = await execImpl(executable, ['plugin', 'list', '--json'], cliOptions(60000));
      const parsed = JSON.parse(String(stdout || '{}'));
      if (!Array.isArray(parsed.installed) || !Array.isArray(parsed.available)) throw new Error('Codex plugin list returned no inventory');
      const rows = [...(parsed.installed || []), ...(parsed.available || [])];
      const items = rows.map(row => ({
        pluginId: String(row.pluginId || `${row.name}@${row.marketplaceName || ''}`),
        name: String(row.name || ''),
        displayName: String(row.name || ''),
        description: String(row.description || row.summary || ''),
        version: String(row.version || ''),
        marketplace: String(row.marketplaceName || ''),
        marketplaceName: String(row.marketplaceName || ''),
        source: row.installed ? 'codex-installed' : 'codex-available',
        installed: row.installed === true,
        enabled: row.enabled === true,
        lifecycleAvailable: true,
        status: row.installed ? row.enabled ? 'enabled' : 'disabled' : 'available',
        kind: 'codex',
      }));
      return { items, source: 'codex-cli' };
    } catch { /* CLI missing or failed: fall through to the cache scan */ }
    const items = [];
    const sections = [
      { dir: 'openai-curated-remote', source: 'codex-curated' },
      { dir: 'openai-bundled', source: 'codex-bundled' },
    ];
    for (const section of sections) {
      let entries;
      try { entries = await readdir(join(cacheRoot, section.dir), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries.filter(item => item.isDirectory())) {
        const pluginDir = join(cacheRoot, section.dir, entry.name);
        let displayName = entry.name;
        let description = '';
        let version = 'installed';
        let category = '';
        let author = '';
        try {
          // Plugin manifests carry richer copy than the skill frontmatter.
          const manifest = await readJson(join(pluginDir, '.codex-plugin', 'plugin.json'));
          if (manifest) {
            displayName = String(manifest.name || displayName);
            description = String(manifest.description || description);
            version = String(manifest.version || version);
            category = String(manifest.interface?.category || '');
            author = String(manifest.author?.name || '');
          }
          if (section.source === 'codex-curated') {
            // Versioned skill directories carry SKILL.md frontmatter.
            const versions = (await readdir(pluginDir, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort().reverse();
            if (versions.length) {
              version = versions[0];
              const skills = await readdir(join(pluginDir, version, 'skills'), { withFileTypes: true }).catch(() => []);
              const firstSkill = skills.find(item => item.isDirectory());
              if (firstSkill) {
                const manifest = parseFrontmatter(await readFile(join(pluginDir, version, 'skills', firstSkill.name, 'SKILL.md'), 'utf8'));
                displayName = String(manifest.name || firstSkill.name);
                description = String(manifest.description || '');
              }
            }
          } else {
            const versions = (await readdir(pluginDir, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort().reverse();
            if (versions.length) {
              version = versions[0];
              const mcp = await readFile(join(pluginDir, version, '.mcp.json'), 'utf8').catch(() => null);
              if (mcp) {
                const parsed = JSON.parse(mcp);
                const serverName = Object.keys(parsed?.mcpServers || parsed?.servers || {})[0];
                displayName = serverName || entry.name;
                description = String(parsed?.mcpServers?.[serverName]?.description || parsed?.description || '');
              }
            }
          }
        } catch { /* unreadable plugin directory is skipped per-field, row still emitted */ }
        items.push({
          pluginId: `${section.source}:${entry.name}`,
          name: entry.name,
          displayName,
          description,
          version,
          source: section.source,
          installed: true, enabled: false, status: 'cached', lifecycleAvailable: false,
          kind: 'codex',
          category,
          author,
        });
      }
    }
    items.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    return { items, source: 'codex-home', error: { code: 'CODEX_PLUGIN_INVENTORY_UNAVAILABLE', message: 'Codex CLI 目录不可用，以下仅为缓存，无法确认是否安装或启用。' } };
  }

  async function changeCodex(operation, pluginId, marketplaceName = '') {
    const name = String(pluginId || '').trim();
    if (!name) throw new StudioCodexPluginsError('CODEX_PLUGIN_ID_MISSING', '插件名不能为空');
    const spec = name.includes('@') ? name : marketplaceName ? `${name}@${String(marketplaceName).trim()}` : name;
    if (!/^[^\s@]+@[^\s@]+$/.test(spec) || spec.startsWith('-')) throw new StudioCodexPluginsError('CODEX_PLUGIN_MARKETPLACE_MISSING', '请使用完整插件标识：插件名@市场名');
    try {
      const { stdout } = await execImpl(executable, ['plugin', operation, spec, '--json'], cliOptions(120000));
      return { ok: true, pluginId: spec, output: String(stdout || '').slice(-1200), note: operation === 'add' ? 'Codex 插件已安装；新建 Codex Agent 会话后加载，连接器按 Codex 的授权状态使用。' : 'Codex 插件已卸载。' };
    } catch (error) {
      throw new StudioCodexPluginsError('CODEX_PLUGIN_OPERATION_FAILED', String(error?.stderr || error?.message || 'Codex 插件操作失败').trim().slice(-1200), { pluginId: spec, operation });
    }
  }

  async function installCodex(pluginId, marketplaceName) { return changeCodex('add', pluginId, marketplaceName); }
  async function uninstallCodex(pluginId, marketplaceName) { return changeCodex('remove', pluginId, marketplaceName); }

  return { listCodex, installCodex, uninstallCodex };
}
