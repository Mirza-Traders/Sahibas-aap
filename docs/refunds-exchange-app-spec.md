# Sahibas Refunds & Exchange — standalone app specification

Extracted from the live "Sahibas by Mirza / OPS" app (`public/index.html` + `cloudflare-worker.js`,
repo `Mirza-Traders/Sahibas-aap`, as of commit `bcc2642`; app build `2026-09-12a`, Worker build
`2026-09-07a`). Hand this file to Claude so it can build the Refunds & Exchange section as its own app
with the **same process, approvals and users**.

Where this document is silent, the original code is the source of truth. A source map with line numbers
is in section 15, and a ready-to-paste kickoff prompt is in section 14.

Contents: 1 Goal · 2 Users & roles · 3 Ticket lifecycle · 4 Ticket data · 5 Duplicate-refund guard ·
6 Screens · 7 Backend today · 8 Failures already suffered · 9 Gaps to fix in the new app ·
10 Data to carry over · 11 Product data dependency · 12 Decisions needed · 13 Suggested build ·
14 Kickoff prompt · 15 Source map · 16 Visual identity

---

## 1. Goal and scope

**What it is.** A ticketing workflow for customer **refunds** (money goes back to the customer's bank
account) and **exchanges** (a different item is sent). Every ticket moves through six fixed stages.
Each stage has a specific person/role who may move it forward, and three stages require a photo as proof.
Refunds are checked against every other refund so the same person is never paid twice.

**What must stay identical**
- The six stages, the order they happen in, and who may perform each one (section 3).
- The mandatory proof photos at Received, Paid/Dispatched and Informed.
- The duplicate-refund guard and who may override it (section 5).
- The audit trail: every action is recorded with who and when; nothing is silently edited.
- The same people, with the same logins and the same refund roles (section 2).

**What changes**
- It is its own app, outside the main OPS app. The old "Refunds & Exchange" panel stays until the new
  app is trusted, then is retired.
- Every rule is enforced on the **server**. The current app enforces them only in the browser
  (section 9, items 1-2).

**Out of scope.** Everything else in OPS (sales reports, production orders, costs, ads, insights).

---

## 2. Users and roles

### 2.1 How login works today
- Email + password. The Worker (`POST /login`) checks the password and returns a signed session token.
- Token = `base64url({email, exp}) + "." + HMAC-SHA256`, valid **30 days**, kept in the browser
  (`localStorage.sbm_tok`) and sent as `Authorization: Bearer <token>`. A 401 anywhere sends the user
  back to the login screen with "Session expired — please sign in again."
- Passwords are stored in Cloudflare KV key `auth_users` as
  `{ "<email, lowercase>": { "name": "...", "hash": "<sha256(password + '::' + AUTH_SECRET)>" } }`.
- Minimum password length is 6.
- Self-service: **Change password** (needs the current password).
- **Owner only:** create a user, reset anyone's password, revoke (delete) a login.
- There is no automatic "forgot password". The login screen's link opens a pre-filled email to the Owner.
- The Owner is `junaidsarwar82@gmail.com`. That address is hard-coded in the Worker's admin endpoints.
- A revoked user's already-issued token keeps working until its own expiry (tokens are stateless).

### 2.2 The refund role
Access to this section is decided **only** by the person's *refund role*. No refund role = the menu
entry is hidden and the page says "Not authorized". The Owner is always `admin`.

Refund roles are stored in the cloud under `roles.__rex` as `{ "<email>": "<role>" }` and are assigned
by the Owner in the Users panel ("Refund Role" column). A role change takes effect after the person logs
out and back in.

| Role | Who it is meant for | What it adds |
|---|---|---|
| `admin` | Owner (and anyone the Owner trusts fully) | Everything, including Send Back, Delete, paying through a duplicate warning |
| `manager` | Supervisor | Same stage rights as admin, but **not** Send Back, Delete or duplicate override |
| `accountant` | Whoever pays refunds | Marks refunds Paid; sees bank details; may clear duplicate warnings |
| `warehouse` | Whoever receives returned parcels | Marks Received; may also mark exchanges Dispatched |
| `dispatch` | Whoever sends exchange parcels | Marks exchanges Dispatched |
| `member` | Customer-service staff (code comments name **Sana and Bano**) | Marks Informed |

### 2.3 Permission matrix (current behaviour)

| Action | admin | manager | accountant | warehouse | dispatch | member |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| See the ticket list and open any ticket | Y | Y | Y | Y | Y | Y |
| Create a refund or exchange ticket | Y | Y | Y | Y | Y | Y |
| Add a note to a ticket | Y | Y | Y | Y | Y | Y |
| Move to **Received** | Y | Y | - | Y | - | - |
| Move to **Approved** | Y | Y | - | - | - | - |
| Move to **Paid** (refund) | Y | Y | Y | - | - | - |
| Move to **Dispatched** (exchange) | Y | Y | - | Y | Y | - |
| Move to **Informed** | Y | Y | - | - | - | Y |
| Move to **Closed** | Y | Y | - | - | - | - |
| **Send Back** to an earlier stage | Y | - | - | - | - | - |
| **Delete** a ticket | Y | - | - | - | - | - |
| See bank details inside a ticket | Y | Y | Y | - | - | - |
| Clear a duplicate warning ("Not a duplicate") | Y | Y | Y | - | - | - |
| Pay a refund that has a RED duplicate warning (with a reason) | Y | - | - | - | - | - |
| Add / reset / revoke users, assign refund roles | Owner only | | | | | |

Extra rule for **Informed**: besides the `member` role, the person the ticket is **assigned to** may also
mark it Informed, whatever their role.

"Y" for admin means the Owner and anyone given the `admin` refund role.

### 2.4 Assignment
Every ticket has an `assignedTo` (a person's display name). When creating a ticket the dropdown lists
everyone who has a refund role, pre-selected as follows (first match in the user list wins):
- **Refund:** first `accountant`, else first `admin`, else the creator.
- **Exchange:** first `dispatch`, else first `warehouse`, else first `admin`, else the creator.

The list has an "Assigned to me" filter.

### 2.5 The users to carry over
Source: the hard-coded directory in the current app. The "main role" column is the app-wide role in the
source code; the live value can differ because the cloud overrides it. **The refund role is not in the
code** — it lives in the cloud. Fill that column from the Users panel (or `GET /roles` → `__rex`) before
building. Hints from code comments are marked.

| Name | Email | Main role (source) | Refund role (fill in) |
|---|---|---|---|
| Junaid Sarwar | junaidsarwar82@gmail.com | Owner | `admin` (always) |
| Bano Hussain | banohussain720@gmail.com | — | probably `member` (code comment) — confirm |
| Bilal MBA | bilalmba246@gmail.com | — | ? (a code comment shows Bilal attaching payment proof) |
| Ch Toseef Manzoor | am2066949@gmail.com | — | ? |
| Elite Tech Services | infoelitetechservices@gmail.com | Viewer | ? |
| Irsa Haider | irsahaider02@gmail.com | Editor | ? |
| Javeria Rehman | javeriarehman510@gmail.com | — | ? |
| Kamran Maqsood | kamranmaqsood128@gmail.com | — | ? |
| M. Shahbaz Alam | mshahbazalam.2000@gmail.com | Production | ? |
| Mubasher Iqbal | mubbasheriqbal32@gmail.com | Editor | ? |
| RZ (Zain) | rz1753431@gmail.com | Editor | **Login revocation was requested — confirm it was done and leave him out** |
| Sahibas by Mirza | sahibasbymirza@gmail.com | Editor | ? |
| Sahibas US | sahibasus2211@gmail.com | Editor | ? |
| Sana | sana28042002@gmail.com | Editor | probably `member` (code comment) — confirm |
| Zaid | zaid77870@gmail.com | Viewer | ? |
| Zee | zee4729291@gmail.com | — | ? |
| Zeeshan Shafayt | zeeshanshafaytex@gmail.com | — | ? |

Only people who currently hold a refund role need to exist in the new app. Everyone else can be dropped.

---

## 3. Ticket lifecycle

### 3.1 Stages
Strictly linear. A ticket can only move to the **next** stage; stages cannot be skipped. The only way
backwards is Send Back (admin).

```
initiated -> received -> approved -> paid -> informed -> closed
                                      (shown as "Dispatched" for exchanges)
```

| # | Stage | Meaning | Who moves it here | Proof required | Notes |
|---|---|---|---|---|---|
| 1 | Initiated | Ticket raised | the creator | Chat screenshot is optional | Created with the fields in section 4 |
| 2 | Received | The returned article reached us | `warehouse` (or admin/manager) | **Photo of the received article** | |
| 3 | Approved | Approved after receipt | `admin` / `manager` only | none | The real approval step: money or replacement is not released before this |
| 4 | Paid / Dispatched | Refund: money sent. Exchange: replacement sent | Refund: `accountant`. Exchange: `dispatch` or `warehouse` (+ admin/manager) | **Refund: bank payment voucher. Exchange: dispatch proof** | Refunds pass the duplicate gate (section 5) |
| 5 | Informed | Customer told it is done | `member` or the assignee (+ admin/manager) | **Screenshot of the chat that informed the customer** | |
| 6 | Closed | Finished | `admin` / `manager` only | none | |

Each move writes a history entry `{ stage, by, at, note }`. Photo stages store the image plus who and
when (`receivedPhoto`, `receivedPhotoBy`, `receivedPhotoAt`, and the same for `paid` and `informed`).
For the three photo stages the button opens the camera/file picker ("Attach photo & Mark Received →");
the ticket only advances once a photo is attached. Re-advancing after a Send Back asks for a fresh photo,
which replaces the old one.

### 3.2 Send Back (admin only)
Pick any earlier stage, and a **reason is mandatory**. The ticket returns to that stage; a red history
entry records who, when and why (`sendBack: true`). Photos already attached stay on the ticket.

### 3.3 Notes
Anyone with a refund role can add a note at any time. A note never changes the stage and is shown in the
history as "Note".

### 3.4 Delete (admin only)
Asks for confirmation, then permanently removes the ticket. Deletion is explicit — a stale browser can
never delete a ticket by omission.

### 3.5 History labels shown to users
Ticket raised · Article received · Approved after receipt · Refund paid / Replacement dispatched ·
Customer informed · Closed · Sent back to <stage> · Note. Steps are numbered in the order they happened.

---

## 4. Ticket data

### 4.1 Fields

| Field | Type | Notes |
|---|---|---|
| `uid` | string | Unique for life (`u` + time + random). The real identity. Never reused |
| `id` | string | Human label `RX-001`, `RX-002`, ... Display only |
| `type` | `refund` \| `exchange` | |
| `status` | stage name | One of the six stages |
| `order` | string | Free text. May hold several numbers, e.g. `#5964 6008` |
| `platform` | string | `Sahibas (Local)`, `Sahibas International`, `Laam (Local)`, `Laam International` |
| `customer` | string | Customer name |
| `customerMobile`, `customerAddress` | string | Optional |
| `instagramProfile`, `facebookProfile`, `whatsappProfile` | string | Customer verification links. At least one is required |
| `chatScreenshot` | image | Optional, taken at creation |
| `items[]` | array | One entry per returned item (below) |
| `amount` | number (PKR) | Sum of item amounts (refunds) |
| `reason` | string | One of: Size Issue · Color Mismatch · Fabric Different from Description · Product Defect / Damage · Wrong Item Dispatched · Customer Changed Mind · Other |
| `notes` | string | Optional, free text at creation |
| `assignedTo` | string | Person's display name |
| `bankName`, `accountTitle`, `accountNumber` | string | Refunds only. `accountNumber` is the IBAN / account number |
| `createdBy`, `createdAt` | string | Creator's name; `YYYY-MM-DD HH:MM` |
| `history[]` | array | `{ stage, by, at, note, noteOnly?, sendBack? }`, append-only |
| `receivedPhoto`/`paidPhoto`/`informedPhoto` (+ `By`, `At`) | image + who + when | Proof photos |
| `dupCleared` | `{ otherUid: { by, at } }` | Pairs a reviewer marked "not a duplicate" |
| `_rev`, `_srv` | number | Server bookkeeping for conflict detection |

Each **item** is `{ product, size, productToSend, sizeToSend, amount }`. Sizes are `S`, `M`, `L`, `XL`
(or blank). `productToSend` / `sizeToSend` are used only on exchanges; `amount` only on refunds.
Older tickets have a single flat `product/size/...` instead of `items[]`; treat that as one item.

### 4.2 Validation when creating a ticket
- Order # is required. Customer name is required.
- At least one item. Every item needs a **Product Returned**.
- Refund: every item needs an **amount greater than zero**.
- Exchange: every item needs a **Product To Send**.
- At least one of Instagram / Facebook / WhatsApp profile is required ("this is how the Owner/Admin
  confirms the case is genuine").
- Reason and Platform have defaults, so they are always set.
- Bank name, account title and IBAN are **optional** today, even for refunds (see section 9, item 4).

### 4.3 Photos
Photos are shrunk in the browser (longest side 1000 px, JPEG quality 0.8) and stored inside the ticket
as base64. Camera capture is preferred on phones.

### 4.4 Numbering
`RX-001`, `RX-002`, ... in creation order. Today each browser computes "highest + 1" itself, which is
why two people raising a ticket at the same moment could collide (section 8). The new app must assign
numbers on the server.

---

## 5. Duplicate-refund guard

**Risk it prevents:** paying the same person twice. Refunds are compared against **every other refund,
all time, including closed and already-paid ones.** Exchanges are never compared (no money moves).

### 5.1 Matching
Before comparing, values are normalised, otherwise the check is decorative:
- Account number: upper-case, strip every character that is not A-Z or 0-9
  (`PK11 ALFH 0292` equals `pk11alfh0292`).
- Order number: upper-case, split on anything that is not A-Z/0-9, ignore pieces of 2 characters or fewer,
  compare as a **set** (so `#5964 6008` matches a ticket for `6008`).
- Customer name: lower-case, collapse spaces.

### 5.2 Grades
The signals are graded rather than merged, because a warning that fires on every repeat customer gets
clicked through within a week.

| Level | Condition |
|---|---|
| **RED** | Same order number on two refunds |
| **RED** | Same bank account, and one of the two is already Paid, Informed or Closed |
| **AMBER** | Same bank account, different customer names (the shape fraud takes) |
| **AMBER** | Same bank account, different orders (often a genuine repeat customer) |
| INFO | Same customer name only (too common to alarm on; never counted as a risk) |

Each ticket carries its single worst level.

### 5.3 What happens
- **The gate:** a refund with a **RED** match cannot be marked **Paid**.
  - Non-admin: blocked with a message naming the matches.
  - Admin only: may override, must type a **reason**, and the override is written into the ticket history
    with their name and the matching ticket numbers.
  - AMBER warns but lets the step through.
  - The gate applies before a photo is read, so a refusal never leaves a payment slip on a ticket that
    did not advance.
- **Clearing a warning:** admin, manager or accountant can press "Not a duplicate" on a pair after
  confirming. The decision is stored on **both** tickets with who/when, and written into both histories.
  Clearing once is enough (honoured from either side).
- **Early warning:** while typing the Order # or IBAN in the New Refund form, matches appear live
  ("This may already have been refunded" / "This account has been used before", up to four listed).
  Name-only matches are not shown while typing.
- **In the list:** a counter chip ("N duplicate risks · N to check", or a green "No duplicate refunds")
  that filters the list to risky tickets; a mark beside the ticket number (red or amber).
- **In a ticket:** a panel naming each match, with "Open RX-xxx" and "Not a duplicate" buttons.
- **CSV export:** includes the risk level and the matching detail.

---

## 6. Screens

Single page, modals for create/detail. Desktop-first; staff also use phones for photos.

### 6.1 Login
Email + password, sign-in button, "forgot password" (email to the Owner), error line. Change-password dialog
from the user menu. Logout.

### 6.2 Ticket list (main screen)
- **KPI cards:** Open Tickets (with "N total"), Refunds Open (count and PKR "to pay out"), Exchanges
  Open ("Awaiting dispatch"), Closed (all time). *Open* means "not closed".
- **Stage tabs, two rows:** Refunds and Exchanges, each with `All` plus the six stages and a live count
  (counts respect search and "Assigned to me", never the tab's own filter). The exchange row labels the
  fourth stage "Dispatched".
- **Toolbar:** search (ticket number, order, customer, any product on the ticket) · "Assigned to me" ·
  "Clear type/stage" · duplicate chip · column toggles **Customer Profile** and **Bank** (both default ON,
  remembered per browser) · **CSV** export · **New Exchange** · **New Refund**.
- **Table columns:** Date · Ticket (with duplicate mark) · Type badge · Order# · Customer ·
  Customer Profile (IG / FB / WA, shown as clickable links; only `http(s)` or known social domains become
  links, anything else stays plain text so a pasted `javascript:` string can never be clicked) ·
  Product (thumbnail, name, rating chip, "+N more" for extra items, "-> product to send" for exchanges) ·
  Amount · Bank · Account Title · IBAN · Platform · Assigned · Stage badge.
- Sorted **newest first** by creation time. Clicking a row opens the ticket.
- The list refreshes when opened and every **15 seconds** while visible.
- CSV columns: Ticket, Type, Created, Order#, Customer, Mobile, Product(s), Size(s), Product(s) To Send,
  Size(s) To Send, Amount, Platform, Reason, Assigned To, Stage, Created By, Bank, Account Title, IBAN,
  Duplicate Risk, Duplicate Detail, History.

### 6.3 New Refund / New Exchange (modal)
Fields in order: Order # * · Platform * · Customer Name * · Mobile · Address · **Customer Verification**
(chat screenshot, Instagram, Facebook, WhatsApp — at least one profile) · **Items** (repeatable rows:
Product Returned * with live thumbnail and size; exchanges also Product To Send * and size; refunds also
Amount (PKR) *) · "+ Add another item" · Reason * · **Bank details** (refunds only: Bank Name, Account
Title, IBAN/Account #, with the live duplicate warning) · Assign To · Notes · "Create Ticket".
Product fields are type-ahead lists fed from the product catalogue (section 11) but must also accept
free text.

### 6.4 Ticket detail (modal)
Ticket number and type · six-segment progress bar with stage names · Order, Customer, Mobile, Platform,
Reason, Amount, Assigned To, Created (when and by whom) · the items (with exchange arrows and amounts) ·
Address · Customer Verification block · photo gallery (chat, received article, payment voucher / dispatch
proof, customer informed — each with who and when; click to enlarge) · bank block (admin, manager,
accountant only) · duplicate panel · action buttons (next stage with the camera button when a photo is
required, Send Back, Delete — each shown only to those allowed) · numbered history · "Add a note" box.

### 6.5 Feedback and safety UX
Short toasts for success. **Persistent** banners for anything that could lose work: a red "N tickets NOT
saved yet — do not close this tab. Retrying…" with a Retry-now button, and an orange "Your change to
RX-xxx was NOT saved — someone else updated it at the same time" banner (15 s). The browser warns before
closing a tab with unsaved tickets. If the server cannot be reached the page says so plainly and **never**
shows an empty list that looks like "everything is gone".

---

## 7. Backend today (so you can reproduce or improve it)

Cloudflare Worker `sahibas-po-api` with one KV namespace `PO_STORE`; the front end is a static page on
Netlify. Secrets on the Worker: `AUTH_SECRET` (signs tokens and salts hashes), plus unrelated ones.

| Endpoint | Purpose | Who may call (current) |
|---|---|---|
| `POST /login` | Email + password to token | anyone |
| `POST /change-password` | Self-service | any token |
| `POST /admin-create-user`, `/admin-reset-pw`, `/admin-delete-user` | User administration | Owner token only |
| `GET /roles`, `POST /roles` | Main roles + `__rex` refund roles + `__pub` | **any token (both read and write)** |
| `GET /tickets` | All tickets | any token |
| `POST /tickets` | Upsert one or more tickets | any token |
| `POST /tickets/delete` `{uids}` | The only way a ticket leaves | any token |

**Ticket storage ("v2"):** one KV key per ticket (`tk:<uid>`), plus an index key `tk_index` listing uids
(KV listings lag up to ~60 s, so reads take the union of index and listing and heal the index). Each stored
ticket carries `_rev` (revision counter) and `_srv` (write stamp). A save sends only the tickets it
changed; the Worker skips any ticket whose stored revision is newer than the one the client read, and tells
the client which were saved, skipped, renamed (two tabs picked the same number), or deferred (a cap of 40
writes per request). Photos are inside the ticket JSON as base64 (KV value limit 25 MiB).

**Client save safety, in order:** stash the ticket in the browser (localStorage, 6-hour life) and queue it
before the network call; read the server copy first and refuse to write if that read failed; send only
touched tickets; on failure keep it queued and retry with back-off (15 s, 30 s, 60 s cap); adopt the
revision the Worker returns; drop an edit the server rejected as stale and show the conflict banner.

The existing test harness `tests/worker/tickets-harness.mjs` documents the expected behaviour and one known
limit (two people editing the *same* ticket within ~60 s from different cities can still race — only a
Durable Object or database closes that fully).

---

## 8. Failures already suffered — design requirements, not trivia

Each of these happened in production and cost real tickets. The new app must make each impossible by
construction.

1. **Tickets vanished when two people raised one at the same moment.** Identity was the ticket *number*,
   computed per browser. -> Identity is a server-issued id; the number is a label assigned atomically on
   the server.
2. **A whole-list overwrite erased other people's tickets.** Every save replaced everyone's data. -> Save one
   ticket at a time; never replace the collection.
3. **A stale tab put a ticket back a stage.** A tab left open all day saved a note onto its old copy.
   -> Every write carries the revision it read; the server rejects stale writes and tells the user.
4. **KV eventual consistency made fresh tickets "disappear" for up to a minute.** -> Use a store that is
   consistent for reads-after-writes (Durable Object, D1/SQLite, or equivalent).
5. **Pressing F5 mid-save lost the ticket.** -> Save-before-navigate protection and a local stash.
6. **A failed read looked like an empty list, then a save wiped the server.** -> Never write after a failed
   read; show "could not load", never "no tickets".
7. **Role pages said "Not authorized" while roles were still loading.** -> Show "Checking your access…"
   until roles are known.

---

## 9. Gaps in the current app — fix in the new one (or consciously keep)

1. **Rules are enforced only in the browser.** The server accepts any stage change, any photo-less advance,
   any role, and ignores the duplicate gate. Anyone with a login can call the API directly and approve or
   pay a refund. *New app: validate every transition, role, required photo and the duplicate gate on the
   server.*
2. **Any logged-in user can rewrite everyone's roles.** `POST /roles` has no Owner check, and refund rights
   come from that blob. A `member` could make themselves `admin` by calling the API. *New app: only the
   Owner may change roles, enforced server-side.*
3. **A token opens every endpoint** of the main Worker (costs, orders, sales data), not just refunds. Fine
   today because everyone is staff, but refund staff should not be able to read business data. *New app:
   tokens scoped to this app, or a separate backend.*
4. **Bank visibility is inconsistent.** The ticket detail hides bank details from `warehouse`/`dispatch`/
   `member`, but the list (with the Bank column on) and the CSV show the full IBAN to every refund role.
   *Decide one rule; recommended: admin, manager, accountant only, everywhere including export.*
5. **Bank details are optional for refunds**, so a refund can reach Paid with no bank details. *Decide:
   require them before Approved or Paid?*
6. **Timestamps mix UTC and local time.** The date part is UTC and the time part is the browser's local time,
   with no timezone stored. *New app: store UTC, display in Pakistan time (UTC+5).*
7. **Tickets (and their bank details) are backed up nowhere.** The Worker mirrors costs, orders, customers
   etc. to GitHub but not tickets. *New app: scheduled export/backup.*
8. **Photos are base64 inside the ticket.** *New app: object storage (R2), served only to logged-in users.*
9. **The duplicate guard only gates the move to Paid** and only compares refunds. Creation only warns.
   (This was a deliberate choice; keep unless told otherwise.)
10. **"Refunds Open — PKR to pay out" includes refunds already paid but not yet closed**, because "open" means
    "not closed". Consider counting only stages before Paid.
11. **The user list is hard-coded in the page**, so a new person cannot appear until the code is edited and
    redeployed. *New app: users live on the server.*
12. **Login has no rate limiting**, and passwords use a fast SHA-256 hash. *New app: slow salted hash
    (e.g. PBKDF2 or Argon2), lock-out after repeated failures.*
13. **Revoked users keep a working token** for up to 30 days. *New app: check the user list on every request.*
14. **Order numbers are free text** and are not checked against Shopify or Laam, and the amount is not
    compared with the order value.
15. **A role change needs the person to log in again.** *New app: read the role on every request.*
16. **A control that was built and then reverted at the owner's request:** forcing the payer to tick that a
    payment slip matches the beneficiary's bank, account title, IBAN and amount before a refund can be
    marked Paid. Do **not** bring it back unless the owner asks.

---

## 10. Data to carry over

| What | Where it lives now | Notes |
|---|---|---|
| Tickets | KV keys `tk:<uid>`, index `tk_index`; the older single blob `tickets` (from before the per-ticket store) is kept as a backup only | Keep `uid`, `id` (RX-number), history, photos, `dupCleared`. Continue numbering after the highest existing RX number |
| Logins | KV `auth_users` | If the new app uses a different hash scheme, verify the old hash once at first login, then re-save with the new one; otherwise passwords must be reset |
| Refund roles | `roles.__rex` inside KV `roles` | Plus the main roles for context |
| Product catalogue | See section 11 | Not owned by this app |

Do the carry-over as a one-time import run by the Owner, with a dry run that prints counts (tickets, photos,
users, roles) and a way to roll back.

---

## 11. Product data dependency

The current panel borrows product information from the main app, which the new app will not have:
- **Product names** for the type-ahead come from the Laam stock file and the sales detail.
- **Thumbnails** come from the Shopify product snapshot (`data/shopify-snapshot.json`, keys `stock`,
  `price`, `status`, `img`, `gen`, ~700 products keyed by lower-case product name). Name matching is
  forgiving: exact, then letters-and-digits only, then ignoring brackets, then longest-prefix.
- **Rating chip** (stars, feedback count) comes from Laam customer ratings.

The new app should work with **free-text products** and treat the catalogue, thumbnails and ratings as
optional enrichments. Decision needed on where the catalogue comes from (section 12).

---

## 12. Decisions needed from the owner before building

1. **Backend:** (a) reuse the existing Worker, so users, roles and tickets are shared with OPS from day one,
   or (b) a new, separate Worker with a one-time import. *Recommendation: (b)*, because it fixes items 2-3 of
   section 9 (roles overwrite, token over-reach) and keeps refund staff away from business data. Costs one
   migration.
2. **Where tickets are stored:** Durable Object or D1 (recommended: consistent, atomic numbers, real
   transactions) versus staying on KV.
3. **Bank-detail visibility** (section 9, item 4) and whether bank details become mandatory (item 5).
4. **Product catalogue source:** the daily Shopify snapshot already published by the owner's PC automation,
   live Shopify, or free text only.
5. **Who gets which refund role** (fill the table in 2.5), and confirm RZ/Zain is excluded.
6. **Hosting and name:** new Netlify site and Cloudflare Worker names; whether the old panel is hidden after
   cut-over.
7. **Cut-over plan:** run both in parallel for a period, or switch on a set date.

---

## 13. Suggested build

**Stack (matches what the owner already runs):** static front end on Netlify (vanilla JS single page is fine,
same style as OPS), Cloudflare Worker back end, R2 for photos, a consistent store for tickets (decision 2).
No build step is needed on the front end.

**Phases**
1. Server: users, login, roles, ticket store with server-side rules and tests.
2. Front end: login, ticket list with filters and KPIs, create, detail, history, notes.
3. Proof photos, Send Back, Delete, duplicate guard (live + gate + clearing + override).
4. CSV export, backups, import of existing tickets/users/roles, phone polish.
5. Parallel run, then cut-over.

**Acceptance checklist** (each must be demonstrated, ideally as an automated test)
- Every transition in the section 3 table is allowed for the listed roles and **refused for all others by
  the server**, including when calling the API directly.
- A stage cannot be skipped; photo stages refuse to advance without a photo.
- Two people raising a ticket at the same instant get two different numbers and both tickets survive.
- A stale edit is rejected and the user is told; nothing is silently reverted.
- A refund with a RED duplicate cannot be paid by a non-admin; an admin override requires a reason and is
  logged; "Not a duplicate" is recorded on both tickets.
- Normalisation cases: spaced vs unspaced IBAN, lower- vs upper-case, multi-number order fields.
- A non-Owner cannot change roles or users; a removed user cannot log in or use an existing token.
- A failed or offline save never shows an empty list and never wipes data; unsaved work is visibly flagged.
- History is append-only and every entry shows who and when.
- Bank details are visible only to the roles decided in decision 3, in the list, the detail and the CSV.

---

## 14. Kickoff prompt (paste into a new Claude Code session, with this file attached)

```
You are building a new standalone web app, "Sahibas Refunds & Exchange".

Read docs/refunds-exchange-app-spec.md completely before doing anything. It is the specification,
extracted from the live Sahibas OPS app. Where it is silent, the original code is the source of truth:
repo Mirza-Traders/Sahibas-aap at commit bcc2642 — public/index.html lines 6799-7985 and
cloudflare-worker.js lines 313-384 and 595-786 (full source map in section 15 of the spec).

Rules:
1. Keep the process exactly as specified: the six stages, who may do each, the mandatory proof photos,
   the duplicate-refund guard, and the audit history. The users and refund roles must be the same people.
2. Enforce every rule on the server, not only in the UI. Section 9 lists where the old app did not.
3. Do not modify, deploy or push anything in the existing Sahibas OPS app or its Worker.
4. Before writing code, ask me the open decisions in section 12 in a single batch, then propose the
   architecture and wait for my approval.
5. Build in the phases in section 13 and run the acceptance checklist before calling a phase done.
6. Show screenshots of the finished screens.
```

---

## 15. Source map (current app, commit `bcc2642`)

| What | File | Lines |
|---|---|---|
| Whole Refunds & Exchange section | `public/index.html` | 6799-7985 |
| Stages, labels, role-to-stage permission (`rxCanAdvance`) | `public/index.html` | 6828-6841, 7253-7271 |
| Ticket list screen (`rRX`), CSV export | `public/index.html` | 7359-7559 |
| New ticket form and `submitRx` | `public/index.html` | 7570-7730 |
| Ticket detail, photo rules, advance, send back, note, delete | `public/index.html` | 7731-7985 |
| Duplicate-refund guard | `public/index.html` | 7273-7357, 7840-7909 |
| Save, merge, stash, retry, polling | `public/index.html` | 6842-7196 |
| `rexRole()`, role-based menu hiding | `public/index.html` | 1262-1332 |
| Users panel (Refund Role column), saving refund roles | `public/index.html` | 3345-3400, 3859-3872 |
| User directory (hard-coded) | `public/index.html` | 635-653 |
| Login, logout, change password, create / reset / revoke user | `public/index.html` | 3758-3820, 8267-8372 |
| Image compression | `public/index.html` | 5410-5430 |
| Auth primitives, `/login`, `/change-password`, admin endpoints | `cloudflare-worker.js` | 14-90, 124-221 |
| `/roles`, `/tickets`, `/tickets/delete` | `cloudflare-worker.js` | 269-284, 313-384 |
| Per-ticket store (index, upsert, revisions, migration) | `cloudflare-worker.js` | 595-786 |
| Behaviour tests | `tests/worker/tickets-harness.mjs`, `tests/worker/auth-harness.mjs` | |

---

## 16. Visual identity (keep it recognisable)

- Brand line: "SAHIBAS BY MIRZA / OPS". Gold accent `#c8a96e` (dark gold `#a07030`), near-black `#1a1a1a`,
  page background `#f5f5f5`.
- Refund = red (`#c0392b`). Exchange = green (`#0F6E56`). Both appear in badges, buttons and the stage-tab rows.
- Stage badges: Initiated `#fff8e0`/`#a07030` · Received `#eef3fb`/`#2471a3` · Approved `#f5e8f8`/`#8e44ad` ·
  Paid `#e8f8ee`/`#1e8449` · Informed `#e8f8f5`/`#16a085` · Closed `#f0f0f0`/`#888`.
- Duplicate marks: red `⛔` for RED, amber `⚠` for AMBER; green "No duplicate refunds" chip when clear.
- Customer-profile columns tinted light blue, bank columns tinted light gold, so the two are visually
  paired with the money step.
- Dense, table-first layout; modals for create and detail; toasts for success, sticky banners for risk.
