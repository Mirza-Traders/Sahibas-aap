const REPO_OWNER = 'Mirza-Traders';
const REPO_NAME = 'Sahibas-aap';
const COSTS_PATH = 'data/costs.json';
const SALES_SNAPSHOT_PATH = 'data/sales-snapshot.json';
const COSTS_BRANCH = 'main';

export default {
  // Runs on the Cron Trigger configured in the dashboard (e.g. daily). My sandbox
  // can't reach this Worker directly, so the daily bake job commits the fresh
  // dataset to GitHub instead — this handler pulls it from there into R2.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncSalesFromGitHub(env));
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
          await mirrorCostsToGitHub(env, body);
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

      // GET /sales-data — read the full baked dataset { d, s, m, st, mo }
      if (path === '/sales-data' && request.method === 'GET') {
        const obj = await env.SALES_DATA.get('snapshot.json');
        if (!obj) {
          return new Response('null', { headers: { ...cors, 'Content-Type': 'application/json' } });
        }
        return new Response(obj.body, { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // POST /sales-data — overwrite the full baked dataset directly (manual/testing path)
      if (path === '/sales-data' && request.method === 'POST') {
        const body = await request.text();
        await env.SALES_DATA.put('snapshot.json', body);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /sync-now — manually trigger the same GitHub -> R2 sync the Cron
      // Trigger runs daily. Useful right after a fresh bake, or right after
      // deploying, instead of waiting for the next scheduled tick.
      if (path === '/sync-now' && request.method === 'GET') {
        const result = await syncSalesFromGitHub(env);
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

// Writes the current cost map to data/costs.json in the GitHub repo via the
// Contents API. Requires a fine-scoped PAT (Contents: read/write on this repo
// only) stored as the GITHUB_TOKEN Worker secret — never exposed to the browser.
async function mirrorCostsToGitHub(env, bodyText) {
  if (!env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN secret not configured on the Worker yet');
  }
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${COSTS_PATH}`;
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
      message: 'Auto-sync cost data from app',
      content,
      branch: COSTS_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) {
    throw new Error('GitHub PUT failed: ' + putRes.status + ' ' + (await putRes.text()));
  }
}

// Pulls data/sales-snapshot.json (committed by the daily bake job) from GitHub's
// raw content CDN and stores it in R2 so the app can serve it via /sales-data.
async function syncSalesFromGitHub(env) {
  try {
    const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${COSTS_BRANCH}/${SALES_SNAPSHOT_PATH}?_=${Date.now()}`;
    const res = await fetch(rawUrl, { cf: { cacheTtl: 0 } });
    if (!res.ok) {
      return { ok: false, error: 'GitHub raw fetch failed: ' + res.status };
    }
    const body = await res.text();
    JSON.parse(body); // throws if GitHub returned something unexpected (e.g. a 404 HTML page)
    await env.SALES_DATA.put('snapshot.json', body);
    return { ok: true, bytes: body.length, syncedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
