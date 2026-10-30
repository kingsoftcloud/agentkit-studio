import { validateModelSurface } from '@kingsoftcloud/agentkit-harness-core';

/** The tool owner supplies actual roots; neither process.cwd nor ambient host prompt data is a fallback. */
export function bindNativeModelSurface({ environment, description, original, executionCapabilities } = {}) {
  const modelSurface = { contract: 'bound-model-surface/v1',
    ...(original === undefined ? {verificationProjection:'readable-evidence/v1'}
      : original.verificationProjection ? {verificationProjection:original.verificationProjection} : {}),
    ...(executionCapabilities === undefined ? {} : { executionCapabilities: structuredClone(executionCapabilities) }),
    environment: { ...structuredClone(environment),
    date: original?.environment.date ?? new Date().toISOString().slice(0, 10),
    supportsImages: description.input.includes('image') } };
  validateModelSurface(modelSurface);
  return modelSurface;
}

/** Preserve content-part indices when exposing the last actual user input to children. */
export function nativeChildInputMediaSources(rows, admission) {
  let sources = new Map();
  rows.forEach(({ message }, index) => {
    if (admission.messages[index].kind !== 'user_input') return;
    sources = new Map(); let image = 0;
    message.content.forEach((part, partIndex) => {
      if (part.type === 'image' && part.offloaded !== true) sources.set(partIndex, admission.messages[index].media?.[image++]);
    });
  });
  return sources;
}
