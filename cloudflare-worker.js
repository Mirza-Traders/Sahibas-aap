const REPO_OWNER = 'Mirza-Traders';
const REPO_NAME = 'Sahibas-aap';
const COSTS_PATH = 'data/costs.json';
const CUSTOMERS_PATH = 'data/customers.json';
const FABRICS_PATH = 'data/fabrics.json';
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
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

      // POST /orders — save all orders
      if (path === '/orders' && request.method === 'POST') {
        const body = await request.text();
        await env.PO_STORE.put('orders', body);
        return new Response(JSON.stringify({ ok: true }), {
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

      // GET /tickets — read all refund/exchange tickets
      if (path === '/tickets' && request.method === 'GET') {
        const data = await env.PO_STORE.get('tickets');
        return new Response(data || '[]', {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // POST /tickets — save all refund/exchange tickets
      if (path === '/tickets' && request.method === 'POST') {
        const body = await request.text();
        JSON.parse(body); // reject broken payloads
        await env.PO_STORE.put('tickets', body);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
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
        return new Response(JSON.stringify({ status: 'ok', time: new Date().toISOString() }), {
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
