/** Pure prompt projection used by the host's resource materializer. */
export function formatSkillContext(skill, { limit = 12000, indexOnly = false } = {}) {
  const definitions = (skill?.definitions || []).filter(item => item.path && item.resourceBase?.kind === 'directory');
  const locations = definitions.map(item => `- ${item.name}: ${item.description || ''}\n  SKILL.md: ${JSON.stringify(item.path)}\n  资源目录: ${JSON.stringify(item.resourceBase.path)}`).join('\n');
  const index = locations ? `已绑定的 Skill 文件：\n${locations}\n任务匹配时先读取对应 SKILL.md；其中的相对脚本和引用路径均相对于该 Skill 的资源目录，不是当前工作区。执行已绑定的脚本，不要用临时重写的代码替代；文件或依赖不可用时如实报告。` : '';
  return [index, indexOnly && definitions.length ? '' : String(skill?.content || '').slice(0, limit)].filter(Boolean).join('\n\n');
}
