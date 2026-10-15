# Public source and release checks

This repository contains product source, tests, compatibility patches, examples
and public documentation. Keep team plans, private deployment records, customer
data, personal profiles and installation evidence outside the repository.

`make public-gate` checks the working tree, reachable history, secret patterns,
source tests, compatibility patch format and npm package contents. Before changing
repository visibility, also inspect every remote branch and tag with
`node scripts/public-history-audit.mjs --all-refs` and scan all refs with Gitleaks.
Removing a file from `main` does not remove earlier versions from Git history.
Historical documents and contributor instructions receive the same private-material
checks as current files. A passing credential scan alone does not establish that
release plans, private deployment records or personal paths are safe to publish.

The cloud client includes documented public service addresses and optional
network-specific endpoints. Addresses are configuration, not authentication;
credentials are resolved only by the trusted Host and are never shipped in npm
packages, installers, browser storage or Git history.

A source check does not qualify an installer. Release candidates require signature
verification, actual installation and startup, runtime execution, file delivery,
and update/restart checks. Publish immutable assets first and the online feed only
after candidate qualification succeeds. Failed candidates are not advertised.
