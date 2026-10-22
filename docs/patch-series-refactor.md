# Patch series refactor

The merged `dsh-v0.2.1-rc.2` maintenance source contains 41 active patches. Its
legacy IDs intentionally retain historical gaps (`004`, `006`, `008`, ... `048`)
because the IDs are embedded in `Studio-Patch` commit trailers and are bound to
the reviewed maintenance bundle, source descriptor, commit inventory, and patch
content hashes.

This branch adds a canonical contiguous `sequence` field (`1..41`) to
`manifest.json` and validates it with `scripts/check-patch-sequence.mjs`. The
legacy `id` and filename remain unchanged, so the maintenance bundle stays
cryptographically verifiable and can still be regenerated from the pinned DSH
source.

A future full renumbering must be a maintenance-source migration, not a file
rename. It must:

1. Export a new linear maintenance branch from the pinned DSH baseline.
2. Rewrite each `Studio-Patch` trailer and regenerate every patch diff.
3. Rebuild `maintenance.bundle`, `source.json`, and all SHA-256 inventories.
4. Update historical documentation and downstream references.
5. Run source, manifest, bundle, host, package, and update qualification gates.

Until that migration is complete, the canonical sequence is the safe way to
present patches in UI and release documentation while preserving rollback and
upstream-removal evidence.
