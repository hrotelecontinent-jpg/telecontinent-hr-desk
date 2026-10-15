# Telecontinent HR Desk v2 review application

This directory is the **v2 application root**, imported alongside the unchanged production application one level above. Start with [PREPARATION_STATUS.md](docs/PREPARATION_STATUS.md) for current results and remaining staging requirements; the parent [integration review](../V2_INTEGRATION_REVIEW.md) describes the import boundaries.

```sh
npm ci
npm run build
npm run db:local
npm run dev
# In another terminal in this directory:
npm test
npm run test:migration
```

Tests target local simulators and fictional accounts only. Never deploy `wrangler.dev.jsonc`. Run `npm run check:worker` for a bundle dry-run without deployment. See the status document for browser testing and offline migration tooling.

- `secure-app/` is the generated page; edit `secure-app-src/` and rebuild.
- `worker.js`, `seed.js`, `migrations/` implement the backend and workflow catalog.
- `backup/original/` is the original source with its embedded signature withheld from Git. Despite the upstream filename, it is sanitized. The exact actual image is preserved securely outside Git for private R2 migration; no image transformation was performed.
- `docs/` includes supplier policy and deployment documents. Supplier instructions are historical reference, not authorization to change production.

All 22 original form definitions and added workflow modules are retained. Existing production files remain unchanged; do not merge or deploy until staging validation and the documented release prerequisites are complete.
