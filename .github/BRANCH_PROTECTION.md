# Main branch protection

Recommended settings for `main`:

- Require pull requests and passing `public-gate` and Secret Pattern Audit checks.
- Require reviews for changes to credentials, workflows and runtime contracts.
- Disallow force pushes and branch deletion.
- Limit signing and publication credentials to the protected release environment.
- Run the optional mirror parity check after a reviewed update.

External contributions use the same tests and review process. Fork pull requests
must not receive signing, storage, model, or mirror credentials.
