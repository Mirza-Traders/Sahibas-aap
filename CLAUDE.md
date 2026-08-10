# Sahibas by Mirza / OPS — working notes

## Screenshots
Always send screenshots with `display: "render"` so they show full-size
inline, not as a small download card.

## Repo layout
- `public/index.html` — the entire app (single file, vanilla JS, no build step).
- `Sahibas_App (3).html` — a byte-identical mirror of `public/index.html`.
  **After every edit to `public/index.html`, run:**
  `cp "public/index.html" "Sahibas_App (3).html"`
- `cloudflare-worker.js` — Cloudflare Worker (KV + R2) backing the app's API.
  Deployed manually by the user; pushing it here does not deploy it.
- `data/` — published snapshots (`sales-snapshot.json`, `shopify-snapshot.json`,
  `costs.json`, …).

## Branch & deploy
Develop on `claude/test-coverage-analysis-kgk589`. Commit and push there
freely, but **only deploy to `main` when the user explicitly says "deploy"**:

```
git fetch origin main && git merge origin/main
git push origin claude/test-coverage-analysis-kgk589:main
git push -u origin claude/test-coverage-analysis-kgk589
```

Netlify serves `main`, so pushing to `main` is what makes a change live.

## Discuss first
When the user ends a request with "discuss", investigate and present a plan —
do not write code until they confirm.

## Testing
Playwright scripts live in the session scratchpad under `automation/`. Run with:
`NODE_PATH=/opt/node22/lib/node_modules node <script>.js`
using `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'`.

Typical harness: stub the Worker endpoints with `page.route`, log in as
`junaidsarwar82@gmail.com`, then set `window.CU` / `window.CM` / `window.STOCK`
/ `window.DETAIL` directly and call `doST('<tab>')`. Note `doST` (not `doR`) is
what makes a panel visible.

## Conventions that matter
- A product missing from the last stock file must render as `—`, never `0` —
  "no data" and "zero stock" are different answers.
- `window.CM` holds a mix of cases (`saveCost` stores as typed, cloud costs are
  lowercased), so membership checks must lowercase both sides.
- `body { zoom: 1.15 }` means `getBoundingClientRect()` reports post-zoom
  pixels while inline `style.height` is pre-zoom. Divide by `zoomScale()` in any
  "fill remaining viewport" helper.
- Commission is a flat 25% (`DC_COMM_RATE`); break-even = `cost / 0.75`.
