/** Serializable contracts. No Host services, filesystem handles or credentials. */
export const NATIVE_SCHEMA = 'agentkit.native-run/v1' as const;
export const NATIVE_ENGINE = 'agentkit.native/v1' as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export type Phase = 'created' | 'preparing_context' | 'requesting_model' | 'executing_tools'
  | 'awaiting_interaction' | 'compacting' | 'verifying' | 'finalizing' | 'paused'
  | 'completed' | 'failed' | 'canceled' | 'interrupted';
export type Outcome = 'verified' | 'unverified' | 'partial' | 'blocked' | 'failed' | 'budget_exhausted';
export interface RunScope { tenantId: string; workspaceId: string; userId: string; agentId: string }
export interface RunIdentity {
  scope: RunScope; runId: string; sessionId: string; turnId: string; buildId: string;
  parentRunId: string | null; taskChainId: string;
}
export interface ToolCall { callId: string; name: string; arguments: ObjectValue; wireArgumentsInvalid?: boolean }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  kind?: string; callId?: string; name?: string; toolCalls?: ToolCall[];
  /** Private provider protocol data; never part of a public event's payload. */
  providerReplay?: ObjectValue; media?: Json[]; persistent?: boolean;
  /** Stable provenance for imported history; never grants current-run authority. */
  history?: { sourceRunId: string; sourceIndex: number };
  /** Original protocol call id -> canonical historical/current call id. */
  replayToolIds?: Record<string, string>;
}
export interface ToolDefinition {
  name: string; description: string; parameters: ObjectValue;
  readOnly: boolean; concurrentSafe: boolean;
  permissions: string[]; timeoutMs: number;
  contextRole: 'none' | 'workspace_read' | 'workspace_search' | 'workspace_list' | 'artifact_read' | 'task_planning';
  observationRole: 'none' | 'browser';
  progressObservation: boolean; contextRetention: 'normal' | 'persistent';
  childBudgetPolicy?: 'start/v1' | 'settle/v1' | 'delegate/v1';
  childApprovalPolicy?: 'owned-child-approval/v1';
  backgroundCommandPolicy?: 'owned-command-launch/v1';
  delegatedReadOnly?: boolean; deliveryWrite?: boolean;
  /** Explicit Host guarantee of repeatable reads; readOnly alone never grants replay. */
  recoveryPolicy?: 'manual' | 'safe-read/v1';
}
export interface ModelProfile {
  profileId: string; profileVersion: string; providerFamily: string;
  maxOutputTokens: number; contextWindow: number; maxRetries: number; maxProviderRetries: number;
  maxContinuations: number; requestTimeoutMs: number; retryInitialDelayMs: number;
  retryMaxDelayMs: number; retryBackoffMultiplier: number; rateLimitCooldownMs: number;
  providerReplayMode: 'none' | 'reasoning_content' | 'anthropic_content';
  compatibilityDigest: string;
}
export interface RunLimits {
  maxWallMs: number | null; maxModelCalls: number | null; maxToolCalls: number | null;
  maxParallelTools: number; maxRepairs: number; maxOutputRestarts: number;
  finalizationReserveModelCalls: number; finalizationReserveWallMs: number;
  effectTimeoutMs: number; leaseMs: number; maxSubagentDepth: number;
  maxToolResultBytes: number; maxInlineImageBytes: number;
  maxRecoveryRetries: number;
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
export interface HookDefinition {
  hookId: string; events: ('PreToolUse' | 'PostToolUse' | 'PreCompact' | 'Stop')[]; timeoutMs: number;
}
export interface ContextSourceDefinition { sourceId: string; priority: number; timeoutMs: number; required: boolean }
export interface RunConfiguration {
  engine: typeof NATIVE_ENGINE; profile: ModelProfile; limits: RunLimits; tools: ToolDefinition[];
  contract: TaskContract; instructions: string; hostBindingDigest: string;
  contextSources: ContextSourceDefinition[]; hooks: HookDefinition[];
  stopHookContinuationLimit: number; delegationDepth: number;
  modelRecoveryPolicy: 'manual' | 'pure-inference/v1';
}
export interface Usage {
  inputTokens: number; outputTokens: number; modelCalls: number; toolCalls: number; cost: number;
  cachedInputTokens?: number; reasoningTokens?: number;
}
export interface ArtifactRef { uri: string; digest: string; mediaType: string; sizeBytes: number; metadata: ObjectValue }
export interface ToolResult {
  status: 'ok' | 'error' | 'approval_required' | 'uncertain'; content: Json;
  interactionId?: string; workspaceChangedPaths?: string[]; artifactRefs?: ArtifactRef[];
  resourceUsage?: Usage; childRunIds?: string[]; metadata?: ObjectValue;
}
export type ModelResponseKind = 'tool_calls' | 'final_candidate' | 'output_limit' | 'context_overflow'
  | 'empty_response' | 'malformed_tool_call' | 'provider_retryable_error' | 'provider_terminal_error'
  | 'policy_abort' | 'user_abort';
export interface ModelResult {
  kind: ModelResponseKind; text: string; toolCalls: ToolCall[]; usage: Usage;
  /** False means counters are partial/absent; zero must not imply known free usage. */
  usageReported?: boolean;
  providerReplay?: ObjectValue; retryAfterMs?: number; failureKind?: string;
  replayToolIds?: Record<string, string>;
}
export interface PendingInteraction { interactionId: string; hostInteractionId: string; callId: string; operationKey: string }
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
  binding?: CandidateBinding;
}
export interface ChildState {
  runId: string; sessionId: string; operationKey: string; callId: string;
  state: 'prepared' | 'running' | 'awaiting_interaction' | 'completed' | 'failed' | 'canceled';
  reservedModelCalls: number | null; reservedToolCalls: number | null; usage: Usage;
  notified: boolean; metadata: ObjectValue;
}
export interface BackgroundCommand {
  commandId: string; operationKey: string; state: 'running' | 'completed' | 'failed' | 'canceled';
  notified: boolean; metadata: ObjectValue;
}
export interface ToolErrorStreak {
  signature: string; count: number; modelCall: number; goalRevision: number; workspaceRevision: string | null;
}
export interface RunSnapshot extends RunIdentity {
  schemaVersion: typeof NATIVE_SCHEMA; configDigest: string; revision: number; eventSeq: number;
  phase: Phase; resumePhase: Phase | null; goal: string; goalRevision: number;
  messages: Message[]; pendingTools: ToolCall[]; pendingIntent: string | null;
  pendingInteraction: PendingInteraction | null; interaction: ObjectValue | null;
  usage: Usage; descendantUsage: Usage; modelErrors: number; providerErrors: number;
  continuations: number; outputRestarts: number; repairs: number;
  activeElapsedMs: number; retryNotBefore: number;
  candidate: CompletionCandidate | null; verification: VerificationReport | null;
  finalText: string; outcome: Outcome | null; reason: string | null;
  workspaceRevision: string | null; workspaceModifiedPaths: string[]; artifactRefs: ArtifactRef[];
  children: ChildState[]; backgroundCommands: BackgroundCommand[];
  context: ObjectValue; diagnostics: ObjectValue; stopHookContinuations: number;
  recoveryRetriesUsed: number;
  toolErrorStreak: ToolErrorStreak | null;
}
export interface NativeEvent { eventId: string; runId: string; turnId: string; seq: number; kind: string; payload: ObjectValue }
export type EffectKind = 'workspace' | 'model' | 'tool' | 'verify' | 'context' | 'hook' | 'child';
export interface EffectIntent { operationKey: string; kind: EffectKind; payload: ObjectValue; status: 'prepared' | 'running'; claimedAtMs?: number }
export interface EffectReceipt { operationKey: string; status: 'committed' | 'failed' | 'uncertain'; result: ObjectValue }
export type CommandKind = 'cancel' | 'policy_revoked' | 'pause' | 'resume' | 'submit_interaction'
  | 'steer' | 'guide' | 'promote_child' | 'message_child' | 'cancel_child';
export interface RunCommand { commandId: string; kind: CommandKind; payload: ObjectValue }
export interface CommandReceipt { commandId: string; status: 'accepted' | 'duplicate' | 'rejected'; reason: string | null }
export interface Lease { owner: string; fence: number; expiresAt: number }
export interface CommitBatch {
  commitId: string; snapshot: RunSnapshot; events: NativeEvent[];
  intents: EffectIntent[]; receipts: EffectReceipt[]; consumedCommandId: string | null;
  requireNoPendingCommands: boolean;
}
export interface StoredRun {
  configuration: RunConfiguration; snapshot: RunSnapshot; lease: Lease | null; fence: number;
  events: NativeEvent[]; intents: EffectIntent[]; receipts: EffectReceipt[];
  commands: { command: RunCommand; consumed: boolean }[];
  commits: { commitId: string; fingerprint: string }[];
  projections: Record<string, number>;
}
/** All mutations are atomic. Implementations must fence even duplicate commits. */
export interface RunStore {
  create(configuration: RunConfiguration, snapshot: RunSnapshot): RunSnapshot;
  load(scope: RunScope, runId: string): StoredRun;
  list(scope: RunScope, sessionId?: string): RunSnapshot[];
  sessionHead(scope: RunScope, sessionId: string): RunSnapshot | null;
  acquire(scope: RunScope, runId: string, owner: string, now: number, ttlMs: number): Lease;
  renew(scope: RunScope, runId: string, lease: Lease, now: number, ttlMs: number): Lease;
  release(scope: RunScope, runId: string, lease: Lease): void;
  commit(scope: RunScope, runId: string, lease: Lease, now: number, expectedRevision: number, batch: CommitBatch): RunSnapshot;
  claim(scope: RunScope, runId: string, lease: Lease, now: number, operationKey: string): EffectIntent;
  enqueue(scope: RunScope, runId: string, command: RunCommand): CommandReceipt;
  events(scope: RunScope, runId: string, after?: number): NativeEvent[];
  acknowledge(scope: RunScope, runId: string, projection: string, through: number): void;
}
export interface PortContext extends RunIdentity {
  operationKey: string; signal: AbortSignal;
}
export interface ModelRequest extends PortContext {
  profile: ModelProfile; messages: Message[]; tools: ToolDefinition[]; finalizationOnly: boolean;
  maxInlineImageBytes: number;
}
export interface ModelStreamEvent { kind: 'text' | 'thinking' | 'tool_delta'; text: string; metadata?: ObjectValue }
export interface ModelPort { generate(request: ModelRequest, emit: (event: ModelStreamEvent) => void): Promise<ModelResult> }
export interface ToolRequest extends PortContext {
  call: ToolCall; definition: ToolDefinition; interaction: ObjectValue | null;
}
export interface ToolPort { execute(request: ToolRequest): Promise<ToolResult> }
export interface WorkspaceObservation { revision: string | null; changedPaths: string[]; status: 'ok' | 'unavailable'; reason: string | null }
export interface WorkspacePort { observe(request: PortContext): Promise<WorkspaceObservation> }
export interface ContextPort {
  prepare(request: PortContext & { snapshot: RunSnapshot; configuration: RunConfiguration; forceCompaction: boolean }): Promise<{ messages: Message[]; context: ObjectValue }>;
}
export interface VerificationPort {
  verify(request: PortContext & { candidate: CompletionCandidate; contract: TaskContract; snapshot: RunSnapshot }): Promise<VerificationReport>;
}
export interface HookPort {
  invoke(request: PortContext & { hook: HookDefinition; event: HookDefinition['events'][number]; input: ObjectValue }): Promise<{ decision: 'allow' | 'deny' | 'continue'; content: Json }>;
}
export interface ArtifactPort {
  write(request: PortContext & { content: string; mediaType: string; metadata: ObjectValue }): Promise<ArtifactRef>;
  read(request: PortContext & { ref: ArtifactRef; offset: number; limit: number }): Promise<{ content: string; nextOffset: number | null }>;
  search(request: PortContext & { query: string; limit: number }): Promise<ArtifactRef[]>;
}
export interface ChildLifecyclePort {
  invoke(request: PortContext & { action: 'start' | 'resume' | 'cancel' | 'message' | 'promote' | 'release' | 'observe'; input: ObjectValue }): Promise<ObjectValue>;
}
export interface BackgroundCommandPort {
  invoke(request: PortContext & { action: 'launch' | 'observe' | 'cancel'; input: ObjectValue }): Promise<ObjectValue>;
}
export interface NativePorts {
  model: ModelPort; tools: ToolPort; workspace?: WorkspacePort; context?: ContextPort;
  verification?: VerificationPort; hooks?: HookPort; artifacts?: ArtifactPort;
  children?: ChildLifecyclePort; background?: BackgroundCommandPort;
}
export const terminal = (phase: Phase): boolean => ['completed', 'failed', 'canceled', 'interrupted'].includes(phase);
export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, cost: 0 });
export const commandPriority: Record<CommandKind, number> = {
  cancel: 100, policy_revoked: 95, submit_interaction: 90, cancel_child: 85,
  pause: 80, resume: 80, promote_child: 70, message_child: 70, steer: 60, guide: 60,
};
