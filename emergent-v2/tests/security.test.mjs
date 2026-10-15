import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Load a test-only named export without changing the Worker's deployment exports.
const source = (await readFile(new URL('../worker.js', import.meta.url), 'utf8'))
  .replace('"fflate"', JSON.stringify(import.meta.resolve('fflate')))
  .replace('"./seed.js"', JSON.stringify(new URL('../seed.js', import.meta.url).href));
const { default: worker, verifyAccessJwt } = await import('data:text/javascript;base64,' +
  Buffer.from(source + '\nexport { verifyAccessJwt };').toString('base64'));

let validToken;

test('Access tokens require valid signature, algorithm, issuer, audience and time claims', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'test-key' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ keys: [jwk] });
  const env = { TEAM_DOMAIN: 'test.cloudflareaccess.com', POLICY_AUD: 'test-audience' };
  const claims = { email: 'fictional@example.test', aud: ['test-audience'],
    iss: 'https://test.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 120 };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  async function token(payload, alg = 'RS256') {
    const input = encode({ alg, kid: 'test-key' }) + '.' + encode(payload);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(input));
    return input + '.' + Buffer.from(sig).toString('base64url');
  }
  try {
    const valid = await token(claims); validToken = valid;
    assert.equal(await verifyAccessJwt(valid, env), claims.email);
    for (const change of [{ exp: undefined }, { exp: 1 }, { iss: undefined },
      { iss: 'https://other.cloudflareaccess.com' }, { aud: ['other'] },
      { nbf: Math.floor(Date.now() / 1000) + 3600 }]) {
      assert.equal(await verifyAccessJwt(await token({ ...claims, ...change }), env), null);
    }
    assert.equal(await verifyAccessJwt(await token(claims, 'HS256'), env), null);
    assert.equal(await verifyAccessJwt(valid + '.extra', env), null);
    const altered = valid.split('.'); altered[1] = encode({ ...claims, email: 'forged@example.test' });
    assert.equal(await verifyAccessJwt(altered.join('.'), env), null);
  } finally { globalThis.fetch = originalFetch; }
});

test('static pages fail closed for denied users and database errors', async () => {
  let served = false;
  const env = { ENVIRONMENT: 'development', DEV_AUTH: '1',
    ASSETS: { fetch: async () => { served = true; return new Response('private'); } } };
  // Production has no JWT: it must not serve assets.
  const unauth = await worker.fetch(new Request('https://example.test/'), { ...env, ENVIRONMENT: 'production',
    TEAM_DOMAIN: 'test.cloudflareaccess.com', POLICY_AUD: 'test-audience' });
  assert.equal(unauth.status, 401); assert.equal(served, false);
  const production = { ...env, ENVIRONMENT: 'production', TEAM_DOMAIN: 'test.cloudflareaccess.com',
    POLICY_AUD: 'test-audience', ALLOWED_DOMAIN: 'example.test' };
  const request = () => new Request('https://example.test/', { headers: { 'cf-access-jwt-assertion': validToken } });
  const denied = await worker.fetch(request(), { ...production, DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } });
  assert.equal(denied.status, 403); assert.equal(served, false);
  const originalError=console.error; console.error=()=>{};
  let failed; try {failed = await worker.fetch(request(), production);}finally{console.error=originalError;}
  assert.equal(failed.status, 500); assert.equal(served, false);
  assert.deepEqual(await failed.json(), { error: 'Server error. Contact the HR Desk administrator.' });
});
