// Builds secure-app/index.html from the UNCHANGED original HR Desk (backup/original) plus the v2 workflow modules.
// Every patch must match exactly once, otherwise the build stops (so the original is never silently altered).
// Run: node tools/build-secure-app.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
let html = fs.readFileSync(path.join(root, "backup/original/Telecontinent_HR_Desk_ORIGINAL_UNCHANGED.html"), "utf8");
const BLANK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const patches = [
  // 1. Remove the embedded signature image from public source. The Worker supplies it only for released letters.
  [/^const LH_SIG="(?:data:image\/png;base64,[^"]+)?";?[^\n]*$/m, 'let LH_SIG=""; /* signature image removed from public source: supplied by the Worker only for a released letter, every use logged */\nconst BLANK_PNG="' + BLANK_PNG + '";'],
  ['img:!x.draft&&sameName(x.sn,SIGNER.n)', 'img:!x.draft&&!!LH_SIG&&sameName(x.sn,SIGNER.n)'],
  ['{n:"word/media/sig.png",d:b64u8(LH_SIG)}', '{n:"word/media/sig.png",d:b64u8(LH_SIG||BLANK_PNG)}'],
  // 2. Issued letters (original register): fetch the signature from the server just before print / Word, then discard it.
  ['if(t.dataset.lpr){const o=', 'if(t.dataset.lpr||t.dataset.lwd){if(!await v1Sig(reissue.ref))return}if(t.dataset.lpr){const o='],
  // 3. Server-checked maker-checker before the original "Approve and issue" (the Worker also enforces it on save).
  ['if(isMine(c.draft)){toast("You prepared this letter. Another Lead HR or the HR Manager must approve it.");return}if(!ready())return;',
   'if(isMine(c.draft)){toast("You prepared this letter. Another Lead HR or the HR Manager must approve it.");return}if(CLOUD){try{const vc=await capi("v2/vetcheck?em="+encodeURIComponent(c.draft.em||""));if(!vc.ok){toast(vc.why);return}}catch(err){toast("HR Desk could not confirm your vetting authority. Check the connection.");return}}if(!ready())return;'],
  // 4. Register the workflow views without changing the original ones.
  ['const fn={dash:rDash,cases:rCases,mgr:rMgr,pay:rPay,find:rFind,lib:rLib,keys:rKeys,tools:rTools,data:rData}[view];m.innerHTML=fn();bind();navRoles();}',
   'const fn=Object.assign({dash:rDash,cases:rCases,mgr:rMgr,pay:rPay,find:rFind,lib:rLib,keys:rKeys,tools:rTools,data:rData},window.V2VIEWS||{})[view]||rDash;m.innerHTML=fn();bind();navRoles();if(window.v2Nav)window.v2Nav();if(window.v2After)window.v2After(view);}'],
  // 5. Second navigation row for the workflow modules (original row unchanged).
  ['<button data-v="data">Data</button></nav>',
   '<button data-v="data">Data</button></nav>\n<nav class="v2nav" aria-label="Workflow"><button data-v="w_dash" data-testid="nav-w-dash">Workflow</button><button data-v="w_new" data-testid="nav-w-new">New request</button><button data-v="w_work" data-testid="nav-w-work">My work</button><button data-v="w_appr" data-testid="nav-w-appr">Pending approvals</button><button data-v="w_letters" data-testid="nav-w-letters">Letters &amp; vetting</button><button data-v="w_reg" data-testid="nav-w-reg">Movement register</button><button data-v="w_tpl" data-testid="nav-w-tpl">Letter library</button><button data-v="w_pay" data-testid="nav-w-pay">Payroll handover</button><button data-v="w_rep" data-testid="nav-w-rep">Reports</button><button data-v="w_admin" data-testid="nav-w-admin">Administration</button></nav>'],
  ['<title>HR Desk - Telecontinent</title>', '<title>Telecontinent HR Desk</title>']
];
for (const [from, to] of patches) {
  const n = typeof from === "string" ? html.split(from).length - 1 : (html.match(new RegExp(from.source, "gm")) || []).length;
  if (n !== 1) { console.error("PATCH FAILED (" + n + " matches):", String(from).slice(0, 90)); process.exit(1); }
  html = typeof from === "string" ? html.replace(from, () => to) : html.replace(from, () => to);
}
if (/data:image\/png;base64,iVBORw0KGgoAAAANSUhEUgAAAvgAAADqCAYAAADXozFa/.test(html)) { console.error("Signature image still present"); process.exit(1); }
const csvExpression = 'String(x==null?"":x).replace(/"/g,\'""\')';
if (html.split(csvExpression).length - 1 !== 2) throw new Error("Original CSV export patches must match twice");
html = html.split(csvExpression).join('csvCell(x).replace(/"/g,\'""\')');
const helper = 'function csvCell(value){let s=String(value==null?"":value);return typeof value==="string"&&/^[\\s\\u0000-\\u001f]*[=+@-]/.test(s)?"\'"+s:s} async function v1Sig(ref){LH_SIG="";try{const s=await capi("sig?ref="+encodeURIComponent(ref));if(s.available){LH_SIG=s.dataUrl;setTimeout(()=>{LH_SIG=""},2000);return true}}catch(e){}toast("The preserved signature must be configured in private storage before final letters can be generated.");return false}';
const css = '<style>.hwrap{flex-wrap:wrap}.v2nav{display:flex;flex-wrap:wrap;gap:2px;flex-basis:100%;order:10;margin-top:4px;border-top:1px solid rgba(255,255,255,.2);padding-top:4px}.v2nav button{font-size:12px}.kpi:hover{box-shadow:0 2px 8px rgba(0,0,0,.12)}#devsw{background:#C55A11;color:#fff;border:0;border-radius:4px;font-size:11px;margin-right:6px;max-width:260px}</style>';
const read = (f) => fs.readFileSync(path.join(root, "secure-app-src", f), "utf8").replace(/<\/script/gi, "<\\/script");
html = html.replace(/<\/body><\/html>\s*$/, () => css + "<script>" + helper + "</script><script>" + read("v2letters.js") + "</script><script>" + read("v2.js") + "</script></body></html>\n");
if (!html.includes("V2VIEWS={}")) { console.error("v2 module not injected"); process.exit(1); }
fs.writeFileSync(path.join(root, "secure-app/index.html"), html);
console.log("secure-app/index.html built:", html.length, "bytes");
