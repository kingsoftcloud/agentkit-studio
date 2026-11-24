import { isRecord } from './native-values.mjs';

export const ENGINE_TOOL_CATALOG = 'agentkit.engine-tool-catalog/v1';
export const ENGINE_TOOL_CATALOG_FILE = 'dist/studio-tool-catalog.json';

/** @param {unknown} value @returns {value is string} */
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value);
/** @param {readonly unknown[]} values */
const unique = values => new Set(values).size === values.length;

/** Accept authoring metadata only from the currently verified release.
 * @param {unknown} value @param {string} version
 */
export function readEngineToolCatalog(value, version) {
  if (!isRecord(value) || value.schemaVersion !== ENGINE_TOOL_CATALOG || value.version !== version
    || !Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 128
    || !Array.isArray(value.defaultTools) || !unique(value.defaultTools)
    || !Array.isArray(value.supportedCommandPlatforms) || !unique(value.supportedCommandPlatforms)
    || !value.supportedCommandPlatforms.every(target => typeof target === 'string' && /^(darwin|linux|win32)-(arm64|x64)$/.test(target)))
    throw Error('Invalid Star Harness tool catalog');
  /** @type {Set<string>} */
  const names = new Set();
  const tools = value.tools.map((/** @type {unknown} */ tool) => {
    if (!isRecord(tool) || !identifier(tool.name) || names.has(tool.name)
      || typeof tool.description !== 'string' || tool.description.length > 8192
      || !isRecord(tool.parameters) || tool.parameters.type !== 'object' || typeof tool.readOnly !== 'boolean'
      || typeof tool.timeoutMs !== 'number' || !Number.isSafeInteger(tool.timeoutMs) || tool.timeoutMs < 1
      || !Array.isArray(tool.permissions) || !tool.permissions.every(item => typeof item === 'string' && item.length <= 128)
      || typeof tool.availability !== 'string' || !['always', 'search', 'browser', 'local-command'].includes(tool.availability))
      throw Error('Invalid Star Harness tool descriptor');
    const { name, description, parameters, readOnly, timeoutMs, permissions, availability } = tool;
    names.add(name);
    return { name, description, parameters, readOnly, timeoutMs, permissions, availability };
  });
  if (!value.defaultTools.every(name => names.has(name))) throw Error('Invalid Star Harness tool defaults');
  const { childWorkspaceTools } = value;
  if (childWorkspaceTools !== undefined && (!Array.isArray(childWorkspaceTools) || childWorkspaceTools.length > names.size
    || !unique(childWorkspaceTools) || !childWorkspaceTools.every(name => names.has(name))))
    throw Error('Invalid Star Harness child workspace tools');
  return { schemaVersion: ENGINE_TOOL_CATALOG, version, tools, defaultTools: value.defaultTools,
    ...(childWorkspaceTools !== undefined ? { childWorkspaceTools } : {}),
    supportedCommandPlatforms: value.supportedCommandPlatforms };
}
