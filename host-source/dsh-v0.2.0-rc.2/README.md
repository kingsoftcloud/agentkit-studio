# DSH maintenance source

`maintenance.bundle` is a standard Git bundle containing the Studio maintenance
commits after the public upstream baseline. It is the editable source of the
generated patches, not an application binary. The upstream prerequisite is
`639ed015397290b3745d163aafe02ffee4aa3f84` from
<https://github.com/deepseek-ai/deepseek-harness>.

The bundle preserves the original commit identities and `Studio-Patch` trailers.
Its branch, head, tree and SHA-256 are pinned by
[`source.json`](../../patches/dsh-v0.2.0-rc.2/source.json); the patch manifest binds
that descriptor by SHA-256. The bundle contains no upstream history before the
prerequisite. Upstream code retains its [MIT license](LICENSE).

Restore the branch into a new checkout, edit its commits, then export with the
commands in [the maintenance guide](../../docs/refactor-patches.md). Git commands
operate on the maintenance checkout; application builds still apply the generated
patches to a clean fixed upstream checkout. This directory is repository-only and
is excluded from the Studio npm package's `files` allowlist.
