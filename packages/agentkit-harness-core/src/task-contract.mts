import type { RunCommand, RunConfiguration, RunSnapshot, TaskContract } from './contracts.mjs';
import { configure } from './configuration.mjs';
import { invariant, isNativeError } from './values.mjs';
import type { ChildTaskControlState } from './child-contract.mjs';

export const NATIVE_GOAL_CONTRACT_BINDING = 'agentkit.native-goal-contract/v1';

/** The activation pin remains immutable; a Host command can replace only its task contract. */
export function effectiveRunConfiguration(snapshot: RunSnapshot, configuration: RunConfiguration,
  digest: (value: unknown) => string): RunConfiguration {
  if (!snapshot.taskContract) {
    invariant(snapshot.taskContractDigest === null || snapshot.taskContractDigest === undefined, 'stored_task_contract_mismatch');
    return configuration;
  }
  invariant(snapshot.taskContractDigest === digest(snapshot.taskContract), 'stored_task_contract_mismatch');
  return configure({ ...configuration, contract: snapshot.taskContract });
}

export interface SteeringAdmission {
  reason: string; contract: TaskContract | null; contractDigest: string | null;
}
export interface SteeringBindings {
  configuration?: RunConfiguration; digest?: (value: unknown) => string;
  childTasks?: ChildTaskControlState[];
}

/** Missing contracts retain acceptance. Replacements need a fresh revision and bound tool scope. */
export function admitSteering(snapshot: RunSnapshot, command: RunCommand, bindings: SteeringBindings = {}): SteeringAdmission {
  const reject = (reason: string): SteeringAdmission => ({ reason, contract: null, contractDigest: null });
  const input = command.payload;
  if (!Object.hasOwn(input, 'expectedGoalRevision')) return reject('contract_revision_required');
  if (typeof input.text !== 'string' || !input.text.trim()
    || !Number.isSafeInteger(input.expectedGoalRevision) || (input.expectedGoalRevision as number) < 0
    || Object.keys(input).some(key => !['text', 'expectedGoalRevision', 'taskContract'].includes(key))) return reject('invalid_steering');
  if (input.expectedGoalRevision !== snapshot.goalRevision) return reject('stale_goal_revision');
  if (input.taskContract === undefined || input.taskContract === null) return reject('applied');
  if (!bindings.configuration || !bindings.digest) return reject('task_contract_binding_unavailable');
  if (typeof input.taskContract !== 'object' || Array.isArray(input.taskContract)) return reject('invalid_steering');
  if (snapshot.taskContract && snapshot.taskContractDigest !== bindings.digest(snapshot.taskContract)) return reject('contract_binding_mismatch');
  try {
    const contract = configure({ ...bindings.configuration,
      contract: { ...input.taskContract, objective: input.text } as unknown as TaskContract }).contract;
    if (contract.revision === (snapshot.taskContract ?? bindings.configuration.contract).revision) return reject('contract_revision_required');
    return { reason: 'applied', contract, contractDigest: bindings.digest(contract) };
  } catch (error) {
    return reject(isNativeError(error) && error.code === 'unbound_allowed_tool' ? 'task_tool_scope_unbound' : 'invalid_steering');
  }
}
