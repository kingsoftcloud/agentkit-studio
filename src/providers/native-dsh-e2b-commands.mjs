/** Studio composition of the E2B lifecycle, durable command store and ledger
 * ToolPort. Production supervisors import the installed SDK adapter by URL;
 * the explicit loadSdk seam keeps deterministic tests in this process. */
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { canonical, copy, invariant, scopeKey } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { E2BCommandStore, createE2BBackgroundReader } from '../../packages/agentkit-harness/src/native/e2b-background.mjs';
import { createNativeE2BCommandTools } from '../../packages/agentkit-harness/src/native/e2b-command-tools.mjs';
import { createOwnedCommandResolver } from '../../packages/agentkit-harness/src/native/owned-command.mjs';
import { createNativeToolAuthority } from './native-tool-authority.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const transportModule = new URL('./native-e2b-sdk-transport.mjs', import.meta.url).href;

export async function createNativeDshE2BCommands({ prepared, workspaceRoot, stateDir,
  scope, sessionId, store: ledger, artifacts, isClosed, inProcessTransport = false }) {
  scopeKey(scope);
  const fixedScope = copy(scope), workspace = realpathSync(workspaceRoot);
  invariant(prepared?.binding?.backend === 'e2b' && typeof prepared.forSession === 'function'
    && typeof isClosed === 'function', 'studio_native_e2b_binding_required');
  const assertOpen = () => invariant(!isClosed() && realpathSync(workspaceRoot) === workspace, 'studio_native_e2b_owner_closed');
  assertOpen();
  const lexical = resolve(stateDir);
  invariant(lexical !== workspace && !lexical.startsWith(workspace + sep), 'background_state_inside_workspace');
  // Canonicalize the trusted Host path (including macOS /var aliases), then
  // let both durable backends enforce private directories and no symlinks.
  mkdirSync(lexical, { recursive: true, mode: 0o700 });
  const root = realpathSync(lexical);
  invariant(root !== workspace && !root.startsWith(workspace + sep), 'background_state_inside_workspace');
  const scopeRoot = join(root, 'e2b-commands', hash(fixedScope));
  mkdirSync(scopeRoot, { recursive: true, mode: 0o700 });
  const assertAuthority = createNativeToolAuthority({ scope: fixedScope, sessionId, store: ledger, isClosed });
  const host = await prepared.forSession({ scope: fixedScope, sessionId, workspaceRoot: workspace,
    stateRoot: join(scopeRoot, 'owners'), assertAuthority });
  assertOpen();
  // A changed endpoint, credential or template must also reject read/stop.
  // Moving it into a different directory would accidentally allocate a fresh
  // sandbox for the same Session instead of exposing the changed binding.
  host.owner.inspect();
  const transport = inProcessTransport ? await host.createTransport() : null;
  assertOpen();
  let commandStore;
  const storeFactory = input => {
    assertOpen();
    invariant(canonical(input.scope) === canonical(fixedScope) && input.sessionId === sessionId,
      'studio_native_e2b_store_owner_mismatch');
    const owner = host.owner.inspect();
    invariant(owner?.sandboxId, 'studio_native_e2b_sandbox_unavailable');
    if (input.sandboxId !== undefined) invariant(owner?.phase === 'ready' && owner.sandboxId === input.sandboxId,
      'studio_native_e2b_sandbox_unproven');
    if (!commandStore) commandStore = new E2BCommandStore({
      stateRoot: join(scopeRoot, 'background'), workspaceRoot: workspace, sessionId,
      transportModule, transportConfig: host.transportOptions(), ...(transport ? { transport } : {}),
      sandboxId: owner?.sandboxId ?? null, launchAuthorized: false,
      authority: frozen => {
        assertOpen();
        const current = host.owner.inspect();
        return current?.phase === 'ready' && current.sandboxId === frozen.sandboxId;
      },
    });
    return commandStore;
  };
  const tools = createNativeE2BCommandTools({ scope: fixedScope, sessionId, owner: host.owner, storeFactory,
    artifacts, authorize: async () => 'allow', assertAuthority,
    resolveOwnedCommand: createOwnedCommandResolver({ scope: fixedScope, store: ledger }),
    allowInternetAccess: prepared.binding.allowInternetAccess, foregroundTimeoutSeconds: prepared.binding.timeoutSeconds,
    backgroundTimeoutSeconds: prepared.binding.timeoutSeconds });
  return Object.freeze({ definitions: tools.definitions, execute: tools.execute,
    reader: request => {
      assertOpen();
      invariant(canonical(request.scope) === canonical(fixedScope) && request.sessionId === sessionId,
        'studio_native_e2b_reader_owner_mismatch');
      const result = createE2BBackgroundReader(storeFactory({ scope: fixedScope, sessionId }))(request);
      // The reader is synchronous except for its public Promise boundary. The
      // surrounding BackgroundCommandPort seals the complete canonical probe.
      return result.then(output => { assertOpen(); return output; });
    } });
}
