const {chromium:pw}=require('playwright');
const chromium=require('@sparticuz/chromium');
const {unzipSync}=require('fflate');
const base=process.env.BASE || 'http://127.0.0.1:8787';
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname))throw Error('Browser checks are local only');
(async()=>{
 if((await fetch(base+'/api/health').then(r=>r.json())).environment!=='development')throw Error('Development simulator required');
 const browser=await pw.launch({executablePath:await chromium.executablePath(),args:chromium.args,headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const response=await page.goto(base+'/',{waitUntil:'networkidle'});if(response.status()!==200)throw Error('Page failed');
 await page.waitForFunction(()=>document.querySelector('#main')?.textContent.includes('Dashboard'));
 const forms=await page.evaluate(()=>FORMS.map(f=>{const b=formDocxBytes(f.id);return {id:f.id,bytes:b.length,zip:b[0]===80&&b[1]===75,data:Array.from(b)}}));
 if(forms.length!==22||forms.some(f=>!f.zip||!f.bytes))throw Error('Form download generation failed');
 for(const form of forms) {const zip=unzipSync(Uint8Array.from(form.data));if(!zip['word/document.xml'])throw Error('Invalid Word form '+form.id);}
 let checked=0;
 for(const view of ['dash','cases','mgr','pay','find','lib','keys','tools','data','w_dash','w_new','w_work','w_appr','w_letters','w_reg','w_tpl','w_pay','w_rep']){
  const button=page.locator('nav [data-v="'+view+'"]').first();if(!await button.isVisible())continue;
  await button.click();await page.waitForTimeout(180);checked++;
 }
 const signed=await page.evaluate(async()=>{
   const listing=await fetch('/api/v2/letters').then(r=>r.json());const l=listing.rows.find(l=>l.status==='released');if(!l)throw Error('Run API fixture suite before browser checks');
   const x=await fetch('/api/v2/txns/'+l.txn_id).then(r=>r.json());const letter=x.letters.find(y=>y.id===l.id);
   const sig=await fetch('/api/v2/letters/'+l.id+'/signature').then(r=>r.json());if(!sig.available)throw Error('Synthetic signature fixture missing');
   const L=LBYID(letter.template_code),v=letter.versions[letter.versions.length-1].vals;
   const o={ref:letter.ref,date:letter.released_at.slice(0,10),name:x.txn.emp_name,id:x.txn.emp_id||'',dept:'TEST',sn:letter.signatory_name,st:letter.signatory_title,draft:false};
   LH_SIG=sig.dataUrl;
   try {
     const final=letterDoc(L,v,o,false),draft=letterDoc(L,v,{...o,draft:true},false);
     const blob=docxBlob(L,v,o);
     return {finalHasSignature:final.includes(sig.dataUrl),draftHasSignature:draft.includes(sig.dataUrl),docx:Array.from(new Uint8Array(await blob.arrayBuffer())),signature:sig.dataUrl.split(',')[1]};
   }finally{LH_SIG='';}
 });
 if(!signed.finalHasSignature||signed.draftHasSignature)throw Error('Final/draft signature visibility failed');
 const media=unzipSync(Uint8Array.from(signed.docx))['word/media/sig.png'];
 if(!media||!Buffer.from(media).equals(Buffer.from(signed.signature,'base64')))throw Error('Word signature bytes changed');
 if(errors.length)throw Error('Runtime errors: '+errors.join('; '));
 console.log(JSON.stringify({page:response.status(),forms_generated:forms.length,navigation_views_checked:checked,javascript_errors:errors.length,final_signature_bytes_preserved:true,drafts_unsigned:true}));
 await browser.close();
})().catch(e=>{console.error(e.message);process.exitCode=1});
