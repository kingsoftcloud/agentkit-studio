import { isDeepStrictEqual } from 'node:util';
import { NATIVE_ENGINE, NATIVE_SCHEMA, NATIVE_JSON_CODEC } from '@kingsoftcloud/agentkit-harness-core';
import { NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-contract';

export const BUILD_ENGINE_CONTRACT = 'agentkit.build-engine/v1';
const unsupported = () => Object.assign(new Error('STUDIO_BUILD_ENGINE_UNSUPPORTED'), { code: 'STUDIO_BUILD_ENGINE_UNSUPPORTED' });

/** Harness has one execution implementation. A Host cannot select an old loop. */
export function nativeHarnessHostContract(env = {}) {
  const configured = env.AGENTKIT_STUDIO_NATIVE_HARNESS;
  if (configured === undefined || configured === '' || configured === NATIVE_DSH_TURN_CONTRACT) return NATIVE_DSH_TURN_CONTRACT;
  throw new TypeError('Unsupported Native Harness engine contract');
}

export function buildExecutionEngine(spec, nativeEngineContract = NATIVE_DSH_TURN_CONTRACT) {
  if (nativeEngineContract !== NATIVE_DSH_TURN_CONTRACT) throw unsupported();
  if (spec?.runtime?.type !== 'harness') return undefined;
  return { contract: BUILD_ENGINE_CONTRACT, runtime: 'harness', engine: NATIVE_ENGINE,
    turnContract: NATIVE_DSH_TURN_CONTRACT, runSchema: NATIVE_SCHEMA, jsonCodec: NATIVE_JSON_CODEC };
}

export function validateBuildExecutionEngine(spec, value) {
  if (spec?.runtime?.type !== 'harness' && value === undefined) return;
  if (!isDeepStrictEqual(value, buildExecutionEngine(spec))) throw unsupported();
}

export function validateBuildEngineManifest(manifest) {
  if (manifest.spec?.runtime?.type !== 'harness') {
    if (manifest.format === 'agentkit.agent-bundle/v1' && manifest.executionEngine === undefined) return;
    throw unsupported();
  }
  if (manifest.format !== 'agentkit.agent-bundle/v2') throw unsupported();
  validateBuildExecutionEngine(manifest.spec, manifest.executionEngine);
}

export function selectedNativeBuildContract(agent, liveDefault = NATIVE_DSH_TURN_CONTRACT) {
  if (agent.spec?.runtime?.type !== 'harness') return undefined;
  if (!agent.buildId) {
    if (liveDefault !== NATIVE_DSH_TURN_CONTRACT) throw unsupported();
    return NATIVE_DSH_TURN_CONTRACT;
  }
  validateBuildExecutionEngine(agent.spec, agent.executionEngine);
  return NATIVE_DSH_TURN_CONTRACT;
}
