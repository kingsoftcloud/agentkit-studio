import { validateModelSurface } from '@kingsoftcloud/agentkit-harness-core';

/** A child gets facts for its own workspace and selected model, with its narrower tool catalog. */
export function nativeChildModelSurface(parent, { workspaceRoot, supportsImages, tools, original } = {}) {
  if (!parent) return undefined;
  const { commandCwd: _cwd, environmentNames: _names, commandResources: _resources, ...base } = parent.environment;
  const root = workspaceRoot ?? base.workspaceRoot, commands = tools.some(tool => tool.name === 'run_command');
  const environment = { ...base, workspaceRoot: root, cwd: root, supportsImages,
    date: original?.environment.date ?? base.date, commandBackend: commands ? base.commandBackend : 'none',
    ...(commands && base.commandBackend === 'local_process' ? { commandCwd: root,
      environmentNames: parent.environment.environmentNames ?? [],
      ...(parent.environment.commandResources ? { commandResources: structuredClone(parent.environment.commandResources) } : {}) } : {}) };
  const source=original??parent;
  const result = { contract: parent.contract, environment,
    ...(parent.executionCapabilities === undefined ? {} : { executionCapabilities: parent.executionCapabilities
      .filter(capability => tools.some(tool => tool.name === capability.toolName)).map(capability => structuredClone(capability)) }),
    ...(source.verificationProjection ? {verificationProjection:source.verificationProjection} : {}) };
  validateModelSurface(result); return result;
}
