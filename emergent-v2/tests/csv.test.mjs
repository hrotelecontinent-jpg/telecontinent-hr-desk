import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const html=await readFile(new URL('../secure-app/index.html',import.meta.url),'utf8');
const helper=html.slice(html.indexOf('function csvCell('),html.indexOf(' async function v1Sig'));
const context=vm.createContext({});vm.runInContext(helper,context);
test('CSV exports neutralize spreadsheet formulas without changing numeric cells',()=>{
 for(const value of ['=HYPERLINK("https://example.test")','+cmd','-1+2','@SUM(A1)','\t=1','\r=1']) assert.equal(context.csvCell(value),"'"+value);
 assert.equal(context.csvCell(-42),'-42');assert.equal(context.csvCell('Ordinary text'),'Ordinary text');assert.equal(context.csvCell(null),'');
});
