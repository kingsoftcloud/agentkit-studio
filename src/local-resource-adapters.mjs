/** Host-owned adapters for resources bound to a local Agent revision. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class LocalResourceError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'LocalResourceError'; this.code = code; this.details = details; }
}

function resourceId(value) { return String(value?.resourceId || value?.id || value || '').trim(); }

export function createLocalResourceAdapters({ serverClient, skillDiscovery } = {}) {
  const mcpClients = new Map();

  async function mcp(id) {
    const key = resourceId(id);
    if (!key) throw new LocalResourceError('MCP_ID_MISSING', 'MCP 资源 ID 不能为空');
    if (mcpClients.has(key)) return mcpClients.get(key);
    const detail = (await serverClient.action('GetMCP', { Id: key })).data || {};
    const endpoint = detail.mcp_endpoint || detail.private_mcp_endpoint || detail.endpoint;
    if (!endpoint || !/^https?:\/\//i.test(endpoint)) throw new LocalResourceError('MCP_ENDPOINT_UNAVAILABLE', 'MCP 没有可用的 HTTP Endpoint', { resourceId: key });
    const headers = detail.api_key ? { Authorization: `Bearer ${detail.api_key}` } : undefined;
    const client = new Client({ name: 'agentkit-studio-local-runtime', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), headers ? { requestInit: { headers } } : undefined);
    await client.connect(transport);
    const entry = { client, transport };
    mcpClients.set(key, entry);
    return entry;
  }

  async function listMcpTools(id) {
    const { client } = await mcp(id);
    return (await client.listTools()).tools || [];
  }

  async function callMcpTool(id, name, args = {}) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(name || ''))) throw new LocalResourceError('MCP_TOOL_NAME_INVALID', 'MCP 工具名无效');
    const { client } = await mcp(id);
    const result = await client.callTool({ name: String(name), arguments: args });
    if (result?.isError) throw new LocalResourceError('MCP_TOOL_FAILED', 'MCP 工具执行失败', { resourceId: resourceId(id), name });
    return result?.content || result;
  }

  async function loadSkill(id) {
    if (!skillDiscovery) throw new LocalResourceError('SKILL_ADAPTER_MISSING', 'Skill 适配器未启用');
    const installed = await skillDiscovery.listInstalled();
    if (!installed.items?.some(item => item.resourceId === resourceId(id))) {
      throw new LocalResourceError('SKILL_NOT_INSTALLED', `绑定的 Skill（${resourceId(id)}）不在本地导入目录中；请在 Agent 编辑页重新选择 Skill。Skill Center 不能作为本地 Skill 使用。`, { resourceId: resourceId(id) });
    }
    const value = await skillDiscovery.previewInstalled(resourceId(id));
    const manifest = value.files?.find(file => file.path === 'SKILL.md');
    if (!manifest) throw new LocalResourceError('SKILL_MANIFEST_MISSING', 'Skill 缺少 SKILL.md', { resourceId: resourceId(id) });
    const content = (await skillDiscovery.previewInstalled(resourceId(id), 'SKILL.md')).content || '';
    return { name: resourceId(id), content };
  }

  async function searchKnowledge(id, query) {
    const result = await serverClient.action('RetrieveKnowledge', {
      DatasetId: resourceId(id), Query: String(query || ''),
      RetrievalModel: { SearchMethod: 'semantic', TopK: 5, RerankingEnable: true },
    }, { apiVersion: '2025-11-14' });
    return result.data?.Records || result.data?.records || [];
  }

  async function close() {
    for (const { client } of mcpClients.values()) await client.close().catch(() => {});
    mcpClients.clear();
  }

  return { listMcpTools, callMcpTool, loadSkill, searchKnowledge, close };
}
