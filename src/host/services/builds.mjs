import { join } from 'node:path';
/** Domain construction only; state belongs to this Host scope. */
export function createBuildServices({ storeDir: studioStoreDir }) {
    const studioBuildPromise = Promise.all([
        import('../../studio-operations.mjs').then(({ createOperationManager }) => createOperationManager({ storeDir: join(studioStoreDir, 'operations') })),
        import('../../studio-build.mjs').then(({ createStudioBuild }) => createStudioBuild({ storeDir: studioStoreDir })),
    ]).then(([operations, build]) => ({ operations, build }));
    return { studioBuildPromise };
}
