// /admin-create-user harness for cloudflare-worker.js.
//
//   node tests/worker/auth-harness.mjs
//
// SEED_USERS no longer carries real passwords, so this is the only path that
// creates a login. Owner-only, must reject a weak password, must not clobber
// an existing email, and the created login must actually work afterward.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

class FakeKV {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, val) { this.store.set(key, val); }
}

async function main() {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const src = path.resolve(dir, '..', '..', 'cloudflare-worker.js');
  const shim = path.join(os.tmpdir(), 'sahibas-worker-auth-' + process.pid + '.mjs');
  fs.copyFileSync(src, shim);
  const mod = await import(pathToFileURL(shim).href);
  const worker = mod.default;

  const OWNER_EMAIL = 'junaidsarwar82@gmail.com', OWNER_PASS = 'owner-pw-only';
  const kv = new FakeKV();
  await kv.put('auth_users', JSON.stringify({ [OWNER_EMAIL]: { name: 'Junaid Sarwar', hash: await mod.hashPassword('test-secret', OWNER_PASS) } }));
  const env = { AUTH_SECRET: 'test-secret', PO_STORE: kv };

  const login = async (email, password) => {
    const r = await worker.fetch(new Request('https://w/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }), env);
    return { status: r.status, body: await r.json() };
  };
  const ownerTok = (await login(OWNER_EMAIL, OWNER_PASS)).body.token;
  const createUser = (body, tok) => worker.fetch(new Request('https://w/admin-create-user', { method: 'POST', headers: { Authorization: 'Bearer ' + (tok || ownerTok), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env).then(async r => ({ status: r.status, body: await r.json() }));

  console.log('=== 1. Owner creates a new user ===');
  const r1 = await createUser({ name: 'Irsa Haider', email: 'irsahaider02@gmail.com', password: 'XiuyaQdXQHv' });
  console.log('  status ' + r1.status + ' -> ' + JSON.stringify(r1.body) + (r1.status === 200 && r1.body.ok ? '  ✓' : '  ✗'));

  console.log('\n=== 2. The new login actually works ===');
  const r2 = await login('irsahaider02@gmail.com', 'XiuyaQdXQHv');
  console.log('  status ' + r2.status + ' -> token issued: ' + !!r2.body.token + ' · name: ' + (r2.body.user && r2.body.user.name) + (r2.status === 200 && r2.body.token && r2.body.user.name === 'Irsa Haider' ? '  ✓' : '  ✗'));

  console.log('\n=== 3. Duplicate email is rejected, does not overwrite ===');
  const r3 = await createUser({ name: 'Someone Else', email: 'irsahaider02@gmail.com', password: 'different-pw' });
  const r3login = await login('irsahaider02@gmail.com', 'XiuyaQdXQHv'); // original password still works
  console.log('  create -> status ' + r3.status + ' ' + JSON.stringify(r3.body) + (r3.status === 409 ? '  ✓ rejected' : '  ✗') + ' · original password still works: ' + !!r3login.body.token);

  console.log('\n=== 4. Non-Owner cannot create users ===');
  const r4 = await createUser({ name: 'Nope', email: 'nope@example.com', password: 'whatever1' }, r2.body.token);
  console.log('  status ' + r4.status + ' -> ' + JSON.stringify(r4.body) + (r4.status === 403 ? '  ✓ blocked' : '  ✗'));

  console.log('\n=== 5. Weak password rejected ===');
  const r5 = await createUser({ name: 'Weak', email: 'weak@example.com', password: '123' });
  console.log('  status ' + r5.status + ' -> ' + JSON.stringify(r5.body) + (r5.status === 400 ? '  ✓ rejected' : '  ✗'));

  console.log('\n=== 6. Missing name / bad email rejected ===');
  const r6a = await createUser({ email: 'noname@example.com', password: 'longenough1' });
  const r6b = await createUser({ name: 'Bad Email', email: 'not-an-email', password: 'longenough1' });
  console.log('  no name -> ' + r6a.status + (r6a.status === 400 ? '  ✓' : '  ✗') + ' · bad email -> ' + r6b.status + (r6b.status === 400 ? '  ✓' : '  ✗'));
}
main().catch(e => { console.error(e); process.exit(1); });
