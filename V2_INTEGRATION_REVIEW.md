# Emergent v2 integration review

This branch imports `Telecontinent_HR_Desk_v2.zip` into `emergent-v2/`, with that directory as the v2 application root. Every file that existed on `main` is preserved byte-for-byte. The production entrypoint and Wrangler configuration remain unchanged. No deployment, remote migration, production database query, or signature upload was performed.

## Layout and changes

The complete archive file inventory and source/import SHA-256 hashes are in `emergent-v2/docs/IMPORT_MANIFEST.json`. All 21 archive files are represented. The supplied backup HTML contained an embedded signature image: that embedded copy is withheld from the imported backup and preserved byte-for-byte in protected local migration storage outside Git. Despite its upstream `ORIGINAL_UNCHANGED` filename, this review copy is sanitized. The uploaded ZIP remains outside the checkout and is not committed. The served v2 page has no embedded signature. The actual image is preserved at `/workspace/private-hrdesk-migration/authorized-signature.png` (directory 0700, file 0600), with private SHA-256/dimension metadata. No re-encoding, resizing or quality change was performed. `tools/preserve-signature.py` can reproduce this extraction from the uploaded archive without exposing or uploading the image. Never commit the PNG or private integrity metadata.

The v2 app includes Worker/seed code, its HTML and workflow source, migration, build tools, tests, source policy documents and upstream documentation. Added a private npm manifest and lockfile pinning Wrangler 4.151.0. Fixed the Node 24 test invocation, restricted fixture-writing API tests to local development, and made authentication fail closed on static pages. JWT checks now require RS256, issuer, expiry, audience, valid time claims, a valid signature and exactly three token segments. Production API authentication precedes seeding and health checks. Unexpected errors no longer return internal exception details to the client. Fixed an asset canonical-redirect loop. Automatic final filing now obtains and retains the signature through asynchronous DOCX generation; final print/download is blocked if private signature storage is unavailable instead of silently substituting a typed name. Draft output remains unsigned.

## Local development

Requires Node 22.17+ (verified with Node 24.19.0). From the repository root:

```sh
cd emergent-v2
npm ci
npm run build
npm run db:local
npm run dev
```

In a second shell in `emergent-v2/`, run `npm test`. It requires the local server on port 8787. Tests use only fictional accounts and local D1/R2 storage. `npm run check:worker` bundles using `--dry-run`; it does not deploy. Never deploy `wrangler.dev.jsonc`, which enables fictional authentication. For restricted cloud home directories, set `npm_config_cache=/tmp/hrdesk-npm-cache` and `XDG_CONFIG_HOME=/tmp/hrdesk-config`; keep TLS and artifact integrity verification enabled.

## Validation performed on 2026-10-15

- Safe ZIP traversal/symlink checks and complete 21-file import inventory.
- All original files on main remain unchanged; only review files added.
- Repeatable HTML build; all JavaScript source files and inline scripts pass syntax checks.
- Both imported HTML copies retain form IDs 1–22. Workflow navigation/source covers dashboard, requests, work queue, approvals, letters/vetting, movement register, letter library, payroll, reports and administration.
- Local D1 migration: 24 SQL commands successful; second application reports no pending migrations.
- API and security suite: **14 passed, 0 failed, 0 skipped** (10 supplied plus 4 added). Covers roles, CRUD/concurrency, approvals, maker/checker, document privacy, restricted transactions, delegation, JWT claims/signatures, and denied/error static-page requests, exact-byte private signature retrieval only after release, and no unsigned final-output fallback.
- Cloudflare Worker dry-run bundle passes; npm audit reports 0 known vulnerabilities, including development dependencies.
- Local functional HTML and bootstrap requests checked separately. Literal page asset references are embedded data or generated API document links; no missing static file dependency was identified. Dynamic browser paths, downloads, layout, document extraction and real Access sessions still need browser/staging checks.
- Initial `node --test tests/` failed under Node 24; corrected to the explicit test-file glob. Initial npm/Wrangler log writes encountered an unavailable home directory; subsequent commands used writable cache/config paths. Neither remains a failing application check.

The upstream `docs/TEST_RESULTS.md` contains the supplier's claims. They are historical, not evidence of checks performed in this review. No real employee records or signature files were used for validation.

## Required deployment work — do not deploy this branch as-is

1. **Data compatibility blocker:** current `main/worker.js` uses `hrdesk_objects` and `hrdesk_sequences`. V2 detects `hr_cases` or creates a new empty table. Its additive migration does not import the current records or reference counters. The frontend/API contracts also differ (`GET /api/sync`, `/api/object`, `/api/next-ref` versus v2 `/api/data`, `POST /api/sync`, `/api/next`). A separate reviewed adapter/migration with synthetic round-trip and rollback tests is needed before any production cutover. Existing data is preserved but would not automatically appear in v2. Do not use the upstream claim that `hr_cases` compatibility proves compatibility with this repository.
2. **Cloudflare Access:** fill team domain, per-application AUD and real administrator allowlist. Configure Access on every hostname, including workers.dev/preview routes, and test real signed sessions, expiry, revocation and each role on staging. Never enable DEV_AUTH outside local development. The default and staging v2 configs still contain placeholders.
3. **D1:** provision an isolated staging database and replace its placeholder ID. Review the additive `hrd_*` migration and the Worker's runtime creation/seeding behavior. No remote resources were queried or changed. The production ID included in the supplied configuration is retained only as source configuration, not validated or used.
4. **R2:** provision isolated private staging document storage; verify DOCS binding and access/retention/backup policy. No public bucket/custom domain. Migrate the already preserved actual signature securely only after the role/security review; do not ask the signatory to recreate it. Use the Administration signature upload with the preserved file, or a separately authorized private R2 object upload to `private/signature/current` with `image/png` content type. Validate its SHA-256 and dimensions against the private metadata. Do not include the PNG in Git, public assets, PR attachments or logs. Verify account limits and supported retention/backup features in current Cloudflare documentation; do not rely on the supplier's pricing/versioning assertions.
5. **Security review still required:** the supplied `/api/v2/audit` allows admin to see audit payloads that may include restricted transaction data; pending-approval listing is broader than transaction-level visibility for HR specialists; key-date mutation does not apply transaction visibility; aggregate reports may include restricted categories. Delegation scope/active-user checks and legacy-record permissions need review. Uploaded file checks rely on extension/client MIME, and final documents are client generated. Request-size limits, CSRF/origin controls and spreadsheet formula injection protections need hardening. The passing supplied isolation tests do not cover these paths. Treat these as release blockers for sensitive HR use.
6. **Functional acceptance:** browser-test all 22 form downloads, filled Word/PDF extraction, letter output in Word/PDF, all role navigation, approval routes and payroll policy with fictional data. Letter wording and approval policy require HR/legal sign-off.
7. **Release mechanics:** explicitly select `emergent-v2/` as the application root only for a separately authorized staging deployment. The root production application remains active and unchanged. Review connected build triggers before pushing/merging any deployment configuration. Do not merge or run the supplier's production instructions as part of this review.

`emergent-v2/docs/DEPLOYMENT.md` is imported supplier documentation, not authorization to export/restore production, delete Pages projects, run remote migrations or deploy. Follow this review's release gates first.

## Signature migration and release routing

The requested signature is preserved, not discarded. Local API tests use a synthetic 1×1 PNG, never Hairul’s real image. The production application and its existing signature remain unchanged. V2 final print, Word download and automatic final document filing retrieve the exact image from private R2 only for released/acknowledged letters. No image resizing or encoding change was introduced; original letter layout is retained. Configure Norwana’s real account as Lead HR and Hairul’s real account as HR Manager; Specialists → Lead HR and Lead HR → HR Manager are tested, including refusal of self-release. Ensure no unintended accounts receive those roles and review delegation policy before staging. The image is not yet uploaded to any Cloudflare account.
