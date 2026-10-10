# Protected branch and forge parity contract

The internal forge `master` and GitHub `main` are protected refs. The internal
forge is the canonical merge authority; GitHub accepts external pull requests
but the approved change is imported into the internal merge request before it
becomes a canonical commit. A synchronization job then fast-forwards GitHub
to that exact commit. Neither job performs a force push.

Both forges run the same repository-owned gate:

```sh
make public-gate
```

The gate checks tracked paths and text, portability, source and product tests,
patch format, package contents, and `git diff --check`. The repository's
Gitleaks job adds entropy-aware secret detection. The internal CI entrypoint is
[`ci/ezone-public-gate.sh`](../ci/ezone-public-gate.sh); set
`RUN_REF_PARITY=1` only for the post-merge parity job.
The Ezone runner must install Gitleaks; the entrypoint fails closed when the
secret scanner is unavailable.

Parity is read-only and compares the exact commit IDs of the two protected
refs:

```sh
make ref-parity \
  PARITY_LEFT_REMOTE=ezone PARITY_LEFT_REF=refs/heads/master \
  PARITY_RIGHT_REMOTE=github PARITY_RIGHT_REF=refs/heads/main
```

If the refs diverge, synchronization stops. A one-time baseline reset may be
needed before enabling this contract when the two histories are already
different; that operation is outside this gate and requires a separate review.
