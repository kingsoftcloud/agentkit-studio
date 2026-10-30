import type { ObjectValue, RunConfiguration } from './contracts.mjs';
import { copy, invariant } from './values.mjs';

export const INSTRUCTION_SCOPES = 'agentkit.native-instruction-scopes/v1';
export interface InstructionScopes extends ObjectValue {
  contract: typeof INSTRUCTION_SCOPES;
  sourceId: string;
  bindingDigest: string;
  directories: string[];
}

/** Durable discovery addresses only. File bodies/versions are always reread by
 * the bound source; a scope record is never a permission or tool grant. */
export function validateInstructionScopes(value: unknown, config?: RunConfiguration): InstructionScopes {
  const state = value as InstructionScopes;
  invariant(state && typeof state === 'object' && !Array.isArray(state)
    && Object.keys(state).sort().join(',') === 'bindingDigest,contract,directories,sourceId'
    && state.contract === INSTRUCTION_SCOPES
    && [state.sourceId, state.bindingDigest].every(item => typeof item === 'string' && !!item.trim())
    && Array.isArray(state.directories) && state.directories.length <= 512
    && new Set(state.directories).size === state.directories.length
    && state.directories.every(directory => typeof directory === 'string' && directory.length <= 4096
      && !directory.includes('\\') && !directory.includes('\0')
      && (directory === '' || directory.split('/').every(part => part && part !== '.' && part !== '..'))),
  'invalid_instruction_scopes');
  invariant(!config || config.contextSources.some(source => source.instructionPolicy === 'current-files/v1'
    && source.required && state.sourceId === source.sourceId && state.bindingDigest === source.bindingDigest),
  'instruction_scopes_source_unbound');
  return copy(state);
}
