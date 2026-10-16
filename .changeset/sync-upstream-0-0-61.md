---
"@panaversity/ksor": patch
---

Bring in upstream `@panaversity/ksor` 0.0.61. `pnpm dev` now drops a document
that is deleted or moved while it runs, so its old url answers 404 and it leaves
the sidebar. npm and bun scaffolds hold `mdast-util-to-markdown` at 2.1.2
through root `overrides`, which upstream adopted in place of this fork's
earlier pin. The pnpm scaffold no longer carries the override, because its
committed lockfile already holds 2.1.2.
