// /ads-summary harness for cloudflare-worker.js.
//
//   node tests/worker/ads-harness.mjs
//
// Unlike tickets, this endpoint has exactly one writer (the Ads Daily Summary
// Routine, once a day), so none of the multi-edge conflict machinery applies.
// What matters here: the automation-key auth path works without a user login,
// a normal user token still works too, a day can be upserted (re-run same day
// without duplicating), history is capped, and a bad payload is rejected.
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
  const shim = path.join(os.tmpdir(), 'sahibas-worker-ads-' + process.pid + '.mjs');
  fs.copyFileSync(src, shim);
  const mod = await import(pathToFileURL(shim).href);
  const worker = mod.default;

  // SEED_USERS in the real Worker no longer carries real passwords, so tests
  // seed their own synthetic user straight into the fake KV instead.
  const TEST_EMAIL = 'test-owner@example.com', TEST_PASS = 'test-pw-only';
  const kv = new FakeKV();
  await kv.put('auth_users', JSON.stringify({ [TEST_EMAIL]: { name: 'Test Owner', hash: await mod.hashPassword('test-secret', TEST_PASS) } }));
  const env = { AUTH_SECRET: 'test-secret', PO_STORE: kv, AUTOMATION_KEY: 'test-automation-key' };
  const day = (date, spend, revenue) => ({ date, campaigns: [{ name: 'Veil 1', platform: 'meta', spend, revenue, roas: spend ? revenue / spend : 0, purchases: 1, decision: 'scale' }] });

  const postAuto = (body) => worker.fetch(new Request('https://w/ads-summary', { method: 'POST', headers: { 'X-Automation-Key': 'test-automation-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
  // GET is a normal read, gated the same as every other endpoint -- only a
  // logged-in user (the app), never the automation key, which only ever posts.
  let userTok;
  const get = async () => {
    if (!userTok) {
      const lr = await worker.fetch(new Request('https://w/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }) }), env);
      userTok = (await lr.json()).token;
    }
    return worker.fetch(new Request('https://w/ads-summary', { headers: { Authorization: 'Bearer ' + userTok } }), env).then(r => r.json());
  };

  console.log('=== 1. Automation key authenticates without a user login ===');
  const r1 = await postAuto(day('2026-09-01', 1000, 4000));
  const j1 = await r1.json();
  console.log('  status ' + r1.status + ' -> ' + JSON.stringify(j1) + (r1.status === 200 ? '  ✓' : '  ✗'));

  console.log('\n=== 2. Wrong or missing key is rejected ===');
  const rBad = await worker.fetch(new Request('https://w/ads-summary', { method: 'POST', headers: { 'X-Automation-Key': 'nope', 'Content-Type': 'application/json' }, body: JSON.stringify(day('2026-09-02', 1, 1)) }), env);
  const rNone = await worker.fetch(new Request('https://w/ads-summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(day('2026-09-02', 1, 1)) }), env);
  console.log('  wrong key -> ' + rBad.status + (rBad.status === 401 ? '  ✓' : '  ✗') + ' · no key -> ' + rNone.status + (rNone.status === 401 ? '  ✓' : '  ✗'));

  console.log('\n=== 3. A real user token also works (manual testing from a logged-in tab) ===');
  const loginR = await worker.fetch(new Request('https://w/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }) }), env);
  const tok = (await loginR.json()).token;
  const rUser = await worker.fetch(new Request('https://w/ads-summary', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(day('2026-09-02', 2000, 9000)) }), env);
  console.log('  user-token POST -> ' + rUser.status + (rUser.status === 200 ? '  ✓' : '  ✗'));

  console.log('\n=== 4. Re-posting the same date upserts, does not duplicate ===');
  await postAuto(day('2026-09-02', 2500, 11000)); // corrected number for a date already saved
  const hist1 = await get();
  const sep2 = hist1.filter(d => d.date === '2026-09-02');
  console.log('  entries for 2026-09-02: ' + sep2.length + (sep2.length === 1 ? '  ✓' : '  ✗') + ' · latest value kept: ' + (sep2[0] && sep2[0].campaigns[0].spend === 2500));

  console.log('\n=== 5. History stays sorted oldest-first regardless of arrival order ===');
  const dates = hist1.map(d => d.date);
  const sorted = [...dates].sort();
  console.log('  order: ' + JSON.stringify(dates) + (JSON.stringify(dates) === JSON.stringify(sorted) ? '  ✓' : '  ✗'));

  console.log('\n=== 6. History caps at the configured window ===');
  for (let i = 3; i <= 65; i++) {
    const d = '2026-' + String(9 + Math.floor(i / 30)).padStart(2, '0') + '-' + String((i % 28) + 1).padStart(2, '0');
    await postAuto(day(d, 100, 100));
  }
  const hist2 = await get();
  console.log('  posted 65+ distinct-ish days -> stored: ' + hist2.length + (hist2.length <= 60 ? '  ✓ capped' : '  ✗ uncapped'));

  console.log('\n=== 7. Malformed payloads are rejected, not silently stored ===');
  const rNoDate = await postAuto({ campaigns: [] });
  const rBadJson = await worker.fetch(new Request('https://w/ads-summary', { method: 'POST', headers: { 'X-Automation-Key': 'test-automation-key', 'Content-Type': 'application/json' }, body: '{not json' }), env);
  console.log('  missing date -> ' + rNoDate.status + (rNoDate.status === 400 ? '  ✓' : '  ✗') + ' · broken JSON -> ' + rBadJson.status + (rBadJson.status === 400 ? '  ✓' : '  ✗'));

  console.log('\n=== 8. GET with no history yet returns an empty array, not null/error ===');
  const kv2 = new FakeKV();
  await kv2.put('auth_users', JSON.stringify({ [TEST_EMAIL]: { name: 'Test Owner', hash: await mod.hashPassword('test-secret', TEST_PASS) } }));
  const env2 = { AUTH_SECRET: 'test-secret', PO_STORE: kv2, AUTOMATION_KEY: 'test-automation-key' };
  const lr2 = await worker.fetch(new Request('https://w/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }) }), env2);
  const tok2 = (await lr2.json()).token;
  const rEmpty = await worker.fetch(new Request('https://w/ads-summary', { headers: { Authorization: 'Bearer ' + tok2 } }), env2);
  const jEmpty = await rEmpty.json();
  console.log('  status ' + rEmpty.status + ' body ' + JSON.stringify(jEmpty) + (Array.isArray(jEmpty) && jEmpty.length === 0 ? '  ✓' : '  ✗'));

  console.log('\n=== 9. A GitHub mirror failure (no token configured here) still saves the data ===');
  const j9 = await (await postAuto(day('2026-09-01', 1, 1))).json();
  console.log('  ' + JSON.stringify(j9) + (j9.ok === true && j9.githubMirror === 'failed' ? '  ✓ saved despite mirror failure' : '  ✗'));
}
main().catch(e => { console.error(e); process.exit(1); });
