export declare const HARNESS_CONTRACT_VERSION: string
export declare const DSH_SESSION_EVENT_TYPES: readonly string[]
export declare const DSH_ASSISTANT_STREAM_FRAME_TYPES: readonly string[]
export declare const HARNESS_RUNTIME_CAPABILITIES: readonly string[]
export declare function assertDshHarnessContext<T>(ctx: T): T
export declare function assertDshStreamFrame<T>(frame: T): T
export declare function runtimeContract(): Readonly<Record<string, unknown>>
