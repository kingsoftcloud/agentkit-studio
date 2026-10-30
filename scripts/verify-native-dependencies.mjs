import { NativeKernel } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore, createNativeModelPort } from '@kingsoftcloud/agentkit-harness-node';
import { resolveLocalProcessLauncher } from '@kingsoftcloud/agentkit-harness-node/native/local-process';
import { localOutputPolicy, localEnvironmentPolicy } from '@kingsoftcloud/agentkit-harness-node/native/local-output-policy';
import { localResourceSettings, localResourceFacts } from '@kingsoftcloud/agentkit-harness-node/native/local-resource-profile';
import { workspaceBrowserCapability } from '@kingsoftcloud/agentkit-harness-node/native/browser-workspace-policy';
import { nativeToolModelGuidance } from '@kingsoftcloud/agentkit-harness-node/native/tool-guidance';
import { roleAllocationDefaults, resolveChildCallLimits } from '@kingsoftcloud/agentkit-harness-node/native/child-owner';
import { createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { verifyNativePackageTree } from './native-package-integrity.mjs';
import { fileURLToPath } from 'node:url';

const checked = verifyNativePackageTree(fileURLToPath(new URL('../', import.meta.url)));

if (![NativeKernel, SqliteRunStore, createNativeModelPort, resolveLocalProcessLauncher, createNativeWorkspaceTools,
  localOutputPolicy, localEnvironmentPolicy, localResourceSettings, localResourceFacts, workspaceBrowserCapability,
  nativeToolModelGuidance, roleAllocationDefaults, resolveChildCallLimits]
  .every(value => typeof value === 'function')) throw Error('Native package public API is unavailable');
console.log(`Native package public APIs and ${checked} installed files match their pinned archives.`);
