# Deployment — Telecontinent HR Desk (GitHub + Cloudflare Worker + D1 + R2)

Nothing here has been deployed to your Cloudflare account. These are the exact steps for you to follow.

## Cost: runs on Cloudflare's free plans (no Emergent server needed)
- Workers Free: 100,000 requests per day. D1 Free: 5 GB. R2 Free: 10 GB storage, 1 million uploads and 10 million reads per month, no egress fees (Cloudflare asks for a card to activate R2, but you are not charged within the free tier). Zero Trust / Access Free: up to 50 users. Only the HR Desk users count, not all 1,000 employees. GitHub: a free private repo.
- If you do not want to add a card for R2: delete the `r2_buckets` block in `wrangler.jsonc`. Everything still works except storing uploaded documents and the signature image (the app shows a clear message instead).

## 0. Before you start: backup
1. In GitHub, open `hrotelecontinent-jpg/telecontinent-hr-desk` → **Code → Download ZIP**. Keep it (this is your rollback copy).
2. Back up D1: `npx wrangler d1 export telecontinent-hr-desk-db --remote --output=backup-before-v2.sql`
3. Check the binding name in your current `wrangler.jsonc`. This package uses `"binding": "DB"`. If your old file uses a different name, change it in the new `wrangler.jsonc` to match.

## 1. Create the private document bucket (R2)
Cloudflare dashboard → **R2 → Create bucket** → name `telecontinent-hr-desk-docs`. Do **not** enable public access or a public custom domain.
(For staging, also create `telecontinent-hr-desk-docs-staging`.)

## 2. Fill in `wrangler.jsonc`
- `TEAM_DOMAIN`: Zero Trust → Settings → Custom pages: your team domain, for example `telecontinent.cloudflareaccess.com`
- `POLICY_AUD`: Zero Trust → Access → Applications → HR Desk → **Application Audience (AUD) Tag**
- `ADMIN_EMAILS`: your Gmail administrator address (comma-separated if more than one)
- `ALLOWED_DOMAIN`: `telecontinent.com.my`
Never deploy `wrangler.dev.jsonc`. It switches on the fictional test accounts.

## 3. Staging first
1. `npx wrangler d1 create telecontinent-hr-desk-db-staging` → paste the id into `env.staging` in `wrangler.jsonc`.
2. In Access, add an application for `telecontinent-hr-desk-staging.<your-subdomain>.workers.dev` (Email OTP policy, same as production) → copy its AUD into `env.staging.vars.POLICY_AUD`.
3. `npx wrangler d1 migrations apply telecontinent-hr-desk-db-staging --remote --env staging`
4. `npx wrangler deploy --env staging`
5. Sign in with your Gmail admin account → **Administration → Users** → add Hairul (manager), Norwana (lead), the HR Specialists, Payroll, requestors and approvers with their @telecontinent.com.my emails.
6. Run through the checklist in `docs/TEST_RESULTS.md` (section "Manual staging checks") using fictional employees.

## 4. Production
1. Upload the ZIP contents to the GitHub repo root. Keep the folder structure. `backup/` and `docs/` can stay; they contain no employee data.
2. Apply the migration. It is additive: it only creates `hrd_*` tables and never touches `hr_cases`:
   `npx wrangler d1 migrations apply telecontinent-hr-desk-db --remote`
3. If Cloudflare Workers Builds is connected to GitHub, the push deploys automatically. Otherwise run `npx wrangler deploy`.
4. Open `https://telecontinent-hr-desk.hrotelecontinent.workers.dev/api/health`. Expected: `"db":true,"r2":true`. `legacyCompatible:true` means your existing `hr_cases` rows are used as they are. If it shows `false`, send me the output of `npx wrangler d1 execute telecontinent-hr-desk-db --remote --command "PRAGMA table_info(hr_cases)"` and I will map the columns. Your data is not changed either way.
5. Administration → Signature: upload Hairul's signature as a PNG. It is stored privately in R2.

## 5. Old Cloudflare Pages project
Pages → old HR Desk project → **Settings → Delete project**. If you need to keep it, put it behind an Access application. A Pages copy of the standalone HTML has no Access check on its own.

## 6. Rollback
- Code: in GitHub, revert to the previous commit (or re-upload the ZIP from step 0), then let it redeploy or run `npx wrangler deploy`. To roll back without code: Workers → telecontinent-hr-desk → **Deployments → Rollback** to the previous version.
- Data: the old app only uses `hr_cases`, which v2 never alters, so it keeps working after a rollback. The new `hrd_*` tables can stay. To restore D1 completely: `npx wrangler d1 time-travel restore telecontinent-hr-desk-db --timestamp=<before deploy>`.

## 7. Local development (optional)
`npm i -D wrangler` → `npx wrangler d1 migrations apply hrdesk-dev --local -c wrangler.dev.jsonc` → `node tools/build-secure-app.js` → `npx wrangler dev -c wrangler.dev.jsonc` → open http://127.0.0.1:8787. Use the orange TEST switcher to change accounts. Run the tests with `BASE=http://127.0.0.1:8787 node --test tests/`.

## Backup and recovery routine
- Weekly: `npx wrangler d1 export telecontinent-hr-desk-db --remote --output=hrdesk-YYYY-MM-DD.sql`. Store it in company storage, not GitHub.
- D1 Time Travel keeps point-in-time restore for 30 days.
- R2 documents: turn on bucket lifecycle and versioning as your retention policy requires. The default retention set in HR Desk is 7 years (Administration → Settings).
