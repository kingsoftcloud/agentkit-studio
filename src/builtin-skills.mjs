/** Builtin skills shipped with this package.
 *
 * These skills are available to Studio-hosted DSH presets once the Agent
 * actually binds a platform resource (knowledge base, memory instance,
 * Skill/Skill Space, bound Tool, MCP/HTTP tool). The manifest is read from a
 * package-relative path (`import.meta.url`) so the same code works from a
 * checkout and from an installed npm package (package.json ships `src`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runtimeSkill } from './skill-files.mjs';
import { boundSkillResources } from './local-runtime.mjs';
import { PLATFORM_KINDS } from './platform-resource-bindings.mjs';

/** Codex sessions receive developerInstructions instead of a DSH skill
 * registry, so the builtin guide is inlined there within this character
 * budget instead of being loaded on demand. */
export const BUILTIN_SKILL_CONTEXT_LIMIT = 8000;

/** @type {ReadonlyArray<{ name: string, manifest: URL }>} */
const BUILTIN_SKILL_MANIFESTS = Object.freeze([
  Object.freeze({
    name: 'agentengine-platform-resources',
    manifest: new URL('./builtin-skills/platform-resources/SKILL.md', import.meta.url),
  }),
]);

let cachedDefinitions;

/**
 * Load the builtin skill definitions from the package payload.
 * @returns {object[]} DSH runtime skill definitions (see runtimeSkill)
 */
export function builtinSkillDefinitions() {
  if (!cachedDefinitions) {
    cachedDefinitions = BUILTIN_SKILL_MANIFESTS.map(({ name, manifest }) => {
      const path = fileURLToPath(manifest);
      let content;
      try {
        content = readFileSync(path, 'utf8');
      } catch (cause) {
        throw Object.assign(new Error(`内置 Skill 清单缺失或不可读：${path}`), {
          code: 'BUILTIN_SKILL_MANIFEST_MISSING',
          details: { name, path },
          cause,
        });
      }
      if (!content.trim()) {
        throw Object.assign(new Error(`内置 Skill 清单为空：${path}`), {
          code: 'BUILTIN_SKILL_MANIFEST_EMPTY',
          details: { name, path },
        });
      }
      return runtimeSkill({ name, content, path });
    });
  }
  // The DSH SkillRegistry owns the registered objects for the lifetime of a
  // preset; hand out fresh top-level values so one preset cannot mutate the
  // cached definition observed by another.
  return cachedDefinitions.map(definition => ({
    ...definition,
    resourceBase: { ...definition.resourceBase },
    invocation: { ...definition.invocation },
  }));
}

/**
 * Whether an Agent's bindings include any AgentEngine platform resource.
 *
 * The builtin skill (and its DSH skill loader / shell plugins) must only be
 * injected for Agents that actually use a platform resource. A pure chat Agent
 * keeps the previous preset composition and does not gain shell execution.
 *
 * Skill/Skill Space bindings reuse the harness `boundSkillResources` helper
 * (which also skips disabled plugins); the remaining platform kinds come from
 * `PLATFORM_KINDS`, and Tool/MCP bindings are plain arrays.
 * @param {object} bindings - agent.spec.bindings
 * @returns {boolean}
 */
export function hasPlatformResourceBindings(bindings = {}) {
  const source = bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? bindings : {};
  if (boundSkillResources(source).length) return true;
  if (Array.isArray(source.tools) && source.tools.length) return true;
  if (Array.isArray(source.mcpServers) && source.mcpServers.length) return true;
  const kinds = new Set(PLATFORM_KINDS);
  const plugins = Array.isArray(source.plugins) ? source.plugins : [];
  return plugins.some(plugin => plugin?.enabled !== false && kinds.has(plugin?.config?.binding?.resource?.kind));
}

/**
 * Merge builtin definitions with the Agent's bound skill definitions.
 * Builtin skills win name collisions so a bound Skill can never shadow the
 * platform contract, and the result always contains the builtin skills even
 * when the Agent binds none of its own.
 * @param {object[]} boundDefinitions
 * @returns {object[]}
 */
export function mergeSkillDefinitions(boundDefinitions = []) {
  const builtin = builtinSkillDefinitions();
  const seen = new Set(builtin.map(definition => String(definition.name || '')));
  const bound = [];
  for (const definition of Array.isArray(boundDefinitions) ? boundDefinitions : []) {
    const name = String(definition?.name || '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    bound.push(definition);
  }
  return [...builtin, ...bound];
}

/**
 * Render the builtin skill as bounded inline context for surfaces that cannot
 * call the DSH `skill` tool (the Codex App Server only receives
 * developerInstructions plus explicit dynamic tools).
 * @param {{ limit?: number }} [options]
 * @returns {string}
 */
export function formatBuiltinSkillContext({ limit = BUILTIN_SKILL_CONTEXT_LIMIT } = {}) {
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : BUILTIN_SKILL_CONTEXT_LIMIT;
  const sections = builtinSkillDefinitions().map(skill => [
    `- ${skill.name}: ${skill.description}`,
    `  SKILL.md: ${JSON.stringify(skill.path)}`,
    `  资源目录: ${JSON.stringify(skill.resourceBase.path)}`,
    '  任务匹配时先读取对应 SKILL.md（若正文已内联，则以内联正文为准），再按其中说明使用平台资源。',
    String(skill.content || '').slice(0, max),
  ].join('\n'));
  return ['内置平台 Skill（AgentKit Studio 提供，随本会话 developerInstructions 内联）：', ...sections].join('\n\n');
}

/**
 * Skill definitions a Studio preset should register for an Agent's bindings.
 * Zero-binding Agents intentionally receive [] (previous behavior: no builtin
 * skill, therefore no implicit DSH skill loader or shell plugin).
 * @param {object} bindings - agent.spec.bindings
 * @param {object[]} boundDefinitions - definitions loaded from bound resources
 * @returns {object[]}
 */
export function skillDefinitionsForBindings(bindings, boundDefinitions = []) {
  return hasPlatformResourceBindings(bindings) ? mergeSkillDefinitions(boundDefinitions) : [];
}

/**
 * Append the builtin skill context to a Codex resource-context result.
 *
 * Only the `codex` runtime is touched: cloud and non-Codex sessions never see
 * this block. The block is skipped when the prompt already points at the same
 * manifest, so a bound Skill copy or a retried call cannot duplicate it.
 * @param {object} context - result of createCodexResourceContext()
 * @param {{ runtime?: string, limit?: number }} [options]
 * @returns {object} the same context when no injection applies
 */
export function withBuiltinSkillContext(context, { runtime, limit } = {}) {
  if (String(runtime || '').toLowerCase() !== 'codex') return context;
  const systemPrompt = String(context?.systemPrompt || '');
  const definitions = builtinSkillDefinitions();
  if (definitions.some(skill => systemPrompt.includes(skill.path))) return context;
  const block = formatBuiltinSkillContext({ limit });
  return { ...context, systemPrompt: [systemPrompt.trim(), block].filter(Boolean).join('\n\n') };
}

/**
 * Gate + inject for the Codex App Server seam: the builtin guide is only added
 * for Codex sessions whose Agent actually binds a platform resource.
 * @param {object} context - result of createCodexResourceContext()
 * @param {object} bindings - agent.spec.bindings
 * @param {{ runtime?: string, limit?: number }} [options]
 * @returns {object}
 */
export function withBuiltinSkillContextForBindings(context, bindings, { runtime = 'codex', limit } = {}) {
  if (!hasPlatformResourceBindings(bindings)) return context;
  return withBuiltinSkillContext(context, { runtime, limit });
}
