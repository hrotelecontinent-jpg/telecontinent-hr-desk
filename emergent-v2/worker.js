// TELECONTINENT HR DESK — Cloudflare Worker backend (D1 + R2 + Cloudflare Access)
// Every /api route requires a verified identity. Production: Cloudflare Access JWT (Cf-Access-Jwt-Assertion), verified here.
// Development only (ENVIRONMENT=development and DEV_AUTH=1): fictional test accounts via the x-dev-user header / devuser cookie.
import { MATRIX, MOVEMENTS, CATEGORIES, DEV_USERS } from "./seed.js";

const HR_ROLES = ["manager", "lead", "specialist"];
const SIGNATORY = { name: "Hairul Izwan Mokhti", title: "Manager, Human Resource and Admin" };
const DEFAULT_VETTING = { specialist: ["lead"], lead: ["manager"], manager: ["lead"] };
const now = () => new Date().toISOString();
const uid = (p) => p + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });
const E = (msg, s = 400, extra = {}) => J({ error: msg, ...extra }, s);
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
class HttpError extends Error { constructor(m, s, x) { super(m); this.status = s; this.extra = x || {}; } }
const fail = (m, s = 400, x) => { throw new HttpError(m, s, x); };

// ---------- authentication ----------
let JWKS = null, JWKS_AT = 0;
const b64uDec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function verifyAccessJwt(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sg] = parts;
  if (!h || !p || !sg) return null;
  const head = JSON.parse(new TextDecoder().decode(b64uDec(h)));
  if (head.alg !== "RS256") return null;
  const pay = JSON.parse(new TextDecoder().decode(b64uDec(p)));
  const team = String(env.TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!JWKS || Date.now() - JWKS_AT > 3600e3) { JWKS = (await (await fetch("https://" + team + "/cdn-cgi/access/certs")).json()).keys; JWKS_AT = Date.now(); }
  const jwk = JWKS.find((k) => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uDec(sg), new TextEncoder().encode(h + "." + p));
  if (!ok) return null;
  const aud = Array.isArray(pay.aud) ? pay.aud : [pay.aud];
  if (!aud.includes(env.POLICY_AUD)) return null;
  if (!Number.isFinite(pay.exp) || pay.exp * 1000 <= Date.now()) return null;
  if (pay.nbf != null && (!Number.isFinite(pay.nbf) || pay.nbf * 1000 > Date.now())) return null;
  if (pay.iss !== "https://" + team) return null;
  return pay.email ? String(pay.email).toLowerCase() : null;
}
const devMode = (env) => env.ENVIRONMENT === "development" && env.DEV_AUTH === "1";
function cookie(req, name) { const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")); return m ? decodeURIComponent(m[1]) : null; }

async function identify(req, env) {
  let email = null;
  if (devMode(env)) email = (req.headers.get("x-dev-user") || cookie(req, "devuser") || DEV_USERS[3][0]).toLowerCase();
  else {
    if (!env.TEAM_DOMAIN || !env.POLICY_AUD) fail("setup", 500);
    const tok = req.headers.get("cf-access-jwt-assertion") || cookie(req, "CF_Authorization");
    if (tok) { try { email = await verifyAccessJwt(tok, env); } catch (e) { email = null; } }
  }
  if (!email) fail("Not signed in. Open HR Desk again and sign in with your company email.", 401);
  const admins = String(env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const dom = String(env.ALLOWED_DOMAIN || "telecontinent.com.my").toLowerCase();
  if (!email.endsWith("@" + dom) && !admins.includes(email)) fail("This email is not allowed to use HR Desk.", 403);
  let u = await env.DB.prepare("SELECT * FROM hrd_users WHERE email=?").bind(email).first();
  if (!u) {
    const legacyRole = [["HR_MANAGER_EMAILS", "manager"], ["LEAD_EMAILS", "lead"], ["SPECIALIST_EMAILS", "specialist"], ["PAYROLL_EMAILS", "payroll"]]
      .find(([k]) => String(env[k] || "").toLowerCase().split(",").map((s) => s.trim()).includes(email));
    if (admins.includes(email)) u = { email, name: email, role: "admin", active: 1 };
    else if (legacyRole) u = { email, name: email, role: legacyRole[1], active: 1 };
  }
  if (!u || !u.active) fail("Your account is not registered in HR Desk. Ask the System Administrator to add you.", 403);
  return u;
}

// ---------- helpers ----------
async function audit(env, actor, action, entity, entityId, ref, oldV, newV, remarks, docVersion) {
  await env.DB.prepare("INSERT INTO hrd_audit (at,actor,action,entity,entity_id,ref,old_value,new_value,remarks,doc_version) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(now(), actor, action, entity, entityId || null, ref || null, oldV == null ? null : JSON.stringify(oldV), newV == null ? null : JSON.stringify(newV), remarks || null, docVersion || null).run();
}
async function nextNo(env, k) {
  await env.DB.prepare("INSERT OR IGNORE INTO hrd_counters (k,n) VALUES (?,0)").bind(k).run();
  const r = await env.DB.prepare("UPDATE hrd_counters SET n=n+1 WHERE k=? RETURNING n").bind(k).first();
  return r.n;
}
async function getConfig(env, key, dflt) { const r = await env.DB.prepare("SELECT value FROM hrd_config WHERE key=?").bind(key).first(); return r ? parse(r.value, dflt) : dflt; }
let SEEDED = false;
async function ensureSeed(env) {
  if (SEEDED) return;
  const c = await env.DB.prepare("SELECT COUNT(*) n FROM hrd_matrix").first();
  if (!c.n) {
    const st = MATRIX.map((m) => env.DB.prepare("INSERT OR IGNORE INTO hrd_matrix (matrix_key,movement,initiating_record,recommender,reviewers,final_approver,employee_response,level,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], "seed", now()));
    await env.DB.batch(st);
  }
  const mt = await env.DB.prepare("SELECT COUNT(*) n FROM hrd_movement_types").first();
  if (!mt.n) await env.DB.batch(MOVEMENTS.map((m) => env.DB.prepare("INSERT OR IGNORE INTO hrd_movement_types (code,category,name,matrix_key,form_id,letter_code,payroll_impact,sensitivity,acceptance) VALUES (?,?,?,?,?,?,?,?,?)").bind(...m)));
  if (devMode(env)) await env.DB.batch(DEV_USERS.map((u) => env.DB.prepare("INSERT OR IGNORE INTO hrd_users (email,name,role,active,created_at,updated_at) VALUES (?,?,?,1,?,?)").bind(u[0], u[1], u[2], now(), now())));
  SEEDED = true;
}
const isHR = (u) => HR_ROLES.includes(u.role);
const need = (cond, msg = "You do not have permission for this action.") => { if (!cond) fail(msg, 403); };
async function activeDelegators(env, email) {
  const t = now().slice(0, 10);
  const r = await env.DB.prepare("SELECT d.from_email, u.role FROM hrd_delegations d JOIN hrd_users u ON u.email=d.from_email WHERE d.to_email=? AND d.revoked_at IS NULL AND d.start_date<=? AND d.end_date>=?").bind(email, t, t).all();
  return r.results;
}
// Who may vet/release a letter prepared by `prep`: rule by preparer role; delegation from a reviewer allowed. Never the preparer.
async function canVet(env, u, prepEmail, prepRole) {
  if (u.email === prepEmail) return { ok: false, why: "You prepared this letter. You cannot vet or release your own letter." };
  const rules = await getConfig(env, "vetting_rules", DEFAULT_VETTING);
  const allowed = rules[prepRole] || ["lead", "manager"];
  if (allowed.includes(u.role)) return { ok: true, as: u.role };
  const dl = (await activeDelegators(env, u.email)).find((d) => allowed.includes(d.role) && d.from_email !== prepEmail);
  if (dl) return { ok: true, as: dl.role, delegatedFrom: dl.from_email };
  const label = allowed.map((r) => (r === "lead" ? "Lead HR Operations (Norwana Adnan)" : r === "manager" ? "HR Manager (Hairul Izwan Mokhti)" : r)).join(" or ");
  return { ok: false, why: "A letter prepared by a " + prepRole + " must be vetted by " + label + "." };
}
function canSeeTxn(u, t, approvals) {
  if (u.role === "requestor") return t.originator === u.email;
  if (u.role === "approver") return (approvals || []).some((a) => a.approver_email === u.email) || t.originator === u.email;
  if (u.role === "payroll") return false;
  if (u.role === "admin") return t.sensitivity !== "restricted";
  if (t.sensitivity === "restricted") return ["manager", "lead"].includes(u.role) || t.owner === u.email || t.originator === u.email;
  return isHR(u);
}
const CONDITIONAL_RE = /\b(if|where|required|applicable|needed|relevant|for extension|funded)\b/i;
function buildSteps(m) {
  const steps = [{ stage: "Operational Recommendation", role_label: m.recommender || "Manager / HOD", conditional: 0 }];
  String(m.reviewers || "").split(";").map((s) => s.trim()).filter((s) => s && !/^HR$/i.test(s) && !/^HR (review|validation)$/i.test(s))
    .forEach((r) => steps.push({ stage: "Specialist Review", role_label: r, conditional: CONDITIONAL_RE.test(r) ? 1 : 0 }));
  steps.push({ stage: "Final Approval", role_label: m.final_approver || "Designated authority", conditional: 0 });
  return steps;
}
function ymOf(d) { return String(d || "").slice(0, 7); }
function addMonth(ym, n) { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); }
async function payrollMonth(env, project, effective, releasedAt) {
  const cyc = project ? await env.DB.prepare("SELECT cutoff_day FROM hrd_payroll_cycles WHERE project=?").bind(project).first() : null;
  const cutoff = cyc ? cyc.cutoff_day : await getConfig(env, "default_cutoff_day", 20);
  const eff = effective || releasedAt.slice(0, 10);
  let pm = Number(eff.slice(8, 10)) > cutoff ? addMonth(ymOf(eff), 1) : ymOf(eff);
  const rel = releasedAt.slice(0, 10);
  const relPm = Number(rel.slice(8, 10)) > cutoff ? addMonth(ymOf(rel), 1) : ymOf(rel);
  let treatment = "Within cut-off (day " + cutoff + ")";
  if (relPm > pm) { treatment = "Released after cut-off of effective month; processed in later cycle"; pm = relPm; }
  else if (Number(eff.slice(8, 10)) > cutoff) treatment = "Effective after cut-off (day " + cutoff + "); next cycle";
  return { pm, treatment, retro: pm > ymOf(eff) ? 1 : 0 };
}
const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : n; };
const KD_FIELDS = [["probation_end", "Probation expiry"], ["contract_end", "Fixed-term contract expiry"], ["acting_end", "Acting appointment expiry"], ["assignment_end", "Temporary assignment / secondment end"], ["fwa_review", "FWA review date"], ["lwd", "Resignation / exit last working day"], ["early_release", "Early-release date"], ["retirement_date", "Retirement date"], ["return_date", "Approved return-to-work date"], ["end_date", "End of approved period"]];
async function makeKeyDates(env, t, extra) {
  const d = parse(t.data, {});
  const rows = KD_FIELDS.filter(([k]) => d[k]).map(([k, label]) => [k, label, d[k]]);
  if (t.effective_date) rows.push(["effective", "Payroll-effective date", t.effective_date]);
  (extra || []).forEach((x) => rows.push(x));
  if (!rows.length) return;
  await env.DB.batch(rows.map(([k, label, due]) => env.DB.prepare("INSERT INTO hrd_keydates (id,txn_id,kind,due_date,emp_name,note,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(txn_id,kind) DO UPDATE SET due_date=excluded.due_date, note=excluded.note")
    .bind(uid("kd"), t.id, k, String(due).slice(0, 10), t.emp_name, label + " — " + t.ref, now())));
}
async function loadTxn(env, id) { const t = await env.DB.prepare("SELECT * FROM hrd_transactions WHERE id=?").bind(id).first(); if (!t) fail("Transaction not found", 404); return t; }
async function txnApprovals(env, id) { return (await env.DB.prepare("SELECT * FROM hrd_approvals WHERE txn_id=? ORDER BY step_no").bind(id).all()).results; }
async function bumpTxn(env, t, fields, actor, action, remarks) {
  const keys = Object.keys(fields);
  const r = await env.DB.prepare("UPDATE hrd_transactions SET " + keys.map((k) => k + "=?").join(",") + ", ver=ver+1, updated_at=? WHERE id=? AND ver=?")
    .bind(...keys.map((k) => fields[k]), now(), t.id, t.ver).run();
  if (!r.meta.changes) fail("Another user changed this transaction. Reload and try again.", 409);
  await audit(env, actor, action, "transaction", t.id, t.ref, Object.fromEntries(keys.map((k) => [k, t[k]])), fields, remarks);
}

// ---------- legacy (original HR Desk) shared-database API: /api/me, /api/data, /api/sync, /api/next ----------
let LEG = null;
async function legacy(env) {
  if (LEG) return LEG;
  const cols = (await env.DB.prepare("PRAGMA table_info(hr_cases)").all()).results.map((c) => c.name);
  if (!cols.length) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS hr_cases (t TEXT NOT NULL, id TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 1, rev INTEGER NOT NULL DEFAULT 0, data TEXT, deleted INTEGER NOT NULL DEFAULT 0, by_email TEXT, updated_at TEXT, PRIMARY KEY (t,id))").run();
    return (LEG = { table: "hr_cases", t: "t", id: "id", ver: "ver", rev: "rev", data: "data", del: "deleted", by: "by_email", at: "updated_at", compatible: true });
  }
  const pick = (...c) => c.find((x) => cols.includes(x)) || null;
  const m = { table: "hr_cases", t: pick("t", "type", "kind"), id: pick("id", "rid", "key"), ver: pick("ver", "version"), rev: pick("rev", "revision", "seq"), data: pick("data", "json", "body", "payload"), del: pick("deleted", "del", "is_deleted"), by: pick("by_email", "by", "updated_by", "email", "user_email"), at: pick("updated_at", "updated", "ts", "at") };
  m.compatible = !!(m.t && m.id && m.ver && m.data);
  if (!m.compatible) Object.assign(m, { table: "hrd_legacy", t: "t", id: "id", ver: "ver", rev: "rev", data: "data", del: "deleted", by: "by_email", at: "updated_at", originalColumns: cols });
  return (LEG = m);
}
function legacyRole(u) { return ["manager", "lead", "payroll"].includes(u.role) ? u.role : "specialist"; }
async function legacyRow(env, L, t, id) { return env.DB.prepare(`SELECT * FROM ${L.table} WHERE ${L.t}=? AND ${L.id}=?`).bind(t, id).first(); }
const legOut = (L, r) => ({ t: r[L.t], id: r[L.id], ver: r[L.ver], data: parse(r[L.data]), deleted: L.del ? !!r[L.del] : false, by: L.by ? r[L.by] : null });
async function legacySync(env, u, body) {
  need(isHR(u) || u.role === "payroll" || u.role === "admin", "Your role cannot change HR Desk records.");
  const L = await legacy(env);
  const ok = [], conflict = [], notes = [];
  const userRole = async (email) => { const r = email ? await env.DB.prepare("SELECT role FROM hrd_users WHERE email=?").bind(email).first() : null; return r ? r.role : "specialist"; };
  const rev = L.rev ? await nextNo(env, "legacy_rev") : 0;
  for (const p of body.put || []) {
    if (!["case", "kd", "letter"].includes(p.t) || !p.id || typeof p.data !== "object") continue;
    const cur = await legacyRow(env, L, p.t, p.id);
    const curOut = cur ? legOut(L, cur) : null;
    if ((cur ? cur[L.ver] : 0) !== (p.ver || 0)) { conflict.push(curOut || { t: p.t, id: p.id, deleted: true }); continue; }
    const data = p.data, old = curOut ? curOut.data : null;
    let reject = null;
    if (u.role === "payroll" && p.t !== "case") reject = "Payroll cannot change key dates or the letter register.";
    if (p.t === "letter") {
      if (old && JSON.stringify(old) !== JSON.stringify(data)) reject = "An issued letter record cannot be changed.";
      if (!old) {
        const cs = (body.put || []).find((x) => x.t === "case" && x.id === data.caseId);
        const caseData = cs ? cs.data : parse((await legacyRow(env, L, "case", data.caseId) || {})[L.data], {});
        const prepEm = caseData && caseData.draft ? caseData.draft.em : "";
        const v = await canVet(env, u, prepEm, await userRole(prepEm));
        if (!v.ok) reject = v.why;
        else { data.rev = u.name || u.email; data.revEm = u.email; }
      }
    }
    if (p.t === "case" && data.draft) {
      const od = old && old.draft ? old.draft : {};
      if (data.draft.status === "review" && od.status !== "review") data.draft.em = u.email;
      if (["approved", "returned"].includes(data.draft.status) && od.status !== data.draft.status) {
        if (!(u.role === "manager" || u.role === "lead" || (await activeDelegators(env, u.email)).length)) reject = "Only Lead HR or the HR Manager can review a letter.";
        else { const v = await canVet(env, u, od.em || data.draft.em, await userRole(od.em || data.draft.em)); if (!v.ok) reject = v.why; }
        if (!reject) { data.draft.rb = u.name || u.email; data.draft.rbEm = u.email; }
      }
    }
    if (reject) { notes.push(reject); conflict.push(curOut || { t: p.t, id: p.id, deleted: true }); continue; }
    const ver = (cur ? cur[L.ver] : 0) + 1;
    const cols = [L.t, L.id, L.ver, L.data], vals = [p.t, p.id, ver, JSON.stringify(data)];
    if (L.rev) { cols.push(L.rev); vals.push(rev); } if (L.del) { cols.push(L.del); vals.push(0); } if (L.by) { cols.push(L.by); vals.push(u.email); } if (L.at) { cols.push(L.at); vals.push(now()); }
    await env.DB.prepare(`INSERT OR REPLACE INTO ${L.table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...vals).run();
    await audit(env, u.email, cur ? "legacy.update" : "legacy.create", "legacy_" + p.t, p.id, data.ref || null, null, null, null, ver);
    ok.push({ t: p.t, id: p.id, ver, data });
  }
  for (const d of body.del || []) {
    const cur = await legacyRow(env, L, d.t, d.id);
    if (!cur) { ok.push({ t: d.t, id: d.id, deleted: true }); continue; }
    const data = parse(cur[L.data], {});
    const issued = d.t === "letter" || (d.t === "case" && (data.status === "closed" || (data.draft && data.draft.status === "approved")));
    if (issued || cur[L.ver] !== d.ver) { if (issued) notes.push("A finalised or issued record cannot be deleted."); conflict.push(legOut(L, cur)); continue; }
    if (L.del) await env.DB.prepare(`UPDATE ${L.table} SET ${L.del}=1, ${L.ver}=${L.ver}+1${L.rev ? `, ${L.rev}=${rev}` : ""} WHERE ${L.t}=? AND ${L.id}=?`).bind(d.t, d.id).run();
    else await env.DB.prepare(`DELETE FROM ${L.table} WHERE ${L.t}=? AND ${L.id}=?`).bind(d.t, d.id).run();
    await audit(env, u.email, "legacy.delete", "legacy_" + d.t, d.id, data.ref || null, data, null);
    ok.push({ t: d.t, id: d.id, deleted: true });
  }
  return { ok, conflict, notes, rev };
}
async function legacyData(env, u, since) {
  if (!(isHR(u) || u.role === "payroll" || u.role === "admin")) return { rows: [], rev: 0 };
  const L = await legacy(env);
  const q = L.rev ? `SELECT * FROM ${L.table} WHERE ${L.rev}>?` : `SELECT * FROM ${L.table}`;
  const rows = (await (L.rev ? env.DB.prepare(q).bind(since) : env.DB.prepare(q)).all()).results;
  const rev = L.rev ? ((await env.DB.prepare(`SELECT MAX(${L.rev}) m FROM ${L.table}`).first()).m || 0) : 0;
  return { rows: rows.map((r) => legOut(L, r)).filter((r) => since > 0 || !r.deleted), rev };
}

// ---------- v2 workflow API ----------
async function txnFull(env, u, id) {
  const t = await loadTxn(env, id);
  const approvals = await txnApprovals(env, id);
  need(canSeeTxn(u, t, approvals), "This record is restricted.");
  const letters = (await env.DB.prepare("SELECT * FROM hrd_letters WHERE txn_id=? ORDER BY created_at").bind(id).all()).results;
  for (const l of letters) {
    l.versions = (await env.DB.prepare("SELECT * FROM hrd_letter_versions WHERE letter_id=? ORDER BY version").bind(l.id).all()).results.map((v) => ({ ...v, vals: parse(v.vals, {}) }));
    l.events = (await env.DB.prepare("SELECT * FROM hrd_letter_events WHERE letter_id=? ORDER BY at").bind(l.id).all()).results;
  }
  const docs = (await env.DB.prepare("SELECT id,kind,filename,mime,size,sha256,version,uploaded_by,uploaded_at FROM hrd_documents WHERE txn_id=? ORDER BY uploaded_at").bind(id).all()).results;
  const payroll = await env.DB.prepare("SELECT * FROM hrd_payroll WHERE txn_id=?").bind(id).first();
  const keydates = (await env.DB.prepare("SELECT * FROM hrd_keydates WHERE txn_id=? ORDER BY due_date").bind(id).all()).results;
  const auditRows = (await env.DB.prepare("SELECT * FROM hrd_audit WHERE entity_id=? OR entity_id IN (SELECT id FROM hrd_letters WHERE txn_id=?) OR entity_id IN (SELECT id FROM hrd_approvals WHERE txn_id=?) ORDER BY id DESC LIMIT 300").bind(id, id, id).all()).results;
  return { txn: { ...t, data: parse(t.data, {}), extracted: parse(t.extracted, {}), matrix_snapshot: parse(t.matrix_snapshot, {}) }, approvals, letters, docs, payroll, keydates, audit: auditRows };
}
const REQUIRED = ["emp_name", "effective_date"];
async function createTxn(env, u, b) {
  need(isHR(u) || u.role === "requestor", "Only HR or an authorised requestor can open a transaction.");
  const mt = await env.DB.prepare("SELECT * FROM hrd_movement_types WHERE code=?").bind(b.movement_code).first();
  if (!mt) fail("Choose a valid movement type.");
  const data = b.data || {};
  if (!String(data.emp_name || "").trim()) fail("Employee name is required.");
  const m = await env.DB.prepare("SELECT * FROM hrd_matrix WHERE matrix_key=?").bind(mt.matrix_key).first();
  const y = new Date().getFullYear();
  const ref = "HRD-" + y + "-" + String(await nextNo(env, "txn" + y)).padStart(5, "0");
  const id = uid("tx");
  const status = u.role === "requestor" ? "submitted" : "draft";
  await env.DB.prepare("INSERT INTO hrd_transactions (id,ref,movement_code,status,emp_id,emp_name,project,new_project,dept,data,extracted,matrix_snapshot,legacy_case_id,originator,owner,sensitivity,effective_date,outstanding,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, ref, mt.code, status, data.emp_id || null, data.emp_name.trim(), data.cur_project || null, data.new_project || null, data.cur_dept || null, JSON.stringify(data), b.extracted ? JSON.stringify(b.extracted) : null, JSON.stringify(m), b.legacy_case_id || null, u.email, isHR(u) ? u.email : null, mt.sensitivity, data.effective_date || null, "HR validation", now(), now()).run();
  const steps = buildSteps(m);
  await env.DB.batch(steps.map((s, i) => env.DB.prepare("INSERT INTO hrd_approvals (id,txn_id,step_no,stage,role_label,conditional) VALUES (?,?,?,?,?,?)").bind(uid("ap"), id, i + 1, s.stage, s.role_label, s.conditional)));
  if (b.source_doc_id) await env.DB.prepare("UPDATE hrd_documents SET txn_id=? WHERE id=? AND txn_id IS NULL AND uploaded_by=?").bind(id, b.source_doc_id, u.email).run();
  await audit(env, u.email, "txn.create", "transaction", id, ref, null, { movement: mt.code, data }, b.extracted ? "Created from uploaded form; original extracted values kept" : "Created");
  if (b.extracted) {
    const diffs = Object.keys(data).filter((k) => String(b.extracted[k] ?? "") !== String(data[k] ?? "")).map((k) => ({ field: k, extracted: b.extracted[k] ?? null, confirmed: data[k] }));
    if (diffs.length) await audit(env, u.email, "txn.extraction_corrected", "transaction", id, ref, null, diffs, diffs.length + " field(s) corrected by HR before saving");
  }
  return { id, ref };
}
async function updateTxn(env, u, id, b) {
  const t = await loadTxn(env, id);
  need(isHR(u) || (u.role === "requestor" && t.originator === u.email && t.status === "submitted"));
  need(canSeeTxn(u, t, []), "This record is restricted.");
  if (!["draft", "submitted", "hr_validation", "returned"].includes(t.status)) fail("This transaction is " + t.status + ". Confirmed data is locked after approval. Withdraw and open a new transaction to change it.", 409);
  if (b.ver !== t.ver) fail("Another user changed this transaction. Reload and try again.", 409);
  const data = b.data || {};
  if (!String(data.emp_name || "").trim()) fail("Employee name is required.");
  await bumpTxn(env, t, { data: JSON.stringify(data), emp_id: data.emp_id || null, emp_name: data.emp_name.trim(), project: data.cur_project || null, new_project: data.new_project || null, dept: data.cur_dept || null, effective_date: data.effective_date || null }, u.email, "txn.update", b.note || "Data corrected");
  return { ok: true };
}
async function txnAction(env, u, id, b) {
  const t = await loadTxn(env, id);
  const ap = await txnApprovals(env, id);
  need(canSeeTxn(u, t, ap), "This record is restricted.");
  if (b.ver !== t.ver) fail("Another user changed this transaction. Reload and try again.", 409);
  const a = b.action, data = parse(t.data, {});
  if (a === "validate") {
    need(isHR(u), "Only HR can complete HR validation.");
    if (!["draft", "submitted", "hr_validation", "returned"].includes(t.status)) fail("HR validation is not open for this transaction.", 409);
    const miss = REQUIRED.filter((k) => !String(data[k] || "").trim());
    if (miss.length) fail("Missing required information: " + miss.join(", "), 422);
    const docs = await env.DB.prepare("SELECT COUNT(*) n FROM hrd_documents WHERE txn_id=? AND kind IN ('original_form','supporting')").bind(id).first();
    if (!docs.n && !b.no_source_reason) fail("Attach the original form or a supporting document, or record why none exists.", 422);
    const ret = ap.filter((x) => x.decision === "Returned");
    if (ret.length) await env.DB.batch(ret.map((x) => env.DB.prepare("UPDATE hrd_approvals SET decision='Pending', remarks=COALESCE(remarks,'')||' [resubmitted]' WHERE id=?").bind(x.id)));
    await bumpTxn(env, t, { status: "in_approval", hr_validated_by: u.email, hr_validated_at: now(), owner: t.owner || u.email, outstanding: "Approvals" }, u.email, "txn.hr_validated", JSON.stringify({ checklist: b.checklist || [], remarks: b.remarks || "", no_source_reason: b.no_source_reason || null }));
    return { ok: true };
  }
  if (a === "withdraw") {
    need(isHR(u) || t.originator === u.email);
    if (["withdrawn", "closed"].includes(t.status)) fail("Already " + t.status, 409);
    if (!String(b.remarks || "").trim()) fail("Give the reason for withdrawal.", 422);
    await bumpTxn(env, t, { status: "withdrawn", outstanding: "None" }, u.email, "txn.withdrawn", b.remarks);
    const p = await env.DB.prepare("SELECT * FROM hrd_payroll WHERE txn_id=?").bind(id).first();
    if (p) { await env.DB.prepare("UPDATE hrd_payroll SET status='reversal_required', remarks=COALESCE(remarks,'')||? , ver=ver+1, updated_at=? WHERE id=?").bind(" | Movement withdrawn " + now().slice(0, 10) + ": " + b.remarks, now(), p.id).run(); await audit(env, u.email, "payroll.reversal_flagged", "payroll", p.id, t.ref, { status: p.status }, { status: "reversal_required" }, b.remarks); }
    await env.DB.prepare("UPDATE hrd_letters SET status='superseded_withdrawn', ver=ver+1, updated_at=? WHERE txn_id=? AND status NOT IN ('released','acknowledged')").bind(now(), id).run();
    return { ok: true };
  }
  if (a === "complete") {
    need(isHR(u), "Only HR can complete implementation.");
    const L = (await env.DB.prepare("SELECT * FROM hrd_letters WHERE txn_id=? AND status IN ('released','acknowledged')").bind(id).all()).results;
    const mt = await env.DB.prepare("SELECT * FROM hrd_movement_types WHERE code=?").bind(t.movement_code).first();
    if (t.status !== "approved" && t.status !== "letter_released" && t.status !== "acknowledged") fail("Only an approved transaction can be completed.", 409);
    if (mt.letter_code && !L.length) fail("Release the employee letter before completing.", 409);
    if (L.some((l) => l.status !== "acknowledged") && !b.ack_waived_reason) fail("Employee acknowledgement / acceptance is outstanding.", 409);
    if (!Array.isArray(b.checklist) || !b.checklist.length) fail("Confirm the implementation checklist (iPayroll, MyESS, roster, access, filing).", 422);
    await bumpTxn(env, t, { status: "completed", outstanding: "None" }, u.email, "txn.completed", JSON.stringify({ checklist: b.checklist, ack_waived_reason: b.ack_waived_reason || null }));
    return { ok: true };
  }
  if (a === "assign") { need(["manager", "lead"].includes(u.role)); await bumpTxn(env, t, { owner: String(b.owner || "").toLowerCase() }, u.email, "txn.assigned", b.remarks); return { ok: true }; }
  fail("Unknown action");
}
async function decide(env, u, id, aid, b) {
  const t = await loadTxn(env, id);
  const ap = await txnApprovals(env, id);
  const step = ap.find((x) => x.id === aid);
  if (!step) fail("Approval step not found", 404);
  need(canSeeTxn(u, t, ap), "This record is restricted.");
  if (t.status !== "in_approval") fail("Approvals can only be recorded after HR validation and before a final decision (status now: " + t.status + ").", 409);
  if (step.decision !== "Pending") fail("This step already has a recorded decision (" + step.decision + "). Recorded decisions cannot be overwritten.", 409);
  const earlier = ap.filter((x) => x.step_no < step.step_no && !["Approved", "Not required"].includes(x.decision));
  if (earlier.length) fail("Complete the earlier stages first: " + earlier.map((x) => x.stage + " — " + x.role_label).join("; "), 409);
  const d = b.decision;
  if (d === "Not required") {
    need(isHR(u), "Only HR can mark a review as not required.");
    if (!step.conditional) fail("This review is mandatory for this movement under the approval matrix.", 409);
    if (!String(b.remarks || "").trim()) fail("Give the reason this review is not required.", 422);
    await env.DB.prepare("UPDATE hrd_approvals SET decision='Not required', remarks=?, recorded_by=?, recorded_at=? WHERE id=? AND decision='Pending'").bind(b.remarks, u.email, now(), aid).run();
    await audit(env, u.email, "approval.not_required", "approval", aid, t.ref, { decision: "Pending" }, { decision: "Not required" }, b.remarks);
    return { ok: true };
  }
  if (!["Approved", "Rejected", "Returned for Clarification"].includes(d)) fail("Choose Approved, Rejected or Returned for Clarification.");
  let name = String(b.approver_name || "").trim(), email = String(b.approver_email || "").toLowerCase().trim(), delegatedFrom = null;
  const inApp = u.role === "approver";
  if (inApp && step.approver_email !== u.email) fail("This approval step is not assigned to you.", 403);
  if (inApp) { name = u.name; email = u.email; }
  else need(isHR(u), "Only HR can record an approval decision received outside HR Desk, or the approver must decide in HR Desk.");
  if (!name) fail("Name the actual approver.", 422);
  if (!inApp && d === "Approved" && !b.evidence_doc_id) fail("Attach the approval evidence (signed form page or approval email) before recording an approval.", 422);
  if (b.evidence_doc_id) { const ev = await env.DB.prepare("SELECT id FROM hrd_documents WHERE id=? AND txn_id=?").bind(b.evidence_doc_id, id).first(); if (!ev) fail("Evidence document not found on this transaction.", 422); }
  if (norm(name) === norm(t.emp_name)) fail("The employee cannot approve their own movement.", 409);
  if (email && email === t.originator && step.stage === "Final Approval") fail("The person who initiated this transaction cannot give the final approval.", 409);
  if (email && email === u.email && !inApp) fail("You cannot record your own approval. The approver must decide in HR Desk, or another HR user must record it.", 409);
  if (inApp && email === t.originator) fail("You initiated this transaction; you cannot approve it.", 409);
  if (b.delegated_from) delegatedFrom = String(b.delegated_from).toLowerCase();
  const dRes = d === "Returned for Clarification" ? "Returned" : d;
  if ((dRes === "Rejected" || dRes === "Returned") && !String(b.remarks || "").trim()) fail("Remarks are required for a rejection or return.", 422);
  const decidedAt = b.decided_at || now();
  const r = await env.DB.prepare("UPDATE hrd_approvals SET decision=?, approver_name=?, approver_email=?, decided_at=?, remarks=?, evidence_doc_id=?, delegated_from=?, recorded_by=?, recorded_at=? WHERE id=? AND decision='Pending'")
    .bind(dRes, name, email || null, decidedAt, b.remarks || null, b.evidence_doc_id || null, delegatedFrom, u.email, now(), aid).run();
  if (!r.meta.changes) fail("This step was decided by someone else. Reload.", 409);
  await audit(env, u.email, "approval." + dRes.toLowerCase(), "approval", aid, t.ref, { decision: "Pending" }, { decision: dRes, approver: name, email, decidedAt, evidence: b.evidence_doc_id || (inApp ? "in-app decision" : null), delegatedFrom }, b.remarks);
  const t2 = await loadTxn(env, id);
  if (dRes === "Rejected") await bumpTxn(env, t2, { status: "rejected", outstanding: "None (rejected)" }, u.email, "txn.rejected", step.stage + ": " + b.remarks);
  else if (dRes === "Returned") await bumpTxn(env, t2, { status: "returned", outstanding: "Clarification for " + step.role_label }, u.email, "txn.returned", b.remarks);
  else if (step.stage === "Final Approval") {
    await bumpTxn(env, t2, { status: "approved", approved_at: decidedAt, outstanding: "Letter preparation" }, u.email, "txn.approved", "Final approval by " + name);
    await makeKeyDates(env, await loadTxn(env, id));
  }
  return { ok: true };
}

// ---------- documents (private R2) ----------
const ALLOWED_MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", msg: "application/vnd.ms-outlook", eml: "message/rfc822", html: "text/html", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
const DOC_KINDS = ["original_form", "approval_evidence", "supporting", "letter_draft", "final_letter", "acknowledgement", "payroll_confirmation"];
async function putDoc(env, u, txnId, kind, filename, bytes, mime) {
  if (!env.DOCS) fail("Document storage (R2 binding DOCS) is not configured.", 500);
  if (!DOC_KINDS.includes(kind)) fail("Unknown document type.");
  const ext = String(filename).split(".").pop().toLowerCase();
  if (!ALLOWED_MIME[ext]) fail("This file type is not accepted. Use Word (.docx), PDF, PNG/JPG, email (.msg/.eml) or Excel.", 415);
  if (bytes.byteLength > 15 * 1024 * 1024) fail("File is larger than 15 MB.", 413);
  if (txnId) { const t = await loadTxn(env, txnId); need(canSeeTxn(u, t, await txnApprovals(env, txnId)), "This record is restricted."); }
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const id = uid("doc");
  const prev = txnId ? await env.DB.prepare("SELECT MAX(version) v FROM hrd_documents WHERE txn_id=? AND filename=? AND kind=?").bind(txnId, filename, kind).first() : null;
  const key = "hrdesk/" + (txnId || "unlinked") + "/" + id + "-" + filename.replace(/[^A-Za-z0-9._-]/g, "_");
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: mime || ALLOWED_MIME[ext] }, customMetadata: { uploadedBy: u.email, sha256: sha } });
  const keepYears = await getConfig(env, "retention_years", 7);
  const until = new Date(Date.now() + keepYears * 365.25 * 864e5).toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO hrd_documents (id,txn_id,kind,filename,mime,size,sha256,r2_key,version,uploaded_by,uploaded_at,retention_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, txnId || null, kind, filename, mime || ALLOWED_MIME[ext], bytes.byteLength, sha, key, ((prev && prev.v) || 0) + 1, u.email, now(), until).run();
  await audit(env, u.email, "document.upload", "document", txnId || id, null, null, { id, kind, filename, sha256: sha }, null, ((prev && prev.v) || 0) + 1);
  return { id, sha256: sha };
}
async function getDoc(env, u, id) {
  const d = await env.DB.prepare("SELECT * FROM hrd_documents WHERE id=?").bind(id).first();
  if (!d) fail("Document not found", 404);
  if (d.txn_id) { const t = await loadTxn(env, d.txn_id); need(canSeeTxn(u, t, await txnApprovals(env, d.txn_id)) || (u.role === "payroll" && ["final_letter", "payroll_confirmation"].includes(d.kind)), "This document is restricted."); }
  else need(d.uploaded_by === u.email, "This document is restricted.");
  const o = await env.DOCS.get(d.r2_key);
  if (!o) fail("File missing from storage", 404);
  await audit(env, u.email, "document.download", "document", d.txn_id || id, null, null, { id, filename: d.filename });
  return new Response(o.body, { headers: { "content-type": d.mime || "application/octet-stream", "content-disposition": 'attachment; filename="' + d.filename.replace(/"/g, "") + '"', "cache-control": "no-store, private" } });
}

// ---------- letters ----------
async function letterRow(env, id) { const l = await env.DB.prepare("SELECT * FROM hrd_letters WHERE id=?").bind(id).first(); if (!l) fail("Letter not found", 404); return l; }
async function lEvent(env, l, u, action, comment, version) { await env.DB.prepare("INSERT INTO hrd_letter_events (id,letter_id,action,by_email,at,version,comment) VALUES (?,?,?,?,?,?,?)").bind(uid("le"), l.id, action, u.email, now(), version || l.current_version, comment || null).run(); await audit(env, u.email, "letter." + action, "letter", l.id, l.ref || null, null, { status: l.status, version: version || l.current_version }, comment, version || l.current_version); }
async function createLetter(env, u, txnId, b) {
  need(isHR(u), "Only HR can prepare letters.");
  const t = await loadTxn(env, txnId);
  need(canSeeTxn(u, t, []), "This record is restricted.");
  if (!["approved", "letter_released", "acknowledged"].includes(t.status)) fail("A letter can only be prepared after the movement has final approval. Current status: " + t.status + ".", 409);
  if (!b.template_code) fail("Choose a letter template.");
  const open = await env.DB.prepare("SELECT id FROM hrd_letters WHERE txn_id=? AND template_code=? AND status NOT IN ('released','acknowledged','superseded_withdrawn')").bind(txnId, b.template_code).first();
  if (open) fail("A draft of this letter already exists for this transaction.", 409);
  const sig = await getConfig(env, "signatory", SIGNATORY);
  const id = uid("lt");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO hrd_letters (id,txn_id,template_code,status,preparer_email,preparer_role,signatory_name,signatory_title,current_version,supersedes_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)").bind(id, txnId, b.template_code, "draft", u.email, u.role, sig.name, sig.title, b.supersedes_id || null, now(), now()),
    env.DB.prepare("INSERT INTO hrd_letter_versions (letter_id,version,vals,edited_by,edited_at,note) VALUES (?,?,?,?,?,?)").bind(id, 1, JSON.stringify(b.vals || {}), u.email, now(), "Draft generated from confirmed transaction data")
  ]);
  await lEvent(env, { id, ref: null, status: "draft", current_version: 1 }, u, "created", b.supersedes_id ? "Correction / reissue of " + b.supersedes_id : null, 1);
  return { id };
}
async function editLetter(env, u, id, b) {
  const l = await letterRow(env, id);
  need(isHR(u), "Only HR can edit letters.");
  if (b.ver !== l.ver) fail("Another user changed this letter. Reload and try again.", 409);
  if (["released", "acknowledged", "superseded_withdrawn"].includes(l.status)) fail("A released letter is locked. Use Correct / reissue to supersede it.", 409);
  if (l.status === "pending_vetting" && u.email === l.preparer_email) fail("The letter is with the reviewer. Wait for it to be returned before editing.", 409);
  const v = l.current_version + 1;
  const status = l.status === "approved_for_release" || l.status === "returned" || l.status === "revised_draft" ? "revised_draft" : l.status === "pending_vetting" ? "pending_vetting" : "draft";
  const invalidated = l.status === "approved_for_release";
  const r = await env.DB.prepare("UPDATE hrd_letters SET current_version=?, status=?, approved_version=CASE WHEN ? THEN NULL ELSE approved_version END, ver=ver+1, updated_at=? WHERE id=? AND ver=?").bind(v, status, invalidated ? 1 : 0, now(), id, l.ver).run();
  if (!r.meta.changes) fail("Another user changed this letter. Reload.", 409);
  await env.DB.prepare("INSERT INTO hrd_letter_versions (letter_id,version,vals,edited_by,edited_at,note) VALUES (?,?,?,?,?,?)").bind(id, v, JSON.stringify(b.vals || {}), u.email, now(), b.note || null).run();
  await lEvent(env, { ...l, status }, u, invalidated ? "edited_after_approval_revetting_required" : "edited", b.note, v);
  return { ok: true, version: v, status };
}
function lcodeOf(tpl) { const m = { mvpro: "PRO", mvsal: "SAL", mvtr: "TRF", mvvar: "VAR", mvno: "REJ", act: "ACT", promo: "PRO", ext: "AEX", ret: "RET", conf: "CNF", pext: "PEX", nc: "NCF", cext: "CEX", conv: "PRM", cexp: "CEN", fwok: "FWA", fwno: "FWR", piu: "PIU", leok: "LVE", leno: "LVR", dem: "DEM", ofr: "OFR", jdc: "JDC", rsg: "RSG", rtm: "RTM", rdn: "RDN", tmc: "TMC", abn: "ABN", dis: "DIS" }; return m[tpl] || (/^m\d\d$/.test(tpl) ? "M" + tpl.slice(1) : "LTR"); }
const initials = (n) => String(n || "").replace(/@.*$/, "").replace(/\(.*?\)/g, "").split(/[\s._-]+/).filter((w) => w && !/^(bin|binti|bt|bte|b|a\/l|a\/p|s\/o|d\/o|al|ap|test)$/i.test(w)).map((w) => w[0].toUpperCase()).filter((c) => /[A-Z]/.test(c)).join("").slice(0, 4);
async function letterAction(env, u, id, b) {
  const l = await letterRow(env, id);
  const t = await loadTxn(env, l.txn_id);
  need(canSeeTxn(u, t, []), "This record is restricted.");
  if (b.ver !== l.ver) fail("Another user changed this letter. Reload and try again.", 409);
  const set = async (f, action, comment) => {
    const k = Object.keys(f);
    const r = await env.DB.prepare("UPDATE hrd_letters SET " + k.map((x) => x + "=?").join(",") + ", ver=ver+1, updated_at=? WHERE id=? AND ver=?").bind(...k.map((x) => f[x]), now(), id, l.ver).run();
    if (!r.meta.changes) fail("Another user changed this letter. Reload.", 409);
    await lEvent(env, { ...l, ...f }, u, action, comment);
  };
  const a = b.action;
  if (a === "submit") {
    need(isHR(u), "Only HR can submit letters.");
    if (!["draft", "returned", "revised_draft"].includes(l.status)) fail("Only a draft can be submitted for vetting.", 409);
    if (!["approved", "letter_released", "acknowledged"].includes(t.status)) fail("The movement is not approved.", 409);
    await set({ status: "pending_vetting", submitted_by: u.email, submitted_at: now(), preparer_email: l.status === "draft" && l.preparer_email !== u.email ? l.preparer_email : l.preparer_email }, "submitted_for_vetting", b.comment);
    return { ok: true };
  }
  if (["return", "approve", "release"].includes(a)) {
    const v = await canVet(env, u, l.preparer_email, l.preparer_role);
    if (!v.ok) fail(v.why, 403);
    // anyone who edited the vetted version is also a maker for that version
    const editors = (await env.DB.prepare("SELECT DISTINCT edited_by FROM hrd_letter_versions WHERE letter_id=? AND version=?").bind(id, l.current_version).all()).results.map((x) => x.edited_by);
    if (editors.includes(u.email)) fail("You edited this version of the letter. Another authorised reviewer must vet it.", 403);
    if (a === "return") {
      if (l.status !== "pending_vetting") fail("Only a letter pending vetting can be returned.", 409);
      if (!String(b.comment || "").trim()) fail("Write the amendment comments for the preparer.", 422);
      await set({ status: "returned", reviewer_email: u.email, reviewed_at: now() }, "returned_for_amendment", b.comment);
      return { ok: true };
    }
    if (a === "approve") {
      if (l.status !== "pending_vetting") fail("Only a letter pending vetting can be approved.", 409);
      await set({ status: "approved_for_release", reviewer_email: u.email, reviewed_at: now(), approved_version: l.current_version }, "approved_for_release", (b.comment || "") + (v.delegatedFrom ? " [delegated by " + v.delegatedFrom + "]" : ""));
      return { ok: true };
    }
    if (a === "release") {
      if (!["pending_vetting", "approved_for_release"].includes(l.status)) fail("The letter must be vetted before release.", 409);
      if (l.status === "approved_for_release" && l.approved_version !== l.current_version) fail("The letter changed after approval and must be vetted again.", 409);
      if (!["approved", "letter_released", "acknowledged"].includes(t.status)) fail("Required movement approvals are not complete.", 409);
      const ap = await txnApprovals(env, t.id);
      if (ap.some((x) => !["Approved", "Not required"].includes(x.decision))) fail("Required movement approvals are not complete.", 409);
      const y = new Date().getFullYear();
      const n = await nextNo(env, "L" + y);
      const ref = "TC/HR/" + lcodeOf(l.template_code) + "/" + y + "/" + String(n).padStart(3, "0") + "/" + (initials((await env.DB.prepare("SELECT name FROM hrd_users WHERE email=?").bind(l.preparer_email).first() || {}).name || l.preparer_email) || "HR");
      await set({ status: "released", ref, reviewer_email: l.reviewer_email || u.email, reviewed_at: l.reviewed_at || now(), released_by: u.email, released_at: now(), approved_version: l.current_version }, "released", (b.comment || "") + (v.delegatedFrom ? " [delegated by " + v.delegatedFrom + "]" : ""));
      const t2 = await loadTxn(env, t.id);
      if (t2.status === "approved") await bumpTxn(env, t2, { status: "letter_released", outstanding: "Employee acknowledgement" }, u.email, "txn.letter_released", ref);
      const mt = await env.DB.prepare("SELECT * FROM hrd_movement_types WHERE code=?").bind(t.movement_code).first();
      const d = parse(t.data, {});
      if (mt.payroll_impact && !(await env.DB.prepare("SELECT id FROM hrd_payroll WHERE txn_id=?").bind(t.id).first())) {
        const pm = await payrollMonth(env, d.new_project || d.cur_project, t.effective_date, now());
        await env.DB.prepare("INSERT INTO hrd_payroll (id,txn_id,letter_id,payroll_month,cutoff_treatment,prev_basic,new_basic,allowance_type,prev_allow,new_allow,retro,final_pay,status,remarks,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(uid("py"), t.id, id, pm.pm, pm.treatment, num(d.cur_basic), num(d.new_basic), d.allowance_type || null, num(d.cur_allow), num(d.new_allow), pm.retro || (d.retro ? 1 : 0), /^[FG]/.test(mt.category) && !/WD|NOTICE|SUSP|LIFT/.test(mt.code) ? 1 : (d.final_pay ? 1 : 0), "pending", null, now(), now()).run();
        await audit(env, u.email, "payroll.created", "payroll", t.id, t.ref, null, { payroll_month: pm.pm, retro: pm.retro }, "Movement released with payroll impact");
      }
      const ackDue = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
      await makeKeyDates(env, t2, [["ack_" + id, "Outstanding employee acknowledgement (" + ref + ")", ackDue]]);
      return { ok: true, ref };
    }
  }
  if (a === "acknowledge") {
    need(isHR(u), "Only HR can record acknowledgement.");
    if (l.status !== "released") fail("Only a released letter can be acknowledged.", 409);
    const type = b.ack_type === "acceptance" ? "acceptance" : b.ack_type === "refused" ? "refused" : "receipt";
    if (!b.ack_doc_id) fail("Attach the signed acknowledgement / acceptance copy.", 422);
    await set({ status: "acknowledged", ack_type: type, ack_date: b.ack_date || now().slice(0, 10), ack_doc_id: b.ack_doc_id }, "acknowledged_" + type, b.comment);
    await env.DB.prepare("UPDATE hrd_keydates SET done=1, done_by=? WHERE txn_id=? AND kind=?").bind(u.email, t.id, "ack_" + id).run();
    const t2 = await loadTxn(env, t.id);
    if (t2.status === "letter_released") await bumpTxn(env, t2, { status: "acknowledged", outstanding: "Implementation and completion" }, u.email, "txn.acknowledged", type);
    return { ok: true };
  }
  if (a === "withdraw") {
    need(isHR(u));
    if (["released", "acknowledged"].includes(l.status)) fail("A released letter cannot be withdrawn here. Use Correct / reissue.", 409);
    await set({ status: "superseded_withdrawn" }, "withdrawn", b.comment);
    return { ok: true };
  }
  if (a === "supersede") {
    need(isHR(u));
    if (!["released", "acknowledged"].includes(l.status)) fail("Only a released letter can be superseded.", 409);
    if (!String(b.comment || "").trim()) fail("Give the reason for the correction / reissue.", 422);
    const vals = parse((await env.DB.prepare("SELECT vals FROM hrd_letter_versions WHERE letter_id=? AND version=?").bind(id, l.current_version).first()).vals, {});
    await set({ status: "superseded_withdrawn" }, "superseded", b.comment);
    return createLetter(env, u, t.id, { template_code: l.template_code, vals, supersedes_id: id });
  }
  fail("Unknown action");
}
async function signature(env, u, id) {
  const l = await letterRow(env, id);
  if (!["released", "acknowledged"].includes(l.status)) fail("The signature is applied only to a released letter.", 403);
  const t = await loadTxn(env, l.txn_id);
  need((isHR(u) && canSeeTxn(u, t, [])), "Not authorised to print the signed letter.");
  const pol = await getConfig(env, "signature_policy", { mode: "image" });
  if (pol.mode !== "image") return J({ available: false, reason: "Signature policy requires wet-ink or authorised manual signing." });
  const o = env.DOCS ? await env.DOCS.get("private/signature/current") : null;
  if (!o) return J({ available: false, reason: "The preserved signature must be configured in private storage before final letters can be generated." });
  const buf = new Uint8Array(await o.arrayBuffer());
  let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  await audit(env, u.email, "signature.applied", "letter", l.id, l.ref, null, null, "Signature applied to released letter output");
  return J({ available: true, dataUrl: "data:" + (o.httpMetadata && o.httpMetadata.contentType || "image/png") + ";base64," + btoa(s) }, 200, { "cache-control": "no-store, private" });
}

// ---------- payroll ----------
const PAY_STATUSES = ["pending", "verified", "processed", "not_applicable", "reversal_required", "reversed"];
async function payrollList(env, u, q) {
  need(u.role === "payroll" || ["manager", "lead"].includes(u.role) || u.role === "specialist", "Payroll report not available for your role.");
  const where = [], args = [];
  if (q.get("month")) { where.push("p.payroll_month=?"); args.push(q.get("month")); }
  if (q.get("status")) { where.push("p.status=?"); args.push(q.get("status")); }
  if (q.get("project")) { where.push("(t.project LIKE ? OR t.new_project LIKE ?)"); args.push("%" + q.get("project") + "%", "%" + q.get("project") + "%"); }
  if (q.get("employee")) { where.push("(t.emp_name LIKE ? OR t.emp_id LIKE ?)"); args.push("%" + q.get("employee") + "%", "%" + q.get("employee") + "%"); }
  if (q.get("category")) { where.push("m.category=?"); args.push(q.get("category")); }
  if (q.get("retro") === "1") where.push("p.retro=1");
  const sql = "SELECT p.*, t.ref case_ref, t.emp_id, t.emp_name, t.project, t.new_project, t.effective_date, t.status txn_status, t.approved_at, m.category, m.name movement, l.ref letter_ref, l.released_at FROM hrd_payroll p JOIN hrd_transactions t ON t.id=p.txn_id JOIN hrd_movement_types m ON m.code=t.movement_code LEFT JOIN hrd_letters l ON l.id=p.letter_id" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY p.payroll_month DESC, t.emp_name";
  const rows = (await env.DB.prepare(sql).bind(...args).all()).results;
  rows.forEach((r) => { r.salary_diff = r.new_basic != null && r.prev_basic != null ? Math.round((r.new_basic - r.prev_basic) * 100) / 100 : null; r.category_name = CATEGORIES[r.category]; });
  const summary = PAY_STATUSES.reduce((o, s) => ((o[s] = rows.filter((r) => r.status === s).length), o), {});
  return { rows, summary };
}
async function payrollAction(env, u, id, b) {
  need(u.role === "payroll", "Only Payroll can verify or process payroll movements.");
  const p = await env.DB.prepare("SELECT * FROM hrd_payroll WHERE id=?").bind(id).first();
  if (!p) fail("Not found", 404);
  if (b.ver !== p.ver) fail("Another user changed this record. Reload.", 409);
  const flow = { verify: [["pending"], "verified"], process: [["verified"], "processed"], not_applicable: [["pending"], "not_applicable"], reversed: [["reversal_required"], "reversed"], reopen: [["not_applicable"], "pending"] };
  let f = {}, act = b.action;
  if (act === "remarks") f = { remarks: b.remarks || "" };
  else {
    const fl = flow[act]; if (!fl) fail("Unknown action");
    if (!fl[0].includes(p.status)) fail("Cannot " + act + " a record that is " + p.status + ".", 409);
    if ((act === "not_applicable" || act === "reversed") && !String(b.remarks || "").trim()) fail("Remarks are required.", 422);
    f = { status: fl[1] };
    if (act === "verify") Object.assign(f, { verifier: u.email, verified_at: now() });
    if (act === "process") Object.assign(f, { processed_by: u.email, processed_at: now() });
    if (b.remarks) f.remarks = (p.remarks ? p.remarks + " | " : "") + b.remarks;
  }
  const k = Object.keys(f);
  const r = await env.DB.prepare("UPDATE hrd_payroll SET " + k.map((x) => x + "=?").join(",") + ", ver=ver+1, updated_at=? WHERE id=? AND ver=?").bind(...k.map((x) => f[x]), now(), id, p.ver).run();
  if (!r.meta.changes) fail("Another user changed this record. Reload.", 409);
  await audit(env, u.email, "payroll." + act, "payroll", p.txn_id, null, { status: p.status }, f, b.remarks);
  return { ok: true };
}

// ---------- reports / dashboard ----------
async function dashboard(env, u) {
  const c = async (sql, ...a) => ((await env.DB.prepare(sql).bind(...a).first()) || {}).n || 0;
  const ym = now().slice(0, 7);
  const lettersBy = async (role, st) => c("SELECT COUNT(*) n FROM hrd_letters WHERE status=? AND preparer_role IN (" + role.map(() => "?").join(",") + ")", st, ...role);
  const rules = await getConfig(env, "vetting_rules", DEFAULT_VETTING);
  const forRole = (r) => Object.keys(rules).filter((k) => rules[k].includes(r));
  const out = {
    new_requests: await c("SELECT COUNT(*) n FROM hrd_transactions WHERE status IN ('draft','submitted')"),
    pending_hr_validation: await c("SELECT COUNT(*) n FROM hrd_transactions WHERE status IN ('draft','submitted','returned')"),
    pending_approval: await c("SELECT COUNT(*) n FROM hrd_transactions WHERE status='in_approval'"),
    letters_awaiting_norwana: await lettersBy(forRole("lead"), "pending_vetting"),
    letters_awaiting_hairul: await lettersBy(forRole("manager"), "pending_vetting"),
    letters_returned: await c("SELECT COUNT(*) n FROM hrd_letters WHERE status='returned'"),
    letters_issued_month: await c("SELECT COUNT(*) n FROM hrd_letters WHERE released_at LIKE ?", ym + "%"),
    awaiting_payroll: await c("SELECT COUNT(*) n FROM hrd_payroll WHERE status IN ('pending','verified','reversal_required')"),
    overdue_keydates: await c("SELECT COUNT(*) n FROM hrd_keydates WHERE done=0 AND due_date<?", now().slice(0, 10)),
    upcoming: (await env.DB.prepare("SELECT k.*, t.ref, t.sensitivity FROM hrd_keydates k LEFT JOIN hrd_transactions t ON t.id=k.txn_id WHERE k.done=0 AND k.due_date<=? ORDER BY k.due_date LIMIT 12").bind(new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10)).all()).results.filter((k) => k.sensitivity !== "restricted" || ["manager", "lead"].includes(u.role)),
    by_category: (await env.DB.prepare("SELECT m.category, COUNT(*) n FROM hrd_transactions t JOIN hrd_movement_types m ON m.code=t.movement_code WHERE t.created_at LIKE ? GROUP BY m.category").bind(ym + "%").all()).results
  };
  return out;
}
async function reports(env, q) {
  const from = q.get("from") || "0000", to = q.get("to") || "9999";
  const rows = (await env.DB.prepare("SELECT substr(t.created_at,1,7) month, m.category, m.name movement, t.status, COUNT(*) n FROM hrd_transactions t JOIN hrd_movement_types m ON m.code=t.movement_code WHERE substr(t.created_at,1,10)>=? AND substr(t.created_at,1,10)<=? GROUP BY 1,2,3,4 ORDER BY 1 DESC,2,3").bind(from, to).all()).results;
  const turnaround = (await env.DB.prepare("SELECT m.category, AVG(julianday(l.released_at)-julianday(t.created_at)) days, COUNT(*) n FROM hrd_letters l JOIN hrd_transactions t ON t.id=l.txn_id JOIN hrd_movement_types m ON m.code=t.movement_code WHERE l.released_at IS NOT NULL GROUP BY 1").all()).results;
  return { rows, turnaround, categories: CATEGORIES };
}

// ---------- router ----------
async function route(req, env, url) {
  const p = url.pathname, M = req.method;
  // Seed fictional local accounts only in explicit development mode.
  if (devMode(env)) await ensureSeed(env);
  const u = await identify(req, env);
  if (!devMode(env)) await ensureSeed(env);
  if (p === "/api/health") { const r = await env.DB.prepare("SELECT 1 ok").first(); const L = await legacy(env); return J({ ok: !!r, db: true, r2: !!env.DOCS, legacyTable: L.table, legacyCompatible: L.compatible, environment: env.ENVIRONMENT || "production" }); }
  const body = M === "POST" || M === "PUT" ? (req.headers.get("content-type") || "").includes("application/json") ? await req.json().catch(() => ({})) : null : null;
  // legacy contract used by the original HR Desk
  if (p === "/api/me") return J({ email: u.email, name: u.name, role: legacyRole(u), v2role: u.role, dev: devMode(env) });
  if (p === "/api/data" && M === "GET") return J(await legacyData(env, u, Number(url.searchParams.get("since") || 0)));
  if (p === "/api/sync" && M === "POST") return J(await legacySync(env, u, body || {}));
  if (p === "/api/next" && M === "POST") { need(isHR(u)); return J({ n: await nextNo(env, "legacy_" + String((body || {}).k || "x").slice(0, 20)) }); }
  if (p === "/api/sig" && M === "GET") {
    const ref = url.searchParams.get("ref"); const L = await legacy(env);
    const rows = (await env.DB.prepare(`SELECT ${L.data} d FROM ${L.table} WHERE ${L.t}='letter'`).all()).results.map((r) => parse(r.d, {}));
    const rec = rows.find((r) => r.ref === ref);
    if (!rec || !isHR(u)) fail("Signature is only available for an issued letter in the register.", 403);
    const o = env.DOCS ? await env.DOCS.get("private/signature/current") : null;
    const pol = await getConfig(env, "signature_policy", { mode: "image" });
    if (!o || pol.mode !== "image") return J({ available: false });
    const buf = new Uint8Array(await o.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    await audit(env, u.email, "signature.applied", "legacy_letter", ref, ref, null, null, "Signature applied to issued letter output");
    return J({ available: true, dataUrl: "data:image/png;base64," + btoa(s) });
  }
  if (!p.startsWith("/api/v2/")) fail("Not found", 404);
  const seg = p.slice(8).split("/").filter(Boolean);
  const [a, b, c, d] = seg;
  if (a === "me") return J({ ...u, delegations: await activeDelegators(env, u.email), dev: devMode(env) });
  if (a === "vetcheck") { const em = String(url.searchParams.get("em") || "").toLowerCase(); const r = em ? await env.DB.prepare("SELECT role FROM hrd_users WHERE email=?").bind(em).first() : null; return J(await canVet(env, u, em, r ? r.role : "specialist")); }
  if (a === "dev" && b === "users") { if (!devMode(env)) fail("Not found", 404); return J({ users: DEV_USERS.map((x) => ({ email: x[0], name: x[1], role: x[2] })) }); }
  if (a === "bootstrap") {
    const mt = (await env.DB.prepare("SELECT * FROM hrd_movement_types WHERE active=1 ORDER BY category, name").all()).results;
    const mx = (await env.DB.prepare("SELECT * FROM hrd_matrix ORDER BY movement").all()).results;
    const users = isHR(u) || u.role === "admin" ? (await env.DB.prepare("SELECT email,name,role,active FROM hrd_users ORDER BY name").all()).results : [];
    return J({ movements: mt, matrix: mx, categories: CATEGORIES, users, vetting_rules: await getConfig(env, "vetting_rules", DEFAULT_VETTING), signatory: await getConfig(env, "signatory", SIGNATORY) });
  }
  if (a === "dashboard") { need(isHR(u) || u.role === "admin" || u.role === "payroll"); return J(await dashboard(env, u)); }
  if (a === "txns" && !b && M === "GET") {
    const rows = (await env.DB.prepare("SELECT t.id,t.ref,t.movement_code,t.status,t.emp_id,t.emp_name,t.project,t.new_project,t.dept,t.originator,t.owner,t.sensitivity,t.effective_date,t.outstanding,t.updated_at,t.created_at,m.name movement,m.category, (SELECT status FROM hrd_letters l WHERE l.txn_id=t.id ORDER BY created_at DESC LIMIT 1) letter_status, (SELECT status FROM hrd_payroll p WHERE p.txn_id=t.id) payroll_status, (SELECT stage||': '||role_label FROM hrd_approvals a WHERE a.txn_id=t.id AND a.decision IN ('Pending','Returned') ORDER BY step_no LIMIT 1) approval_stage FROM hrd_transactions t JOIN hrd_movement_types m ON m.code=t.movement_code ORDER BY t.updated_at DESC LIMIT 2000").all()).results;
    const mine = u.role === "approver" ? new Set((await env.DB.prepare("SELECT txn_id FROM hrd_approvals WHERE approver_email=?").bind(u.email).all()).results.map((x) => x.txn_id)) : null;
    return J({ rows: rows.filter((t) => (mine && mine.has(t.id)) || canSeeTxn(u, t, [])) });
  }
  if (a === "txns" && !b && M === "POST") return J(await createTxn(env, u, body || {}));
  if (a === "txns" && b && !c && M === "GET") return J(await txnFull(env, u, b));
  if (a === "txns" && b && !c && M === "PUT") return J(await updateTxn(env, u, b, body || {}));
  if (a === "txns" && b && c === "action" && M === "POST") return J(await txnAction(env, u, b, body || {}));
  if (a === "txns" && b && c === "approvals" && d && seg[4] === "assign" && M === "POST") {
    need(isHR(u), "Only HR can assign an approver.");
    const t = await loadTxn(env, b); need(canSeeTxn(u, t, []), "This record is restricted.");
    const em = String((body || {}).email || "").toLowerCase().trim();
    const ap = await env.DB.prepare("SELECT * FROM hrd_users WHERE email=? AND active=1 AND role='approver'").bind(em).first();
    if (!ap) fail("Choose an active Authorised Management Approver account.");
    if (em === t.originator) fail("The initiator cannot be the approver.", 409);
    const r = await env.DB.prepare("UPDATE hrd_approvals SET approver_email=?, approver_name=? WHERE id=? AND txn_id=? AND decision='Pending'").bind(em, ap.name, d, b).run();
    if (!r.meta.changes) fail("Step already decided.", 409);
    await audit(env, u.email, "approval.assigned", "approval", d, t.ref, null, { approver: em });
    return J({ ok: true });
  }
  if (a === "txns" && b && c === "approvals" && d && M === "POST") return J(await decide(env, u, b, d, body || {}));
  if (a === "txns" && b && c === "letters" && M === "POST") return J(await createLetter(env, u, b, body || {}));
  if (a === "approvals" && b === "mine") {
    need(u.role === "approver" || isHR(u));
    const rows = (await env.DB.prepare("SELECT a.*, t.ref, t.emp_name, t.status txn_status, t.originator, m.name movement FROM hrd_approvals a JOIN hrd_transactions t ON t.id=a.txn_id JOIN hrd_movement_types m ON m.code=t.movement_code WHERE a.decision='Pending' AND t.status='in_approval' ORDER BY t.updated_at").all()).results;
    const first = {}; rows.forEach((r) => { if (!first[r.txn_id] || first[r.txn_id].step_no > r.step_no) first[r.txn_id] = r; });
    return J({ rows: Object.values(first).filter((r) => isHR(u) || (u.role === "approver" && r.approver_email === u.email && r.originator !== u.email)) });
  }
  if (a === "docs" && !b && M === "POST") {
    const fd = await req.formData(); const f = fd.get("file");
    if (!f || typeof f === "string") fail("No file received.");
    return J(await putDoc(env, u, fd.get("txn_id") || null, String(fd.get("kind") || "supporting"), f.name, await f.arrayBuffer(), f.type));
  }
  if (a === "docs" && b && M === "GET") return getDoc(env, u, b);
  if (a === "letters" && !b && M === "GET") {
    need(isHR(u));
    const rows = (await env.DB.prepare("SELECT l.id,l.txn_id,l.ref,l.template_code,l.status,l.preparer_email,l.preparer_role,l.reviewer_email,l.released_by,l.released_at,l.current_version,l.updated_at,t.ref case_ref,t.emp_name,t.sensitivity,t.owner,t.originator FROM hrd_letters l JOIN hrd_transactions t ON t.id=l.txn_id ORDER BY l.updated_at DESC").all()).results;
    return J({ rows: rows.filter((r) => canSeeTxn(u, r, [])) });
  }
  if (a === "letters" && b && !c && M === "PUT") return J(await editLetter(env, u, b, body || {}));
  if (a === "letters" && b && c === "action" && M === "POST") return J(await letterAction(env, u, b, body || {}));
  if (a === "letters" && b && c === "signature" && M === "GET") return signature(env, u, b);
  if (a === "letters" && b && c === "final" && M === "POST") {
    const l = await letterRow(env, b); need(isHR(u));
    if (!["released", "acknowledged"].includes(l.status)) fail("Only a released letter can be filed as final.", 409);
    if (l.final_doc_id && l.final_docx_id) return J({ ok: true, already: true });
    const bytes = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
    const fname = l.ref.replace(/\//g, "-");
    const h = l.final_doc_id ? { id: l.final_doc_id } : await putDoc(env, u, l.txn_id, "final_letter", fname + ".html", new TextEncoder().encode(body.html || ""), "text/html");
    const x = l.final_docx_id ? { id: l.final_docx_id } : body.docx_b64 ? await putDoc(env, u, l.txn_id, "final_letter", fname + ".docx", bytes(body.docx_b64)) : { id: null };
    await env.DB.prepare("UPDATE hrd_letters SET final_doc_id=?, final_docx_id=?, ver=ver+1, updated_at=? WHERE id=?").bind(h.id, x.id, now(), b).run();
    return J({ ok: true });
  }
  if (a === "payroll" && !b && M === "GET") return J(await payrollList(env, u, url.searchParams));
  if (a === "payroll" && b && c === "action" && M === "POST") return J(await payrollAction(env, u, b, body || {}));
  if (a === "keydates" && !b && M === "GET") {
    need(isHR(u));
    const rows = (await env.DB.prepare("SELECT k.*, t.ref, t.sensitivity, t.owner, t.originator, t.status txn_status FROM hrd_keydates k LEFT JOIN hrd_transactions t ON t.id=k.txn_id ORDER BY k.done, k.due_date").all()).results;
    return J({ rows: rows.filter((r) => !r.txn_id || canSeeTxn(u, r, [])) });
  }
  if (a === "keydates" && b && M === "POST") { need(isHR(u)); const k = await env.DB.prepare("SELECT * FROM hrd_keydates WHERE id=?").bind(b).first(); if (!k) fail("Not found", 404); await env.DB.prepare("UPDATE hrd_keydates SET done=?, done_by=? WHERE id=?").bind(body.done ? 1 : 0, u.email, b).run(); await audit(env, u.email, "keydate." + (body.done ? "done" : "reopened"), "keydate", k.txn_id, null, { done: k.done }, { done: !!body.done }); return J({ ok: true }); }
  if (a === "reports") { need(["manager", "lead", "specialist", "admin"].includes(u.role)); return J(await reports(env, url.searchParams)); }
  if (a === "audit") { need(["manager", "lead", "admin"].includes(u.role)); const rows = (await env.DB.prepare("SELECT * FROM hrd_audit ORDER BY id DESC LIMIT 500").all()).results; return J({ rows }); }
  // administration
  if (a === "admin") {
    const isAdm = u.role === "admin";
    if (b === "users" && M === "GET") { need(isAdm || u.role === "manager"); return J({ rows: (await env.DB.prepare("SELECT * FROM hrd_users ORDER BY role,name").all()).results }); }
    if (b === "users" && M === "POST") {
      need(isAdm, "Only the System Administrator manages users.");
      const e = String(body.email || "").toLowerCase().trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || !body.name || !["admin", "manager", "lead", "specialist", "payroll", "requestor", "approver"].includes(body.role)) fail("Enter a valid email, name and role.");
      const old = await env.DB.prepare("SELECT * FROM hrd_users WHERE email=?").bind(e).first();
      if (old && old.email === u.email && body.role !== "admin") fail("You cannot remove your own administrator role.", 409);
      await env.DB.prepare("INSERT INTO hrd_users (email,name,role,title,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name, role=excluded.role, title=excluded.title, active=excluded.active, updated_at=excluded.updated_at").bind(e, body.name, body.role, body.title || null, body.active === false ? 0 : 1, now(), now()).run();
      await audit(env, u.email, old ? "user.update" : "user.create", "user", e, null, old, body);
      return J({ ok: true });
    }
    if (b === "matrix" && c && M === "PUT") {
      need(isAdm || u.role === "manager", "Only the HR Manager or System Administrator can change the approval matrix.");
      const old = await env.DB.prepare("SELECT * FROM hrd_matrix WHERE matrix_key=?").bind(c).first();
      if (!old) fail("Not found", 404);
      if (body.version !== old.version) fail("Someone else changed this row. Reload.", 409);
      const lv = Number(body.level); if (![1, 2, 3, 4].includes(lv)) fail("Level must be 1 to 4.");
      await env.DB.prepare("UPDATE hrd_matrix SET recommender=?, reviewers=?, final_approver=?, employee_response=?, initiating_record=?, level=?, version=version+1, source='Edited in HR Desk administration', updated_by=?, updated_at=? WHERE matrix_key=? AND version=?").bind(body.recommender, body.reviewers, body.final_approver, body.employee_response, body.initiating_record, lv, u.email, now(), c, old.version).run();
      await audit(env, u.email, "matrix.update", "matrix", c, null, old, body, "Applies to new transactions; existing transactions keep their route snapshot");
      return J({ ok: true });
    }
    if (b === "delegations" && M === "GET") { need(isAdm || ["manager", "lead"].includes(u.role)); return J({ rows: (await env.DB.prepare("SELECT * FROM hrd_delegations ORDER BY created_at DESC").all()).results }); }
    if (b === "delegations" && M === "POST" && !c) {
      need(isAdm || ["manager", "lead"].includes(u.role), "Not authorised to delegate.");
      const from = String(body.from_email || u.email).toLowerCase(), to = String(body.to_email || "").toLowerCase();
      if (from !== u.email && !isAdm && u.role !== "manager") fail("You can only delegate your own authority.", 403);
      if (!to || from === to || !body.start_date || !body.end_date || body.end_date < body.start_date) fail("Enter the delegate and a valid period.");
      const tgt = await env.DB.prepare("SELECT role FROM hrd_users WHERE email=? AND active=1").bind(to).first(); if (!tgt) fail("The delegate must be an active HR Desk user.");
      const id = uid("dl");
      await env.DB.prepare("INSERT INTO hrd_delegations (id,from_email,to_email,scope,start_date,end_date,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(id, from, to, body.scope || "letter_vetting", body.start_date, body.end_date, body.reason || null, u.email, now()).run();
      await audit(env, u.email, "delegation.create", "delegation", id, null, null, body);
      return J({ ok: true, id });
    }
    if (b === "delegations" && c && d === "revoke" && M === "POST") { need(isAdm || ["manager", "lead"].includes(u.role)); await env.DB.prepare("UPDATE hrd_delegations SET revoked_at=?, revoked_by=? WHERE id=?").bind(now(), u.email, c).run(); await audit(env, u.email, "delegation.revoke", "delegation", c); return J({ ok: true }); }
    if (b === "config" && M === "GET") { need(isAdm || u.role === "manager"); return J({ rows: (await env.DB.prepare("SELECT * FROM hrd_config").all()).results, defaults: { vetting_rules: DEFAULT_VETTING, signatory: SIGNATORY, default_cutoff_day: 20, retention_years: 7, signature_policy: { mode: "image" } } }); }
    if (b === "config" && c && M === "PUT") {
      need(isAdm, "Only the System Administrator changes configuration.");
      if (!["vetting_rules", "signatory", "default_cutoff_day", "retention_years", "signature_policy"].includes(c)) fail("Unknown setting");
      const old = await getConfig(env, c, null);
      await env.DB.prepare("INSERT INTO hrd_config (key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(c, JSON.stringify(body.value), u.email, now()).run();
      await audit(env, u.email, "config.update", "config", c, null, old, body.value);
      return J({ ok: true });
    }
    if (b === "cycles" && M === "GET") { need(isAdm || u.role === "payroll" || u.role === "manager"); return J({ rows: (await env.DB.prepare("SELECT * FROM hrd_payroll_cycles ORDER BY project").all()).results }); }
    if (b === "cycles" && M === "POST") { need(isAdm || u.role === "payroll"); const cd = Number(body.cutoff_day); if (!body.project || !(cd >= 1 && cd <= 31)) fail("Enter project and a cut-off day 1-31."); await env.DB.prepare("INSERT INTO hrd_payroll_cycles (project,cutoff_day,note,updated_by,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project) DO UPDATE SET cutoff_day=excluded.cutoff_day, note=excluded.note, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(body.project, cd, body.note || null, u.email, now()).run(); await audit(env, u.email, "cycle.update", "cycle", body.project, null, null, body); return J({ ok: true }); }
    if (b === "signature" && M === "GET") { need(isAdm || u.role === "manager"); const o = env.DOCS ? await env.DOCS.head("private/signature/current") : null; return J({ uploaded: !!o, uploaded_at: o ? o.uploaded : null, by: o && o.customMetadata ? o.customMetadata.uploadedBy : null }); }
    if (b === "signature" && M === "POST") {
      need(isAdm, "Only the System Administrator can upload the signature image.");
      const fd = await req.formData(); const f = fd.get("file");
      if (!f || typeof f === "string" || !/^image\/png$/.test(f.type)) fail("Upload a PNG image.", 415);
      const buf = await f.arrayBuffer(); if (buf.byteLength > 1024 * 1024) fail("Signature image must be under 1 MB.", 413);
      const prev = await env.DOCS.get("private/signature/current");
      if (prev) await env.DOCS.put("private/signature/archive-" + Date.now(), await prev.arrayBuffer(), { httpMetadata: { contentType: "image/png" } });
      await env.DOCS.put("private/signature/current", buf, { httpMetadata: { contentType: "image/png" }, customMetadata: { uploadedBy: u.email } });
      await audit(env, u.email, "signature.uploaded", "signature", "current", null, null, { size: buf.byteLength }, "Signatory: " + SIGNATORY.name);
      return J({ ok: true });
    }
    if (b === "legacy" && M === "GET") { need(isAdm); return J(await legacy(env)); }
  }
  fail("Not found", 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await route(req, env, url);
      // Static app: still require a verified identity before serving any page.
      if (!devMode(env)) await identify(req, env);
      const sec = { "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
      const r = await env.ASSETS.fetch(req);
      const h = new Headers(r.headers); Object.entries(sec).forEach(([k, v]) => h.set(k, v));
      return new Response(r.body, { status: r.status, headers: h });
    } catch (e) {
      if (e instanceof HttpError) return E(e.message, e.status, e.extra);
      console.error(e);
      return E("Server error. Contact the HR Desk administrator.", 500);
    }
  }
};
