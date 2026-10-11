# Protected branch and forge parity contract

The internal forge `master` and GitHub `main` are protected refs. The internal
forge is the canonical merge authority; GitHub accepts external pull requests
as intake only. The approved change is imported into the internal merge request before it
becomes a canonical commit. A synchronization job then fast-forwards GitHub
to that exact commit. Neither job performs a force push.

The production mirror is `kingsoftcloud/agentkit-studio`, represented locally
by `upstream/main`. `AgentArcLab/agentkit-studio` (`github/main`) is a
development fork and is not the production parity target. The parity workflow
runs only in the production mirror repository.

Both forges run the same repository-owned gate:

```sh
make public-gate
```

The gate checks tracked paths and text, portability, source and product tests,
patch format, package contents, and `git diff --check`. The repository's
Gitleaks job adds entropy-aware secret detection. The internal CI entrypoint is
[`ci/ezone-public-gate.sh`](../ci/ezone-public-gate.sh); set
`RUN_REF_PARITY=1` only for the post-merge parity job.
GitHub Actions downloads and verifies the pinned Gitleaks `8.30.1` binary
through [`ci/install-gitleaks.sh`](../ci/install-gitleaks.sh). Ezone workers
must provide that version in the worker image or through `GITLEAKS_BIN`, since
their entrypoint does not depend on external GitHub release downloads; it
fails closed when the scanner is unavailable.

Parity is read-only and compares the exact commit IDs of the two protected
refs:

```sh
make ref-parity \
  PARITY_LEFT_REMOTE=ezone PARITY_LEFT_REF=refs/heads/master \
  PARITY_RIGHT_REMOTE=upstream PARITY_RIGHT_REF=refs/heads/main
```

If the refs diverge, synchronization stops. A one-time baseline reset may be
needed before enabling this contract when the two histories are already
different; that operation is outside this gate and requires a separate review.
