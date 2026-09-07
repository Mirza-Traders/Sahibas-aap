const REPO_OWNER = 'Mirza-Traders';
const REPO_NAME = 'Sahibas-aap';
const COSTS_PATH = 'data/costs.json';
const ORDERS_PATH = 'data/orders.json';
const CUSTOMERS_PATH = 'data/customers.json';
const FABRICS_PATH = 'data/fabrics.json';
const BRIEF_PATH = 'data/daily-brief.json';
const SALES_SNAPSHOT_PATH = 'data/sales-snapshot.json';
const SHOPIFY_SNAPSHOT_PATH = 'data/shopify-snapshot.json';
const COSTS_BRANCH = 'main';

// Login lasts this long before the user must sign in again.
const TOKEN_TTL_DAYS = 30;

// Seed credentials — used ONLY to first-populate the KV user store, and only
// if it's empty. After that, KV ('auth_users') is the source of truth and
// password changes/resets persist there. This file lives server-side in a
// PRIVATE repo and is never served to browsers, so these are not publicly
// exposed the way the old in-HTML passwords were. Rotate them post-launch to
// remove plaintext from source entirely.
const SEED_USERS = [
  { name: 'Junaid Sarwar', email: 'junaidsarwar82@gmail.com', pass: '0000' },
  { name: 'Bano Hussain', email: 'banohussain720@gmail.com', pass: 'Bano@2026' },
  { name: 'Bilal MBA', email: 'bilalmba246@gmail.com', pass: 'Bilal@2026' },
  { name: 'Ch Toseef Manzoor', email: 'am2066949@gmail.com', pass: 'Toseef@2026' },
  { name: 'Elite Tech Services', email: 'infoelitetechservices@gmail.com', pass: 'Elite@2026' },
  { name: 'Javeria Rehman', email: 'javeriarehman510@gmail.com', pass: 'Javeria@2026' },
  { name: 'Kamran Maqsood', email: 'kamranmaqsood128@gmail.com', pass: 'Kamran@2026' },
  { name: 'M. Shahbaz Alam', email: 'mshahbazalam.2000@gmail.com', pass: 'Shahbaz@2026' },
  { name: 'Mubasher Iqbal', email: 'mubbasheriqbal32@gmail.com', pass: 'Mubasher@2026' },
  { name: 'RZ', email: 'rz1753431@gmail.com', pass: 'Rz@2026' },
  { name: 'Sahibas by Mirza', email: 'sahibasbymirza@gmail.com', pass: 'Sahibas@2026' },
  { name: 'Sahibas US', email: 'sahibasus2211@gmail.com', pass: 'SahibasUS@2026' },
  { name: 'Sana', email: 'sana28042002@gmail.com', pass: 'Sana@2026' },
  { name: 'Zaid', email: 'zaid77870@gmail.com', pass: 'Zaid@2026' },
  { name: 'Zee', email: 'zee4729291@gmail.com', pass: 'Zee@2026' },
  { name: 'Zeeshan Shafayt', email: 'zeeshanshafaytex@gmail.com', pass: 'Zeeshan@2026' },
];

// ── AUTH PRIMITIVES ──────────────────────────────────────────────────────
const enc = new TextEncoder();
function b64urlFromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlFromStr(str) { return b64urlFromBytes(enc.encode(str)); }
function strFromB64url(b64) {
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return decodeURIComponent(Array.prototype.map.call(atob(b64), function (c) {
    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
  }).join(''));
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return b64urlFromBytes(new Uint8Array(sig));
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}
function hashPassword(secret, pw) { return sha256Hex(pw + '::' + secret); }

async function makeToken(secret, payloadObj) {
  const payload = b64urlFromStr(JSON.stringify(payloadObj));
  const sig = await hmac(secret, payload);
  return payload + '.' + sig;
}
// Returns the payload object if the token is valid & unexpired, else null.
async function verifyToken(secret, token) {
  if (!token || token.indexOf('.') < 0) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = await hmac(secret, parts[0]);
  // constant-time-ish compare
  if (expected.length !== parts[1].length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[1].charCodeAt(i);
  if (diff !== 0) return null;
  let obj;
  try { obj = JSON.parse(strFromB64url(parts[0])); } catch (e) { return null; }
  if (!obj.exp || obj.exp < Math.floor(Date.now() / 1000)) return null;
  return obj;
}

// Loads (seeding on first use) the KV user store: { email: {name, hash} }.
async function loadAuthUsers(env) {
  const raw = await env.PO_STORE.get('auth_users');
  if (raw) { try { return JSON.parse(raw); } catch (e) { /* fall through to reseed */ } }
  const map = {};
  for (const u of SEED_USERS) {
    map[u.email.toLowerCase()] = { name: u.name, hash: await hashPassword(env.AUTH_SECRET, u.pass) };
  }
  await env.PO_STORE.put('auth_users', JSON.stringify(map));
  return map;
}

export default {
  // Runs on the Cron Trigger configured in the dashboard (e.g. daily). My sandbox
  // can't reach this Worker directly, so the daily bake job commits the fresh
  // dataset to GitHub instead — this handler pulls it from there into R2.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncSalesFromGitHub(env));
    ctx.waitUntil(syncShopifyFromGitHub(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    // Bump on every deploy; /ping reports it so "which Worker is live?" is a
    // one-line check in any browser.
    const WORKER_BUILD = '2026-09-07a';
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      // Without this the browser hides X-Tickets-Store from the app's JS.
      'Access-Control-Expose-Headers': 'X-Tickets-Store',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const path = url.pathname;

    try {
      if (!env.AUTH_SECRET) {
        return new Response(JSON.stringify({ error: 'AUTH_SECRET not configured on the Worker' }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // POST /login — exchange email+password for a signed session token.
      if (path === '/login' && request.method === 'POST') {
        let body; try { body = await request.json(); } catch (e) { body = {}; }
        const email = String(body.email || '').toLowerCase().trim();
        const pw = String(body.password || '');
        const users = await loadAuthUsers(env);
        const u = users[email];
        const ok = u && (await hashPassword(env.AUTH_SECRET, pw)) === u.hash;
        if (!ok) {
          return new Response(JSON.stringify({ ok: false, error: 'Incorrect email or password.' }), {
            status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_DAYS * 86400;
        const token = await makeToken(env.AUTH_SECRET, { email, exp });
        return new Response(JSON.stringify({ ok: true, token, user: { name: u.name, email } }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // POST /change-password — self-service, requires a valid token.
      if (path === '/change-password' && request.method === 'POST') {
        const auth = await verifyToken(env.AUTH_SECRET, (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
        if (!auth) return new Response(JSON.stringify({ ok: false, error: 'Not authenticated' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
        let body; try { body = await request.json(); } catch (e) { body = {}; }
        const users = await loadAuthUsers(env);
        const u = users[auth.email];
        if (!u || (await hashPassword(env.AUTH_SECRET, String(body.oldPassword || ''))) !== u.hash) {
          return new Response(JSON.stringify({ ok: false, error: 'Current password is incorrect.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
        }
        const np = String(body.newPassword || '');
        if (np.length < 6) return new Response(JSON.stringify({ ok: false, error: 'New password must be at least 6 characters.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
        u.hash = await hashPassword(env.AUTH_SECRET, np);
        await env.PO_STORE.put('auth_users', JSON.stringify(users));
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // POST /admin-reset-pw — Owner resets someone else's password.
      if (path === '/admin-reset-pw' && request.method === 'POST') {
        const auth = await verifyToken(env.AUTH_SECRET, (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
        if (!auth || auth.email !== 'junaidsarwar82@gmail.com') {
          return new Response(JSON.stringify({ ok: false, error: 'Only the Owner can reset passwords.' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
        }
        let body; try { body = await request.json(); } catch (e) { body = {}; }
        const target = String(body.email || '').toLowerCase().trim();
        const np = String(body.newPassword || '');
        if (np.length < 6) return new Response(JSON.stringify({ ok: false, error: 'Password must be at least 6 characters.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
        const users = await loadAuthUsers(env);
        if (!users[target]) return new Response(JSON.stringify({ ok: false, error: 'Unknown user.' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
        users[target].hash = await hashPassword(env.AUTH_SECRET, np);
        await env.PO_STORE.put('auth_users', JSON.stringify(users));
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // Health + sync endpoints stay open: they return only status (no business
      // data) and the sync links are triggered by pasting a URL in a browser,
      // where an Authorization header can't be added.
      const OPEN = (path === '/' || path === '/ping' || path === '/sync-now' || path === '/sync-shopify-now');
      if (!OPEN) {
        const auth = await verifyToken(env.AUTH_SECRET, (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
        if (!auth) {
          return new Response(JSON.stringify({ error: 'Not authenticated' }), {
            status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
      }
      // GET /orders — read all orders
      if (path === '/orders' && request.method === 'GET') {
        const data = await env.PO_STORE.get('orders');
        return new Response(data || '[]', {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // POST /orders — save all orders, and mirror them into the GitHub repo
      // so a daily offline review can read Production Orders without calling this Worker.
      if (path === '/orders' && request.method === 'POST') {
        const body = await request.text();
        await env.PO_STORE.put('orders', body);
        try {
          await mirrorJsonToGitHub(env, ORDERS_PATH, body, 'Auto-sync production orders from app');
        } catch (mirrorErr) {
          // Orders are already saved to KV (the live source for the app) — a GitHub
          // mirror hiccup shouldn't fail the user's save action. Surface it instead.
          return new Response(JSON.stringify({ ok: true, githubMirror: 'failed', detail: mirrorErr.message }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true, githubMirror: 'ok' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /roles — read roles
      if (path === '/roles' && request.method === 'GET') {
        const data = await env.PO_STORE.get('roles');
        return new Response(data || '{}', {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // POST /roles — save roles
      if (path === '/roles' && request.method === 'POST') {
        const body = await request.text();
        await env.PO_STORE.put('roles', body);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /costs — read product cost map { "product name": cost }
      if (path === '/costs' && request.method === 'GET') {
        const data = await env.PO_STORE.get('costs');
        return new Response(data || '{}', {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // POST /costs — save cost map, and mirror it into the GitHub repo
      // so the offline daily bake job can read it without calling this Worker.
      if (path === '/costs' && request.method === 'POST') {
        const body = await request.text();
        await env.PO_STORE.put('costs', body);
        try {
          await mirrorJsonToGitHub(env, COSTS_PATH, body, 'Auto-sync cost data from app');
        } catch (mirrorErr) {
          // Cost is already saved to KV (the live source for the app) — a GitHub
          // mirror hiccup shouldn't fail the user's save action. Surface it instead.
          return new Response(JSON.stringify({ ok: true, githubMirror: 'failed', detail: mirrorErr.message }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true, githubMirror: 'ok' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // ── TICKETS: one KV key per ticket ─────────────────────────────────
      // Tickets used to live in ONE blob under 'tickets', and every save was
      // GET-blob → merge → POST-blob. That design loses tickets by construction:
      //   • KV is eventually consistent. A save from Karachi ten seconds after a
      //     save from Lahore reads Lahore's PREVIOUS blob from its own edge,
      //     merges into that, and overwrites — Lahore's ticket is gone. No
      //     client-side merge can fix this, because the merge is fed stale input.
      //   • 79 tickets × up to four base64 photos was heading for KV's 25 MiB
      //     value ceiling, after which every put() would throw and every save
      //     would fail — silently, because the client never checked.
      // Now each ticket is its own key, tk:<uid>. A save touches only the
      // tickets it changed. Nobody can overwrite a ticket they never read, and
      // the size limit applies per ticket instead of to everyone at once.
      //
      // _rev: every stored ticket carries a revision counter. A save must present
      // the revision it read; if the store has moved on, the copy is skipped and
      // the client is told, so it reloads instead of rolling back someone else's
      // edit. HONEST LIMIT: the Worker's own read-before-compare goes through the
      // same edge cache, so two people editing the SAME ticket within ~60s from
      // different cities can still race on that one ticket's fields. That is a
      // far smaller problem than the one this replaces (whole tickets vanishing),
      // and it is fully closed only by moving the store to a Durable Object --
      // the upgrade path if same-ticket conflicts ever show up in practice.
      //
      // Old app tabs still POST the whole array. That is now an upsert of each
      // element, never a replacement, so an out-of-date tab can no longer erase
      // anything; the worst it can do is be told its copies were stale.
      // Every KV operation counts against the per-request subrequest cap (50 on
      // the free plan). So: bulk reads (one call per 100 keys), migration in
      // batches of MIG_BATCH per request, and a save only writes what changed.
      // Worst case per request stays around 40.
      if (path === '/tickets' && request.method === 'GET') {
        const mig = await migrateStep(env);
        const all = await loadAllTickets(env);
        const have = new Set(all.map(t => t.uid));
        for (const t of mig.pending) {               // still only in the old blob
          const u = ticketUid(t);
          if (u && !have.has(u)) { if (!t.uid) t.uid = u; all.push(t); }
        }
        return new Response(JSON.stringify(all), {
          headers: { ...cors, 'Content-Type': 'application/json', 'X-Tickets-Store': 'v2' },
        });
      }

      if (path === '/tickets' && request.method === 'POST') {
        const mig = await migrateStep(env);
        const body = await request.text();
        let incoming = JSON.parse(body); // reject broken payloads
        if (!Array.isArray(incoming)) incoming = [incoming];
        const result = await upsertTickets(env, incoming, mig.legacyByUid);
        return new Response(JSON.stringify({ ok: true, ...result }), {
          headers: { ...cors, 'Content-Type': 'application/json', 'X-Tickets-Store': 'v2' },
        });
      }

      // POST /tickets/delete { uids: [...] } — the only way a ticket leaves.
      // Explicit, so a stale tab's whole-array save can never delete by omission.
      if (path === '/tickets/delete' && request.method === 'POST') {
        await migrateStep(env);
        const req = JSON.parse(await request.text());
        const uids = Array.isArray(req && req.uids) ? req.uids : [];
        let deleted = 0;
        for (const uid of uids) {
          if (typeof uid !== 'string' || !uid) continue;
          await env.PO_STORE.delete(TK + uid);
          deleted++;
        }
        await removeFromIndex(env, uids.filter(u => typeof u === 'string' && u));
        return new Response(JSON.stringify({ ok: true, deleted }), {
          headers: { ...cors, 'Content-Type': 'application/json', 'X-Tickets-Store': 'v2' },
        });
      }

      // GET /customers — read the saved list of customer/buyer names
      if (path === '/customers' && request.method === 'GET') {
        const data = await env.PO_STORE.get('customers');
        return new Response(data || '[]', {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // POST /customers — save the customer list, and mirror it into GitHub
      if (path === '/customers' && request.method === 'POST') {
        const body = await request.text();
        await env.PO_STORE.put('customers', body);
        try {
          await mirrorJsonToGitHub(env, CUSTOMERS_PATH, body, 'Auto-sync customer list from app');
        } catch (mirrorErr) {
          return new Response(JSON.stringify({ ok: true, githubMirror: 'failed', detail: mirrorErr.message }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true, githubMirror: 'ok' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /fabrics — read the saved list of fabric/material types
      if (path === '/fabrics' && request.method === 'GET') {
        const data = await env.PO_STORE.get('fabrics');
        return new Response(data || '[]', {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // POST /fabrics — save the fabric list, and mirror it into GitHub
      if (path === '/fabrics' && request.method === 'POST') {
        const body = await request.text();
        await env.PO_STORE.put('fabrics', body);
        try {
          await mirrorJsonToGitHub(env, FABRICS_PATH, body, 'Auto-sync fabric list from app');
        } catch (mirrorErr) {
          return new Response(JSON.stringify({ ok: true, githubMirror: 'failed', detail: mirrorErr.message }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true, githubMirror: 'ok' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /sales-data — read the full baked dataset { d, s, m, st, mo }
      if (path === '/sales-data' && request.method === 'GET') {
        const obj = await env.SALES_DATA.get('snapshot.json');
        if (!obj) {
          return new Response('null', { headers: { ...cors, 'Content-Type': 'application/json' } });
        }
        return new Response(obj.body, { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // POST /sales-data — overwrite the full baked dataset directly. Used by
      // the in-app "Publish" button (Owner). publishedAt is stamped so the
      // daily GitHub cron won't clobber a fresher direct publish with an
      // older committed snapshot.
      if (path === '/sales-data' && request.method === 'POST') {
        const body = await request.text();
        JSON.parse(body); // reject broken payloads before they replace good data
        await env.SALES_DATA.put('snapshot.json', body, {
          customMetadata: { publishedAt: new Date().toISOString() },
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /daily-brief — the latest published brief (small JSON).
      if (path === '/daily-brief' && request.method === 'GET') {
        const v = await env.PO_STORE.get('daily_brief');
        return new Response(v || 'null', { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // POST /daily-brief — save the brief and mirror it into the repo, so the
      // scheduled briefing can read it from GitHub without touching the 11MB
      // sales snapshot. Same pattern as /costs: KV is the live copy, GitHub is
      // the readable one, and a failed mirror never fails the save.
      if (path === '/daily-brief' && request.method === 'POST') {
        const body = await request.text();
        JSON.parse(body); // reject broken payloads
        await env.PO_STORE.put('daily_brief', body);
        try {
          await mirrorJsonToGitHub(env, BRIEF_PATH, body, 'Auto-sync daily brief from app');
        } catch (mirrorErr) {
          return new Response(JSON.stringify({ ok: true, githubMirror: 'failed', detail: mirrorErr.message }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true, githubMirror: 'ok' }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /sync-now — manually trigger the same GitHub -> R2 sync the Cron
      // Trigger runs daily. Add ?force=1 to overwrite even if the data in R2
      // is newer than the GitHub commit.
      if (path === '/sync-now' && request.method === 'GET') {
        const result = await syncSalesFromGitHub(env, url.searchParams.get('force') === '1');
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /shopify-data — read the Shopify stock/price/status snapshot
      if (path === '/shopify-data' && request.method === 'GET') {
        const obj = await env.SALES_DATA.get('shopify.json');
        if (!obj) {
          return new Response('null', { headers: { ...cors, 'Content-Type': 'application/json' } });
        }
        return new Response(obj.body, { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // POST /shopify-data — overwrite the Shopify snapshot directly (in-app
      // Publish with a fresh Shopify export, or manual/testing path)
      if (path === '/shopify-data' && request.method === 'POST') {
        const body = await request.text();
        JSON.parse(body);
        await env.SALES_DATA.put('shopify.json', body, {
          customMetadata: { publishedAt: new Date().toISOString() },
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /sync-shopify-now — manually trigger the GitHub -> R2 sync for the
      // Shopify snapshot, same idea as /sync-now for sales data.
      if (path === '/sync-shopify-now' && request.method === 'GET') {
        const result = await syncShopifyFromGitHub(env, url.searchParams.get('force') === '1');
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // Health check
      if (path === '/' || path === '/ping') {
        // `store` lets anyone confirm which ticket store is live by opening
        // /ping in a browser -- no login needed, no headers to inspect.
        return new Response(JSON.stringify({ status: 'ok', store: 'v2', build: WORKER_BUILD, time: new Date().toISOString() }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },
};

// ── TICKET STORE (per-key) ───────────────────────────────────────────────
const TK = 'tk:';            // one key per ticket: tk:<uid>
const TK_MIGRATED = 'tk_migrated';
const TK_LEGACY = 'tickets'; // the old single blob; kept untouched as a backup

function ticketUid(t) {
  if (t && typeof t.uid === 'string' && t.uid) return t.uid;
  if (t && typeof t.id === 'string' && t.id) return t.id; // legacy: uid seeded from RX-###
  return null;
}
function freshUid() {
  return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const TK_INDEX = 'tk_index';   // JSON array of uids -- see loadAllTickets for why list() alone is not enough
const MIG_BATCH = 30;   // legacy tickets moved per request; keeps a request under the subrequest cap
const PUT_CAP = 40;     // hard ceiling on writes per request, for the same reason

// KV get() accepts up to 100 keys in one call and returns a Map -- one
// operation instead of one per ticket.
async function bulkGet(env, keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const m = await env.PO_STORE.get(chunk);
    if (m && typeof m.forEach === 'function') m.forEach((v, k) => out.set(k, v));
  }
  return out;
}
async function readLegacy(env) {
  const raw = await env.PO_STORE.get(TK_LEGACY);
  let list = [];
  if (raw) { try { list = JSON.parse(raw); } catch (e) { list = []; } }
  return Array.isArray(list) ? list : [];
}
// What a ticket "says", ignoring the bookkeeping the store adds. Used to tell
// a genuine edit from a client echoing back an unchanged copy.
function ticketSig(t) {
  const c = Object.assign({}, t); delete c._srv; delete c._rev; delete c.uid;
  return JSON.stringify(c, Object.keys(c).sort());
}

// Incremental migration of the legacy blob into per-ticket keys: at most
// MIG_BATCH writes per call, tracked by a progress marker, never touching a key
// that already exists (a ticket saved through the new path must not be
// overwritten by its older legacy copy). Returns the legacy tickets not yet
// moved, so reads can still serve them, and the whole legacy list keyed by uid,
// so a save can tell "unchanged echo of an old ticket" from a real edit. The
// blob itself is never deleted.
async function migrateStep(env) {
  const raw = await env.PO_STORE.get(TK_MIGRATED);
  let st = { done: false, next: 0 };
  if (raw) { try { st = JSON.parse(raw) || st; } catch (e) { st = { done: true }; } }
  if (st.done) return { pending: [], legacyByUid: new Map() };
  const legacy = await readLegacy(env);
  const legacyByUid = new Map();
  for (const t of legacy) { const u = ticketUid(t); if (u) legacyByUid.set(u, t); }
  const now = Date.now();
  if (!legacy.length) {
    await env.PO_STORE.put(TK_MIGRATED, JSON.stringify({ done: true, next: 0, count: 0, at: now }));
    return { pending: [], legacyByUid };
  }
  const start = st.next || 0;
  const batch = legacy.slice(start, start + MIG_BATCH);
  const existing = await bulkGet(env, batch.map(ticketUid).filter(Boolean).map(u => TK + u));
  const moved = [];
  for (const t of batch) {
    const uid = ticketUid(t); if (!uid) continue;
    if (existing.get(TK + uid)) continue;
    if (!t.uid) t.uid = uid;
    if (!t._srv) t._srv = now;
    if (!t._rev) t._rev = 1;
    await env.PO_STORE.put(TK + uid, JSON.stringify(t));
    moved.push(uid);
  }
  await addToIndex(env, moved);
  const next = start + batch.length, done = next >= legacy.length;
  await env.PO_STORE.put(TK_MIGRATED, JSON.stringify({ done, next, count: legacy.length, at: now }));
  return { pending: done ? [] : legacy.slice(next), legacyByUid };
}

// KV's list() is eventually consistent: a key written seconds ago can be absent
// from the listing for up to a minute -- so a ticket someone just raised would
// vanish on refresh and reappear later. Not a loss, but indistinguishable from
// one to the person looking. So the store also keeps its own index of uids,
// which a save updates in the same request; the writer's edge sees that write
// at once. Reads take the UNION of index and listing: a uid missing from the
// index (a lost race between two savers) is caught by the listing, and one
// missing from the listing (lag) is caught by the index. Whenever the two
// disagree the index is rewritten to the union, so it heals itself.
async function readIndex(env) {
  const raw = await env.PO_STORE.get(TK_INDEX);
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter(u => typeof u === 'string') : []; } catch (e) { return []; }
}
async function addToIndex(env, uids) {
  if (!uids.length) return;
  const cur = await readIndex(env);
  const set = new Set(cur);
  let changed = false;
  for (const u of uids) if (!set.has(u)) { set.add(u); changed = true; }
  if (changed) await env.PO_STORE.put(TK_INDEX, JSON.stringify([...set]));
}
async function removeFromIndex(env, uids) {
  const cur = await readIndex(env);
  const drop = new Set(uids);
  const next = cur.filter(u => !drop.has(u));
  if (next.length !== cur.length) await env.PO_STORE.put(TK_INDEX, JSON.stringify(next));
}
async function loadAllTickets(env) {
  const listed = [];
  let cursor;
  do {
    const page = await env.PO_STORE.list({ prefix: TK, cursor });
    for (const k of page.keys) listed.push(k.name.slice(TK.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const indexed = await readIndex(env);
  const uids = [...new Set(indexed.concat(listed))];
  const got = await bulkGet(env, uids.map(u => TK + u));
  const out = [], present = [];
  for (const u of uids) {
    const raw = got.get(TK + u);
    if (!raw) continue;                       // indexed but deleted, or not yet visible at this edge
    try { out.push(JSON.parse(raw)); present.push(u); } catch (e) { /* skip a corrupt key rather than fail the whole read */ }
  }
  // Heal: anything the listing knows that the index does not.
  const idxSet = new Set(indexed);
  if (present.some(u => !idxSet.has(u))) await env.PO_STORE.put(TK_INDEX, JSON.stringify([...new Set(indexed.concat(present))]));
  return out;
}

// Upsert each incoming ticket. Reads all of them in one bulk call, then writes
// only the ones that actually changed. Returns which were saved, which were
// skipped because the stored copy is newer, which were renamed because two
// old-code tabs picked the same number, and which were deferred by the write
// cap (the client keeps them queued and retries).
async function upsertTickets(env, incoming, legacyByUid) {
  const saved = [], skipped = [], renamed = [], deferred = [], written = [], revs = {};
  const now = Date.now();
  const items = incoming.filter(t => t && typeof t === 'object' && ticketUid(t));
  const storedMap = await bulkGet(env, items.map(t => TK + ticketUid(t)));
  let puts = 0;
  for (const t of items) {
    let uid = ticketUid(t);
    const storedRaw = storedMap.get(TK + uid);
    let stored = null;
    if (storedRaw) { try { stored = JSON.parse(storedRaw); } catch (e) { stored = null; } }
    if (stored) {
      // _rev is the revision the client READ. If the stored revision has moved
      // PAST it, someone wrote in between and this copy is stale: not applied,
      // and the client is told so it can reload. A revision counter, not a
      // time stamp -- two writes in the same millisecond would tie on time.
      // Only "stored is newer" counts as a conflict. A client AHEAD of what
      // this edge holds is not stale -- this edge's cache is (KV serves reads
      // from a per-location cache for up to a minute). Revisions only ever
      // come from this Worker, so the client cannot have invented one.
      const sr = Number(stored._rev) || 0, cr = Number(t._rev) || 0;
      if (t._rev != null && stored._rev != null && sr > cr) { skipped.push(uid); continue; }
      // A copy with NO revision claim (an older app build, or a ticket the tab
      // raised itself and never learned the revision of) still carries the
      // _srv write stamp of the copy it read. If the stored copy was written
      // after that, someone else moved the ticket on in between -- this copy
      // must not put it back. This is the "ticket went back to its previous
      // status by itself" report: a tab parked on the panel all day saving a
      // note onto its own stale copy.
      if (t._rev == null && t._srv != null && stored._srv != null && Number(stored._srv) > Number(t._srv)) { skipped.push(uid); continue; }
      if (ticketSig(stored) === ticketSig(t)) { saved.push(uid); revs[uid] = Math.max(sr, cr); continue; }   // unchanged echo: nothing to write
      if (t._rev == null && (stored.createdAt !== t.createdAt || stored.createdBy !== t.createdBy)) {
        // A ticket claiming to be brand-new landing on a key that already holds
        // a DIFFERENT ticket: two old-code tabs picked the same RX number. Keep
        // both -- give this one its own key.
        const fresh = freshUid();
        renamed.push({ from: uid, to: fresh });
        uid = fresh; t.uid = fresh; stored = null;
      }
    } else if (legacyByUid && legacyByUid.has(uid) && ticketSig(legacyByUid.get(uid)) === ticketSig(t)) {
      saved.push(uid); continue;   // unchanged copy of a not-yet-migrated ticket: the migration will move it
    }
    if (puts >= PUT_CAP) { deferred.push(uid); continue; }
    if (!t.uid) t.uid = uid;
    t._srv = now;
    t._rev = Math.max(stored && Number(stored._rev) || 0, Number(t._rev) || 0) + 1;
    await env.PO_STORE.put(TK + uid, JSON.stringify(t));
    puts++;
    saved.push(uid);
    revs[uid] = t._rev;   // so the client can carry the right revision into its next edit
    written.push(uid);
  }
  await addToIndex(env, written);
  return { saved, skipped, renamed, deferred, revs, srv: now };
}

// Writes JSON text to a path in the GitHub repo via the Contents API. Requires
// a fine-scoped PAT (Contents: read/write on this repo only) stored as the
// GITHUB_TOKEN Worker secret — never exposed to the browser. Shared by
// /costs, /customers and /fabrics so the offline daily bake job can read any
// of them straight from GitHub without calling this Worker.
async function mirrorJsonToGitHub(env, path, bodyText, message) {
  if (!env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN secret not configured on the Worker yet');
  }
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;
  const headers = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'sahibas-po-api-worker',
  };

  let sha;
  const getRes = await fetch(`${apiUrl}?ref=${COSTS_BRANCH}`, { headers });
  if (getRes.ok) {
    const meta = await getRes.json();
    sha = meta.sha;
  } else if (getRes.status !== 404) {
    throw new Error('GitHub GET failed: ' + getRes.status + ' ' + (await getRes.text()));
  }

  // base64-encode UTF-8 safely
  const content = btoa(unescape(encodeURIComponent(bodyText)));

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content,
      branch: COSTS_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) {
    throw new Error('GitHub PUT failed: ' + putRes.status + ' ' + (await putRes.text()));
  }
}

// When was a repo file last committed on main? Used to decide whether the
// GitHub copy is actually newer than what's already in R2.
async function githubLastCommitDate(env, filePath) {
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits?path=${encodeURIComponent(filePath)}&sha=${COSTS_BRANCH}&per_page=1`;
  const res = await fetch(apiUrl, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'sahibas-po-api-worker',
    },
  });
  if (!res.ok) return null;
  const commits = await res.json();
  return (commits[0] && commits[0].commit && commits[0].commit.committer && commits[0].commit.committer.date) || null;
}

// Shared GitHub -> R2 sync used for both snapshots. The in-app Publish button
// writes straight to R2 with a publishedAt stamp; this sync must not clobber
// that fresher data with an older GitHub commit, so it compares dates first
// (force=true skips the comparison).
async function syncSnapshotFromGitHub(env, filePath, r2Key, force) {
  try {
    if (!env.GITHUB_TOKEN) {
      return { ok: false, error: 'GITHUB_TOKEN secret not configured on the Worker yet' };
    }
    if (!force) {
      const head = await env.SALES_DATA.head(r2Key);
      const publishedAt = head && head.customMetadata && head.customMetadata.publishedAt;
      if (publishedAt) {
        const commitDate = await githubLastCommitDate(env, filePath);
        if (commitDate && new Date(commitDate) <= new Date(publishedAt)) {
          return { ok: true, skipped: true, reason: 'R2 data (' + publishedAt + ') is newer than the GitHub commit (' + commitDate + ') — add ?force=1 to overwrite anyway' };
        }
      }
    }
    const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}?ref=${COSTS_BRANCH}`;
    const res = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.raw+json',
        'User-Agent': 'sahibas-po-api-worker',
      },
    });
    if (!res.ok) {
      return { ok: false, error: 'GitHub contents fetch failed: ' + res.status + ' ' + (await res.text()) };
    }
    const body = await res.text();
    JSON.parse(body); // throws if GitHub returned something unexpected
    await env.SALES_DATA.put(r2Key, body, {
      customMetadata: { publishedAt: new Date().toISOString() },
    });
    return { ok: true, bytes: body.length, syncedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function syncSalesFromGitHub(env, force) {
  return syncSnapshotFromGitHub(env, SALES_SNAPSHOT_PATH, 'snapshot.json', force);
}

function syncShopifyFromGitHub(env, force) {
  return syncSnapshotFromGitHub(env, SHOPIFY_SNAPSHOT_PATH, 'shopify.json', force);
}
