import type { LlmAdapter } from '@deepseek-ai/dsh-llm'

export interface HarnessModel {
  stream(options: Parameters<LlmAdapter['stream']>[0]): ReturnType<LlmAdapter['stream']>
}
export declare function createDshHarnessAdapter(options: {
  model: HarnessModel
  provider?: string
  modelName?: string
}): LlmAdapter
