# Public main protection baseline

Apply this baseline to the public `main` branch before accepting external changes:

- Require a pull request before merging.
- Require CI and Secret Pattern Audit status checks.
- Require branches to be up to date before merging.
- Disable force pushes and branch deletion.
- Require conversation resolution.
- Keep release and publication workflows limited to reviewed `main` commits.
