# Telecontinent HR Desk

Folder layout = GitHub repo root.

- `secure-app/index.html`: the complete app page (original HR Desk + workflow modules). Served by the Worker behind Cloudflare Access.
- `worker.js` + `seed.js`: the backend (API, roles, approvals, letters, payroll, documents, audit).
- `wrangler.jsonc`: production and staging configuration.
- `migrations/`: D1 SQL migrations (additive only).
- `secure-app-src/` + `tools/build-secure-app.js`: the source the page is built from. After you edit them, run `node tools/build-secure-app.js`.
- `backup/original/`: your original HTML, unchanged.
- `docs/`: DEPLOYMENT (incl. rollback), CHANGES, FEATURE_MATRIX, TEST_RESULTS, MOVEMENT_REGISTER, and your two source documents.
- `tests/`: automated tests.

`setup-only/index.html` and the root `index.html` from your existing repo are not included, because I did not receive them. Leave them as they are in GitHub, or delete the root `index.html` if it is a public copy of the standalone app.
