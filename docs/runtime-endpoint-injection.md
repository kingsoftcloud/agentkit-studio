# Runtime endpoint injection

The public cloud client keeps the public KOP and IAM origins as its default
contract. Deployments that serve accounts restricted to the intranet inject
their internal origins into the trusted Node Host process:

- `AGENTENGINE_INNER_KOP_URL`
- `AGENTENGINE_INNER_IAM_URL`

These values are read only from the Host process environment. They are not
stored in the Studio configuration file, exposed in the browser form, or
accepted from renderer requests. The client signs requests onto an injected
origin only when the configured control-plane origin exactly matches it and
has no credentials, port, path, query, or fragment. A public KOP denial falls
back to the injected inner KOP only for the documented inner-account denial;
all other errors remain fail-closed.

Internal deployment manifests should provide both variables through the
private environment or secret-management layer. Public-only installations can
leave them unset; inner-account requests then fail with the existing bounded
cloud error instead of sending credentials to an unconfigured destination.
