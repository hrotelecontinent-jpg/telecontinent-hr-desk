import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../secure-app-src/v2.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('async function withSig('), source.indexOf('\nasync function fileFinal'));
test('final outputs wait for the private signature and never silently substitute a name', async () => {
  const ctx = vm.createContext({ LH_SIG: '', api: async () => ({ available: false }), toast: () => {} });
  vm.runInContext(helper, ctx);
  let generated = false;
  assert.equal(await ctx.withSig('released-test', () => { generated = true; }), false);
  assert.equal(generated, false);
  const fixture = 'data:image/png;base64,TEST_FIXTURE_ONLY';
  ctx.api = async () => ({ available: true, dataUrl: fixture });
  assert.equal(await ctx.withSig('released-test', async () => {
    await Promise.resolve();
    assert.equal(ctx.LH_SIG, fixture);
    generated = true;
  }), true);
  assert.equal(generated, true); assert.equal(ctx.LH_SIG, '');
  await assert.rejects(ctx.withSig('released-test', async () => { throw Error('generation failed'); }));
  assert.equal(ctx.LH_SIG, '');
});
