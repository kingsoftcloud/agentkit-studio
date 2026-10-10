# Public main protection baseline

Apply this baseline to the public `main` branch before accepting external changes:

- Require a pull request before merging.
- Require the CI `public-gate` and Secret Pattern Audit status checks.
- Require branches to be up to date before merging.
- Disable force pushes and branch deletion.
- Require conversation resolution.
- Keep release and publication workflows limited to reviewed `main` commits.

Run Forge Ref Parity after every protected-branch update as a required
post-merge drift check. A mismatch blocks synchronization and raises an
incident; it is not a reason to force-push either branch.

The internal forge `master` must apply the same rules through its merge-request
configuration and run `ci/ezone-public-gate.sh`. The repository does not grant
either forge permission to force-push a protected branch.
