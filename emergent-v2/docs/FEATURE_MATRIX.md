# Feature coverage matrix

Legend: **Implemented & tested** (automated or browser test) · **Implemented, not fully tested** · **Partial** · **Not implemented** · **Needs external** (your Cloudflare setup) · **Needs policy** (Management confirmation)

| Module | Status | Notes |
|---|---|---|
| Original 22 forms, Dashboard, Records, Manager view, Payroll report, Which form?, Form library, Key dates, Date tools, Data | Implemented & tested (render) | Original code kept unchanged except the 7 patches in CHANGES.md |
| Original upload received form (Word/PDF) | Implemented, not fully tested | Original readers unchanged; tested with blank forms only |
| Scans / photos → clear message | Implemented & tested | Asks for the Word file or an electronic PDF; no OCR, as you chose |
| Upload → verification screen (missing / conflict / uncertain, HR correction, original kept) | Implemented & tested | Extracted and corrected values both kept in the audit trail |
| Cloudflare Access JWT verification on the server | Implemented, needs external | Needs TEAM_DOMAIN and AUD; verify on staging |
| Roles: admin, HR Manager, Lead HR, Specialist, Payroll, Requestor, Approver | Implemented & tested | Managed in Administration |
| Restricted (disciplinary/medical) records | Implemented & tested | Visible to Lead HR, HR Manager, owner and originator only |
| Approval matrix (49 routes) from your document, editable | Implemented & tested | Every route is a recommended control; **needs policy** until a Delegation of Authority is approved |
| Approval workflow (8 stages, conditional reviews, evidence, order, no self-approval, returned/rejected) | Implemented & tested | |
| Delegation with history | Implemented & tested | Scope: letter vetting |
| Letter maker–checker (specialist → Norwana, Norwana → Hairul) | Implemented & tested | Rules editable in Administration |
| Letter versions, reviewer comments, re-vetting after edit, supersede/reissue | Implemented & tested | |
| Original 29 letters + M1–M30 | Implemented, not fully tested | All templates appear in the Letter library; wording **needs HR/legal review** before use |
| Final PDF / DOCX | Partial | DOCX is generated in the browser. PDF comes from the browser's "Save as PDF" print. The issued HTML and DOCX are filed in R2 automatically |
| Signature: private R2, only on released letters, logged | Implemented & tested (API) | Needs external: upload the PNG on staging |
| Payroll handover (filters, statuses, verify/process, reversal, retro, cut-offs, CSV/Excel/PDF) | Implemented & tested | |
| Payroll cycles by project | Implemented, not fully tested | Rule: day > cut-off goes to the next month; **needs policy** for accounts with special cycles |
| Key dates generated automatically from transactions | Implemented & tested | Shown on Key dates and the dashboard |
| Movement register / cases / document registry / audit trail | Implemented & tested | |
| Reports & analytics | Implemented, not fully tested | Movements by month/category/status; letter turnaround |
| Concurrency protection and collision-free references | Implemented & tested | |
| Original shared data (`hr_cases`) compatibility | Implemented, needs external | Columns are detected automatically. If they differ, the data is read but not changed, and I need your `PRAGMA` output to map it |
| Email/notification to approvers | Not implemented | Not requested; approvers see their items under Pending approvals |
| Employee self-service acknowledgement | Not implemented | HR records the acknowledgement and uploads the signed copy |
| Contract-specific notice periods | Partial | Stored per transaction (`notice_period`); no automatic entitlement calculation (this avoids hard-coding legal assumptions) |
