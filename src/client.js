/*
 * AgentKit Studio browser entrypoint.
 *
 * The DSH browser bundle is assembled from the ordered fragments in
 * `src/client-fragments/` by `scripts/build-client.mjs`. Keeping this entry
 * small makes the source-size gate meaningful while preserving one DSH
 * ModuleLoader registration in the packed artifact.
 */
