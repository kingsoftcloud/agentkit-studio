/** Agent authoring tools for the public DSH ToolRegistry.
 * Conversation and tool history remain in DSH. This stores only the editable
 * Agent draft, scoped by the execution's session identity (never model input).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStudioHostRemote } from './host-remote.mjs';
import { STUDIO_DEFAULT_AUTHORING_RUNTIME } from './authoring-defaults.mjs';
import { NATIVE_AGENT_POLICY_CONTRACT } from './native-agent-policy.mjs';

const RUNTIMES = ['dsh-native', 'harness', 'codex'];
const KINDS = ['model', 'mcp', 'skill'];
const FIELDS = ['name', 'description', 'runtimeType', 'systemPrompt', 'taskPrompt', 'modelProfileIds', 'mcpResourceIds', 'skillResourceIds'];
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}`), { code }); };
const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
const revisionSchema = { type: 'integer', minimum: 0, description: 'Exact revision returned by studio_agent_draft; do not guess.' };
const idsSchema = { type: 'array', items: { type: 'string' }, maxItems: 100 };

async function hostRemote(signal) {
  const remote = createStudioHostRemote({
    baseUrl: process.env.AGENTKIT_STUDIO_HOST_URL || 'http://127.0.0.1:8789',
    sessionToken: process.env.AGENTKIT_STUDIO_HOST_SESSION_TOKEN || null,
    fetchImpl: (url, init) => fetch(url, { ...init, signal }),
  });
  await remote.exchangeSession();
  return remote;
}

export function createAuthoringTools({ directory = join(process.env.AGENTKIT_HOME || join(homedir(), '.agentkit'), 'studio', 'authoring'), remoteFactory } = {}) {
  const resolveRemote = remoteFactory || hostRemote;
  function pathFor(exec) {
    const id = exec.agent?.session?.id;
    if (!id) fail('AUTHORING_SESSION_REQUIRED', 'Use this tool from a DSH conversation.');
    return join(directory, createHash('sha256').update(String(id)).digest('hex') + '.json');
  }
  async function read(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return emptyDraft();
    }
  }
  const emptyDraft = (revision = 0) => ({ revision, status: 'draft', draft: { name: '', description: '', runtimeType: STUDIO_DEFAULT_AUTHORING_RUNTIME,
    systemPrompt: '', taskPrompt: '', modelProfileIds: [], mcpResourceIds: [], skillResourceIds: [] } });
  async function save(path, state) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  async function locked(exec, action) {
    const path = pathFor(exec);
    exec.signal?.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await mkdir(path + '.lock', { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') fail('AUTHORING_BUSY', 'Another draft update is in progress. Read the draft again before retrying.'); throw error; }
    try { return await action(await read(path), state => save(path, state)); }
    finally { await rm(path + '.lock', { recursive: true, force: true }); }
  }
  function checkRevision(state, revision) {
    if (!Number.isSafeInteger(revision) || revision !== state.revision) fail('DRAFT_REVISION_CONFLICT', 'Read the current draft and review it before editing or creating.');
  }
  function patchDraft(draft, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('INVALID_DRAFT', 'patch must be an object.');
    for (const [key, value] of Object.entries(patch)) {
      if (!FIELDS.includes(key)) fail('INVALID_DRAFT_FIELD', `Unsupported field: ${key}`);
      if (key.endsWith('Ids')) {
        if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 512)) fail('INVALID_BINDING', `${key} must contain catalog resource IDs.`);
        draft[key] = [...new Set(value)];
      } else {
        if (typeof value !== 'string' || value.length > 32000) fail('INVALID_DRAFT', `${key} must be text of at most 32000 characters.`);
        if (key === 'runtimeType' && !RUNTIMES.includes(value)) fail('RUNTIME_UNSUPPORTED', 'Choose dsh-native, harness or codex.');
        draft[key] = value.trim();
      }
    }
    return draft;
  }
  async function catalog(remote, kind, query = '') {
    const result = await remote.resources(new URLSearchParams({ kind, limit: '100', query }).toString());
    return (result?.items || []).map(item => ({ resourceId: item.resourceId, name: item.displayName || item.name || item.resourceId }));
  }
  return [
    {
      name: 'studio_agent_resources',
      description: 'List actual Studio model, MCP or Skill IDs before binding an Agent draft. Never invent IDs. This tool does not expose credentials. Knowledge/memory and cloud deployment are not handled by these authoring tools yet; do not claim they were bound or deployed.',
      parameters: { ...objectSchema({ kind: { type: 'string', enum: KINDS }, query: { type: 'string' } }), required: ['kind'] },
      output,
      async execute(args, exec) {
        if (!KINDS.includes(args.kind)) fail('RESOURCE_KIND_UNSUPPORTED', 'Choose model, mcp or skill.');
        return { items: await catalog(await resolveRemote(exec.signal), args.kind, args.query || '') };
      },
      presentCall: () => ({ card: 'generic', title: '读取 Agent 可用资源', kind: 'read' }),
    },
    {
      name: 'studio_agent_draft',
      description: 'Create or refine an Agent in this native conversation across multiple turns. Call without patch to read the current draft. To edit, supply expectedRevision and only the fields being changed; omitted fields persist. Show the draft summary and ask for missing requirements. Default runtime is harness (Studio Native); DSH/Codex remain explicit alternatives. Draft edits never create an Agent. reset=true starts a NEW draft only when the user explicitly asks for another Agent.',
      parameters: objectSchema({ expectedRevision: revisionSchema, reset: { type: 'boolean' }, patch: objectSchema({
        name: { type: 'string' }, description: { type: 'string' }, runtimeType: { type: 'string', enum: RUNTIMES },
        systemPrompt: { type: 'string' }, taskPrompt: { type: 'string' }, modelProfileIds: idsSchema, mcpResourceIds: idsSchema, skillResourceIds: idsSchema,
      }) }),
      output,
      async execute(args, exec) {
        if (!args.patch && !args.reset) return read(pathFor(exec));
        return locked(exec, async (state, persist) => {
          checkRevision(state, args.expectedRevision);
          if (state.status === 'creating' || state.status === 'unknown') fail('CREATE_OUTCOME_UNKNOWN', 'Check the Agents page for the previous creation result before making another draft.');
          if (state.status === 'created' && !args.reset) fail('AGENT_ALREADY_CREATED', 'This draft was already created. Read its Agent ID; do not silently create a duplicate.');
          const next = args.reset ? emptyDraft(state.revision) : state;
          if (args.patch) next.draft = patchDraft(next.draft, args.patch);
          next.revision++;
          next.updatedAt = new Date().toISOString();
          await persist(next);
          return next;
        });
      },
      presentCall: args => ({ card: 'generic', title: args.patch ? '更新 Agent 草稿' : '读取 Agent 草稿', kind: args.patch ? 'other' : 'read' }),
    },
    {
      name: 'studio_agent_create',
      description: 'Create a real LOCAL Studio Agent from the current reviewed draft. Only call after showing its name, runtime, prompt and bindings and the user asks to confirm creation. Supply the exact draft revision and confirm=true. Repeated calls return the same created Agent. This does not build, deploy, bind the current conversation, or prove resources executable; report those as separate steps.',
      parameters: { ...objectSchema({ expectedRevision: revisionSchema, confirm: { type: 'boolean' } }), required: ['expectedRevision', 'confirm'] },
      output,
      async execute(args, exec) {
        if (args.confirm !== true) fail('CONFIRMATION_REQUIRED', 'Review the draft with the user before creating.');
        return locked(exec, async (state, persist) => {
          checkRevision(state, args.expectedRevision);
          if (state.status === 'created') return state;
          if (state.status === 'creating' || state.status === 'unknown') fail('CREATE_OUTCOME_UNKNOWN', 'The previous request may have created an Agent. Check the Agents list before retrying; automatic retries are disabled.');
          const draft = state.draft;
          if (!draft.name || !draft.systemPrompt || !draft.modelProfileIds.length) fail('DRAFT_INCOMPLETE', 'Set name, systemPrompt and at least one catalog model ID.');
          const remote = await resolveRemote(exec.signal);
          for (const [kind, key] of [['model', 'modelProfileIds'], ['mcp', 'mcpResourceIds'], ['skill', 'skillResourceIds']]) {
            if (!draft[key].length) continue;
            const available = new Set((await catalog(remote, kind)).map(item => item.resourceId));
            if (draft[key].some(id => !available.has(id))) fail('RESOURCE_NOT_FOUND', `Read the ${kind} catalog and correct the selected resource IDs.`);
          }
          exec.signal?.throwIfAborted();
          state.status = 'creating';
          await persist(state);
          let result;
          try {
            result = await remote.quickAuthorAgent({ name: draft.name, runtimeType: draft.runtimeType, template: 'blank', description: draft.description, spec: {
              description: draft.description,
              security: { toolPolicy: 'deny-by-default', allowedPermissions: draft.runtimeType === 'harness'
                ? ['process:host-user', ...(draft.mcpResourceIds.length ? ['network:mcp'] : [])] : [] },
              instructions: { system: draft.systemPrompt, task: draft.taskPrompt },
              bindings: { modelProfileId: draft.modelProfileIds[0], modelProfileIds: draft.modelProfileIds, tools: [], mcpServers: draft.mcpResourceIds.map(resourceId => ({ resourceId })), skills: draft.skillResourceIds.map(resourceId => ({ resourceId })),
                ...(draft.runtimeType === 'harness' ? { policyTemplate: 'strict', nativeAgentPolicy: {
                  contract: NATIVE_AGENT_POLICY_CONTRACT, mode: 'strict', rules: {} } } : {}) },
            } });
          } catch (error) {
            state.status = error.status >= 400 && error.status < 500 ? 'draft' : 'unknown';
            await persist(state);
            if (state.status === 'unknown') fail('CREATE_OUTCOME_UNKNOWN', 'The service response was lost. Check the Agents list; do not repeat creation.');
            throw error;
          }
          if (!result?.metadata?.id) { state.status = 'unknown'; await persist(state); fail('CREATE_OUTCOME_UNKNOWN', 'The service returned no Agent identity. Check the Agents list.'); }
          state.status = 'created';
          state.agent = { id: result.metadata.id, name: result.metadata.name, revision: result.metadata.revision };
          state.nextStep = 'Agent 已创建，可到 Agents 查看。构建、部署和绑定会话尚未执行。';
          await persist(state);
          return state;
        });
      },
      presentCall: () => ({ card: 'generic', title: '确认创建 Agent', kind: 'other' }),
    },
  ];
}

export function registerAuthoringTools(ctx, { remoteFactory } = {}) {
  ctx.inject(['tools'], scoped => {
    for (const tool of createAuthoringTools({ remoteFactory: remoteFactory || hostRemote })) scoped.tools.register(tool);
  });
}
