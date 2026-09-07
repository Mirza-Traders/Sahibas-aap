// Ticket-store harness for cloudflare-worker.js.
//
//   node tests/worker/tickets-harness.mjs
//
// Runs the real Worker against a fake KV that behaves like Cloudflare KV: a
// write is visible at once at the edge that made it, and other edges keep
// serving the previous value for up to 60s. Then plays the sequences that
// lost tickets in production. Keep this passing: it is the reason the store
// is one key per ticket and not one blob.
//
// To also see the OLD single-blob worker lose a ticket under the same race,
// drop a copy of it next to this file as old-worker.mjs (e.g. from git history).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STALE_MS = 60_000;

// One "global" store plus a per-edge view that lags it.
class FakeKV {
  constructor() { this.global = new Map(); this.edges = new Map(); this.now = 0; this.puts = 0; this.ops = 0; this.maxOps = 0; }
  // Every KV call is one subrequest against Cloudflare's per-request cap (50 free / 1000 paid).
  // A bulk get() of up to 100 keys is ONE call. reset() marks a request boundary.
  reset() { this.ops = 0; }
  tick() { this.ops++; if (this.ops > this.maxOps) this.maxOps = this.ops; }
  edge(name) {
    const kv = this;
    if (!kv.edges.has(name)) kv.edges.set(name, new Map()); // key -> {val, seenAt}
    const view = kv.edges.get(name);
    return {
      async get(key) {
        kv.tick();
        if (Array.isArray(key)) {           // bulk form: Map of key -> value|null, one operation
          if (key.length > 100) throw new Error('KV bulk get: max 100 keys');
          const m = new Map();
          for (const k of key) m.set(k, await this._one(k));
          return m;
        }
        return this._one(key);
      },
      async _one(key) {
        // Serve from this edge's cache while it is younger than STALE_MS,
        // exactly as KV's minimum 60s edge cache does; otherwise fetch global.
        const c = view.get(key);
        if (c && kv.now - c.seenAt < STALE_MS) return c.val;
        const val = kv.global.has(key) ? kv.global.get(key) : null;
        view.set(key, { val, seenAt: kv.now });
        return val;
      },
      async put(key, val) {
        kv.tick(); kv.puts++;
        if (typeof val === 'string' && val.length > 25 * 1024 * 1024) throw new Error('KV PUT failed: value too large (max 25 MiB)');
        kv.global.set(key, val);
        view.set(key, { val, seenAt: kv.now }); // writer sees its own write at once
      },
      async delete(key) { kv.tick(); kv.global.delete(key); view.set(key, { val: null, seenAt: kv.now }); },
      async list({ prefix, cursor }) {
        kv.tick();
        // list() is eventually consistent like everything else: a key written
        // seconds ago can be missing from this edge's view of the listing for
        // STALE_MS. Modelled as a cached snapshot per edge, refreshed when stale.
        const ck = '\u0000list:' + prefix;
        const c = view.get(ck);
        if (c && kv.now - c.seenAt < STALE_MS && !kv.listFresh) return { keys: c.val, list_complete: true, cursor: undefined };
        const keys = [...kv.global.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name }));
        view.set(ck, { val: keys, seenAt: kv.now });
        return { keys, list_complete: true, cursor: undefined };
      },
    };
  }
}

async function login(worker, kv, edge) {
  const env = { AUTH_SECRET: 'test-secret', PO_STORE: kv.edge(edge) };
  const r = await worker.fetch(new Request('https://w/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'junaidsarwar82@gmail.com', password: '0000' }) }), env);
  const j = await r.json();
  if (!j.token) throw new Error('login failed: ' + JSON.stringify(j));
  return j.token;
}
function client(worker, kv, edge, token) {
  const env = { AUTH_SECRET: 'test-secret', PO_STORE: kv.edge(edge) };
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  return {
    async get() { kv.reset(); const r = await worker.fetch(new Request('https://w/tickets', { headers: H }), env); return { status: r.status, hdr: r.headers.get('X-Tickets-Store'), expose: r.headers.get('Access-Control-Expose-Headers'), body: await r.json() }; },
    async ping() { const r = await worker.fetch(new Request('https://w/ping'), env); return await r.json(); },
    async post(list) { kv.reset(); const r = await worker.fetch(new Request('https://w/tickets', { method: 'POST', headers: H, body: JSON.stringify(list) }), env); return { status: r.status, body: await r.json().catch(() => null) }; },
    async del(uids) { kv.reset(); const r = await worker.fetch(new Request('https://w/tickets/delete', { method: 'POST', headers: H, body: JSON.stringify({ uids }) }), env); return { status: r.status, body: await r.json().catch(() => null) }; },
  };
}
const T = (id, uid, customer, extra) => Object.assign({ id, uid, type: 'refund', status: 'initiated', customer, amount: 3000,
  createdAt: '2026-09-02 10:00', createdBy: 'Sana', history: [] }, extra || {});

// ── The race, as the team hits it ─────────────────────────────────────────
// Sana (Lahore edge) and Bano (Karachi edge). Both loaded the list a minute ago.
// Sana creates RX-080 and saves. Ten seconds later Bano creates RX-081 and saves.
// Bano's read is served her edge's cached (pre-Sana) copy.
async function raceWholeBlob(worker, label) {
  const kv = new FakeKV();
  kv.global.set('tickets', JSON.stringify([T('RX-079', 'RX-079', 'Old One', { createdAt: '2026-09-01 09:00' })]));
  const tok = await login(worker, kv, 'lahore');
  const sana = client(worker, kv, 'lahore', tok), bano = client(worker, kv, 'karachi', tok);
  kv.now = 0;
  const s0 = (await sana.get()).body, b0 = (await bano.get()).body;   // both read at t=0
  kv.now = 5_000;
  await sana.post(s0.concat([T('RX-080', 'u-sana', 'Farhat Deebaj')]));                  // whole-array save (old client)
  kv.now = 15_000;
  const bRead = (await bano.get()).body;                                                 // Bano's read: served stale?
  await bano.post(bRead.concat([T('RX-081', 'u-bano', 'Someone Else')]));               // whole-array save (old client)
  kv.now = 120_000;                                                                      // caches expire
  const final = (await client(worker, kv, 'islamabad', tok).get()).body;
  const names = final.map(t => t.customer).sort();
  console.log(`${label}: Bano's read saw ${bRead.length} tickets (stale=${bRead.length === 1}); final server has ${final.length}: ${JSON.stringify(names)}`);
  return names;
}

async function main() {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const src = path.resolve(dir, '..', '..', 'cloudflare-worker.js');
  const shim = path.join(os.tmpdir(), 'sahibas-worker-' + process.pid + '.mjs');
  fs.copyFileSync(src, shim);
  const NEW = (await import(pathToFileURL(shim).href)).default;
  const oldPath = path.join(dir, 'old-worker.mjs');
  const OLD = fs.existsSync(oldPath) ? (await import(pathToFileURL(oldPath).href)).default : null;

  console.log('=== 1. The cross-edge race ===');
  if (OLD) {
    const oldNames = await raceWholeBlob(OLD, 'OLD worker (single blob)');
    console.log('  old worker lost Farhat Deebaj: ' + !oldNames.includes('Farhat Deebaj'));
  } else console.log('  (old-worker.mjs not present -- skipping the before/after comparison)');
  const newNames = await raceWholeBlob(NEW, 'NEW worker (per-ticket)  ');
  console.log('  new worker kept both new tickets: ' + (newNames.includes('Farhat Deebaj') && newNames.includes('Someone Else')));

  console.log('\n=== 2. Migration from the legacy blob ===');
  {
    const kv = new FakeKV();
    const legacy = [T('RX-001', undefined, 'A'), T('RX-002', undefined, 'B'), T('RX-003', 'u3', 'C')];
    kv.global.set('tickets', JSON.stringify(legacy));
    const tok = await login(NEW, kv, 'e1');
    const c = client(NEW, kv, 'e1', tok);
    const g = await c.get();
    const keys = [...kv.global.keys()].filter(k => k.startsWith('tk:')).sort();
    console.log('  header: ' + g.hdr + ' · returned ' + g.body.length + ' · keys: ' + JSON.stringify(keys));
    // A browser only lets page JS read a cross-origin header the server exposes.
    const exposed = /X-Tickets-Store/i.test(g.expose || '');
    console.log('  header readable by the browser (Access-Control-Expose-Headers): ' + exposed + ' · /ping store: ' + (await c.ping()).store);
    console.log('  legacy blob still present as backup: ' + kv.global.has('tickets') + ' · uids backfilled: ' + g.body.every(t => t.uid) + ' · _srv stamped: ' + g.body.every(t => t._srv));
    const before = kv.puts; await c.get();
    console.log('  second GET does not re-migrate (no new puts): ' + (kv.puts === before) + ' · _rev seeded: ' + g.body.every(t => t._rev === 1));
  }

  console.log('\n=== 3. Same-ticket conflict: the _rev check ===');
  for (const [label, edgeA, edgeB, gap] of [['same edge, any gap', 'e1', 'e1', 2_000], ['different edges, 90s apart', 'e1', 'e2', 90_000], ['different edges, 10s apart (KV cache window)', 'e1', 'e2', 10_000]]) {
    const kv = new FakeKV();
    kv.global.set('tickets', JSON.stringify([T('RX-010', 'u10', 'Rao', { status: 'initiated' })]));
    const tok = await login(NEW, kv, edgeA);
    const a = client(NEW, kv, edgeA, tok), b = client(NEW, kv, edgeB, tok);
    kv.now = 0;
    const aCopy = (await a.get()).body[0], bCopy = (await b.get()).body[0];
    kv.now = 1000; aCopy.status = 'paid';     await a.post([aCopy]);
    kv.now = 1000 + gap; bCopy.status = 'approved'; const rb = await b.post([bCopy]);
    kv.now = 500_000;
    const fin = (await client(NEW, kv, 'e9', tok).get()).body[0];
    const protectedOK = rb.body.skipped.length === 1 && fin.status === 'paid';
    console.log('  ' + label.padEnd(46) + ' -> B skipped=' + JSON.stringify(rb.body.skipped) + ' · final: ' + fin.status + (protectedOK ? '  ✓ protected' : '  ✗ B overwrote (KV cache served the Worker a stale _rev)'));
  }
  {
    // The SAME user edits twice in a row, and the second save is routed to an
    // edge whose cache still holds the older revision. The client is ahead of
    // that edge, not stale: it must not be rejected as a conflict.
    const kv = new FakeKV();
    kv.global.set('tickets', JSON.stringify([T('RX-011', 'u11', 'Rao', { status: 'initiated' })]));
    const tok = await login(NEW, kv, 'e1');
    const a1 = client(NEW, kv, 'e1', tok), a2 = client(NEW, kv, 'e2', tok);
    kv.now = 0;
    const copy = (await a1.get()).body[0];
    await a2.get();                                                   // e2 now caches the rev-1 copy
    kv.now = 1000; copy.status = 'received'; const r1 = await a1.post([copy]);
    copy._rev = r1.body.revs && r1.body.revs.u11;                     // client carries the stamped revision
    kv.now = 5000; copy.status = 'approved'; const r2 = await a2.post([copy]);
    kv.now = 500_000;
    const fin = (await client(NEW, kv, 'e9', tok).get()).body[0];
    const ok = r2.body.skipped.length === 0 && fin.status === 'approved';
    console.log('  same user, next edit lands on a stale edge     -> revs=' + JSON.stringify(r1.body.revs) + ' · skipped=' + JSON.stringify(r2.body.skipped) + ' · final: ' + fin.status + (ok ? '  ✓ not a false conflict' : '  ✗ own edit rejected'));
  }
  {
    // The raiser's tab: parked on the panel all day, holding its own ticket
    // with NO revision claim (older build, or saved before it learned the
    // revision). Meanwhile the warehouse moved the ticket on. The raiser adds a
    // note from the stale copy -- that must not put the status back.
    const kv = new FakeKV();
    kv.global.set('tickets', JSON.stringify([T('RX-012', 'u12', 'Sana Raised', { status: 'initiated' })]));
    const tok = await login(NEW, kv, 'e1');
    const raiser = client(NEW, kv, 'e1', tok), warehouse = client(NEW, kv, 'e1', tok);
    kv.now = 0;
    const stale = (await raiser.get()).body[0]; delete stale._rev;          // no claim, but _srv stays as read
    const fresh = (await warehouse.get()).body[0];
    kv.now = 60_000; fresh.status = 'received'; await warehouse.post([fresh]);
    kv.now = 120_000; stale.notes = 'customer called'; const rs = await raiser.post([stale]);
    kv.now = 500_000;
    const fin = (await client(NEW, kv, 'e9', tok).get()).body[0];
    const ok = rs.body.skipped.length === 1 && fin.status === 'received';
    console.log('  raiser\'s stale copy, no revision claim         -> skipped=' + JSON.stringify(rs.body.skipped) + ' · final: ' + fin.status + (ok ? '  ✓ could not put it back' : '  ✗ status went back'));
    // Same, but the copy carries neither _rev nor _srv: a ticket an OLD build
    // raised and never re-read. Nothing to compare against -- documented limit,
    // closed only by that tab reloading once (the periodic refresh does that).
    const bare = Object.assign({}, fin); delete bare._rev; delete bare._srv; bare.status = 'initiated';
    kv.now = 600_000; const rb = await raiser.post([bare]);
    console.log('  (limit) copy with no _rev and no _srv at all    -> skipped=' + JSON.stringify(rb.body.skipped) + ' -- only an old build can send this; a reload fixes it');
  }

  console.log('\n=== 4. An old-code tab saving the whole array cannot delete ===');
  {
    const kv = new FakeKV();
    kv.global.set('tickets', JSON.stringify([T('RX-020', 'u20', 'Keep Me'), T('RX-021', 'u21', 'Also Keep')]));
    const tok = await login(NEW, kv, 'e1');
    const c = client(NEW, kv, 'e1', tok);
    await c.get();
    await c.post([T('RX-020', 'u20', 'Keep Me')]);       // old tab's array is missing RX-021
    kv.now = 120_000;
    const fin = (await client(NEW, kv, 'e2', tok).get()).body.map(t => t.id).sort();
    console.log('  after whole-array POST missing RX-021, server has: ' + JSON.stringify(fin) + ' (nothing deleted: ' + fin.includes('RX-021') + ')');
    const d = await c.del(['u21']);
    kv.now = 240_000;
    const fin2 = (await client(NEW, kv, 'e3', tok).get()).body.map(t => t.id);
    console.log('  explicit /tickets/delete u21 -> ' + JSON.stringify(d.body) + ' · server now: ' + JSON.stringify(fin2));
  }

  console.log('\n=== 5. Two OLD tabs pick the same RX number (no uid, no _srv) ===');
  {
    const kv = new FakeKV();
    kv.global.set('tickets', JSON.stringify([]));
    const tok = await login(NEW, kv, 'e1');
    const a = client(NEW, kv, 'e1', tok), b = client(NEW, kv, 'e2', tok);
    await a.get(); await b.get();
    const ta = { id: 'RX-030', type: 'refund', status: 'initiated', customer: 'From Sana', createdAt: '2026-09-02 11:00', createdBy: 'Sana', history: [] };
    const tb = { id: 'RX-030', type: 'refund', status: 'initiated', customer: 'From Bano', createdAt: '2026-09-02 11:01', createdBy: 'Bano Hussain', history: [] };
    const ra = await a.post([ta]); const rb = await b.post([tb]);
    kv.now = 120_000;
    const fin = (await client(NEW, kv, 'e3', tok).get()).body.map(t => t.customer).sort();
    console.log('  second save renamed: ' + JSON.stringify(rb.body.renamed) + ' · server has: ' + JSON.stringify(fin) + ' (both kept: ' + (fin.length === 2) + ')');
  }

  console.log('\n=== 7. Subrequests per request stay under the free-plan cap (50) ===');
  {
    const kv = new FakeKV();
    const legacy = Array.from({ length: 79 }, (_, i) => T('RX-' + (100 + i), undefined, 'C' + i));
    kv.global.set('tickets', JSON.stringify(legacy));
    const tok = await login(NEW, kv, 'e1');
    const c = client(NEW, kv, 'e1', tok);
    const counts = [];
    let g;
    for (let i = 0; i < 5; i++) { g = await c.get(); counts.push(kv.ops); }   // migration runs in batches across these
    const st = JSON.parse(kv.global.get('tk_migrated'));
    console.log('  GET ops per request during migration: ' + JSON.stringify(counts) + ' · migration done after ' + (counts.findIndex((_, i) => i >= 2) + 1) + '+ reads: ' + st.done + ' · all 79 served every time: ' + (g.body.length === 79));
    // an OLD tab echoes the whole array back with one new ticket added
    const echo = g.body.concat([{ id: 'RX-200', type: 'refund', status: 'initiated', customer: 'New From Old Tab', createdAt: '2026-09-02 12:00', createdBy: 'Bano Hussain', history: [] }]);
    const r = await c.post(echo);
    console.log('  old-tab whole-array POST (80 tickets, 1 new): ops=' + kv.ops + ' · saved=' + r.body.saved.length + ' deferred=' + r.body.deferred.length + ' · only the new one written: ' + (kv.global.has('tk:RX-200')));
    // a new client's delta save
    const one = g.body[0]; one.status = 'received';
    await c.post([one]);
    console.log('  new-client delta POST (1 ticket): ops=' + kv.ops);
    await c.get();
    console.log('  steady-state GET (79 tickets): ops=' + kv.ops);
    console.log('  max ops seen in any single request: ' + kv.maxOps + '  (under 50: ' + (kv.maxOps < 50) + ')');
  }

  console.log('\n=== 8. Raise a ticket, press F5 within a minute ===');
  {
    const kv = new FakeKV();
    kv.global.set('tickets', JSON.stringify([T('RX-079', 'RX-079', 'Old One')]));
    const tok = await login(NEW, kv, 'lahore');
    const me = client(NEW, kv, 'lahore', tok), other = client(NEW, kv, 'karachi', tok);
    kv.now = 0;  await me.get(); await other.get();               // both edges now hold a listing snapshot WITHOUT the new key
    kv.now = 5_000;  await me.post([T('RX-082', 'u-new', 'Just Raised')]);
    kv.now = 10_000; const mine = (await me.get()).body.map(t => t.customer);
    const theirs = (await other.get()).body.map(t => t.customer);
    kv.now = 90_000; const later = (await other.get()).body.map(t => t.customer);
    console.log('  creator refreshes 5s later  -> sees it: ' + mine.includes('Just Raised') + '  (index carried it past the stale listing)');
    console.log('  colleague, other city, 5s   -> sees it: ' + theirs.includes('Just Raised') + '  (may lag up to a minute -- KV limit, not a loss)');
    console.log('  colleague, 85s later        -> sees it: ' + later.includes('Just Raised'));
    console.log('  index self-heals from listing: ' + JSON.parse(kv.global.get('tk_index')).includes('u-new'));
  }

  console.log('\n=== 6. Size ceiling ===');
  {
    const kv = new FakeKV();
    const big = 'x'.repeat(130 * 1024); // one compressed photo ≈ 129 KB
    const heavy = Array.from({ length: 79 }, (_, i) => T('RX-' + (100 + i), 'h' + i, 'C' + i, { chatScreenshot: big, receivedPhoto: big, paidPhoto: big }));
    const blob = JSON.stringify(heavy);
    console.log('  79 tickets × 3 photos as ONE blob = ' + (blob.length / 1024 / 1024).toFixed(1) + ' MB (over 25 MiB: ' + (blob.length > 25 * 1024 * 1024) + ')');
    kv.global.set('tickets', blob);
    const tok = await login(NEW, kv, 'e1');
    const c = client(NEW, kv, 'e1', tok);
    let oldFail = 'skipped (no old-worker.mjs)';
    if (OLD) try { await OLD.fetch(new Request('https://w/tickets', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: blob }), { AUTH_SECRET: 'test-secret', PO_STORE: kv.edge('e9') }).then(r => r.json()).then(j => { oldFail = j; }); } catch (e) { oldFail = { error: e.message }; }
    console.log('  OLD worker saving that blob: ' + JSON.stringify(oldFail));
    const r = await c.post([heavy[0]]);
    console.log('  NEW worker saving one ticket of it: status ' + r.status + ' saved=' + (r.body && r.body.saved && r.body.saved.length));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
