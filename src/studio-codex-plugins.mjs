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

export function createStudioCodexPlugins({ codexHome } = {}) {
  const execImpl = promisify(execFile);
  const cacheRoot = codexHome ? join(codexHome, 'plugins', 'cache') : join(homedir(), '.codex', 'plugins', 'cache');

  async function readJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
  }

  async function listCodex() {
    // `codex plugin list` is the authoritative inventory (installed/enabled
    // status, version, marketplace); the cache scan stays as fallback when
    // the CLI is unavailable.
    try {
      const { stdout } = await execImpl('codex', ['plugin', 'list'], { timeout: 30000, windowsHide: true });
      const items = [];
      for (const line of String(stdout || '').split('\n')) {
        const match = /^([\w@.-]+)\s+(installed,\s*)?(enabled|disabled|available)\s+(\S+)\s+(.+)$/.exec(line.trim());
        if (!match) continue;
        const [, name, , state, version, source] = match;
        items.push({
          pluginId: name, name, displayName: name,
          description: source, version,
          source: 'codex-cli', state,
          installed: state === 'installed' || state === 'enabled',
          enabled: state === 'enabled' || state === 'installed',
          kind: 'codex',
        });
      }
      if (items.length) return { items, source: 'codex-cli' };
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
          installed: true, enabled: true,
          kind: 'codex',
          category,
          author,
        });
      }
    }
    items.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    return { items, source: 'codex-home' };
  }

  async function installCodex(pluginId) {
    const name = String(pluginId || '').trim();
    if (!name) throw new StudioCodexPluginsError('CODEX_PLUGIN_ID_MISSING', '插件名不能为空');
    const { stdout } = await execImpl('codex', ['plugin', 'add', name], { timeout: 120000, windowsHide: true });
    return { ok: true, output: String(stdout || '').slice(-600) };
  }

  async function uninstallCodex(pluginId) {
    const name = String(pluginId || '').trim();
    if (!name) throw new StudioCodexPluginsError('CODEX_PLUGIN_ID_MISSING', '插件名不能为空');
    const { stdout } = await execImpl('codex', ['plugin', 'remove', name], { timeout: 120000, windowsHide: true });
    return { ok: true, output: String(stdout || '').slice(-600) };
  }

  return { listCodex, installCodex, uninstallCodex };
}
