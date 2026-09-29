/** Local DSH plugin ecosystem for the Studio plugin Node host.
 *
 * The legacy Studio Host served /api/v1/plugin-ecosystems/dsh/plugins from
 * the local profile. The plugin Node host owns the same contract: read the
 * profile's package manifest for installed plugins, and forward install /
 * remove to the `dsh plugin` CLI. Codex marketplace cataloging stays out of
 * scope until its catalog source exists.
 */
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class StudioPluginsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioPluginsError';
    this.code = code;
    this.details = details;
  }
}

export function createStudioPlugins({ profileDir, dshRoot, execImpl = execFileAsync, timeoutMs = 300000 } = {}) {
  const profile = profileDir || join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'agentkit-studio');
  const root = dshRoot || process.cwd();

  async function readJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
  }

  async function listDsh() {
    const manifest = await readJson(join(profile, 'package.json'));
    if (!manifest) return { items: [], source: 'profile-missing' };
    const bundles = manifest?.dsh?.profile?.bundles || [];
    const dependencies = manifest.dependencies || {};
    const items = [];
    for (const bundle of bundles) {
      const meta = await readJson(join(profile, 'node_modules', bundle, 'package.json'));
      items.push({
        pluginId: bundle,
        name: bundle,
        displayName: meta?.description || bundle,
        version: meta?.version || 'bundled',
        source: 'bundle',
        enabled: true,
        kind: 'dsh',
      });
    }
    for (const [name, spec] of Object.entries(dependencies)) {
      const meta = await readJson(join(profile, 'node_modules', name, 'package.json'));
      const iconFile = meta?.icon ? join(profile, 'node_modules', name, meta.icon) : null;
      let iconDataUrl = null;
      if (iconFile && /\.(svg|png)$/i.test(iconFile)) {
        try {
          const raw = await readFile(iconFile);
          iconDataUrl = `data:image/${iconFile.endsWith('.svg') ? 'svg+xml' : 'png'};base64,${raw.toString('base64')}`;
        } catch { /* icon asset optional */ }
      }
      items.push({
        pluginId: name,
        name,
        displayName: meta?.description || meta?.name || name,
        version: meta?.version || String(spec).replace(/^file:/, '').split('/').pop() || 'unknown',
        source: String(spec).startsWith('file:') ? 'local-tarball' : 'registry',
        enabled: true,
        kind: 'dsh',
        installSpec: spec,
        iconDataUrl,
      });
    }
    return { items, source: 'profile' };
  }

  function assertSafeSpec(source) {
    const value = String(source || '').trim();
    if (!value) throw new StudioPluginsError('PLUGIN_SOURCE_MISSING', '插件安装源不能为空');
    if (value.includes('..') || value.startsWith('/') || /^[a-z]:/i.test(value)) {
      // file: tarball paths are allowed as absolute file: URLs only.
      if (!value.startsWith('file:')) throw new StudioPluginsError('PLUGIN_SOURCE_INVALID', '安装源必须是包名或 file: tarball');
    }
    if (/[;&|`$]/.test(value)) throw new StudioPluginsError('PLUGIN_SOURCE_INVALID', '安装源包含非法字符');
    return value;
  }

  async function runCli(args) {
    const { stdout, stderr } = await execImpl('pnpm', ['dsh', 'plugin', '--profile', require_profileName(), ...args], {
      cwd: root, timeout: timeoutMs, windowsHide: true,
    });
    return { stdout: String(stdout || ''), stderr: String(stderr || '') };
  }

  function require_profileName() {
    const match = /--profile\s+([^\s]+)/.exec(process.argv.join(' '));
    return match?.[1] || process.env.DSH_PROFILE || 'agentkit-studio';
  }

  async function installDsh(source, acceptHostPermissions = false) {
    const spec = assertSafeSpec(source);
    let exists = true;
    try { await stat(profile); } catch { exists = false; }
    if (!exists) throw new StudioPluginsError('PROFILE_MISSING', 'DSH profile 不存在，请先执行 profile-install', { profile });
    const args = ['add', spec];
    const { stdout } = await runCli(args);
    return { ok: true, output: stdout.slice(-800), acceptHostPermissions: Boolean(acceptHostPermissions) };
  }

  async function uninstallDsh(pluginName) {
    const name = assertSafeSpec(pluginName);
    const { stdout } = await runCli(['remove', name]);
    return { ok: true, output: stdout.slice(-800) };
  }

  // Enable/disable lands in the profile's cordis.patch.yml `disables` list —
  // the documented patch-layer mechanism. Effective after the profile reloads.
  async function setDshEnabled(pluginName, enabled) {
    const name = assertSafeSpec(pluginName);
    const patchPath = join(profile, 'cordis.patch.yml');
    const YAML = await import('yaml');
    let doc = [];
    try { doc = YAML.parse(await readFile(patchPath, 'utf8')) || []; } catch { doc = []; }
    if (!Array.isArray(doc)) doc = [];
    const filtered = doc.filter(entry => !(entry?.disables || []).includes(name));
    if (!enabled) {
      let target = filtered.find(entry => Array.isArray(entry?.disables));
      if (!target) { target = { disables: [] }; filtered.push(target); }
      if (!target.disables.includes(name)) target.disables.push(name);
    }
    const payload = YAML.stringify(filtered);
    await writeFile(patchPath, payload, { mode: 0o600 });
    return { pluginName: name, enabled, note: '已在 profile 补丁层更新；DSH profile 重载后生效' };
  }

  async function updateDsh(pluginName) {
    const name = assertSafeSpec(pluginName);
    const manifest = await readJson(join(profile, 'package.json'));
    const spec = manifest?.dependencies?.[name];
    if (!spec) throw new StudioPluginsError('PLUGIN_NOT_INSTALLED', '插件未安装，无法更新', { pluginName: name });
    await runCli(['remove', name]);
    const { stdout } = await runCli(['add', String(spec).startsWith('file:') ? spec : `${name}@latest`]);
    return { ok: true, output: stdout.slice(-600) };
  }

  return { listDsh, installDsh, uninstallDsh, setDshEnabled, updateDsh };
}
