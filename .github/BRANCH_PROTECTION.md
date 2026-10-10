# Public main protection baseline

Apply this baseline to the public `main` mirror before accepting external changes:

- External pull requests are intake only; do not merge them directly into `main`.
- Require the CI `public-gate` and Secret Pattern Audit checks on every intake PR.
- Permit only the sync bot to fast-forward `main` to the approved internal commit.
- Disable force pushes and branch deletion.
- Keep release and publication workflows limited to reviewed `main` commits.

Run Forge Ref Parity after every protected-branch update as a required
post-merge drift check. A mismatch blocks synchronization and raises an
incident; it is not a reason to force-push either branch.

The internal forge `master` must require a merge request and run
`ci/ezone-public-gate.sh`. The repository does not grant either forge
permission to force-push a protected branch.
