# Examples

Studio is installed as a DSH bundle. Its committed `cordis.patch.yml` is the
reference composition; install the package with the official DSH plugin manager
rather than copying Host source or creating a separate Session implementation.

The independent Harness package's [README](../packages/agentkit-harness/README.md)
contains its exports, peer dependencies and real Host verification commands.
For a complete local Studio environment follow [Getting started](../docs/getting-started.md).

Use placeholder credentials in examples. Resolve actual credentials from Host
configuration; never put them in a shared Agent bundle or browser component.

Inspect the runtime contract without network access or credentials:

```sh
node examples/runtime-contract.mjs
```

The command prints the supported runtimes and validates a complete frozen run
identity. These sample IDs describe the contract; they do not create an Agent or Session.
