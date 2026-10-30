import { join } from 'node:path';
import { nativeHarnessHostContract } from '../../build-engine.mjs';
/** Domain construction only; state belongs to this Host scope. */
export function createBuildServices({ storeDir: studioStoreDir, env = {} }) {
    const nativeEngineContract = nativeHarnessHostContract(env);
    const studioBuildPromise = Promise.all([
        import('../../studio-operations.mjs').then(({ createOperationManager }) => createOperationManager({ storeDir: join(studioStoreDir, 'operations') })),
        import('../../studio-build.mjs').then(({ createStudioBuild }) => createStudioBuild({ storeDir: studioStoreDir,
          nativeEngineContract })),
    ]).then(([operations, build]) => ({ operations, build }));
    return { studioBuildPromise };
}
