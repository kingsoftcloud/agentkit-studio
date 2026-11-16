/**
 * The Studio runtime-type vocabulary.
 *
 * This module is deliberately dependency-free: the browser bundle may import it
 * (`src/client/theme.mjs` re-exports the public list), while
 * `src/runtime-contract.mjs` re-exports the same values next to the capability
 * matrix and the run-identity assertions. `scripts/build-client.mjs` rejects any
 * browser dependency under `src/host/` or `src/providers/`, so the vocabulary
 * cannot live in the contract file itself.
 *
 * There is deliberately more than one set. Each answers a *different* question
 * about the same `runtime.type` vocabulary, and a runtime is absent from the
 * sets whose capability it does not have. Collapsing them into one array would
 * silently grant capabilities: a user would be able to create a `native-engine`
 * Agent, or deploy `harness` as a resident runtime, which the product does not
 * support.
 *
 * | Set                 | Question                                                | Members                          |
 * | ------------------- | ------------------------------------------------------- | -------------------------------- |
 * | public              | may a user create it, and does it ship in a bundle?      | dsh-native, harness, codex       |
 * | experimental        | is it routable but deliberately not offered?             | native-engine                    |
 * | routable            | can the Host route a turn to it? (public ∪ experimental) | public + native-engine           |
 * | managed             | can it be deployed as a resident managed runtime?        | dsh-native, codex                |
 * | team                | may an expert-team role run on it?                       | dsh-native, harness              |
 * | process             | does it run in its own process behind the stream seam?   | codex, native-engine             |
 * | nativeTurn          | does it use the native DSH turn port?                    | harness, native-engine           |
 * | invocationContext   | does it need a bound tool-invocation context?            | dsh-native, codex, native-engine |
 *
 * Relations between the sets are asserted by `tests/runtime-registry.test.mjs`.
 * Adding a runtime means editing this block, not eleven files.
 */

/** Publicly creatable runtimes: the Agent form offers them, portable bundles and deployments accept them. */
export const STUDIO_RUNTIME_TYPES = Object.freeze(['dsh-native', 'harness', 'codex']);

/** Routable locally but not part of the frozen public runtime list: the Native
 * engine as its own process. Not offered in the Agent form, portable bundles
 * or deployments until its resource tools are carried over the protocol. */
export const STUDIO_EXPERIMENTAL_RUNTIME_TYPES = Object.freeze(['native-engine']);

/** Every `runtime.type` the Host can route a turn to: the public set plus the experimental engine. */
export const STUDIO_ROUTABLE_RUNTIME_TYPES = Object.freeze([...STUDIO_RUNTIME_TYPES, ...STUDIO_EXPERIMENTAL_RUNTIME_TYPES]);

/** Runtimes that can be deployed as a resident managed runtime.
 *
 * `harness` is an npm plugin the Host mounts in-process, not a container image
 * the platform can keep running, so it is never a managed deployment target. */
export const STUDIO_MANAGED_RUNTIME_TYPES = Object.freeze(['dsh-native', 'codex']);

/** Runtimes an expert-team role may run on. A team runs on the Host's own
 * session loop, so only the two in-process runtimes qualify. */
export const STUDIO_TEAM_RUNTIME_TYPES = Object.freeze(['dsh-native', 'harness']);

/** Runtimes that run in their own process behind the stream seam. */
export const STUDIO_PROCESS_RUNTIME_TYPES = Object.freeze(['codex', 'native-engine']);

/** Runtimes that use the native DSH turn port instead of Studio's own loop. */
export const STUDIO_NATIVE_TURN_RUNTIME_TYPES = Object.freeze(['harness', 'native-engine']);

/** Runtimes that need a bound tool-invocation context to attribute tool calls. */
export const STUDIO_INVOCATION_CONTEXT_RUNTIME_TYPES = Object.freeze(['dsh-native', 'codex', 'native-engine']);

/**
 * Every registry set, keyed by the question it answers.
 *
 * Tests iterate this instead of restating the membership rules, so a new set
 * cannot be added without also being covered by the self-consistency gate.
 */
export const STUDIO_RUNTIME_SETS = Object.freeze({
  public: STUDIO_RUNTIME_TYPES,
  experimental: STUDIO_EXPERIMENTAL_RUNTIME_TYPES,
  routable: STUDIO_ROUTABLE_RUNTIME_TYPES,
  managed: STUDIO_MANAGED_RUNTIME_TYPES,
  team: STUDIO_TEAM_RUNTIME_TYPES,
  process: STUDIO_PROCESS_RUNTIME_TYPES,
  nativeTurn: STUDIO_NATIVE_TURN_RUNTIME_TYPES,
  invocationContext: STUDIO_INVOCATION_CONTEXT_RUNTIME_TYPES,
});

/** True for a publicly creatable runtime type. */
export function isStudioRuntimeType(value) {
  return STUDIO_RUNTIME_TYPES.includes(value);
}

/** True for any runtime type the Host can route a turn to. */
export function isRoutableRuntimeType(value) {
  return STUDIO_ROUTABLE_RUNTIME_TYPES.includes(value);
}

/** True for a runtime type that can be deployed as a resident managed runtime. */
export function isManagedRuntimeType(value) {
  return STUDIO_MANAGED_RUNTIME_TYPES.includes(value);
}

/** True for a runtime type an expert-team role may run on. */
export function isTeamRuntimeType(value) {
  return STUDIO_TEAM_RUNTIME_TYPES.includes(value);
}

/** True for a runtime type that runs in its own process behind the stream seam. */
export function isProcessRuntimeType(value) {
  return STUDIO_PROCESS_RUNTIME_TYPES.includes(value);
}

/** True for a runtime type that uses the native DSH turn port. */
export function isNativeTurnRuntimeType(value) {
  return STUDIO_NATIVE_TURN_RUNTIME_TYPES.includes(value);
}

/** True for a runtime type that needs a bound tool-invocation context. */
export function isInvocationContextRuntimeType(value) {
  return STUDIO_INVOCATION_CONTEXT_RUNTIME_TYPES.includes(value);
}
