/** Studio TeamDefinitions map one immutable blueprint to a DSH native TeamRun. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { OFFICIAL_TEAM_TOOL_MODULE, usesOfficialTeamTools } from './studio-team-runtime.mjs';
import { installStudioTeamTools, studioTeammateRequest } from './studio-team-tools.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => structuredClone(value);
const nativeRuntimes = new Set(['dsh-native', 'harness']);

function text(value, label, max) {
  const result = String(value || '').trim();
  if (!result || result.length > max) throw fail('TEAM_INVALID', `${label}不能为空且不能超过 ${max} 字`);
  return result;
}

function sourceOf(input) {
  if (input?.source && typeof input.source === 'object') {
    const source = copy(input.source);
    if (!['agent', 'template'].includes(source.kind) || !String(source.id || source.agentId || '').trim()) {
      throw fail('TEAM_INVALID', '团队角色来源无效');
    }
    if (source.kind === 'template' && (!source.digest || !source.version)) {
      throw fail('TEAM_INVALID', '团队角色模板必须锁定版本和摘要');
    }
    if (source.kind === 'agent') {
      const agentId = text(input.agentId ?? source.agentId ?? source.id, '专家', 180);
      return { ...source, id: agentId, agentId };
    }
    return source;
  }
  if (input?.agentId) return { kind: 'agent', agentId: text(input.agentId, '专家', 180), id: text(input.agentId, '专家', 180) };
  throw fail('TEAM_INVALID', '团队角色缺少来源');
}

function normalizeRole(input, lead = false) {
  const name = lead ? 'lead' : String(input?.name || '').trim();
  if (!lead && (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || name === 'lead')) {
    throw fail('TEAM_INVALID', '成员标识须为唯一的小写英文或连字符，不能使用 lead');
  }
  const role = {
    name,
    label: text(input?.label || name || '团队主理人', '成员名称', 80),
    instructions: text(input?.instructions || (lead ? '组织任务、分配职责、审查并汇总全部成员报告。' : ''), '成员职责', 8000),
    source: sourceOf(input),
  };
  const selectedPreset = input?.agentPreset ?? input?.agentPresetId;
  if (selectedPreset != null && String(selectedPreset).trim() !== '') {
    role.agentPreset = text(selectedPreset, `${name || '团队'} agent preset`, 256);
  }
  if (role.source.kind === 'template') {
    if (!input?.spec || typeof input.spec !== 'object') throw fail('TEAM_INVALID', '模板角色缺少冻结的角色蓝图');
    role.spec = copy(input.spec);
    if (input.bindings && typeof input.bindings === 'object') role.bindings = copy(input.bindings);
  } else {
    role.agentId = role.source.agentId;
  }
  return role;
}

export function validateTeam(input) {
  const members = Array.isArray(input?.members) ? input.members : [];
  if (members.length < 1 || members.length > 8) throw fail('TEAM_INVALID', '请选择 1 至 8 位团队成员');
  const leadInput = input?.lead || input?.leadRole;
  const lead = leadInput
    ? normalizeRole({ ...leadInput, ...(leadInput.source?.kind !== 'template' && input.leadAgentId !== undefined ? { agentId: input.leadAgentId } : {}) }, true)
    : normalizeRole({ agentId: input?.leadAgentId, label: '团队主理人', instructions: input?.instructions || '组织任务、分配职责、审查并汇总全部成员报告。' }, true);
  const names = new Set();
  const normalized = members.map(member => {
    const role = normalizeRole(member);
    if (names.has(role.name)) throw fail('TEAM_INVALID', '成员标识必须唯一');
    names.add(role.name);
    return role;
  });
  return {
    runtime: 'dsh-native-team',
    name: text(input?.name, '团队名称', 80),
    description: String(input?.description || '').trim().slice(0, 1000),
    instructions: text(input?.instructions || '分解任务，让每位成员独立完成职责，汇总并审查结果。', '协作指令', 16000),
    lead,
    ...(lead.source.kind === 'agent' ? { leadAgentId: lead.source.agentId } : {}),
    members: normalized.map(role => role.source.kind === 'agent' ? { ...role, agentId: role.source.agentId } : role),
  };
}

function roleAgentId(run, role) {
  return `team-role-${createHash('sha256').update(JSON.stringify([run.teamId, run.id, role.name, role.source, role.instructions])).digest('hex').slice(0, 24)}`;
}

function nativeTeamSpawnRequest(run, role, signal) {
  return studioTeammateRequest({
    role,
    run,
    // DSH persists an initial prompt when creating a teammate. Keep it a
    // readiness check; the Lead assigns the work once the roster is complete.
    prompt: '请简短确认已就绪，等待主理人分配任务。收到任务前不要开始工作或发送团队消息。',
    signal,
  });
}

export function createStudioTeams({ ctx, directory, agents, getAdmission, runtimeReady = Promise.resolve() }) {
  const runs = new Map();
  const locks = new Map();
  const startup = new Map();
  const compatibilityTools = new Map();
  function releaseCompatibilityTools() {
    for (const dispose of compatibilityTools.values()) dispose();
    compatibilityTools.clear();
  }
  function mountTools(agent, options) {
    if (compatibilityTools.has(agent)) return;
    const dispose = installStudioTeamTools(agent, options);
    if (dispose) compatibilityTools.set(agent, dispose);
  }
  ctx.effect?.(() => releaseCompatibilityTools, 'agentkit-studio: team tool ownership');
  const path = (kind, id) => {
    if (!/^(team|teamrun)-[a-f0-9]{24}$/.test(id)) throw fail('TEAM_ID_INVALID', '团队或运行 ID 无效');
    return join(directory, kind, `${id}.json`);
  };
  async function read(kind, id) {
    try { return JSON.parse(await readFile(path(kind, id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function write(kind, item) {
    const target = path(kind, item.id);
    await mkdir(join(directory, kind), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(stored(item), null, 2), { mode: 0o600 });
    await rename(temporary, target);
    return copy(stored(item));
  }
  async function all(kind) {
    const files = await readdir(join(directory, kind)).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return Promise.all(files.filter(file => /^(team|teamrun)-[a-f0-9]{24}\.json$/.test(file)).map(file => read(kind, file.slice(0, -5))));
  }
  async function serial(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    locks.set(key, next);
    try { return await next; }
    finally { if (locks.get(key) === next) locks.delete(key); }
  }
  function stored(value) {
    const { runtimeAgents, ...record } = value || {};
    // A TeamRun owns DSH root/child Sessions.  The synthetic identity used to
    // admit a Studio preset is an in-memory implementation detail, not a
    // second Studio Agent.  Keep legacy files readable, but never persist a
    // `team-role-*` Agent-looking field in new TeamRun records.
    if (/^teamrun-[a-f0-9]{24}$/.test(record.id) && Array.isArray(record.roles)) {
      record.roles = record.roles.map(role => {
        const copyRole = { ...role };
        if (/^team-role-[a-f0-9]{24}$/.test(String(copyRole.agentId || ''))) delete copyRole.agentId;
        delete copyRole.runtimeAgentId;
        return copyRole;
      });
    }
    return record;
  }
  function services() {
    const teams = ctx.get('agentTeams'), controller = ctx.get('sessionController');
    if (!teams || !controller || !ctx.get('agentPresets')) throw fail('TEAM_RUNTIME_UNAVAILABLE', '官方 agent-teams 或会话服务尚未就绪，请重试');
    return { teams, controller };
  }
  async function resolveRoleAgent(run, role) {
    if (run.runtimeAgents?.has(role.name)) return run.runtimeAgents.get(role.name);
    let source;
    if (role.source?.kind === 'agent') {
      const id = role.source.agentId || role.source.id;
      // Once a run has started, its stored spec and revision are the authority,
      // including after the user edits or removes the source Agent.
      source = role.spec
        ? { metadata: { id, name: role.label, revision: role.sourceRevision || 1, local: true }, spec: role.spec }
        : await agents.get(id);
      if (!source) throw fail('TEAM_SOURCE_AGENT_MISSING', `团队角色「${role.label}」的来源专家不存在`);
    } else if (role.source?.kind === 'template') {
      source = {
        metadata: { id: role.source.id, name: role.label, revision: Number(role.source.revision || 1), local: true },
        spec: copy(role.spec || {}),
      };
    } else if (role.agentId) {
      // Compatibility for pre-native TeamRun files.
      source = await agents.get(role.agentId);
      if (!source) throw fail('TEAM_SNAPSHOT_MISSING', '旧团队运行的专家来源已不存在');
    } else {
      throw fail('TEAM_ROLE_SOURCE_MISSING', `团队角色「${role.label}」缺少来源蓝图`);
    }
    const spec = copy(role.spec || source.spec || {});
    const runtime = String(spec.runtime?.type || '').trim();
    if (!nativeRuntimes.has(runtime)) throw fail('TEAM_AGENT_UNSUPPORTED', '专家团成员必须使用本机 DSH Native 或 Harness');
    if (role.bindings && typeof role.bindings === 'object') {
      spec.bindings = { ...(spec.bindings || {}), ...copy(role.bindings) };
      if (role.bindings.modelId) {
        spec.bindings.modelProfileId ||= role.bindings.modelId;
        spec.bindings.modelProfileIds ||= [role.bindings.modelId];
      }
    }
    spec.instructions = {
      ...(spec.instructions || {}),
      system: [spec.instructions?.system || source.metadata?.description || '', `团队职责：${role.instructions}`].filter(Boolean).join('\n\n'),
    };
    const agent = {
      ...copy(source),
      metadata: {
        ...(source.metadata || {}),
        id: role.runtimeAgentId || (/^team-role-[a-f0-9]{24}$/.test(String(role.agentId || '')) ? role.agentId : roleAgentId(run, role)),
        teamRole: {
          teamId: run.teamId, runId: run.id, name: role.name,
          ...(role.source?.kind === 'agent' ? { sourceAgentId: source.metadata.id } : source.metadata?.teamRole || {}),
        },
        name: `${run.name} · ${role.label}`,
        revision: Number(source.metadata?.revision || role.sourceRevision || 1),
        local: true,
      },
      spec,
    };
    run.runtimeAgents ||= new Map();
    run.runtimeAgents.set(role.name, agent);
    if (role.source?.kind === 'agent') {
      if (!role.spec) {
        role.sourceRevision = Number(source.metadata?.revision || 1);
        role.spec = copy(source.spec || {});
      }
    }
    // DSH receives this synthetic identity only while composing the Session;
    // it is deliberately not a persisted Studio Agent identity.
    role.runtimeAgentId ||= /^team-role-[a-f0-9]{24}$/.test(String(role.agentId || '')) ? role.agentId : roleAgentId(run, role);
    if (/^team-role-[a-f0-9]{24}$/.test(String(role.agentId || ''))) delete role.agentId;
    return agent;
  }
  async function hydrate(run) {
    run.runtimeAgents = new Map();
    for (const role of run.roles || []) {
      role.runtimeAgentId ||= /^team-role-[a-f0-9]{24}$/.test(String(role.agentId || '')) ? role.agentId : roleAgentId(run, role);
      await resolveRoleAgent(run, role);
    }
    return run;
  }
  async function admitRole(run, role, recovery = false, requireModelSelection = !recovery) {
    const agent = await resolveRoleAgent(run, role);
    const runtimeAgentId = role.runtimeAgentId || (/^team-role-[a-f0-9]{24}$/.test(String(role.agentId || '')) ? role.agentId : roleAgentId(run, role));
    role.runtimeAgentId = runtimeAgentId;
    const admission = await getAdmission().ensure(runtimeAgentId, {
      agent,
      allowUnavailableResources: recovery,
      requireModelSelection,
    });
    if (admission?.presetId) {
      if (role.agentPreset && role.agentPreset !== admission.presetId) {
        throw fail('TEAM_PRESET_CONFLICT', `团队角色「${role.label}」的 preset 已变化，请新建团队运行`);
      }
      role.agentPreset = admission.presetId;
    }
    if (admission?.modelSelection?.model) role.model = String(admission.modelSelection.model).trim();
    return admission;
  }
  async function admitRoles(run, recovery = false) {
    for (const role of run.roles || []) await admitRole(run, role, recovery);
  }
  async function mount(agent) {
    const parent = agent.session?.header?.parentSession;
    const run = runs.get(parent || agent.id);
    if (!run) return;
    if (!ctx.get('agentTeams')) await runtimeReady;
    const { teams } = services();
    const root = parent ? ctx.get('agents')?.get(parent) : agent;
    if (!root) throw fail('TEAM_ROOT_UNAVAILABLE', '无法恢复团队根会话');
    const name = parent ? teams.listMembers(root).find(row => row.id === agent.id)?.name : 'lead';
    const role = run.roles.find(row => row.name === name);
    const initializing = startup.get(run.id);
    if (parent && role && initializing?.spawning) initializing.teammates.add(agent.id);
    // Official DSH Team tools intentionally allow the Lead to create extra
    // native teammates. They are real Team members, but have no Studio role
    // mapping or preset admission. Leave their inherited composition intact
    // and only install the optional Studio adapter when the official tools are
    // not active; the adapter's own spawn path remains role-limited.
    const useOfficialTools = await usesOfficialTeamTools(ctx);
    if (!role) {
      mountTools(agent, { teams, run, useOfficialTools });
      return;
    }
    // A child Session may inherit DSH's host default before its Studio preset
    // is mounted. Resolve the role's bound model here so the first child turn
    // cannot be rejected by the local runtime's binding check.
    const admission = await admitRole(run, role, true, Boolean(parent));
    const registry = ctx.get('agentPresets');
    if (registry.composedPreset(agent.ctx) !== admission.presetId) await registry.recompose(agent.ctx, admission.presetId);
    if (parent && admission.modelSelection) {
      agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), ...admission.modelSelection }), { prepend: true });
      agent.ctx.on('system-prompt/assemble', async (_payload, _context, next) => {
        const value = await next();
        return { ...value, variables: { ...value.variables, ...admission.modelSelection } };
      });
    }
    mountTools(agent, { teams, run, useOfficialTools });
    if (!parent && run.instructions) {
      if (initializing) {
        agent.ctx.on('agent/pre-step', async ({ messages, step }, next) => {
          if (!initializing.teammates.size) return next();
          // DSH wakes the Lead on child settlement. The first settlement of a
          // preconfigured child is only its readiness check, not a report.
          const notices = new Set(messages.filter(message => message.source?.kind === 'subagent-settled'
            && initializing.teammates.delete(message.source.senderSessionId)).map(message => message.id));
          if (!notices.size) return next();
          if (!initializing.spawning && !initializing.teammates.size) startup.delete(run.id);
          const decision = await next();
          if (decision.kind !== 'enter') return decision;
          const onlyReadiness = step === 1 && messages.every(message => notices.has(message.id));
          return { ...decision, messages: onlyReadiness ? [] : decision.messages.filter(message => !notices.has(message.id)) };
        }, { prepend: true });
      }
      agent.ctx.systemPrompt.section({
        name: 'studio:team-coordination',
        order: 106,
        text: [
          `你是「${run.name}」的主理人。以下成员已经加入团队，直接分配任务即可。`,
          run.instructions,
          `已配置成员：${run.roles.slice(1).map(member => `${member.name}（${member.label}）：${member.instructions}`).join('；')}`,
          '用共享任务板安排工作，通过 send_message 向各成员分配具体任务。收到并核对成员报告后再汇总。',
        ].join('\n'),
      });
    }
  }
  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', ({ agent }) => mount(agent), { prepend: true });
    ctx.on('agent/disposed', ({ agent }) => {
      compatibilityTools.get(agent)?.();
      compatibilityTools.delete(agent);
      if (!agent.session?.header?.parentSession) startup.delete(agent.id);
    }, { global: true });
    ctx.on('loader/entry-init', entry => {
      if (entry?.options?.name === OFFICIAL_TEAM_TOOL_MODULE) releaseCompatibilityTools();
    }, { global: true });
  }

  function childSessionId(member) {
    return member?.sessionId || member?.session?.header?.id || member?.id || null;
  }
  async function reconcileRoster(run, root, teams) {
    const rows = teams.listMembers(root).filter(member => member.role === 'teammate');
    const byName = new Map(rows.map(member => [member.name, member]));
    for (const role of run.roles.slice(1)) {
      const member = byName.get(role.name);
      if (member) {
        role.nativeMemberId ||= member.id || null;
        role.childSessionId ||= childSessionId(member);
        role.status = member.status || role.status || 'provisioning';
      } else if (role.nativeMemberId) {
        role.status = 'failed';
      } else {
        role.status ||= 'provisioning';
      }
    }
    await write('runs', run);
    return run;
  }

  const api = {
    async restore() {
      for (const run of await all('runs')) {
        if (!run) continue;
        runs.set(run.id, run);
        try {
          await hydrate(run);
          await admitRoles(run, true);
        } catch (error) {
          console.warn('[agentkit-studio] native team recovery unavailable:', run.id, error.code || 'TEAM_RECOVERY_FAILED');
        }
      }
    },

    async list() {
      const items = (await all('definitions')).filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const choices = (await agents.list()).filter(agent => !agent.metadata?.teamRole).map(agent => ({
        ...agent,
        selectable: agent.metadata?.local === true && nativeRuntimes.has(agent.spec?.runtime?.type),
      }));
      return { items, presets: [], agents: choices };
    },

    async save(payload) {
      const id = payload.id || `team-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      return serial(id, async () => {
        const previous = await read('definitions', id);
        if (previous && payload.revision !== previous.revision) throw fail('TEAM_REVISION_CONFLICT', '团队已被修改，请重新打开编辑');
        const value = validateTeam(payload);
        for (const role of [value.lead, ...value.members]) {
          if (role.source.kind === 'agent') {
            const source = await agents.get(role.source.agentId);
            if (!source || source.metadata?.local !== true || !nativeRuntimes.has(source.spec?.runtime?.type)) {
              throw fail('TEAM_AGENT_UNSUPPORTED', '请选用本机 DSH Native 或 Harness 专家；云端与 Codex 成员尚未接入');
            }
          }
        }
        const templateSource = previous?.templateSource || payload.templateSource;
        return write('definitions', {
          ...value,
          ...(templateSource ? { templateSource } : {}),
          id,
          revision: (previous?.revision || 0) + 1,
          createdAt: previous?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });
    },

    async remove({ id, revision }) {
      return serial(id, async () => {
        const item = await read('definitions', id);
        if (!item || item.revision !== revision) throw fail('TEAM_REVISION_CONFLICT', '团队版本已变化');
        await unlink(path('definitions', id));
        return { removed: true };
      });
    },

    async start({ id, revision, task, requestId }) {
      const taskText = String(task || '').trim();
      if (!taskText || taskText.length > 32000) throw fail('TEAM_TASK_INVALID', '请输入不超过 32000 字的团队任务');
      if (!/^[a-f0-9-]{36}$/.test(requestId || '')) throw fail('TEAM_REQUEST_INVALID', '运行请求标识无效');
      return serial(requestId, async () => {
        await runtimeReady;
        const { teams, controller } = services();
        const known = [...runs.values()].find(run => run.requestId === requestId)
          || (await all('runs')).find(run => run?.requestId === requestId);
        if (known) {
          runs.set(known.id, known);
          return api.status({ runId: known.id });
        }
        const raw = await read('definitions', id);
        if (!raw || revision !== raw.revision) throw fail('TEAM_REVISION_CONFLICT', '团队已变化，请刷新后运行');
        const team = validateTeam(raw);
        const roleDefinitions = [team.lead, ...team.members];
        const run = {
          id: `teamrun-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
          teamId: id,
          teamRevision: revision,
          name: team.name,
          instructions: team.instructions,
          requestId,
          task: taskText,
          createdAt: new Date().toISOString(),
          dshRootSessionId: null,
          // Roles remain Team-owned blueprints.  They are not copied into the
          // Studio AgentStore; DSH creates the root/child Sessions below.
          roles: roleDefinitions.map(role => {
            const snapshot = copy(role);
            // The source Agent, when one is used by the custom editor, is
            // already captured by `source`; never copy its Studio Agent ID
            // into the TeamRun role record.
            delete snapshot.agentId;
            return snapshot;
          }),
        };
        await hydrate(run);
        await admitRoles(run);
        runs.set(run.id, run);
        const lead = run.roles[0];
        const leadAdmission = await admitRole(run, lead);
        lead.agentPreset ||= leadAdmission.presetId;
        run.dshRootSessionId = run.id;
        await write('runs', run);
        const initializing = { spawning: true, teammates: new Set() };
        startup.set(run.id, initializing);
        try {
          await controller.create({ sessionId: run.id, agentPreset: leadAdmission.presetId });
          await controller.rename?.({ sessionId: run.id, title: team.name });
          if (leadAdmission.modelSelection) await controller.selectModel({ sessionId: run.id, ...leadAdmission.modelSelection, saveDefault: false });
          const resolved = await controller.resolveAgent(run.id);
          if (resolved.error) throw resolved.error;
          const root = resolved.agent;
          await ctx.get('commands').execute(root, '/permission read-only', [], new AbortController().signal);
          const existing = new Set(teams.listMembers(root).filter(member => member.role === 'teammate').map(member => member.name));
          for (const role of run.roles.slice(1)) {
            if (existing.has(role.name)) continue;
            const childAdmission = await admitRole(run, role);
            role.agentPreset ||= childAdmission.presetId;
            const result = await teams.spawnTeammate(root, nativeTeamSpawnRequest(run, role, new AbortController().signal));
            role.nativeMemberId = result.member.id;
            // DSH 0.2.2-RC1 exposes the child Session durable ID as the native
            // roster member `id`; newer runtimes may also expose `sessionId`.
            role.childSessionId = result.member.sessionId || result.member.session?.header?.id || result.member.id || null;
            await write('runs', run);
          }
          await controller.prompt({
            sessionId: run.id,
            requestId,
            mode: 'queue',
            content: [{ type: 'text', text: taskText }],
            clientTimeZone: 'Asia/Shanghai',
          }, AbortSignal.timeout(60000));
        } catch (error) {
          run.error = { code: error.code || 'TEAM_START_FAILED', message: '团队启动未完成，请检查模型与资源后新建运行。' };
          await write('runs', run);
          throw error;
        } finally {
          initializing.spawning = false;
          if (!initializing.teammates.size) startup.delete(run.id);
        }
        return api.status({ runId: run.id });
      });
    },

    async status({ runId }) {
      await runtimeReady;
      const run = runs.get(runId) || await read('runs', runId);
      if (!run) throw fail('TEAM_RUN_NOT_FOUND', '团队运行不存在');
      const { teams, controller } = services();
      runs.set(run.id, run);
      const sessionId = run.dshRootSessionId || run.id;
      const liveAgents = ctx.get('agents');
      const root = liveAgents?.get(sessionId);
      const projection = await controller.projections?.({ sessionId }, AbortSignal.timeout(10000)).catch(() => null);
      async function sessionEvents(id) {
        const events = liveAgents?.get(id)?.session?.snapshotEvents?.();
        if (events) return events;
        const page = await controller.page?.({ address: { kind: 'session', sessionId: id }, maxMessages: 40 }, AbortSignal.timeout(5000)).catch(() => null);
        return (page?.records || []).filter(row => row.type === 'event').map(row => row.event);
      }
      const events = await sessionEvents(sessionId);
      const end = events.findLast(event => event.type === 'turn/end')?.data?.reason?.kind;
      const outcome = end && end !== 'completed' ? (['user', 'aborted'].includes(end) ? 'stopped' : 'failed') : undefined;
      let output = '';
      for (let i = events.length - 1; i >= 0 && !output; i--) {
        if (events[i].type === 'assistant/message') output = events[i].data?.message?.content?.filter(item => item.type === 'text').map(item => item.text).join('') || '';
      }
      const teamProjection = projection?.values?.agentTeam;
      const members = root ? teams.listMembers(root).map(copy) : (teamProjection?.members || []).map(member => ({
        ...member, role: 'teammate', status: member.phase === 'active' ? 'inactive' : member.phase,
      }));
      if (!root && teamProjection) members.unshift({ id: sessionId, name: 'lead', role: 'lead', status: 'inactive' });
      await Promise.all(members.filter(member => member.role === 'teammate' && member.status === 'inactive').map(async member => {
        const memberEnd = (await sessionEvents(childSessionId(member))).findLast(event => event.type === 'turn/end')?.data?.reason;
        if (memberEnd?.kind === 'error') member.lastError = {
          code: String(memberEnd.error?.code || 'TEAM_MEMBER_FAILED'),
          message: '最近一次执行失败，请打开成员会话查看详情',
        };
      }));
      const teamTasks = teamProjection?.tasks ? copy(teamProjection.tasks) : (root ? teams.listTasks(root).map(copy) : []);
      return {
        ...stored(run),
        sessionId,
        status: run.error ? 'failed' : root?.status === 'running' ? 'running' : outcome || 'inactive',
        members,
        tasks: teamTasks,
        output,
      };
    },

    async history({ id }) {
      return {
        items: (await all('runs')).filter(run => run?.teamId === id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(run => ({ id: run.id, name: run.name, createdAt: run.createdAt, teamRevision: run.teamRevision, task: run.task, error: run.error })),
      };
    },

    async resume({ runId }) {
      await runtimeReady;
      const run = runs.get(runId) || await read('runs', runId);
      if (!run) throw fail('TEAM_RUN_NOT_FOUND', '运行不存在');
      await hydrate(run);
      await admitRoles(run, true);
      runs.set(runId, run);
      const result = await services().controller.resolveAgent(run.dshRootSessionId || runId);
      if (result.error) throw result.error;
      if (run.dshRootSessionId) await reconcileRoster(run, result.agent, services().teams);
      return api.status({ runId });
    },

    async stop({ runId }) {
      const run = runs.get(runId) || await read('runs', runId);
      const root = ctx.get('agents')?.get(run?.dshRootSessionId || runId)
        || (run ? (await ctx.get('sessionController')?.resolveAgent(run.dshRootSessionId || runId).catch(() => ({ error: true }))).agent : null);
      if (root) {
        const { teams } = services();
        for (const member of teams.listMembers(root).filter(row => row.role === 'teammate' && row.status === 'running')) teams.interrupt(root, member.name);
        root.cancel?.({ kind: 'user' });
      }
      return api.status({ runId });
    },
  };
  return api;
}
