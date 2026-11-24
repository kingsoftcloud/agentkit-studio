import { copy } from '../contracts/native-values.mjs';

const text = (description, maxLength = 1024) => ({ type: 'string', description, maxLength });
const space = { type: 'string', description: 'Limit to one bound Skill Space.' };
const define = (name, description, properties, required, timeoutMs, readOnly = true) => ({ name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false }, readOnly, concurrentSafe: readOnly,
  permissions: [], timeoutMs, contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' });

const reads = [
  define('list_skill_spaces', 'List visible Skill Spaces with id/name/description.', {}, [], 15000),
  define('list_skills', 'List skills discoverable from configured Skill Spaces.', { space_id: space }, [], 30000),
  define('load_skill', 'Download and load a skill\'s SKILL.md instructions.', { skill_name: text('The skill name to load.'), space_id: space }, ['skill_name'], 30000),
  define('preview_skill', 'Return manifest-level info for a skill without downloading.',
    { skill_name: text('The skill name to preview.'), space_id: space }, ['skill_name'], 15000),
  define('search_skills', 'Search skills by name, aliases, tags, description.', { query: text('The search query.'),
    max_results: { type: 'integer', description: 'Max results (default 10).', minimum: 1, maximum: 50 }, space_id: space }, ['query'], 15000),
];
const workflow = define('execute_skills', 'Execute a workflow through the configured Skill Runtime. Has side effects.', {
  workflow_prompt: text('The workflow prompt.', 8192),
  skill_names: { type: 'array', items: { type: 'string' }, description: 'Skill names to execute with.' },
  approval: { type: 'object', description: 'Optional approval metadata.', additionalProperties: true },
}, ['workflow_prompt'], 900000, false);

export const DSH_SKILL_READ_NAMES = Object.freeze(reads.map(tool => tool.name));
export const studioSkillReadDefinitions = () => copy(reads);
export const studioSkillWorkflowDefinition = () => copy(workflow);

export function normalizeSkillNames(value) {
  if (value == null) return [];
  const names = new Map();
  for (const raw of Array.isArray(value) ? value : [value]) for (const part of String(raw).split(',')) {
    const name = part.trim(), key = name.toLowerCase();
    if (name && !names.has(key)) names.set(key, name);
  }
  return [...names.values()];
}

const tokenize = text => new Set(text.toLowerCase().split(/[^0-9a-z一-鿿]+/u).filter(word => word.length >= 2));

function scoreSkill(skill, name, prompt, tokens) {
  if (name.includes(prompt) || prompt.includes(name)) return [90, 'name'];
  if ((skill.aliases ?? []).some(alias => alias && prompt.includes(alias.toLowerCase()))) return [80, 'alias'];
  if ((skill.tags ?? []).some(tag => tag && (prompt.includes(tag.toLowerCase()) || tokens.has(tag.toLowerCase())))) return [65, 'tag'];
  const metadata = tokenize([skill.description ?? '', ...(skill.examples ?? [])].join(' '));
  const overlap = [...tokens].filter(token => metadata.has(token)).length;
  return overlap ? [Math.min(55, 20 + overlap * 10), 'metadata'] : [0, ''];
}

export function matchSkillRefs(skills, prompt, { skillNames, limit } = {}) {
  const explicit = new Set(normalizeSkillNames(skillNames).map(name => name.toLowerCase()));
  const query = (prompt ?? '').toLowerCase(), tokens = tokenize(query);
  const matches = [], seen = new Set();
  for (const skill of skills) {
    if (!skill.name) continue;
    const name = skill.name.toLowerCase(), identity = skill.cacheKey || skill.skillId || skill.name;
    if (seen.has(identity)) continue;
    const [score, reason] = explicit.size ? [explicit.has(name) ? 100 : 0, 'exact_name'] : scoreSkill(skill, name, query, tokens);
    if (!score) continue;
    seen.add(identity);
    matches.push({ skill, score, reason });
  }
  matches.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
  return limit == null ? matches : matches.slice(0, Math.max(0, limit));
}
