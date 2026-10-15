# Changed files and why

| File | Status | Purpose |
|---|---|---|
| `backup/original/Telecontinent_HR_Desk_ORIGINAL_UNCHANGED.html` | unchanged copy | The original HR Desk exactly as you uploaded it (2.6 MB, 22 forms, embedded libraries). |
| `secure-app/index.html` | generated | Built by `tools/build-secure-app.js`: the original file plus the 7 small patches listed below and 3 script blocks added at the end. No original function, form, view or letter was removed. |
| `secure-app-src/v2.js` | new | Workflow modules: Workflow dashboard, New request / upload and verification, My work, Pending approvals, Letters & vetting (maker–checker), Movement register, Letter library, Payroll handover (CSV, Excel, PDF), Reports, Administration. |
| `secure-app-src/v2letters.js` | new | The 30 movement letters (M1–M30) in the same template format as the original letters, so they use the original letterhead preview, print/PDF and Word output. |
| `worker.js` | new (replaces old) | Cloudflare Access JWT check on the server, roles, the original `/api/me`, `/api/data`, `/api/sync` and `/api/next` contract (now enforcing letter rules on the server), v2 workflow API, R2 documents, private signature, payroll, key dates, audit. |
| `seed.js` | new | Initial approval matrix (49 routes) and movement register (90 movement types), taken from your two documents. |
| `wrangler.jsonc` | replaced | Same Worker name and D1 id; adds the R2 bucket, the Access settings and a staging environment. |
| `wrangler.dev.jsonc` | new | Local development only (fictional accounts). Do not deploy. |
| `migrations/0001_hrdesk_v2_core.sql` | new | Additive tables only (`hrd_*`). Does not drop or alter `hr_cases`. |
| `tests/api.test.mjs` | new | Automated tests (fictional data). |
| `tools/gen-register.mjs`, `docs/MOVEMENT_REGISTER.md` | new | Source-document analysis register. |

## Patches to the original HTML (from `tools/build-secure-app.js`)
1. `const LH_SIG="data:image/png;base64,…"` (the signature image embedded in public HTML) **removed**. It is now `let LH_SIG=""`. The Worker supplies the image only for a released letter, and every use is logged.
2. The signature image is drawn only when one has been supplied (`img:!x.draft&&!!LH_SIG&&…`).
3. Word export uses a 1×1 blank image when there is no signature, so the .docx file is never corrupt.
4. Reprinting an issued letter from the original register fetches the signature from the server just before printing.
5. The original "Approve and issue" now asks the server whether you may vet the letter (specialist → Lead HR, Lead HR → HR Manager). The Worker also rejects the save on its own if the rule is broken.
6. `render()` now also includes the new views. The original nine views are unchanged.
7. A second navigation row was added; the original row is untouched. The page title was changed to "Telecontinent HR Desk".

## Defects found and fixed
- **Signature in public source** (security): fixed by patch 1.
- **Letter review rule** (the old browser check let any Lead HR or the HR Manager approve any letter): the server now enforces the specialist → Norwana, Norwana → Hairul rule and stamps the preparer and reviewer from the verified sign-in. A typed name is no longer trusted.
- **Issued records could be deleted from the shared database**: the server now refuses to delete issued letters and closed records.
- `rReg`: there is no function named `rReg` in the source you uploaded. The register renderer is `rLetterReg()`. I checked it: it escapes all values, returns one valid `<table>`, and its CSV export works. It was left unchanged.
- HTML titles containing `&`: form titles are escaped by `esc()` wherever they are inserted. The new views escape every value.
