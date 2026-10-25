import { isDeepStrictEqual } from 'node:util';
import { NATIVE_ENGINE, NATIVE_SCHEMA, NATIVE_JSON_CODEC } from '../packages/agentkit-harness-core/dist/index.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';
import { HARNESS_CONTRACT_VERSION } from '../packages/agentkit-harness/src/contract.mjs';

export const BUILD_ENGINE_CONTRACT = 'agentkit.build-engine/v1';
const unsupported = () => Object.assign(new Error('STUDIO_BUILD_ENGINE_UNSUPPORTED'), { code: 'STUDIO_BUILD_ENGINE_UNSUPPORTED' });

/** Product default for new revisions/builds; frozen archives keep their own pin. */
export function nativeHarnessHostContract(env = {}) {
  const configured = env.AGENTKIT_STUDIO_NATIVE_HARNESS;
  if (configured === undefined || configured === '' || configured === NATIVE_DSH_TURN_CONTRACT) return NATIVE_DSH_TURN_CONTRACT;
  if (configured === 'legacy') return undefined;
  throw new TypeError('Unsupported Native Harness engine contract');
}

/** Host selection is frozen into the content-addressed build, outside the
 * editable Agent spec. A later Host flag cannot reinterpret the same Build. */
export function buildExecutionEngine(spec, nativeEngineContract) {
  if (nativeEngineContract !== undefined && nativeEngineContract !== NATIVE_DSH_TURN_CONTRACT) throw unsupported();
  if (spec?.runtime?.type !== 'harness') return undefined;
  return nativeEngineContract ? { contract: BUILD_ENGINE_CONTRACT, runtime: 'harness', engine: NATIVE_ENGINE,
    turnContract: NATIVE_DSH_TURN_CONTRACT, runSchema: NATIVE_SCHEMA, jsonCodec: NATIVE_JSON_CODEC }
    : { contract: BUILD_ENGINE_CONTRACT, runtime: 'harness', engine: HARNESS_CONTRACT_VERSION };
}

export function validateBuildExecutionEngine(spec, value) {
  if (value === undefined) return; // Builds preceding explicit engine pins use the legacy Harness.
  if (!isDeepStrictEqual(value, buildExecutionEngine(spec))
    && !isDeepStrictEqual(value, buildExecutionEngine(spec, NATIVE_DSH_TURN_CONTRACT))) throw unsupported();
}

export function validateBuildEngineManifest(manifest) {
  if (manifest.format === 'agentkit.agent-bundle/v1' && manifest.executionEngine === undefined) return;
  if (manifest.format !== 'agentkit.agent-bundle/v2' || manifest.spec?.runtime?.type !== 'harness'
    || manifest.executionEngine === undefined) throw unsupported();
  validateBuildExecutionEngine(manifest.spec, manifest.executionEngine);
}

export function selectedNativeBuildContract(agent, liveDefault) {
  if (!agent.buildId) return liveDefault;
  validateBuildExecutionEngine(agent.spec, agent.executionEngine);
  return agent.executionEngine?.engine === NATIVE_ENGINE ? NATIVE_DSH_TURN_CONTRACT : undefined;
}
