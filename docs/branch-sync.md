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
