/**
 * Telecontinent HR Desk — Cloudflare Worker backend.
 * Existing HR Desk HTML is served unmodified except for its D1 adapter.
 * IMPORTANT: Cloudflare Access MUST protect ALL traffic to every Worker URL.
 * This application relies on that edge authentication. It is not a replacement
 * for role-based case-level authorization or a completed security review.
 */
const KINDS = new Set(['cases', 'keydates', 'letters']);
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hrdesk_objects (
    kind TEXT NOT NULL CHECK(kind IN ('cases','keydates','letters')),
    record_id TEXT NOT NULL,
    data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(kind, record_id)
  )`,
  `CREATE TABLE IF NOT EXISTS hrdesk_sequences (
    kind TEXT NOT NULL CHECK(kind IN ('case','letter')),
    year INTEGER NOT NULL,
    last_num INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(kind, year)
  )`,
  `CREATE TABLE IF NOT EXISTS hrdesk_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_email TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`
];
let schemaPromise;
async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const sql of SCHEMA) await db.prepare(sql).run();
    })().catch(err => { schemaPromise = null; throw err; });
  }
  return schemaPromise;
}
function json(value, status=200) {
  return new Response(JSON.stringify(value), {
    status, headers: {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}
  });
}
async function readJSON(request) {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json'))
    throw Object.assign(new Error('Expected JSON'),{status:415});
  if (+(request.headers.get('content-length') || 0) > 512_000)
    throw Object.assign(new Error('Record too large'),{status:413});
  const data=await request.text();
  if (data.length > 512_000) throw Object.assign(new Error('Record too large'),{status:413});
  try { return JSON.parse(data || '{}'); } catch {
    throw Object.assign(new Error('Invalid JSON'),{status:400});
  }
}
// Access applies at Cloudflare's edge; never rely on a typed display name for permissions.
function actorEmail(request) {
  return request.headers.get('Cf-Access-Authenticated-User-Email') || null;
}
async function syncAll(db) {
  const result=await db.prepare('SELECT kind, record_id, data, version FROM hrdesk_objects ORDER BY kind, created_at').all();
  const out={cases:[],keydates:[],letters:[]};
  for (const row of result.results || []) {
    if (!KINDS.has(row.kind)) continue;
    try { out[row.kind].push({id:row.record_id, data:JSON.parse(row.data), version:row.version}); }
    catch { throw new Error('A stored record could not be decoded; contact the administrator'); }
  }
  return out;
}
async function objectMutation(db, request) {
  const body=await readJSON(request);
  const {kind,id,action,version,data}=body;
  if (!KINDS.has(kind)||typeof id!=='string'||id.length<1||id.length>128||!['upsert','delete'].includes(action)||!Number.isSafeInteger(version)||version<0)
    return json({error:'Invalid record request'},400);
  if (action==='upsert' && (!data || typeof data !== 'object' || Array.isArray(data)))
    return json({error:'Invalid record data'},400);
  const actor=actorEmail(request);
  // D1 conditional writes prevent silent overwrites if another HR specialist updated a record.
  if (action==='upsert') {
    const packed=JSON.stringify(data);
    if (packed.length>450_000) return json({error:'Record exceeds size limit'},413);
    if (version===0) {
      const changes=await db.prepare('INSERT INTO hrdesk_objects(kind,record_id,data,version) VALUES(?,?,?,1) ON CONFLICT(kind,record_id) DO NOTHING')
        .bind(kind,id,packed).run();
      if (changes.meta?.changes!==1) return json({error:'Record changed by another user. Refresh before editing.'},409);
      await db.prepare('INSERT INTO hrdesk_audit(kind,record_id,action,actor_email) VALUES(?,?,?,?)').bind(kind,id,'create',actor).run();
      return json({ok:true,version:1});
    }
    const changes=await db.prepare('UPDATE hrdesk_objects SET data=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE kind=? AND record_id=? AND version=?')
      .bind(packed,kind,id,version).run();
    if (changes.meta?.changes!==1) return json({error:'Record changed by another user. Refresh before editing.'},409);
    await db.prepare('INSERT INTO hrdesk_audit(kind,record_id,action,actor_email) VALUES(?,?,?,?)').bind(kind,id,'update',actor).run();
    return json({ok:true,version:version+1});
  }
  if (version===0) return json({error:'Unknown record'},409);
  const changes=await db.prepare('DELETE FROM hrdesk_objects WHERE kind=? AND record_id=? AND version=?').bind(kind,id,version).run();
  if (changes.meta?.changes!==1) return json({error:'Record changed by another user. Refresh before deleting.'},409);
  await db.prepare('INSERT INTO hrdesk_audit(kind,record_id,action,actor_email) VALUES(?,?,?,?)').bind(kind,id,'delete',actor).run();
  return json({ok:true,deleted:true});
}
async function nextRef(db,request) {
  const body=await readJSON(request);
  const kind=body.kind==='letter'?'letter':'case';
  const year=new Date().getUTCFullYear();
  // Single database statement allocates non-duplicating numbers across concurrent users.
  const row=await db.prepare(`INSERT INTO hrdesk_sequences(kind,year,last_num) VALUES(?,?,1)
    ON CONFLICT(kind,year) DO UPDATE SET last_num=last_num+1 RETURNING last_num`)
      .bind(kind,year).first();
  if (!row) throw new Error('Reference allocation failed');
  return json({ref:(kind==='letter'?'HR-LTR-':'HR-')+year+'-'+String(row.last_num).padStart(3,'0')});
}
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    if(!env.DB) return json({error:'D1 binding DB not configured'},503);
    try {
      await ensureSchema(env.DB);
      if (path==='/api/health' && request.method==='GET') {
        const row=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hrdesk_objects'").first();
        return json({database:'connected',hrdesk_objects_table:!!row});
      }
      if (path==='/api/sync' && request.method==='GET') return json(await syncAll(env.DB));
      if (path==='/api/object' && request.method==='POST') return await objectMutation(env.DB,request);
      if (path==='/api/next-ref' && request.method==='POST') return await nextRef(env.DB,request);
      return json({error:'Not found'},404);
    }catch(err){
      if(err.status) return json({error:err.message},err.status);
      console.error('HR Desk API error:',err);
      return json({error:'Server/database error. Contact HR Desk administrator.'},500);
    }
  }
};
