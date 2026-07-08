const REPO_OWNER = 'Mirza-Traders';
const REPO_NAME = 'Sahibas-aap';
const COSTS_PATH = 'data/costs.json';
const CUSTOMERS_PATH = 'data/customers.json';
const FABRICS_PATH = 'data/fabrics.json';
const SALES_SNAPSHOT_PATH = 'data/sales-snapshot.json';
const SHOPIFY_SNAPSHOT_PATH = 'data/shopify-snapshot.json';
const COSTS_BRANCH = 'main';

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
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const path = url.pathname;

    try {
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
