// Automated API tests for the Telecontinent HR Desk Worker. Fictional data only.
// Run against a local `wrangler dev -c wrangler.dev.jsonc` (DEV_AUTH) instance:
//   BASE=http://127.0.0.1:8787 node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
const BASE = process.env.BASE || "http://127.0.0.1:8787";
const target = new URL(BASE);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'API tests are restricted to local simulators');
const readiness = await fetch(BASE + '/api/health').then(r => r.json());
assert.equal(readiness.environment, 'development', 'Refusing to write test fixtures outside development');
const U = { admin: "admin.test@telecontinent.com.my", hairul: "hairul.test@telecontinent.com.my", norwana: "norwana.test@telecontinent.com.my", sp1: "specialist1.test@telecontinent.com.my", sp2: "specialist2.test@telecontinent.com.my", pay: "payroll.test@telecontinent.com.my", ops: "ops.test@telecontinent.com.my", ceo: "ceo.test@telecontinent.com.my" };
async function call(who, path, opt = {}) {
  const h = { "x-dev-user": who }; let body = opt.body;
  if (body && !(body instanceof FormData)) { h["content-type"] = "application/json"; body = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method: opt.method || (opt.body ? "POST" : "GET"), headers: h, body });
  const ct = r.headers.get("content-type") || ""; return { s: r.status, j: ct.includes("json") ? await r.json() : null, r };
}
const ok = (x, m) => { assert.ok(x.s >= 200 && x.s < 300, (m || "") + " -> " + x.s + " " + JSON.stringify(x.j)); return x.j; };
const DOCX = () => new Blob([new Uint8Array([80, 75, 3, 4, 0, 0])], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
async function uploadDoc(who, txn, kind, name = "TEST_form.docx") { const f = new FormData(); f.append("file", DOCX(), name); f.append("kind", kind); if (txn) f.append("txn_id", txn); return ok(await call(who, "/api/v2/docs", { body: f }), "upload"); }
async function txn(who, code, data) { return ok(await call(who, "/api/v2/txns", { body: { movement_code: code, data: Object.assign({ emp_name: "TEST_Employee " + Math.random().toString(36).slice(2, 7), emp_id: "TEST" + Date.now() % 100000, cur_project: "TEST_ProjectA", effective_date: "2026-11-01" }, data || {}), extracted: { emp_name: "TEST_Wrong Name" } } })); }
async function full(who, id) { return ok(await call(who, "/api/v2/txns/" + id)); }
async function approveAll(id) {
  let x = await full(U.sp1, id); const ev = await uploadDoc(U.sp1, id, "approval_evidence", "TEST_approval_email.eml");
  for (const a of x.approvals) {
    x = await full(U.sp1, id); const cur = x.approvals.find((s) => s.id === a.id);
    ok(await call(U.sp2, `/api/v2/txns/${id}/approvals/${a.id}`, { body: { decision: "Approved", approver_name: "TEST Approver " + a.step_no, approver_email: "approver" + a.step_no + ".test@telecontinent.com.my", evidence_doc_id: ev.id } }), "approve step " + cur.stage);
  }
}
async function validated(code, data) { const t = await txn(U.sp1, code, data); await uploadDoc(U.sp1, t.id, "original_form"); const x = await full(U.sp1, t.id); ok(await call(U.sp1, `/api/v2/txns/${t.id}/action`, { body: { action: "validate", ver: x.txn.ver, checklist: ["ok"] } })); return t; }

test("health and authentication", async () => {
  const h = await fetch(BASE + "/api/health").then((r) => r.json()); assert.equal(h.db, true);
  assert.equal((await call("intruder@gmail.com", "/api/me")).s, 403, "outside domain blocked");
  assert.equal((await call("unknown.person@telecontinent.com.my", "/api/me")).s, 403, "unregistered blocked");
  const me = ok(await call(U.norwana, "/api/v2/me")); assert.equal(me.role, "lead");
});
test("matrix seeded from approval document and editable", async () => {
  const b = ok(await call(U.sp1, "/api/v2/bootstrap"));
  assert.ok(b.matrix.length >= 45); assert.ok(b.movements.length >= 90);
  const promo = b.matrix.find((m) => m.matrix_key === "promo"); assert.equal(promo.final_approver, "CEO / remuneration authority"); assert.equal(promo.level, 3);
  assert.equal((await call(U.sp1, "/api/v2/admin/matrix/promo", { method: "PUT", body: { ...promo, version: promo.version } })).s, 403, "specialist cannot edit matrix");
});
test("case create: unique refs, extraction corrections audited, visible to another HR user", async () => {
  const a = await txn(U.sp1, "C_PROMO", { cur_basic: "4000", new_basic: "4600" }); const b = await txn(U.sp1, "C_PROMO");
  assert.notEqual(a.ref, b.ref); assert.match(a.ref, /^HRD-\d{4}-\d{5}$/);
  const x = await full(U.sp2, a.id); assert.equal(x.txn.data.new_basic, "4600");
  assert.ok(x.audit.some((e) => e.action === "txn.extraction_corrected"));
  assert.equal(x.approvals[x.approvals.length - 1].stage, "Final Approval");
  // concurrency: stale version rejected
  ok(await call(U.sp1, "/api/v2/txns/" + a.id, { method: "PUT", body: { ver: x.txn.ver, data: { ...x.txn.data, new_basic: "4700" } } }));
  assert.equal((await call(U.sp2, "/api/v2/txns/" + a.id, { method: "PUT", body: { ver: x.txn.ver, data: x.txn.data } })).s, 409);
});
test("documents: private storage, unsupported type rejected", async () => {
  const t = await txn(U.sp1, "C_PROJTR");
  const d = await uploadDoc(U.sp1, t.id, "original_form");
  const g = await call(U.sp2, "/api/v2/docs/" + d.id); assert.equal(g.s, 200);
  assert.equal((await call(U.ops, "/api/v2/docs/" + d.id)).s, 403, "requestor cannot read others' docs");
  const f = new FormData(); f.append("file", new Blob(["x"]), "TEST_bad.exe"); f.append("kind", "supporting"); f.append("txn_id", t.id);
  assert.equal((await call(U.sp1, "/api/v2/docs", { body: f })).s, 415);
});
test("approval: evidence enforced, order enforced, self-approval and rejected flow", async () => {
  const t = await validated("C_PROMO", { cur_basic: "4000", new_basic: "4600" });
  let x = await full(U.sp1, t.id); const [s1, s2] = x.approvals;
  assert.equal((await call(U.sp1, `/api/v2/txns/${t.id}/approvals/${s1.id}`, { body: { decision: "Approved", approver_name: "TEST HOD" } })).s, 422, "evidence required");
  assert.equal((await call(U.sp1, `/api/v2/txns/${t.id}/approvals/${s2.id}`, { body: { decision: "Approved", approver_name: "TEST Payroll", evidence_doc_id: "x" } })).s, 409, "cannot skip stage");
  assert.equal((await call(U.sp1, `/api/v2/txns/${t.id}/approvals/${s1.id}`, { body: { decision: "Approved", approver_name: x.txn.emp_name, evidence_doc_id: x.docs[0].id } })).s, 409, "employee cannot approve own movement");
  assert.equal((await call(U.pay, `/api/v2/txns/${t.id}/approvals/${s1.id}`, { body: { decision: "Approved", approver_name: "TEST", evidence_doc_id: x.docs[0].id } })).s, 403, "payroll cannot record approvals");
  ok(await call(U.sp2, `/api/v2/txns/${t.id}/approvals/${s1.id}`, { body: { decision: "Rejected", approver_name: "TEST HOD", remarks: "TEST budget not available" } }));
  x = await full(U.sp1, t.id); assert.equal(x.txn.status, "rejected");
  assert.equal((await call(U.sp1, `/api/v2/txns/${t.id}/letters`, { body: { template_code: "mvpro", vals: {} } })).s, 409, "no letter for rejected");
  assert.equal((await call(U.sp2, `/api/v2/txns/${t.id}/approvals/${s1.id}`, { body: { decision: "Approved", approver_name: "TEST HOD", evidence_doc_id: x.docs[0].id } })).s, 409, "decision cannot be overwritten");
});
test("approver decides in-app; initiator cannot approve", async () => {
  const t = await validated("B_CONFIRM"); const x = await full(U.sp1, t.id);
  assert.equal((await call(U.ceo, `/api/v2/txns/${t.id}/approvals/${x.approvals[0].id}`, { body: { decision: "Approved" } })).s, 403, "unassigned approver blocked");
  assert.equal((await call(U.sp1, `/api/v2/txns/${t.id}/approvals/${x.approvals[0].id}/assign`, { body: { email: U.sp2 } })).s, 400, "only approver accounts can be assigned");
  ok(await call(U.sp1, `/api/v2/txns/${t.id}/approvals/${x.approvals[0].id}/assign`, { body: { email: U.ceo } }));
  const mine = ok(await call(U.ceo, "/api/v2/approvals/mine")); assert.ok(mine.rows.some((r) => r.txn_id === t.id));
  const r = ok(await call(U.ceo, `/api/v2/txns/${t.id}/approvals/${x.approvals[0].id}`, { body: { decision: "Approved" } }));
  assert.ok(r.ok);
});
const syntheticSignature = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
test("private signature upload preserves exact bytes and requires administrator", async () => {
  const form = () => { const fd = new FormData(); fd.append('file', new Blob([syntheticSignature], { type: 'image/png' }), 'TEST_SYNTHETIC.png'); return fd; };
  assert.equal((await call(U.sp1, '/api/v2/admin/signature', { body: form() })).s, 403);
  ok(await call(U.admin, '/api/v2/admin/signature', { body: form() }));
  assert.equal(ok(await call(U.admin, '/api/v2/admin/signature')).uploaded, true);
});
test("letters: maker-checker (specialist->Norwana, Norwana->Hairul), re-vetting, payroll handover", async () => {
  const t = await validated("C_PROMO", { cur_basic: "4000", new_basic: "4600", cur_project: "TEST_ProjectA", effective_date: "2026-08-05" });
  assert.equal((await call(U.sp1, `/api/v2/txns/${t.id}/letters`, { body: { template_code: "mvpro", vals: {} } })).s, 409, "no letter before approval");
  await approveAll(t.id);
  let x = await full(U.sp1, t.id); assert.equal(x.txn.status, "approved");
  const L = ok(await call(U.sp1, `/api/v2/txns/${t.id}/letters`, { body: { template_code: "mvpro", vals: { pos: "TEST Team Lead", eff: "2026-10-05" } } }));
  assert.equal((await call(U.sp1, `/api/v2/letters/${L.id}/signature`)).s, 403, "draft must never receive signature");
  const lv = async () => (await full(U.sp1, t.id)).letters.find((l) => l.id === L.id);
  let l = await lv();
  assert.equal((await call(U.norwana, `/api/v2/letters/${L.id}/action`, { body: { action: "release", ver: l.ver } })).s, 409, "cannot release a draft");
  ok(await call(U.sp1, `/api/v2/letters/${L.id}/action`, { body: { action: "submit", ver: l.ver } }));
  l = await lv();
  assert.equal((await call(U.sp1, `/api/v2/letters/${L.id}/action`, { body: { action: "release", ver: l.ver } })).s, 403, "preparer cannot release own letter");
  assert.equal((await call(U.sp2, `/api/v2/letters/${L.id}/action`, { body: { action: "release", ver: l.ver } })).s, 403, "other specialist cannot release");
  assert.equal((await call(U.pay, `/api/v2/letters/${L.id}/action`, { body: { action: "release", ver: l.ver } })).s, 403, "payroll cannot release");
  assert.equal((await call(U.hairul, `/api/v2/letters/${L.id}/action`, { body: { action: "release", ver: l.ver } })).s, 403, "specialist letters are vetted by Lead HR under default rules");
  ok(await call(U.norwana, `/api/v2/letters/${L.id}/action`, { body: { action: "return", ver: l.ver, comment: "TEST correct the date" } }));
  l = await lv(); assert.equal(l.status, "returned");
  ok(await call(U.sp1, `/api/v2/letters/${L.id}`, { method: "PUT", body: { ver: l.ver, vals: { pos: "TEST Team Lead", eff: "2026-10-06" }, note: "TEST amended" } }));
  l = await lv(); assert.equal(l.status, "revised_draft");
  ok(await call(U.sp1, `/api/v2/letters/${L.id}/action`, { body: { action: "submit", ver: l.ver } })); l = await lv();
  ok(await call(U.norwana, `/api/v2/letters/${L.id}/action`, { body: { action: "approve", ver: l.ver } })); l = await lv();
  assert.equal(l.status, "approved_for_release");
  ok(await call(U.sp1, `/api/v2/letters/${L.id}`, { method: "PUT", body: { ver: l.ver, vals: { pos: "TEST Team Lead II" } } })); l = await lv();
  assert.equal(l.status, "revised_draft", "editing an approved letter invalidates approval"); assert.equal(l.approved_version, null);
  ok(await call(U.sp1, `/api/v2/letters/${L.id}/action`, { body: { action: "submit", ver: l.ver } })); l = await lv();
  assert.equal((await call(U.norwana, `/api/v2/letters/${L.id}/signature`)).s, 403, "no signature before release");
  const rel = ok(await call(U.norwana, `/api/v2/letters/${L.id}/action`, { body: { action: "release", ver: l.ver } }));
  assert.match(rel.ref, /^TC\/HR\/PRO\/\d{4}\/\d{3}\/[A-Z]+$/);
  l = await lv(); assert.equal(l.status, "released"); assert.equal(l.released_by, U.norwana); assert.equal(l.preparer_email, U.sp1);
  assert.equal((await call(U.sp1, `/api/v2/letters/${L.id}`, { method: "PUT", body: { ver: l.ver, vals: {} } })).s, 409, "released letter locked");
  const sig = ok(await call(U.sp1, `/api/v2/letters/${L.id}/signature`)); assert.equal(sig.available, true);
  assert.equal(sig.dataUrl, 'data:image/png;base64,' + syntheticSignature.toString('base64'), 'released output uses exact stored PNG bytes');
  assert.equal((await call(U.pay, `/api/v2/letters/${L.id}/signature`)).s, 403, "payroll cannot obtain signature");
  // payroll
  const p = ok(await call(U.pay, "/api/v2/payroll")); const row = p.rows.find((r) => r.case_ref === t.ref);
  assert.ok(row); assert.equal(row.status, "pending"); assert.equal(row.salary_diff, 600); assert.equal(row.retro, 1, "effective date already passed -> retro");
  assert.equal((await call(U.sp1, `/api/v2/payroll/${row.id}/action`, { body: { action: "verify", ver: row.ver } })).s, 403, "HR cannot verify payroll");
  assert.equal((await call(U.pay, `/api/v2/payroll/${row.id}/action`, { body: { action: "process", ver: row.ver } })).s, 409, "cannot process before verify");
  ok(await call(U.pay, `/api/v2/payroll/${row.id}/action`, { body: { action: "verify", ver: row.ver, remarks: "TEST ok" } }));
  x = await full(U.sp1, t.id); assert.equal(x.txn.status, "letter_released", "payroll does not change HR status");
  // Norwana prepares -> only Hairul releases
  const t2 = await validated("C_SALADJ", { cur_basic: "3000", new_basic: "3300" }); await approveAll(t2.id);
  const L2 = ok(await call(U.norwana, `/api/v2/txns/${t2.id}/letters`, { body: { template_code: "mvsal", vals: { eff: "2026-12-01" } } }));
  let l2 = (await full(U.sp1, t2.id)).letters[0];
  ok(await call(U.norwana, `/api/v2/letters/${L2.id}/action`, { body: { action: "submit", ver: l2.ver } })); l2 = (await full(U.sp1, t2.id)).letters[0];
  assert.equal((await call(U.norwana, `/api/v2/letters/${L2.id}/action`, { body: { action: "release", ver: l2.ver } })).s, 403, "Norwana cannot release own letter");
  ok(await call(U.hairul, `/api/v2/letters/${L2.id}/action`, { body: { action: "release", ver: l2.ver } }));
  // withdrawal flags payroll reversal
  ok(await call(U.sp1, `/api/v2/txns/${t2.id}/action`, { body: { action: "withdraw", ver: (await full(U.sp1, t2.id)).txn.ver, remarks: "TEST business change" } }));
  const p2 = ok(await call(U.pay, "/api/v2/payroll?status=reversal_required")); assert.ok(p2.rows.some((r) => r.case_ref === t2.ref));
  // acknowledgement and completion
  const ack = await uploadDoc(U.sp1, t.id, "acknowledgement", "TEST_ack.pdf");
  l = await lv(); ok(await call(U.sp1, `/api/v2/letters/${L.id}/action`, { body: { action: "acknowledge", ver: l.ver, ack_type: "acceptance", ack_doc_id: ack.id } }));
  x = await full(U.sp1, t.id); assert.equal(x.txn.status, "acknowledged");
  ok(await call(U.sp1, `/api/v2/txns/${t.id}/action`, { body: { action: "complete", ver: x.txn.ver, checklist: ["iPayroll", "MyESS"] } }));
  assert.ok((await full(U.sp1, t.id)).keydates.some((k) => k.kind === "effective"));
});
test("restricted records and requestor isolation", async () => {
  const t = await txn(U.sp1, "G_SUSPEND"); const r = await txn(U.ops, "C_PROJTR");
  assert.equal((await call(U.admin, "/api/v2/txns/" + t.id)).s, 403, "admin cannot read disciplinary record");
  assert.equal((await call(U.sp2, "/api/v2/txns/" + t.id)).s, 403, "other specialist cannot read restricted record");
  ok(await call(U.norwana, "/api/v2/txns/" + t.id));
  const list = ok(await call(U.ops, "/api/v2/txns")); assert.ok(list.rows.every((x) => x.originator === U.ops)); assert.ok(list.rows.some((x) => x.id === r.id));
  assert.equal(ok(await call(U.ops, "/api/data?since=0")).rows.length, 0, "requestor receives no HR register data");
  assert.equal((await call(U.ops, "/api/sync", { body: { put: [], del: [] } })).s, 403, "requestor cannot write HR register");
});
test("legacy (original HR Desk) sync contract and server-side letter rules", async () => {
  const id = "cTEST" + Date.now();
  const c = { id, ref: "HR-TEST", formId: 1, emp: "TEST_Legacy", status: "open", log: [], draft: { lid: "mvpro", status: "review", em: "spoofed@x.com", vals: {} } };
  const s1 = ok(await call(U.sp1, "/api/sync", { body: { put: [{ t: "case", id, ver: 0, data: c }], del: [] } }));
  assert.equal(s1.ok[0].data.draft.em, U.sp1, "preparer identity stamped by the server");
  const d = ok(await call(U.sp2, "/api/data?since=0")); assert.ok(d.rows.some((r) => r.id === id), "visible to another HR user");
  const letter = { ref: "TC/HR/PRO/2026/999/AS", caseId: id, lid: "mvpro", emp: "TEST_Legacy" };
  const bad = ok(await call(U.hairul, "/api/sync", { body: { put: [{ t: "letter", id: letter.ref + "|" + id, ver: 0, data: letter }] } }));
  assert.equal(bad.ok.length, 0); assert.ok(bad.notes.length, "HR Manager is not the default vetter for specialist letters");
  const good = ok(await call(U.norwana, "/api/sync", { body: { put: [{ t: "letter", id: letter.ref + "|" + id, ver: 0, data: letter }] } }));
  assert.equal(good.ok.length, 1); assert.equal(good.ok[0].data.revEm, U.norwana);
  const del = ok(await call(U.sp1, "/api/sync", { body: { put: [], del: [{ t: "letter", id: letter.ref + "|" + id, ver: 1 }] } }));
  assert.equal(del.ok.length, 0, "issued letter cannot be deleted");
  const n1 = ok(await call(U.sp1, "/api/next", { body: { k: "L2026" } })).n, n2 = ok(await call(U.sp2, "/api/next", { body: { k: "L2026" } })).n;
  assert.equal(n2, n1 + 1);
});
test("delegation lets an authorised user vet for Norwana; never own letter", async () => {
  const dl = ok(await call(U.norwana, "/api/v2/admin/delegations", { body: { to_email: U.sp2, start_date: "2026-01-01", end_date: "2030-12-31", reason: "TEST leave" } }));
  const t = await validated("B_CONFIRM"); await approveAll(t.id);
  const L = ok(await call(U.sp1, `/api/v2/txns/${t.id}/letters`, { body: { template_code: "conf", vals: { eff: "2026-12-01" } } }));
  let l = (await full(U.sp1, t.id)).letters[0];
  ok(await call(U.sp1, `/api/v2/letters/${L.id}/action`, { body: { action: "submit", ver: l.ver } })); l = (await full(U.sp1, t.id)).letters[0];
  ok(await call(U.sp2, `/api/v2/letters/${L.id}/action`, { body: { action: "release", ver: l.ver } }));
  ok(await call(U.norwana, `/api/v2/admin/delegations/${dl.id}/revoke`, { body: {} }));
});
