# Repository mirrors

GitHub `main` is the reviewed release source. A secondary forge can mirror the
same commit after checks pass; the mirror does not maintain a separate product
variant. Synchronization uses normal fast-forward pushes.

Both pipelines run `make public-gate`. The optional mirror adapter is
`ci/ezone-public-gate.sh`; its remote URL and authentication come from CI secrets,
not source files. Run the read-only parity check after synchronization:

```sh
make ref-parity \
  PARITY_LEFT_REMOTE=mirror PARITY_LEFT_REF=refs/heads/main \
  PARITY_RIGHT_REMOTE=upstream PARITY_RIGHT_REF=refs/heads/main
```

Configure ref names to match the destination forge. A mismatch blocks release
synchronization; resolve it through review without forcing a branch update.

The Ezone worker bootstraps its pinned offline tools from the dedicated
`codex/studio-ci-tool-cache-v1` branch on that forge. Its separate cache tree holds
verified Gitleaks, Node.js/runtime-library and pnpm archives, not a product source
branch, and is not mirrored to GitHub. The adapter explicitly fetches that ref
when a clean clone lacks its pinned blobs and checks archive SHA-256 values before
execution. Keep this active CI input when deleting obsolete development branches;
retire it only after a replacement worker image/cache passes a clean-clone gate.
