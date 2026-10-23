/** Compose the Node builtin environments admitted through the existing DSH registry. */
import { copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { isBlockedAddress } from '../../packages/agentkit-harness/src/native/web-tools.mjs';
import { hostFetch } from '../http-fetch.mjs';
import { createDshNodeWorkspaceTools } from './dsh-node-workspace-tools.mjs';
import { createDshNodeWebTools } from './dsh-node-web-tools.mjs';
import { createDshNodeToolOutputStore } from './dsh-node-tool-output-store.mjs';
import { createDshNodeCommandTools } from './dsh-node-command-tools.mjs';
import { nativeCommandBackend } from './native-e2b-host.mjs';
import { supportsLocalProcessPlatform } from '../../packages/agentkit-harness/src/native/local-process.mjs';
import { createSsrfPinnedFetch, resolveWebSearchConfig, resolveWebSsrfPolicy } from './native-dsh-web.mjs';

export function createDshNodeBuiltins({ ctx, workspaceRoot, stateDir, agentId, isClosed, signal,
  env = process.env, fetchImpl = hostFetch, persistOutput } = {}) {
  invariant(persistOutput === undefined || typeof persistOutput === 'function', 'dsh_node_output_store_invalid');
  env = { ...env };
  const workspace = createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId, isClosed });
  const output = persistOutput === undefined ? createDshNodeToolOutputStore({ directory: stateDir, agentId, isClosed, signal }) : null;
  const ssrf = resolveWebSsrfPolicy(env);
  const ssrfPolicy = { allowPrivate: ssrf.allowPrivate === true || ssrf.allow_private === true };
  const pinned = createSsrfPinnedFetch({ fetchImpl, ssrfBlockCheck: ssrfPolicy.allowPrivate ? null : isBlockedAddress });
  const web = createDshNodeWebTools({ agentId, isClosed, signal, fetchImpl: pinned.fetch, searchFetch: fetchImpl,
    providerConfig: resolveWebSearchConfig(env), ssrfPolicy, persistOutput: persistOutput ?? output?.persistOutput });
  // Explicit E2B remains on its existing backend until its neutral adapter is
  // complete. Never execute an E2B-selected call on the Host by falling back.
  const commands = nativeCommandBackend(env) === 'local_process' && supportsLocalProcessPlatform()
    ? createDshNodeCommandTools({ ctx, workspaceRoot, stateDir, agentId, isClosed, signal, env, persistOutput }) : null;
  const ports = [workspace, web, ...(commands ? [commands] : [])], owners = new Map();
  for (const port of ports) for (const definition of port.definitions) {
    invariant(!owners.has(definition.name), 'dsh_node_builtin_duplicate'); owners.set(definition.name, port);
  }
  let closing;
  return { contract: 'agentkit.dsh-node-builtins/v1',
    get definitions() { return ports.flatMap(port => port.definitions.map(definition => copy(definition))); },
    supports: name => owners.has(name),
    execute(name, args, exec) {
      invariant(owners.has(name), 'dsh_node_builtin_unbound');
      return owners.get(name).execute(name, args, exec);
    },
    close() {
      if (closing) return closing;
      for (const port of ports) port.close();
      output?.close();
      return closing = Promise.resolve(pinned.close());
    },
  };
}
