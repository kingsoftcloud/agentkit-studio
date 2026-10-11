import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'

export declare const name: 'agentkit-harness'
export declare const inject: readonly ['agents', 'sessions', 'llm']

export interface HarnessConfig {
  defaultAgentOptions?: CreateAgentOptions['agentOptions']
  defaultMeta?: CreateAgentOptions['meta']
}
export interface ObserveOptions {
  onEvent?: (event: SessionEvent) => void
  onAssistantStream?: (frame: AssistantStreamFrame) => void
}
export declare class AgentKitHarnessService {
  readonly ctx: Context
  readonly defaultAgentOptions: NonNullable<HarnessConfig['defaultAgentOptions']>
  readonly defaultMeta: NonNullable<HarnessConfig['defaultMeta']>
  readonly contract: Record<string, unknown>
  constructor(ctx: Context, config?: HarnessConfig)
  create(options?: CreateAgentOptions): Promise<AgentHandle>
  resume(options?: ResumeAgentOptions): Promise<AgentHandle>
  get(sessionId: SessionId | string): Agent | undefined
  list(): Agent[]
  followup(sessionId: SessionId | string, message: UserMessage): void
  cancel(sessionId: SessionId | string, cause?: { kind: 'user' | 'parent' | 'disposed' | 'hook' }, options?: { keepInbox?: boolean }): void
  whenIdle(sessionId: SessionId | string): Promise<void>
  observe(sessionId: SessionId | string, options?: ObserveOptions): () => void
  requireAgent(sessionId: SessionId | string): Agent
}
export declare const AgentKitHarness: typeof AgentKitHarnessService
export declare function apply(ctx: Context, config?: HarnessConfig & { model?: unknown; provider?: string; modelName?: string; adapter?: LlmAdapter }): void
declare const plugin: { name: typeof name; inject: typeof inject; apply: typeof apply }
export default plugin
export * from './contract.js'
export * from './dsh-adapter.js'
