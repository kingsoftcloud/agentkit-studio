/** Remove ordinary delegation only from team-derived standing compositions. */
export function teamBasePlugins(rows) {
  return rows.filter(row=>!String(row.id||'').startsWith('tool-subagent')&&!/^@deepseek-ai\/dsh-tool-subagent(?:$|\/|-control)/.test(row.name||''))
    .map(row=>row.group===true&&Array.isArray(row.config)?{...row,config:teamBasePlugins(row.config)}:row);
}
