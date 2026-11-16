# Internal documentation archive

The **public documentation site** now lives in [`docs-site/`](../docs-site):

- Source: `docs-site/content/docs/` — Chinese `page.mdx` + English `page.en.mdx`
- Writing rules: [`docs-site/AUTHORING.md`](../docs-site/AUTHORING.md)
- Published site: <https://kingsoftcloud.github.io/agentkit-studio/docs/>
- English: <https://kingsoftcloud.github.io/agentkit-studio/en/docs/>

```sh
make docs-site-dev     # local dev server
make docs-site-check   # bilingual parity + link gate
make docs-site-build   # static export published by GitHub Pages
```

## What is left in this directory

| Path | Purpose |
| --- | --- |
| `index.html` | Hand-written landing / download page. Published verbatim at the site root by `docs-site/scripts/build-static.mjs`. |
| `*.md` | **Internal design archive** — refactor records, implementation notes, and release engineering evidence. Not published. Kept for traceability; prefer the public site for anything a user or integrator needs. |
| `assets/`, `brand/`, `contracts/`, `architecture/` | Assets and contracts referenced by the archive and by repository gates. |
| `refactor-client-budget.json` | Read by `scripts/verify-client-modules.mjs` as the browser bundle budget. |

## Why the archive is not the public site

The previous site rendered every Markdown file in this directory, which meant
internal refactor logs and release scripts were published as if they were user
documentation. The public site is now a purpose-built, bilingual, information-
architecture-first application; this directory keeps the historical record
without exposing it.
