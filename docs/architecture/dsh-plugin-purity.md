# Studio DSH plugin boundary

AgentKit Studio is a generic DSH product plugin. It owns agent authoring,
resource binding, deployment controls and the generic DSH session bridge.
Product-specific panels, host gateways, runtime adapters and cloud computer
clients belong to their own plugin packages.

The boundary is intentionally small:

- Studio imports only public DSH/AgentEngine contracts and its own product code.
- A product plugin imports only public DSH contracts plus its own UI and runtime.
- Cross-plugin communication uses DSH registration, connection admission and
  versioned wire contracts; it does not use private service names or source
  imports from another product.
- Runtime images advertise opaque capability labels. Each plugin interprets the
  labels it owns after checking the DSH kernel compatibility.

The `check-dsh-plugin-purity.mjs` gate scans Studio source, tests, packaging and
scripts for product-specific imports, service names and package references.
