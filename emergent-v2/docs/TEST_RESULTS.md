# Test results (run on 2026-10-15, local Worker runtime: wrangler dev / workerd with simulated D1 and R2, fictional data)

## Automated: `node --test tests/` — 10 passed, 0 failed
1. Health and authentication: outside domain blocked (403); unregistered company email blocked (403); role read from the server — PASS
2. Approval matrix seeded from the approval document; specialist cannot edit it — PASS
3. Case created with a unique reference; HR corrections to extracted values recorded in the audit; visible to a second HR user; stale edit rejected (409, concurrency) — PASS
4. Documents stored privately; requestor cannot read them; unsupported file type rejected (415) — PASS
5. Approval evidence enforced; stages cannot be skipped; employee cannot approve own movement; Payroll cannot record approvals; a rejected case cannot get a letter; recorded decisions cannot be overwritten — PASS
6. Management approver must be assigned to a step; then decides in-app with their own sign-in — PASS
7. Letters: no letter before approval; no release of a draft; preparer, another specialist, Payroll and (by default rule) the HR Manager cannot release a specialist's letter; Norwana returns it; amend → revised draft; approve; editing after approval cancels the approval; signature refused before release; Norwana releases (ref TC/HR/PRO/YYYY/NNN/initials); released letter locked; Payroll cannot get the signature; Payroll row pending → verify (Payroll only; process before verify refused); HR status not changed by Payroll; retroactive month detected; Norwana's own letter: Norwana refused, Hairul releases; withdrawal flags the payroll record "reversal required"; acknowledgement requires the signed copy; completion — PASS
8. Restricted (disciplinary) records hidden from admin and other specialists; requestor sees only own requests and none of the HR register — PASS
9. Original sync contract: server stamps the preparer email (spoofed value replaced); visible to a second user; letter-register rule enforced; issued letter cannot be deleted; collision-free running numbers — PASS
10. Delegation from Norwana lets the delegate release; revocation works — PASS

## Browser end-to-end (testing agent, preview URL)
PASS: original navigation (Dashboard, Records, Which form?, Form library with 22 forms, Key dates, Date tools, Data); workflow navigation; manual Promotion transaction with checks; 5-step approval with evidence enforcement; draft letter preview with DRAFT watermark and no signature; document upload; Payroll handover with CSV, Excel and Print buttons; Administration; restricted-record isolation.
Found and fixed: the requestor account saw HR navigation and a "cannot load" banner. Re-checked: the requestor now sees only New request, My work and Movement register.
Re-checked by me after the fix: Norwana Approve for release → Release in the UI produced `TC/HR/CNF/2026/012/AS`, with the typed signatory block (no signature uploaded).

## Not executed / not verifiable here
- Real Cloudflare Access JWT check (code is written; needs your TEAM_DOMAIN and AUD tag) — **verify on staging**.
- Real D1 and R2 on Cloudflare (tested only on the local simulators) — **verify on staging**.
- Extraction of filled-in real forms: the original readers (`readDocx`/`readPdf`) are reused unchanged. The new screen was tested with blank forms only, not with your completed sample forms.
- Downloaded PDF/DOCX opened in Word: the original generators are reused. A downloaded file was not opened in Microsoft Word during this test.
- Session expiry: handled by Cloudflare Access (the API returns 401 and the original page shows the sign-in-again message). Not simulated.

## Manual staging checks (do these with fictional employees)
1. Sign in as each role; confirm the navigation each one sees.
2. Upload one completed Word form and one exported PDF; check every field on the verification screen.
3. Take one Promotion through approval → letter → vetting → release → acknowledgement → Payroll verify/process.
4. Download the issued Word and PDF; check the letterhead and the signature.
5. Confirm records created in the original Records view are visible to a second HR user.
