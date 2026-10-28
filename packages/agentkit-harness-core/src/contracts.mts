import type { BrowserObservation, BrowserRecovery, BrowserSessionRef } from './browser-contract.mjs';
import type { BackgroundCommandPort, BackgroundCommandRef, BackgroundCommandState } from './background-contract.mjs';
import type { ChildApproval, ChildControlDelivery, ChildLifecyclePort, ChildOwnerBinding } from './child-contract.mjs';
export type { ChildLifecyclePort } from './child-contract.mjs';
export type { BackgroundCommandPort } from './background-contract.mjs';

/** Serializable contracts. No Host services, filesystem handles or credentials. */
export const NATIVE_SCHEMA = 'agentkit.native-run/v1' as const;
export const NATIVE_ENGINE = 'agentkit.native/v1' as const;
export const TOOL_RESOURCE_USAGE_CONTRACT = 'agentkit.tool-resource-usage/v1' as const;
/** bigint represents a JSON integer outside the safe Number range, never a string or object wrapper. */
export type Json = null | boolean | number | bigint | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export type Phase = 'created' | 'preparing_context' | 'requesting_model' | 'executing_tools'
  | 'awaiting_interaction' | 'awaiting_reconciliation' | 'reconciling_tool' | 'compacting' | 'verifying' | 'finalizing' | 'paused'
  | 'completed' | 'failed' | 'canceled' | 'interrupted';
export type Outcome = 'verified' | 'unverified' | 'partial' | 'blocked' | 'failed' | 'budget_exhausted';
export interface RunScope { tenantId: string; workspaceId: string; userId: string; agentId: string }
export interface RunIdentity {
  scope: RunScope; runId: string; sessionId: string; turnId: string; buildId: string;
  parentRunId: string | null; taskChainId: string;
}
export interface ToolCall { callId: string; name: string; arguments: ObjectValue; wireArgumentsInvalid?: boolean;
  /** Kernel-resolved target retains the model's wrapper for protocol replay. */
  modelCallWrapper?: 'DeferredToolCall';
}
/** Host-owned display data is opaque to the model protocol and grants no authority. */
export interface MessagePresentation { format: string; content: Json[]; source?: ObjectValue }
export interface ToolContextMessage { content: string; media?: Json[]; presentation?: MessagePresentation }
export interface Message extends ToolContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  kind?: string; callId?: string; name?: string; toolCalls?: ToolCall[];
  /** Private provider protocol data; never part of a public event's payload. */
  providerReplay?: ObjectValue; media?: Json[]; persistent?: boolean;
  /** Runtime-owned receipt outcome for optional request pruning; never inferred from model prose. */
  toolOutcome?: ToolResult['status'];
  /** Kernel-owned completion clock for admitted idle cleanup; no model/permission authority. */
  completedAtMs?: number;
  /** Kernel-owned complete definitions delivered by this successful search. */
  discoveredToolNames?: string[];
  /** Stable provenance for imported history; never grants current-run authority. */
  history?: { sourceRunId: string; sourceIndex: number };
  /** Original protocol call id -> canonical historical/current call id. */
  replayToolIds?: Record<string, string>;
  /** Host journal and admitted-input bindings; neither grants execution authority. */
  operatorGuidance?: { key: string; profileDigest: string; contentDigest: string };
  operatorInputHistory?: { profileDigest: string; frames: { key: string; contentDigest: string }[] };
  providerReplayProjection?: { version: 'anthropic-client-compaction/v1'; profileDigest: string;
    originalContentDigest: string; prefixDigest: string };
  /** Durable inline input identity; carries no tool or Host authority. */
  inputId?: string; inputGoalRevision?: number;
  /** Host-sealed output fragments; model prose cannot authorize assembly. */
  continuationMode?: 'suffix' | 'task_resume' | 'empty_output';
  continuationResponseId?: string; continuationFragmentDigest?: string;
}
export interface ToolDefinition {
  name: string; description: string; parameters: ObjectValue;
  readOnly: boolean; concurrentSafe: boolean;
  permissions: string[]; timeoutMs: number;
  /** Negotiated Host preflight is bounded by run/effect limits; this tool's
   * execution deadline begins only at its actual dispatch boundary. */
  executionTimeoutPolicy?: 'dispatch/v1' | 'dispatch/v2';
  /** Host permission waits yield a durable Native interaction before dispatch. */
  approvalPolicy?: 'durable-preflight/v1';
  contextRole: 'none' | 'workspace_read' | 'workspace_search' | 'workspace_list' | 'artifact_read' | 'task_planning';
  observationRole: 'none' | 'browser';
  progressObservation: boolean; contextRetention: 'normal' | 'persistent';
  discovery?: { deferred: true; aliases?: string[]; searchHint?: string; mcp?: { serverName: string; toolName: string } };
  /** Frozen MCP Plan admission only; never grants replay or concurrency authority. */
  planModeAccess?: { contract: 'zcode-mcp-plan/v1'; destructive: boolean };
  /** Requires a dynamic permission check and a second check at command launch. */
  planModeCommandPolicy?: 'zcode-posix-readonly/v1';
  workspaceEditPolicy?: 'zcode-match/v1' | 'zcode-match/v2';
  workspacePatchPolicy?: 'zcode-patch/v1';
  workspaceCheckpointPolicy?: 'file-preimages/v1';
  /** Explicit operator compensation, separate from read-only receipt queries. */
  workspaceRepairPolicy?: 'preimage-compensation/v1';
  childBudgetPolicy?: 'start/v1' | 'settle/v1' | 'delegate/v1';
  childApprovalPolicy?: 'owned-child-approval/v1';
  backgroundCommandPolicy?: 'owned-command-launch/v1';
  delegatedReadOnly?: boolean; deliveryWrite?: boolean;
  deliveryArtifactRole?: 'none' | 'read' | 'write';
  exactContentPolicy?: 'current-goal-utf8/v1' | 'complete-write-only/v1';
  /** Archive the model-visible observation even when it fits inline. */
  resultArchivePolicy?: 'archived-model-view/v4' | 'archived-model-view/v5';
  sourceObservationPolicy?: 'workspace-source-model/v1';
  directoryObservationPolicy?: 'studio-directory-observation/v1' | 'studio-directory-observation/v2' | 'studio-directory-observation/v3';
  /** safe-read permits a fresh repeatable read; receipt-observation waits for a
   * separately persisted lookup of the original effect and never re-executes it. */
  recoveryPolicy?: 'manual' | 'safe-read/v1' | 'receipt-observation/v1';
}
export interface ModelProfile {
  profileId: string; profileVersion: string; providerFamily: string;
  maxOutputTokens: number; contextWindow: number; maxRetries: number; maxProviderRetries: number;
  maxContinuations: number; requestTimeoutMs: number; retryInitialDelayMs: number;
  retryMaxDelayMs: number; retryBackoffMultiplier: number; rateLimitCooldownMs: number;
  providerReplayMode: 'none' | 'reasoning_content' | 'anthropic_content';
  compatibilityDigest: string;
  /** Absent on older Runs; projection policy is frozen at admission. */
  inlineReasoningPolicy?: { contract: 'profiled-content/v1'; rule: 'auto' | 'permissive' | 'openai'
    | 'strict-openai' | 'cerebras' | 'groq' | 'deepseek' | 'zai' | 'kspmas-gateway' | 'moonshot' | 'mimo' };
  providerCompatibilityPolicy?: { contract: 'provider-compat/v1'; rule: NonNullable<ModelProfile['inlineReasoningPolicy']>['rule'] };
  streaming?: boolean; outputTokenParameter?: 'max_tokens' | 'max_completion_tokens';
  streamTimeoutPolicy?: 'idle/v1'; providerThinkingDisplay?: boolean;
  /** Version the Host's visible-provider-reasoning default without upgrading admitted Runs. */
  providerThinkingDisplayPolicy?: 'provider-visible/v1';
  /** Absence retains old local discovery; each new model binding freezes its own mode. */
  providerToolSearchPolicy?: 'local-only/v1' | 'anthropic-deferred/v1';
  controllerReasoningPolicy?: 'disclosed-delegate/v1';
  anthropicPolicy?: { contract: 'anthropic-wire/v1'; midSystem: boolean; blockBinding: 'drop_block' | 'disabled' };
  promptCachePolicy?: 'anthropic-prefix/v1';
  operatorGuidancePolicy?: 'journaled-system/v1';
  toolCatalogPolicy?: 'stable-task/v1';
  providerReplayProjectionPolicy?: 'anthropic-client-compaction/v1';
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  thinkingMode?: 'enabled' | 'disabled'; parallelToolCalls?: boolean;
  temperature?: number; topP?: number;
}
export interface RunLimits {
  maxWallMs: number | null; maxModelCalls: number | null; maxToolCalls: number | null;
  maxParallelTools: number; maxRepairs: number; maxOutputRestarts: number;
  finalizationReserveModelCalls: number; finalizationReserveWallMs: number;
  verificationReserveModelCalls: number; browserObservationIntervalToolCalls: number;
  verificationIdleToolCalls: number;
  effectTimeoutMs: number; leaseMs: number; maxSubagentDepth: number;
  maxToolResultBytes: number; maxInlineImageBytes: number; maxModelStreamBytes: number;
  maxRecoveryRetries: number;
  deliveryContextRecoveryPolicy?: 'committed-write-summary/v1' | 'delivery-window-summary/v2' | null;
}
export type VerificationMethod = 'deterministic' | 'human' | 'model_assisted';
export interface AcceptanceItem {
  id: string; required: boolean; verifierRef: string; verifierVersion: string;
  verificationMethod: VerificationMethod; description: string;
}
export interface TaskContract {
  objective: string; revision: string; constraints: string[]; acceptance: AcceptanceItem[];
  allowedToolNames: string[] | null; finalSubmissionSchema: ObjectValue | null;
  finalSubmissionPayloadKey: string | null;
  finalOutputFormat: 'text' | 'json_object' | 'json_value';
}
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'PreCompact' | 'Stop';
export interface HookDefinition {
  hookId: string; sourceRef: string; bindingDigest: string; executionPolicyDigest: string;
  /** Host assertion, never a callback-provided replay or permission grant. */
  readOnly: boolean; events: HookEvent[]; toolNames?: string[];
  timeoutMs: number; maxInputBytes: number; maxOutputBytes: number; failureMode: 'warn' | 'block';
  compactionSourceProjection?: 'canonical_user';
}
export interface HookOutput {
  action: 'continue' | 'deny' | 'repair'; additionalContext: string[]; updatedArguments: ObjectValue | null;
}
export type HookFailure = 'producer_failed' | 'producer_invalid' | 'input_budget_exceeded' | 'output_budget_exceeded'
  | 'producer_timeout' | 'binding_unavailable' | 'policy_denied' | 'policy_error';
export interface HookInvocation extends RunIdentity {
  schemaVersion: 'agentkit.native-hook/v1'; operationKey: string; goalRevision: number;
  event: HookEvent; definition: HookDefinition; inputDigest: string;
  input: { goal: string; toolCallCount: number; stopContinuationCount: number;
    call: ToolCall | null; toolResult: ToolResult | null; candidate: CompletionCandidate | null;
    compaction: ObjectValue | null };
}
export interface HookInvocationResult {
  schemaVersion: 'agentkit.native-hook-result/v1'; identity: RunIdentity; operationKey: string; goalRevision: number;
  event: HookEvent; hookId: string; sourceRef: string; bindingDigest: string; executionPolicyDigest: string; inputDigest: string;
  status: 'ok' | 'failed' | 'uncertain'; output: HookOutput | null; reason: HookFailure | null;
}
export interface HookState {
  goalRevision: number;
  pre: { original: ToolCall; effective: ToolCall; nextIndex: number; denied: boolean }[];
  post: { call: ToolCall; result: ToolResult; nextIndex: number }[];
  stop: { candidateId: string; nextIndex: number } | null;
  precompact?: { subjectDigest: string; nextIndex: number };
  feedback: Message[];
}
export interface ContextPlanningPolicy {
  tokenizerId: string; tokenizerDigest: string; enabled: boolean;
  /** Estimates bound complete requests; exact counters keep the strict summary ceiling. */
  summaryBudgetMode?: 'strict' | 'context_bounded_estimate';
  /** Enforce the soft budget before task inference, retaining the fresh tool batch in full. */
  budgetTiming?: 'before-model/v1';
  /** Count and dispatch current Host state after complete history groups.
   * Absence preserves the admitted legacy prefix layout. */
  continuityPlacement?: 'after-history/v1';
  /** Replace older identical proven captured-source bodies in request views. */
  sourceReusePolicy?: 'captured-source/v1';
  triggerRatio: number; targetRatio: number; summaryMaxTokens: number;
  maxCompactions: number | null; maxCompactionsWithoutProgress: number; minModelTurnsBetween: number;
  maxSummaryRetries: number;
  /** Optional for restored runs; count source identities, retaining complete protocol groups. */
  readWorkingSetCount?: number; readWorkingSetMaxTokens?: number; readWorkingSetTotalMaxTokens?: number;
  recentToolBatchCount?: number; recentToolBatchMaxTokens?: number; recentToolBatchesTotalMaxTokens?: number;
  pruneToolResults?: boolean; pruneKeepRecentBatches?: number; pruneMinSavedTokens?: number;
  /** Optional earlier local cleanup boundary; absence preserves the original full-compaction threshold. */
  pruneThresholdTokens?: number;
  /** New admissions derive an earlier cleanup boundary; absence preserves legacy timing. */
  pruneThresholdPolicy?: 'zcode-local/v1';
  /** Admit cleaned historical tool output as the source of a still-needed summary. */
  pruneSummaryPolicy?: 'zcode-local/v1';
  /** Omitted on legacy Runs. Zero triggers after any positive idle interval. */
  pruneIdleThresholdMinutes?: number;
}
export interface ContextHistory {
  prefixCount: number; prefixDigest: string; contractDigest: string; tokenizerDigest: string;
  retainedRefs: string[]; summary: string;
  workspaceRevision?: string | null;
}
export interface ContextChunk {
  start: number; stop: number; sourceDigest: string; projectionDigest: string;
  messages: Message[]; countedInputTokens: number; maxOutputTokens: number;
}
export interface ContextCompaction {
  sourceRevision: number; prefixCount: number; prefixDigest: string; goalRevision: number;
  contractDigest: string; retainedRefs: string[]; removedRefs: string[];
  sourceText: string; sourceDigest: string; offset: number; summary: string;
  coverage: { start: number; stop: number; projectionDigest: string }[];
  chunk: ContextChunk | null; proposal: string | null; errors: number; quoteLimit: number | null;
  /** Provider retry attempts are separate from invalid-summary/proposal attempts.
   * Absence on restored legacy runs conservatively inherits `errors`. */
  providerErrors?: number;
  hookSubject: ObjectValue; hooksComplete: boolean;
  workspaceRevision?: string | null;
  /** References into the immutable prefix; cleared groups must belong to removedRefs. */
  prunedToolResultRefs?: string[];
}
export interface ContextPlanningState {
  history: ContextHistory | null; compaction: ContextCompaction | null;
  compactions: number; compactionsWithoutProgress: number; progressDigest: string | null; lastModelCall: number;
}
export interface ContextAdmission {
  sourceDigest: string; toolsDigest: string; tokenizerId: string; tokenizerDigest: string;
  countedInputTokens: number; maxOutputTokens: number; contextWindow: number;
}
export interface ContextPlanningResult {
  action: 'ready' | 'compact' | 'blocked'; reason: string; state: ContextPlanningState;
  messages: Message[]; admission: ContextAdmission | null;
  toolResultPruning?: ToolResultPruning;
}
export interface ToolResultPruning {
  sourceMessageRefs: string[]; toolCallIds: string[];
  preInputTokens: number; postInputTokens: number; savedTokens: number;
  trigger?: 'idle' | 'token_pressure'; idleElapsedMs?: number;
}
export interface ContextSourceDefinition {
  contract: 'agentkit.native-context-source/v1'; sourceId: string; bindingDigest: string;
  priority: number; timeoutMs: number; required: boolean; maxTokens: number; maxBytes: number;
}
/** A frozen transcript import, never a parent Run or an execution checkpoint. */
export interface ConversationSeed {
  contract: 'native-conversation-fork/v1';
  source: { parentSessionId: string; sessionId: string; runId: string; turnId: string; boundarySeq: number;
    snapshotRevision: number; configDigest: string; snapshotDigest: string; transcriptDigest: string };
  messages: Message[];
  todos?: TodoItem[];
  discoveredToolNames?: string[];
}
export interface RunConfiguration {
  /** Omitted only on historical configurations; new admissions freeze policy identities. */
  policyModules?: import('./policy-registry.mjs').PolicyBinding[];
  conversationRewind?: { contract: 'native-conversation-rewind/v1'; commandId: string;
    expectedHeadRunId: string; generation: number; markerDigest: string;
    retainedBackgroundCommands?: BackgroundCommandState[] };
  childTaskPolicy?: 'session-controls/v1';
  coordinatorResponsePolicy?: 'owned-parent-response/v1';
  todoPolicy?: 'session-todos/v1';
  planModePolicy?: 'session-plan/v1' | 'inherited-child-plan/v1';
  planModeInitialActive?: boolean;
  childPlanPolicy?: 'inherit-plan/v1';
  toolDiscoveryPolicy?: 'local-tool-search/v1';
  artifactPolicy?: 'runtime-artifacts/v1' | null;
  sourceReadPolicy?: 'studio-source-read/v1' | null;
  wallDeliveryPolicy?: 'deadline-delivery/v1' | 'deadline-delivery/v2' | 'deadline-delivery/v3'
    | 'deadline-delivery/v4' | 'deadline-delivery/v5' | 'deadline-delivery/v6' | 'deadline-delivery/v7' | null;
  engine: typeof NATIVE_ENGINE; profile: ModelProfile; limits: RunLimits; tools: ToolDefinition[];
  contract: TaskContract; instructions: string; hostBindingDigest: string;
  /** Admitted user input, bound with the configuration; null uses the objective alone. */
  inputMessages: Message[] | null;
  conversationSeed?: ConversationSeed;
  contextSources: ContextSourceDefinition[]; hooks: HookDefinition[];
  contextPolicy: ContextPlanningPolicy | null;
  workspaceObservationPolicy: { role: 'browser'; pathSuffixes: string[] } | null;
  stopHookContinuationLimit: number; delegationDepth: number;
  modelRecoveryPolicy: 'manual' | 'pure-inference/v1';
  guidancePolicy?: 'boundary-guide/v1' | null;
  outputRecoveryPolicy?: 'task-or-delivery/v1' | null;
  toolErrorRecoveryPolicy?: 'diagnose-before-repeat/v1' | null;
  toolErrorRecoveryModelCalls?: number | null;
  deliveryReviewPolicy?: DeliveryReviewPolicy | null;
  /** Opaque, Host-owned recovery locator. The core never interprets it as authority. */
  hostRecoveryBinding?: ObjectValue;
  backgroundNotificationPolicy?: 'completed-before-model/v1' | null;
  childLifecyclePolicy?: 'owned-background/v2' | null;
  childApprovalPolicy?: 'owned-child-approval/v1' | null;
  childPromotionPolicy?: 'owned-child-promotion/v1' | null;
  childInputPolicy?: 'owned-child-input/v1' | null;
  childOwnerBinding?: ChildOwnerBinding;
}
export interface Usage {
  /** Inclusive prompt/output totals. Cache counters are additive subtypes, not extra input. */
  inputTokens: number; outputTokens: number; modelCalls: number; toolCalls: number; cost: number;
  cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningTokens?: number;
}
/** Parent-owned allocation. A child cannot release it by reporting model-visible JSON. */
export interface ChildBudgetReservation {
  childRunId: string; childScope: RunScope; parentOperationKey: string; parentToolCallId: string;
  childRequestDigest: string; configurationDigest: string;
  maxModelCalls: number; maxToolCalls: number; settledUsageDigest: string | null;
  deliveryMode?: 'foreground' | 'background';
}
export interface ChildBudgetSettlement {
  childRunId: string; parentOperationKey: string; childRequestDigest: string; terminalSnapshotDigest: string;
}
export interface ToolBudget {
  maxModelCallsRemaining: number | null; parentFinalizationReserved: true;
  maxToolCallsRemaining: number | null; depth: number; maxDepth: number;
}
export interface ArtifactRef { uri: string; digest: string; mediaType: string; sizeBytes: number; metadata: ObjectValue }
export interface ToolResult {
  /** Computed by pinned source governance, never accepted from a callback. */
  sourceObservationState?: 'unread';
  status: 'ok' | 'error' | 'approval_required' | 'uncertain'; content: Json;
  /** Explicit model view of the committed receipt; absent keeps legacy JSON encoding. */
  context?: ToolContextMessage;
  /** Host-authorized full post-policy observation before a bounded source projection. */
  archiveContext?: ToolContextMessage;
  /** Deferred until every call in the model's tool batch has a result. */
  additionalContexts?: ToolContextMessage[];
  interactionId?: string; workspaceChangedPaths?: string[]; artifactRefs?: ArtifactRef[];
  /** A negotiated Host permission reply stays in the ledger; it is not a tool-owned interaction. */
  approvalPolicy?: 'durable-preflight/v1';
  /** Kernel-derived observation identity excludes freshly minted archive locators. */
  artifactObservationDigest?: string;
  resourceUsage?: Usage; childRunIds?: string[]; metadata?: ObjectValue;
  /** Paired with resourceUsage. False means these are only the known counters;
   * zero never implies that an unreported nested model request was free. */
  resourceUsageReported?: boolean;
  childBudgetReservation?: ChildBudgetReservation; childBudgetSettlement?: ChildBudgetSettlement;
  coordinatorResponses?: import('./child-contract.mjs').CoordinatorResponse[];
  /** Only a tool pinned with observationRole=browser can admit these host capabilities. */
  browserSessionRef?: BrowserSessionRef; browserSessionClosed?: boolean;
  browserObservation?: BrowserObservation;
  backgroundCommandRef?: BackgroundCommandRef; backgroundCommandFinished?: boolean;
}
export type ModelResponseKind = 'tool_calls' | 'final_candidate' | 'output_limit' | 'context_overflow'
  | 'empty_response' | 'malformed_tool_call' | 'provider_retryable_error' | 'provider_terminal_error'
  | 'policy_abort' | 'user_abort';
export interface ModelResult {
  kind: ModelResponseKind; text: string; toolCalls: ToolCall[]; usage: Usage;
  textCommitVersion?: 'provider-finished-text/v1';
  /** False means counters are partial/absent; zero must not imply known free usage. */
  usageReported?: boolean;
  providerReplay?: ObjectValue; retryAfterMs?: number; failureKind?: string;
  replayToolIds?: Record<string, string>;
}
export interface PendingInteraction {
  interactionId: string; hostInteractionId: string; callId: string; operationKey: string;
  approvalPolicy?: 'durable-preflight/v1';
}
export interface VerificationReport {
  status: 'passed' | 'failed' | 'unverified'; reason: string;
  candidateId?: string; contractRevision?: string;
  binding?: CandidateBinding;
  checks: { id: string; status: 'passed' | 'failed' | 'not_run' | 'blocked' | 'unverified'; evidence: Json;
    verifierId?: string; verifierVersion?: string; verificationMethod?: VerificationMethod;
    evidenceRefs?: string[]; safeSummary?: string; repairable?: boolean }[];
  workspaceRevision: string | null;
  workspaceDependency?: 'required' | 'none'; repairable?: boolean; failureFingerprint?: string;
}
export interface CandidateBinding { subjectDigest: string; subjectContextDigest: string; environmentDigest: string }
export interface CompletionCandidate {
  candidateId: string; text: string; goalRevision: number; workspaceRevision: string | null;
  purpose?: 'final' | 'checkpoint';
  binding?: CandidateBinding;
}
export interface ChildState {
  runId: string; sessionId: string; operationKey: string; callId: string;
  state: 'prepared' | 'running' | 'awaiting_interaction' | 'completed' | 'failed' | 'canceled' | 'interrupted';
  reservedModelCalls: number | null; reservedToolCalls: number | null; usage: Usage;
  notified: boolean; metadata: ObjectValue;
}
export type BackgroundCommand = BackgroundCommandState;
export interface ToolErrorStreak {
  signature: string; count: number; modelCall: number; goalRevision: number; workspaceRevision: string | null;
  action?: { name: string; argumentsDigest: string | null };
}
export interface ToolErrorRecovery {
  action: { name: string; argumentsDigest: string | null }; failureFingerprint: string;
  startedModelCall: number; priorModelCallsSpent: number; observationRevision: number;
  goalRevision: number; workspaceRevision: string | null;
  diagnosticObservationSeen: boolean; diagnosticModelCall: number | null;
  trialConsumed: boolean; trialCallId: string | null; trialModelCall: number | null;
}
export interface DeliveryReviewPolicy {
  pathSuffixes: string[]; maxRounds: number; maxReadRounds: number; reviewUnknownPaths: boolean;
}
export interface DeliveryReviewSuggestion {
  requirements: { requirement: string; implementation_evidence: string; verification_evidence: string }[];
  findings: { issue: string; recommended_check: string }[];
}
export interface DeliveryReviewState {
  status: 'pending' | 'observed' | 'unavailable'; rounds: number; subjectDigest: string; reviewedSubjects: string[];
  suggestion: DeliveryReviewSuggestion | null; reason: string | null; continuationMessages: Message[]; readRounds: number;
}
export interface PreparedContext {
  messages: Message[];
  /** Binds this disposable model view to the immutable transcript and environment. */
  sourceDigest: string;
  admission?: ContextAdmission;
  toolResultPruning?: ToolResultPruning;
  /** Uncached contributors must be read again when another lease admits a model. */
  sourceFence?: number;
}
export type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed'; priority: 'high' | 'medium' | 'low' };
export interface RunSnapshot extends RunIdentity {
  /** Last committed strategy-context boundary; no execution authority. */
  policyContextCursor?: string;
  conversationBranch?: { commandId: string; generation: number };
  planMode?: { active: boolean; revision: number; approvedPlan?: { plan: string; allowedPrompts?: Json } };
  todos?: { items: TodoItem[]; revision: number; assistantTurns: number; lastWriteAssistantTurn: number; lastReminderAssistantTurn: number };
  toolDiscovery?: { discovered: string[]; promoted: string[] };
  /** Runtime-owned capacity for the complete original assistant batch, never a dispatched subset. */
  sourceReadQuote?: SourceReadQuote | null;
  /** Immutable controlled admission of an owned command's completion. */
  backgroundNotification?: { contract: 'agentkit.background-notification-admission/v1'; sourceRunId: string;
    taskId: string; requestDigest: string; sourceConfigDigest: string; admissionElapsedMs: number };
  schemaVersion: typeof NATIVE_SCHEMA; configDigest: string; revision: number; eventSeq: number;
  phase: Phase; resumePhase: Phase | null; goal: string; goalRevision: number;
  taskContract: TaskContract | null; taskContractDigest: string | null;
  messages: Message[]; preparedContext: PreparedContext | null; queuedGuidance: Message[];
  pendingGuidanceIds?: string[];
  /** Monotonic private replay abandonment, committed before model dispatch. */
  abandonedReplayDigests?: string[];
  pendingTools: ToolCall[]; pendingIntent: string | null;
  /** An uncertain receipt remains immutable; only a new read-only observation can resolve it. */
  toolReconciliation?: { contract: 'agentkit.tool-receipt-observation/v1'; operationKey: string; callId: string } | null;
  pendingInteraction: PendingInteraction | null; interaction: ObjectValue | null;
  usage: Usage; descendantUsage: Usage; modelErrors: number; providerErrors: number;
  continuations: number; outputRestarts: number; repairs: number;
  activeElapsedMs: number; retryNotBefore: number;
  candidate: CompletionCandidate | null; verification: VerificationReport | null;
  finalText: string; outcome: Outcome | null; reason: string | null;
  workspaceRevision: string | null; workspaceModifiedPaths: string[]; artifactRefs: ArtifactRef[];
  workspaceDirtySinceCheckpoint: boolean; lastWorkspaceMutationToolCall: number | null;
  checkpointWorkspaceRevision: string | null; checkpointWebMutationToolCall: number | null;
  verificationToolCalls: number | null;
  failureFingerprint: string | null; failureEvidenceDigest: string | null;
  children: ChildState[]; backgroundCommands: BackgroundCommand[];
  childBudgetReservations: ChildBudgetReservation[]; childRunIds: string[];
  promotedChildRunIds?: string[];
  childLifecycleCursor?: string | null; childLifecycleFailure?: 'poll' | 'wait' | 'cancel' | null;
  childResponseCursors?: Record<string, number>;
  childApproval?: ChildApproval | null; childTerminalPhase?: 'canceled' | 'failed' | null;
  context: ObjectValue; diagnostics: ObjectValue; stopHookContinuations: number;
  hookState: HookState | null;
  contextState: ContextPlanningState | null;
  recoveryRetriesUsed: number;
  toolErrorStreak: ToolErrorStreak | null;
  toolErrorRecovery?: ToolErrorRecovery | null;
  deliveryReview?: DeliveryReviewState | null;
  executionBudgetObservation?: { policy: 'prepared-execution-budget/v1'; runId: string; sourceRevision: number;
    goalRevision: number; modelCallsClaimed: number; toolCallsClaimed: number; wallMsRemaining: number | null };
  deliveryArtifacts?: { goalRevision: number; paths: string[] };
  workspaceObservationStatus?: 'captured' | 'unavailable';
  observedProgressRevision?: number; observedProgressFingerprints?: string[];
  browserSessionRefs: BrowserSessionRef[]; browserReobservationRefs: BrowserSessionRef[];
  lastBrowserObservation: BrowserEvidence | null; lastBrowserAttemptToolCall: number | null;
  lastWebMutationToolCall: number | null; unresolvedInteractionObservation: BrowserInteractionObservation | null;
}
export interface BrowserInteractionObservation {
  toolName: string; entryPath: string; toolCall: number; error: string; digest: string;
}
export interface BrowserEvidence {
  sessionRef: BrowserSessionRef; actionId: string; actionSeq: number; digest: string; callId: string;
  toolCall: number; goalRevision: number; workspaceRevision: string | null;
  /** Canonical Host receipt path; model/display text cannot supply this binding. */
  entryPath?: string;
}
export interface NativeEvent { eventId: string; runId: string; turnId: string; seq: number; kind: string; payload: ObjectValue }
export type EffectKind = 'workspace' | 'model' | 'tool' | 'verify' | 'context' | 'hook' | 'child' | 'input' | 'tool_receipt' | 'workspace_repair';
export interface EffectIntent { operationKey: string; kind: EffectKind; payload: ObjectValue; status: 'prepared' | 'running'; claimedAtMs?: number; claimedFence?: number }
export interface EffectReceipt { operationKey: string; status: 'committed' | 'failed' | 'uncertain' | 'not_dispatched'; result: ObjectValue }
export type CommandKind = 'cancel' | 'policy_revoked' | 'pause' | 'resume' | 'submit_interaction'
  | 'reconcile_tool' | 'repair_workspace' | 'steer' | 'guide' | 'promote_child' | 'message_child' | 'cancel_child';
export interface RunCommand { commandId: string; kind: CommandKind; payload: ObjectValue }
export interface CommandReceipt { commandId: string; status: 'accepted' | 'duplicate' | 'rejected'; reason: string | null }
export interface Lease { owner: string; fence: number; expiresAt: number }
export interface CommitBatch {
  commitId: string; snapshot: RunSnapshot; events: NativeEvent[];
  intents: EffectIntent[]; receipts: EffectReceipt[]; consumedCommandId: string | null;
  requireNoPendingCommands: boolean;
  /** Parent command consumption and original child inbox admission share one transaction. */
  childControlDelivery?: ChildControlDelivery;
}
export interface StoredRun {
  /** Operator disposition is separate from the immutable execution verdict. */
  backgroundInterruptionReview?: import('./background-interruption.mjs').BackgroundInterruptionReview;
  configuration: RunConfiguration; snapshot: RunSnapshot; lease: Lease | null; fence: number;
  events: NativeEvent[]; intents: EffectIntent[]; receipts: EffectReceipt[];
  commands: { command: RunCommand; consumed: boolean }[];
  commits: { commitId: string; fingerprint: string }[];
  projections: Record<string, number>;
}
/** All mutations are atomic. Implementations must fence even duplicate commits. */
/** Discovery metadata; polling must not materialize transcript or tool receipts. */
export interface RunScanHead extends Pick<RunSnapshot, 'scope' | 'runId' | 'sessionId' | 'phase' | 'revision' | 'eventSeq' | 'backgroundCommands'> {
  lease: Lease | null;
}
export interface RunStore {
  create(configuration: RunConfiguration, snapshot: RunSnapshot): RunSnapshot;
  createNotification(configuration: RunConfiguration, snapshot: RunSnapshot): { snapshot: RunSnapshot; created: boolean };
  load(scope: RunScope, runId: string): StoredRun;
  /** Unconsumed control inputs without reading the effect journal. */
  pendingCommands?(scope: RunScope, runId: string): RunCommand[];
  list(scope: RunScope, sessionId?: string): RunSnapshot[];
  listHeads?(scope: RunScope, sessionId?: string): RunScanHead[];
  sessionHead(scope: RunScope, sessionId: string): RunSnapshot | null;
  acquire(scope: RunScope, runId: string, owner: string, now: number, ttlMs: number): Lease;
  renew(scope: RunScope, runId: string, lease: Lease, now: number, ttlMs: number): Lease;
  release(scope: RunScope, runId: string, lease: Lease): void;
  commit(scope: RunScope, runId: string, lease: Lease, now: number, expectedRevision: number, batch: CommitBatch): RunSnapshot;
  /** Claim once; atomically charges a model attempt. Load the updated snapshot before reducing its result. */
  claim(scope: RunScope, runId: string, lease: Lease, now: number, operationKey: string): EffectIntent;
  enqueue(scope: RunScope, runId: string, command: RunCommand): CommandReceipt;
  events(scope: RunScope, runId: string, after?: number): NativeEvent[];
  acknowledge(scope: RunScope, runId: string, projection: string, through: number): void;
  reviewBackgroundInterruption?(scope: RunScope, runId: string,
    review: import('./background-interruption.mjs').BackgroundInterruptionReview, now: number): void;
}
export interface PortContext extends RunIdentity {
  operationKey: string; signal: AbortSignal;
  /** Generation that claimed this effect; never taken from current store state after dispatch. */
  executionFence?: number;
}
export interface ModelRequest extends PortContext {
  purpose?: 'task' | 'compaction' | 'delivery_review';
  profile: ModelProfile; messages: Message[]; tools: ToolDefinition[]; finalizationOnly: boolean;
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  maxInlineImageBytes: number;
}
export interface ModelStreamEvent { kind: 'text' | 'thinking' | 'tool_delta' | 'activity'; text: string; metadata?: ObjectValue }
export interface ModelStreamRecord { time: number; event: ModelStreamEvent }
export interface ModelPort { generate(request: ModelRequest, emit: (event: ModelStreamEvent) => void): Promise<ModelResult> }
export interface ToolRequest extends PortContext {
  /** Kernel-sealed command restriction, present only in an active Plan mode. */
  planMode?: 'session-plan/v1';
  resultGovernance?: 'runtime-artifacts/v1';
  sourceReadBudget?: SourceReadBudget;
  call: ToolCall; definition: ToolDefinition; interaction: ObjectValue | null;
  /** Host-derived allowance after the invoking call and parent finalization reserve. */
  budget: ToolBudget;
}
/** Read-only lookup of the original effect; this grants no execution authority for it. */
export interface ToolReceiptRequest extends PortContext {
  contract: 'agentkit.tool-receipt-observation/v1'; originalOperationKey: string;
  originalClaimedFence: number; call: ToolCall; definition: ToolDefinition;
}
export interface ToolReceiptObservation {
  contract: 'agentkit.tool-receipt-observation/v1'; originalOperationKey: string; callId: string;
  /** Additional resourceUsage delta since the original immutable uncertain receipt, never its cumulative total. */
  result: ToolResult | null;
}
export interface ToolPort {
  executionLifecycle?: 'dispatch/v1';
  approvalPolicy?: 'durable-preflight/v1';
  execute(request: ToolRequest, lifecycle?: import('./tool-execution.mjs').ToolExecutionLifecycle): Promise<ToolResult>;
  checkPlanMode?(request: ToolRequest): Promise<boolean>;
  observeReceipt?(request: ToolReceiptRequest): Promise<ToolReceiptObservation>;
  repairWorkspace?(request: WorkspaceRepairRequest): Promise<WorkspaceRepairResult>;
}
export interface WorkspaceRepairRequest extends Omit<ToolReceiptRequest, 'contract'> {
  contract: 'agentkit.workspace-compensation/v1';
}
export interface WorkspaceRepairResult extends Omit<ToolReceiptObservation, 'contract'> {
  contract: 'agentkit.workspace-compensation/v1';
}
export interface WorkspaceObservation { revision: string | null; changedPaths: string[]; status: 'ok' | 'unavailable'; reason: string | null }
export interface WorkspacePort { observe(request: PortContext): Promise<WorkspaceObservation> }
/** Claim Host-admitted input only after its Native intent has been persisted. */
export interface TurnInputMessage extends ToolContextMessage { retention?: 'persistent' | 'normal' }
export interface TurnInputPort {
  prepare(request: PortContext & { step: number }): Promise<{
    status: 'admitted' | 'rejected'; messages: TurnInputMessage[]; planMode?: boolean;
  }>;
}
export interface ContextPort {
  /** Optional read-only, uncached data collected inside each durable Context effect.
   * The Kernel wraps items as untrusted user data and admits only whole items.
   */
  readSource?(request: PortContext & { source: ContextSourceDefinition; snapshot: RunSnapshot;
    configuration: RunConfiguration; remainingTokens: number }): Promise<{ items: ObjectValue[] }>;
  /** context is adapter state, persisted under snapshot.context.adapter. Original messages are never replaced. */
  /** A prepared view must retain unacknowledged snapshot.hookState.feedback before budgeting. */
  prepare?(request: PortContext & { snapshot: RunSnapshot; configuration: RunConfiguration; forceCompaction: boolean }): Promise<{ messages: Message[]; context: ObjectValue }>;
  tokens?: {
    tokenizerId: string; tokenizerDigest: string;
    countRequest(request: PortContext & { profile: ModelProfile; messages: Message[]; tools: ToolDefinition[];
      purpose: 'task' | 'compaction' | 'delivery_review'; maxOutputTokens: number; maxInlineImageBytes: number }): Promise<number>;
    countText(request: PortContext & { text: string }): Promise<number>;
    countMessage?(request: PortContext & { profile: ModelProfile; message: Message; tools?: ToolDefinition[];
      purpose: 'task' | 'delivery_review'; maxInlineImageBytes: number }): Promise<number>;
  };
}
export interface SourceReadQuote {
  policy: 'studio-source-read/v1'; status: 'ready' | 'unavailable'; reason: string | null;
  configDigest: string; goalRevision: number; batchDigest: string;
  tokenizerId: string; tokenizerDigest: string; readerCallIds: string[];
  countedInputTokens: number; fixedUnits: number; mandatoryUnits: number;
  prospectiveRefUnits: number; summaryUnits: number; availableUnits: number;
  maxSourceUnits: number; maxResultUnits: number;
}
export interface SourceReadBudget {
  policy: 'agentkit.source-page-budget/v1'; quoteDigest: string;
  counterId: string; tokenizerDigest: string; sourceGroupSize: number;
  maxSourceUnits: number; maxResultUnits: number; maxResultBytes: number;
}
export interface VerificationPort {
  verify(request: PortContext & { candidate: CompletionCandidate; contract: TaskContract; snapshot: RunSnapshot }): Promise<VerificationReport>;
}
export interface HookPort {
  invoke(request: HookInvocation & { signal: AbortSignal }): Promise<HookInvocationResult>;
}
export interface ArtifactPort {
  write(request: PortContext & { content: string; mediaType: string; metadata: ObjectValue }): Promise<ArtifactRef>;
  read(request: PortContext & { ref: ArtifactRef; offset: number; limit: number }): Promise<{ content: string; nextOffset: number | null }>;
  search(request: PortContext & { query: string; limit: number }): Promise<ArtifactRef[]>;
}
export interface NativePorts {
  model: ModelPort; tools: ToolPort; workspace?: WorkspacePort; context?: ContextPort;
  input?: TurnInputPort;
  verification?: VerificationPort; hooks?: HookPort; artifacts?: ArtifactPort;
  children?: ChildLifecyclePort; background?: BackgroundCommandPort;
  browser?: BrowserRecoveryPort;
}
/** Read-only continuity probe. It must never restart a page or replay an action.
 * A replacement observation is a separately admitted, durable tool effect. */
export interface BrowserRecoveryPort {
  recoverSessions(request: PortContext & { refs: BrowserSessionRef[] }): Promise<BrowserRecovery[]>;
}
export const terminal = (phase: Phase): boolean => ['completed', 'failed', 'canceled', 'interrupted'].includes(phase);
export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, cost: 0 });
export const commandPriority: Record<CommandKind, number> = {
  cancel: 100, policy_revoked: 95, submit_interaction: 90, cancel_child: 85,
  pause: 80, resume: 80, reconcile_tool: 75, repair_workspace: 75, promote_child: 70, message_child: 70, steer: 60, guide: 60,
};
