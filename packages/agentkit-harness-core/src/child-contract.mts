import type { ChildBudgetReservation, ChildState, ObjectValue, PortContext, RunCommand, RunIdentity, RunScope, ToolCall, ToolResult } from './contracts.mjs';

export const CHILD_OWNER_CONTRACT = 'agentkit.native-child-owner/v1' as const;
/** Immutable causal binding; session parentRunId continues to mean session ancestry. */
export interface ChildOwnerBinding {
  contract: typeof CHILD_OWNER_CONTRACT; parent: RunIdentity;
  parentOperationKey: string; parentToolCallId: string; parentExecutionFence: number; childRequestDigest: string; role: string;
  maxModelCalls: number; maxToolCalls: number;
  deliveryMode?: 'foreground' | 'background';
  planMode?: boolean;
  continuationOf?: string;
  continuationParentRunId?: string;
}
export interface ChildApproval {
  childRunId: string; childScope: RunScope; parentOperationKey: string; parentToolCallId: string;
  interactionId: string; hostInteractionId: string; toolCall: ToolCall; definitionDigest: string;
}
export interface CoordinatorResponse {
  childRunId: string; sequence: number; childToolCallId: string;
  responseId: string; summary: string; message: string;
}
export interface ChildLifecycleRequest extends PortContext {
  action: 'poll' | 'wait' | 'cancel'; reservations: ChildBudgetReservation[];
  childApproval: ChildApproval | null; interaction: ObjectValue | null;
  waitForChildRunIds?: string[];
  responseCursors?: Record<string, number>;
}
export interface ChildLifecycleResult {
  operationKey: string; results: ToolResult[]; pendingChildRunIds: string[];
  approvals: ChildApproval[]; errorCode: 'child_owner_unavailable' | 'child_receipt_unavailable' | null;
  children?: ChildState[];
  responses?: CoordinatorResponse[];
}
export interface ChildReadyRequest extends RunIdentity {
  reservations: ChildBudgetReservation[]; includeApprovals: boolean;
  responseCursors?: Record<string, number>;
}
export interface ChildTaskControlState {
  childRunId: string; sessionId: string; role: string; phase: string;
  goalRevision: number;
  delivery: 'foreground' | 'background'; canPromote: boolean; canCancel: boolean; canSendInput: boolean;
}
export interface ChildControlTarget {
  scope: RunScope; runId: string; configurationDigest: string; parentOperationKey: string; parentToolCallId: string;
}
export interface ChildControlDelivery { target: ChildControlTarget; command: RunCommand }
export interface ChildLifecyclePort {
  /** Validate the actual owned start/result-wait before dispatch in Plan mode. */
  admitPlan?(request: import('./contracts.mjs').ToolRequest): Promise<boolean>;
  /** Scope-bound control metadata, including an owned start whose receipt is still in flight. */
  tasks?(request: RunIdentity): ChildTaskControlState[];
  /** Read-only locator. The Store revalidates both ledgers in the delivery transaction. */
  controlTarget?(request: RunIdentity, childRunId: string): ChildControlTarget | null;
  /** Wake an already committed inbox command; never creates a command or a child. */
  wakeControl?(request: RunIdentity, delivery: ChildControlDelivery): Promise<void>;
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
