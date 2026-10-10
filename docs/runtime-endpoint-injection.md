# Runtime endpoint injection

The public cloud client keeps the public KOP and IAM origins as its normal
first attempt. When KOP/IAM returns the documented inner-account denial, the
client automatically falls back to the standard internal service origins:

- `http://aicp.inner.api.ksyun.com`
- `http://iam.inner.api.ksyun.com`

These hostnames are public service addresses, but the services are reachable
only from the internal network. Deployments with a different private routing
variant may override them in the trusted Node Host process:

- `AGENTENGINE_INNER_KOP_URL`
- `AGENTENGINE_INNER_IAM_URL`

The values are read only from the Host process environment. They are not
stored in the Studio configuration file, exposed in the browser form, or
accepted from renderer requests. The client signs requests onto an approved
origin only when the configured control-plane origin exactly matches it and
has no credentials, port, path, query, or fragment. A public KOP denial falls
back to the selected inner KOP only for the documented inner-account denial;
all other errors remain fail-closed.

The variables are optional. Standard installations can leave them unset and
use the built-in official defaults; no one-time environment setup is needed.
If a private deployment supplies an override, it must be a credential-free
origin without a port, path, query, or fragment. The browser and user
configuration cannot change this endpoint selection.
