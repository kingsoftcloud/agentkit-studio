import type { ChildBudgetReservation, ChildState, ObjectValue, PortContext, RunIdentity, RunScope, ToolCall, ToolResult } from './contracts.mjs';

export const CHILD_OWNER_CONTRACT = 'agentkit.native-child-owner/v1' as const;
/** Immutable causal binding; session parentRunId continues to mean session ancestry. */
export interface ChildOwnerBinding {
  contract: typeof CHILD_OWNER_CONTRACT; parent: RunIdentity;
  parentOperationKey: string; parentToolCallId: string; parentExecutionFence: number; childRequestDigest: string; role: string;
  maxModelCalls: number; maxToolCalls: number;
  deliveryMode?: 'foreground' | 'background';
}
export interface ChildApproval {
  childRunId: string; childScope: RunScope; parentOperationKey: string; parentToolCallId: string;
  interactionId: string; hostInteractionId: string; toolCall: ToolCall; definitionDigest: string;
}
export interface ChildLifecycleRequest extends PortContext {
  action: 'poll' | 'wait' | 'cancel'; reservations: ChildBudgetReservation[];
  childApproval: ChildApproval | null; interaction: ObjectValue | null;
  waitForChildRunIds?: string[];
}
export interface ChildLifecycleResult {
  operationKey: string; results: ToolResult[]; pendingChildRunIds: string[];
  approvals: ChildApproval[]; errorCode: 'child_owner_unavailable' | 'child_receipt_unavailable' | null;
  children?: ChildState[];
}
export interface ChildReadyRequest extends RunIdentity {
  reservations: ChildBudgetReservation[]; includeApprovals: boolean;
}
export interface ChildLifecyclePort {
  /** Aborting a poll/wait removes its waiter, never cancels or relaunches children. */
  collect(request: ChildLifecycleRequest): Promise<ChildLifecycleResult>;
  /** Read already sealed child facts after a lost parent claim. Never starts, approves or cancels execution. */
  reconcile?(request: ChildLifecycleRequest): Promise<ChildLifecycleResult | null>;
  readyChildren?(request: ChildReadyRequest & { signal: AbortSignal }): Promise<{ childRunIds: string[] }>;
  /** Host teardown is independent of a parent's write lease. */
  releaseRun?(request: { scope: RunScope; runId: string }): Promise<void>;
  interruptedReceipts?(request: { scope: RunScope; runId: string; parentOperationKey: string }): Promise<{
    parentOperationKey: string; parentToolCallId: string; result: ToolResult;
  }[]>;
}
