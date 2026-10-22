/** One conservative public surface for all three manifest executors. */
export function managedRuntimeBootstrap(runtime, model) {
  const unavailable = () => ({ supported: false, mode: 'unavailable', reason: 'managed_surface_not_implemented' });
  const matrix = Object.fromEntries(['pause', 'resume', 'submit_interaction', 'attach', 'steer', 'inject',
    'checkpoint', 'durable_restore', 'goal', 'loop', 'plan'].map(key => [key, unavailable()]));
  // Managed approval is real: the Host holds each ask as an Interaction record
  // and settles it through its SubmitInteraction action.
  matrix.submit_interaction = { supported: true, mode: 'native' };
  const hostedChat = { Enabled: true, ApiFormats: ['responses'], PreferredTransport: 'responses',
    Transports: [{ Protocol: 'responses', Runtime: 'dsh', Endpoint: '/agentengine/api/v1/RunAgent', Version: 'v1',
      Capabilities: { Cancel: true, Interrupt: false } }] };
  return {
    Agent: { AgentId: runtime.identity.agentId, Name: runtime.declaration.name, Framework: runtime.identity.runtimeName },
    RuntimeIdentity: { ManifestFormat: 'agentengine.dsh-manifest/v1', AgentId: runtime.identity.agentId,
      VersionId: runtime.identity.versionId, ManifestSha256: runtime.identity.manifestSha256,
      RuntimeName: runtime.identity.runtimeName, RuntimeVersion: runtime.identity.runtimeVersion },
    Modules: ['Chat'], ApiFormats: ['responses'], Stream: true,
    Capabilities: {
      HostedChat: hostedChat, HistoryRead: { Protocol: 'ksadk.history/v2', SessionContractVersion: 2, SupportsEpoch: true, SupportsSnapshot: true },
      Attachments: false, WorkspaceFiles: false, Approval: true, Thinking: false,
      ApprovalPolicy: { Modes: ['ask', 'risk'], DefaultMode: 'risk', RuntimeOverride: true },
      StopRun: true, ResumeRun: false, BackgroundRun: false, KernelSessionEvents: false,
      InteractionV1: true, interaction_v1: { enabled: true },
      RunLifecycle: { Enabled: true, Resume: false, Abort: true, Checkpoints: false, CheckpointResume: false, CheckpointResumePreview: false },
      RuntimeCapabilities: { CancelRun: { Supported: true }, ResumeRun: { Supported: false } },
      RuntimeCapabilityMatrix: { schema_version: 1, cancel: { supported: true, mode: 'native' }, ...matrix },
      scoped_cancel: { supported: false }, NativeDashboard: { Enabled: false }, NativeTerminal: { Enabled: false },
      Persistence: { Configured: true, Ready: true, Status: 'ready', Backend: 'dsh-native-disk',
        SharedAcrossPods: false, EffectiveFor: 'same_agent_version', ActiveRunRestore: false },
    },
    Model: { id: model, name: model, source: 'managed-manifest' }, SessionBackend: { Type: 'dsh-native-disk' }, HostedChat: hostedChat,
  };
}
