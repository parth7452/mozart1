# Verify checklist — proving what is built but not yet exercised

*2026-09-24. For the founder. Every item here is built and tested by machines;
none has yet been done by a person on the live app. Each checklist below is
something to click through once, so that "it works" means someone watched it
work.*

`docs/STATE-OF-PLAY.md` → *Built, not yet exercised* is the list these come
from. When a checklist passes, that row can move to *Live in production*.

## How to use this

Every step has three parts:

- **Do** — what to click or type.
- **You should see** — what the screen should show. The words in quotes are
  copied from the app, so they should match exactly.
- **Proof** — how to confirm it from the records rather than from the
  screen: a database query, a log line, or both.

**Where to run the queries.** Supabase dashboard → project
`hvheqbgkvwhlqutklwfh` (production, *not* `mozart-preview`) → **SQL Editor**.
Paste one block, press **Run**. Every query here only *reads*, except the
ones marked **WRITE**, and those only add rows. The SQL editor sees every
workspace at once (it runs as the database owner), so the queries filter
carefully. Please don't adapt them without asking.

**Where to read logs.**

- **Vercel** → the web project → **Logs**. Choose the time of the step and
  search for the text given, for example `[sign-in link]`.
- **Inngest** → the production environment → **Runs**, for background jobs.

Logs are kept for a short time, so check them right after each step.

**What to send me when a step does not match:**

- a screenshot;
- the time (with timezone);
- the number of the step;
- the output of the step's proof query.

Nothing else is needed.

### Before you start — five things that will otherwise trip you up

1. **Production is permanent.** The database is append-only by design:
   anything uploaded, decided, declined, merged or undone stays in the record
   for ever. So checklists **3, 7 and 8 run in a separate test workspace**
   (made in checklist 4). Only the checklists that must touch real data
   (1, 2, 6) run in your own workspace.
2. **Sign out is at the bottom of the sidebar**, under your email address
   (it signs you out everywhere, not just in this window). A separate private
   (incognito) window or browser profile for each person you sign in as is
   still the easiest way to be two people at once. On a narrow (phone-width)
   window the sidebar is collapsed and neither control shows.
3. **Open every sign-in link in the same window that asked for it.** The link
   only works in the browser that requested it. If your email app opens links
   somewhere else, you'll see "that link has expired". In that case, copy the
   link and paste it into the window that asked for it.
4. **Someone in two workspaces switches between them in the sidebar.** Under
   the workspace name, **Switch workspace** lists every workspace you belong
   to, with the one you are looking at marked *current*; press another to
   move to it. It appears only for someone in more than one. The first time
   you sign in you land in the one whose name comes first alphabetically,
   and after that in whichever you last switched to (signing out forgets it).
   Using a *different email address* for the test workspace still works and
   still keeps the two apart most safely: with Gmail,
   `you+tenantb@gmail.com` arrives in your own inbox, but the app treats it
   as a different person.
5. **The app is `https://app.mozart.financial`.** Always use that address,
   never a `vercel.app` one. Sign-in and QuickBooks only work on that address.

### Suggested order

Do **2** first (sign-in; it needs migration 0035 and the hook, see its
*Before you start*), then **4** (make the test workspace), then **2.7**,
**3**, **1**, **6**, **7**, **8**, **9**, **10** and **11**. **5** waits for your Postmark
setup; see its first step.

The fixture files mentioned below are synthetic test documents. Download each
one from GitHub while you are signed in: open the link, then click **Download
raw file**.

| File | What it is | Link |
| --- | --- | --- |
| `hl-case-01-notice.pdf` | A $600.00 deduction notice, claim DN-2609-001 | [download](https://github.com/parth7452/mozart1/blob/main/packages/fixtures/corpus/hl-case-01-notice.pdf) |
| `hl-case-02-remittance.pdf` | A payment that short-paid invoice INV-260802 by $900.00 | [download](https://github.com/parth7452/mozart1/blob/main/packages/fixtures/corpus/hl-case-02-remittance.pdf) |
| `hl-case-02-notice.pdf` | The notice for that same $900.00 deduction, claim DN-2609-002 | [download](https://github.com/parth7452/mozart1/blob/main/packages/fixtures/corpus/hl-case-02-notice.pdf) |
| `crosswind-dense-remittance-scan.jpg` | A scanned 42-row remittance, 12 lines short-paid | [download](https://github.com/parth7452/mozart1/blob/main/packages/fixtures/scans/crosswind-dense-remittance-scan.jpg) |

Reading a document costs money: about 2–3 cents for a one-page notice and
about 12–15 cents for the 42-row remittance.

---

## 1. QuickBooks: disconnect, connect, first sync, disconnect, connect again

**What it proves:**

- the owner can connect the company themselves;
- the first sync starts on its own;
- Disconnect really ends our access at Intuit;
- connecting again after a revoke works.

That last point is one of the two things ADR 0039 left open. **Run on
2026-09-24.** The sandbox connection was disconnected from the app at 18:47
UTC, and Intuit confirmed the revoke. At 19:00 a production company was
connected through the app on the production keys, and its first sync finished
three seconds later.

**Who:** the workspace **owner**, in your own workspace. The company is the
QuickBooks **sandbox** company.

**Start state:** production already holds an enabled connection to the sandbox
company (made 2026-09-23), so the page will show **Connected** rather than a
Connect button. That is why this checklist starts with Disconnect.

> Always pick the **same sandbox company** at Intuit. The page shows only one
> connected company. A second company would connect, but you would not see
> it.

**Q0 — before you start: note these numbers.**

```sql
select now() as checked_at,
       (select max(id)  from audit_log)              as audit_high_water,
       (select max(seq) from accounting_credentials) as credential_high_water,
       (select count(*) from ledger_sync_runs)       as runs_so_far;
```

The queries below use `<COMPANY_ID>`: the number shown next to **Company** on
the settings page.

**Q1 — the connection.** It should read `enabled = true` after a connect and
`false` after a disconnect. The `connection_id` should stay the same
throughout.

```sql
select c.id as connection_id, o.slug as workspace, c.provider_account_id as company_id,
       c.enabled, u.email as syncs_as, c.created_at, c.updated_at
  from accounting_connections c
  join organizations o on o.id = c.org_id
  left join users u on u.id = c.created_by
 where c.provider = 'qbo' and c.provider_account_id = '<COMPANY_ID>'
 order by c.enabled desc, c.updated_at desc;
```

**Q2 — stored sign-ins.** One new row per connect. The sign-in itself is
encrypted and not shown.

```sql
select ac.connection_id, ac.seq, ac.created_at, ac.cipher,
       ac.access_expires_at, ac.refresh_expires_at, u.email as stored_by
  from accounting_credentials ac
  join accounting_connections c on c.id = ac.connection_id
  left join users u on u.id = ac.created_by
 where c.provider_account_id = '<COMPANY_ID>'
 order by ac.seq desc limit 5;
```

**Q3 — the audit trail.** `revoke_result` should read `confirmed`.

```sql
select a.id, a.observed_at, a.action, u.email as actor,
       a.payload->>'via' as via, a.payload->>'environment' as environment,
       a.payload->>'result' as revoke_result, a.payload->>'error_class' as revoke_error
  from audit_log a
  left join users u on u.id = a.actor_id
 where a.subject_table = 'accounting_connections'
   and a.payload->>'provider_account_id' = '<COMPANY_ID>'
 order by a.id desc limit 10;
```

**Q4 — sync runs.** The newest first. The outcome should be `completed` and
`error_class` should be empty.

```sql
select r.started_at, r.outcome, r.error_class, r.window_from, r.window_to,
       r.invoices_examined, r.opened_count, r.skipped_count, r.declined_count, r.anomaly_count
  from ledger_sync_runs r
  join accounting_connections c on c.id = r.connection_id
 where c.provider_account_id = '<COMPANY_ID>'
 order by r.started_at desc, r.recorded_at desc limit 5;
```

### Steps

**1.1 Open the settings page.**

- **Do:** sign in as the owner. In the left sidebar, choose **QuickBooks**.
- **You should see:**
  - the heading "Connected";
  - **Company** followed by a number (write it down as `<COMPANY_ID>`);
  - **Reads** "sandbox QuickBooks companies";
  - **Syncs as** your email;
  - a **Last sync** line;
  - a **Disconnect** button.
- **Proof:** Q1 shows `enabled = true`.
- **Optional:** the approver, in another window, sees the same page with no
  buttons and the line "Only an owner of this workspace can connect or
  disconnect QuickBooks."

**1.2 Disconnect.**

- **Do:** press **Disconnect**.
- **You should see:**
  - the green notice "QuickBooks is disconnected, and Intuit confirmed our
    access is revoked";
  - the heading "Not connected";
  - an **Earlier connections** table listing the company with today's date.
- If the notice instead says "…but Intuit did not confirm the revoke…", the
  connection is still off, but **that is a finding: stop and send it to me**.
- **Proof:**
  - Q1 shows `enabled = false`;
  - Q3 shows two new rows: `accounting_connection.disconnected` (via
    `web_consent`), then `accounting_connection.revoke` with `revoke_result`
    `confirmed`.
- **Log:** a confirmed revoke logs nothing. A failed one logs
  `[recouple] QuickBooks disconnect: connection … is off; revoke failed`.

**1.3 Connect.**

- **Do:** press **Connect QuickBooks**. You are taken to Intuit. The address
  starts `https://appcenter.intuit.com/connect/oauth2` and contains
  `redirect_uri=https%3A%2F%2Fapp.mozart.financial%2Fsettings%2Fquickbooks%2Fcallback`.
  Sign in with the Intuit developer account, choose **the same sandbox
  company**, and approve.
- **Finish within 10 minutes, in one tab, pressing Connect once.**
- **You should see:** back on the settings page:
  - the green notice "QuickBooks is connected, and a first sync is on its way
    — short-paid invoices it finds will appear on the case list";
  - the heading "Connected".
- **If instead you see:**
  - "…could not be matched to this session…" — you took too long, used a
    second tab, or pressed twice. Press Connect once more.
  - "QuickBooks connects from this address only…" — you were not on
    `app.mozart.financial`.
  - "…already connected in another workspace…" — send it to me.
- **Proof:**
  - Q1 shows `enabled = true` with **the same** `connection_id` as before;
  - Q2 shows one new row;
  - Q3 shows a new `accounting_connection.reconnected` row, with via
    `web_consent` and environment `sandbox`.
- **Log:** `[recouple] QuickBooks connect: reconnected company <COMPANY_ID> as
  connection …`.

**1.4 The first sync arrives.**

- **Do:** wait about 3 minutes, then reload the settings page. The page does
  not refresh by itself.
- **You should see:** **Last sync** reads "<date and time> UTC: N invoices
  read, N cases opened, N declined, N anomalies". **Expect 0 cases opened.**
  The short-pays in this company were already found on 2026-09-23, so they
  count as already open.
- Then open **Coverage** (sidebar). Under **LEDGER SYNC → Recent runs**, the
  top row says **Completed**, with its **ALREADY OPEN** count.
- **Proof:**
  - Q4's newest row has outcome `completed` and an empty `error_class`;
  - in Inngest → Runs, "Sync one accounting ledger" shows as completed;
  - in the Vercel logs, `[recouple] ledger sync: step sync-ledger completed,
    connection …`.

**1.5 Disconnect again, and confirm Intuit's revoke.**

- **Do:** press **Disconnect**.
- **You should see and prove:** the same as 1.2 — green "…Intuit confirmed
  our access is revoked", Q1 `false`, Q3 `revoke_result = confirmed`.

**1.6 Connect again.**

- **Do and see:** repeat 1.3, then 1.4. Both notices should match, and a new
  completed run should appear.
- This proves that a fresh consent works after a revoke.

**1.7 End state.** Leave it **connected**, so the daily 07:00 UTC sync keeps
running. This must return one row with `enabled_connections = 1`:

```sql
select provider_account_id as company_id,
       count(*) filter (where enabled) as enabled_connections, count(*) as all_connections
  from accounting_connections where provider = 'qbo' group by provider_account_id;
```

### After this passes: Intuit production keys

**Done.** Intuit's production keys have been on Vercel Production since
2026-09-24, and a production company is connected. The rest of this section
is kept as a record of what the application asked for. The application is in
the Intuit Developer portal, under your app's production settings. What it
asks for:

- a verified developer profile and email;
- **an end-user licence agreement (terms) URL** and **a privacy policy URL**;
- the host domain, launch URL, disconnect URL and connect/reconnect URL;
- the production redirect URI;
- at least one app category;
- a declaration of regulated industries;
- **where the app is hosted** (country and IP addresses);
- an **app assessment questionnaire** covering legal, technical and security
  questions.

Values that already exist (`docs/qbo-credentials.md`):

| Field | Value |
| --- | --- |
| Host domain | `app.mozart.financial` |
| Launch URL | `https://app.mozart.financial/settings/quickbooks` |
| Connect / reconnect URL | `https://app.mozart.financial/settings/quickbooks` |
| Disconnect URL | `https://app.mozart.financial/settings/quickbooks` |
| Redirect URI (production keys) | `https://app.mozart.financial/settings/quickbooks/callback` |
| Hosting country | United States: the app on Vercel, the database on Supabase (AWS us-east-1) |

**The hosting IP question needs me.** Vercel does not give fixed IP
addresses. Ask me before you answer that one.

**The two pages.**

- **Both are done** (you): the privacy policy and the terms. Neither lives in
  this repository.
- Both must be **public** (readable without signing in) and at stable
  addresses. They should sit on the same domain as the app, for example
  `https://mozart.financial/privacy` and `https://mozart.financial/terms`.
  Link both from the site's footer and from the sign-in page.
- Have a lawyer write the final text. What follows are **the facts the pages
  have to state**, taken from how the product actually works.

**The privacy policy must say:**

1. **Who you are** and how to contact you about privacy.
2. **What you collect:**
   - the name and work email of invited users;
   - documents customers upload (deduction notices, remittances, invoices,
     proofs of delivery) and the fields read from them;
   - **from QuickBooks, read only:**
     - the company id;
     - invoices: number, customer name and id, dates, totals, balance and
       currency;
     - the payments and credit memos applied to those invoices: amounts,
       dates, reference numbers and memos.
3. **What you never do with QuickBooks:** Mozart never writes to QuickBooks.
   It does not read payroll, bank feeds or other data it doesn't use.
   - Intuit's permission (the "accounting" scope) would allow writing. Say
     plainly that you only read.
4. **Why you use the data:**
   - to find short-paid invoices and deductions;
   - to open cases for the customer's team to review;
   - to prepare dispute paperwork, which a person approves before anything is
     sent;
   - to measure what was recovered.
5. **How it is protected:**
   - QuickBooks sign-in tokens are encrypted with keys held in AWS's key
     service;
   - each customer's data is kept apart by the database itself;
   - only invited people can sign in;
   - nothing is sent outside without a person's approval.
6. **Who else processes it (sub-processors):**
   - Intuit (QuickBooks);
   - Supabase (database and sign-in email);
   - Vercel (hosting);
   - Amazon Web Services (encryption keys);
   - Inngest (background jobs; it receives record ids, not documents);
   - Anthropic (an AI model reads *uploaded documents* to pull out their
     fields; it never receives QuickBooks data);
   - Reducto (reads the text off scanned pages);
   - Fly.io (the virus scanner uploads pass through);
   - Postmark (email-in, live since 2026-09-25). It keeps inbound mail,
     attachments included, for at least 7 days and 45 by default.
7. **AI use:** say that uploaded documents are read by an AI model, what the
   model provider's contract says about using that data, and that a person
   reviews before anything is filed.
8. **Retention and deletion.** Be honest: the system keeps a permanent audit
   trail on purpose, because a dispute's evidence has to survive audits about
   two years later. Disconnecting QuickBooks stops all reading, but what was
   already imported stays.
   - **This needs a decision from you:** how long records are kept after a
     customer leaves, and what "delete my data" means. Today the database
     refuses deletions by design, so an end-of-contract deletion would be a
     new engineering decision (an ADR).
9. **Customer rights and requests:** access, export, correction and deletion,
   and how to ask for them.
10. **Cookies:** only the sign-in session cookie and a 10-minute cookie used
    while connecting QuickBooks. No advertising trackers (check the marketing
    site too).
11. **Where the data is stored** (the United States), how you will tell
    customers about a security incident, and the policy's effective date and
    how changes are announced.

**The terms (end-user licence agreement) must say:**

1. **Who may use it:** people invited to a customer's workspace. The customer
   must have the authority to connect its QuickBooks company.
2. **What the service does and does not do:**
   - it finds and helps dispute deductions;
   - its QuickBooks access is read-only;
   - **nothing is filed or sent without a person's approval**;
   - recovery is not guaranteed.
3. **Data:** the customer owns its data, and grants you the right to process
   it only to provide the service. Confidentiality.
4. **Fees:** the contingency fee on recovered amounts, what counts as
   "recovered", and how it is invoiced. It must match the customer contract.
5. **Third parties:** QuickBooks is Intuit's product, and Intuit is not
   responsible for Mozart.
6. **Disconnecting and ending the service:**
   - how to disconnect: Settings → QuickBooks → Disconnect, or inside
     QuickBooks;
   - what happens to data afterwards (see privacy item 8).
7. **The usual legal terms:** acceptable use, warranty disclaimer, limitation
   of liability, governing law, how changes are announced, and contact
   details.

---

## 2. Invite-only sign-in, with sign-ups on (ADR 0045, ADR 0051 §6)

**What it proves:**

- members sign in through the form;
- a stranger gets the same message but no email;
- a person added to a workspace signs in from the form alone: their first
  email asks them to confirm their address, and its link signs them in.
  Nothing is pressed in the Supabase dashboard;
- Supabase itself refuses to make an account for an address nobody invited,
  even when it is asked directly rather than through our form;
- a session signed in with a password is refused.

"Allow new users to sign up" was off from ADR 0045 until 2026-09-26, when you
switched it back on: with it off, Supabase will not make an account even for
an invited address. So this checklist no longer ends by switching sign-ups
off. It ends with the hook on and every account nobody invited deleted.

**Before you start** (ADR 0051 §6):

- migration 0035 is applied to production, after `mozart-preview`, and only
  then is the change that came with it deployed. The sign-in form asks the
  database about every address, and without 0035 every address gets "sign-in
  could not be completed" and nobody gets a link. Not yet: as of 2026-09-26,
  0035 is applied nowhere;
- **Allow new users to sign up** is on (Supabase → Authentication → **Sign In
  / Providers**). Done: 2026-09-26. Leave it on. Switched off, Supabase refuses
  to make an invited person's account (`signup_disabled`), so exactly the
  people 2.4 is about get no email, and the app logs `NOT SENT to an invited
  address`;
- the before-user-created hook is enabled: Supabase → Authentication →
  **Hooks** → **Before User Created** → **Postgres** → schema `hooks`,
  function `before_user_created`. The function exists only once 0035 is
  applied. Until the hook is on, anyone holding the publishable key can make
  a Supabase account for any address; 2.6 finds them. The hook also runs for the
  dashboard's **Send invitation**, which is no longer needed, and refuses it
  for anyone without a `users` row and a membership.

**Run once, 2026-09-26** (00:30–01:44 UTC), in your own workspace: 2.1–2.6
passed. The owner, the approver, the read-only tester and tester B (§4) each
reached the case list, with R1 `true` and R3 `linked` for all four. A
never-invited address got the same green notice and no email: both logs said
`otp_disabled` (HTTP 422), before and after sign-ups were switched off at
01:43 UTC, and the owner still got in afterwards. **Both dashboard invitations
went to Gmail's spam folder** (Supabase's default "You've been invited" email;
the branded sign-in email always reached the inbox). Claude ran 2.1, 2.3, 2.4
and 2.6 in an automated browser; you did 2.2, the 2.4 invitation and 2.5.
That run was of this section's **earlier version** (2.4 a dashboard
invitation, 2.5 switching open sign-ups off, 2.6 a re-check), before ADR 0051
rewrote it. Sign-ups have been on again since 07:06 UTC with the hook, and the
read-only tester's and tester B's Auth accounts were deleted at 07:01, so each
signs in again from the form, where the first link makes a new account. The
steps below, 2.4–2.7 as they now read, are not recorded here. The branded
templates in [`docs/email-templates/`](email-templates/README.md) are the fix
for the spam folder.

**R1 — who is invited where.** The last column becomes `true` once that
person has reached the app.

```sql
select o.name as workspace, u.email, m.role, u.auth_user_id is not null as has_reached_the_app
  from memberships m
  join organizations o on o.id = m.org_id
  join users u on u.id = m.user_id
 order by o.name, u.email;
```

**R2 — the hook's function is there, and only Supabase Auth may call it.**
Expect `true`, then `false`. An error saying it does not exist means 0035 is
not applied. This does not say whether the hook is enabled; 2.5 does.

```sql
select has_function_privilege('supabase_auth_admin', 'hooks.before_user_created(jsonb)', 'execute') as auth_may_call,
       has_function_privilege('anon', 'hooks.before_user_created(jsonb)', 'execute') as anon_may_call;
```

**R3 — every sign-in identity Supabase holds, and what the app does with
it.**

```sql
select a.email, a.created_at, a.last_sign_in_at,
       case when u.id is null then 'NO INVITATION: refused and signed out'
            when u.auth_user_id is null then 'invited, not yet reached the app'
            when u.auth_user_id = a.id then 'linked'
            else 'LINKED TO ANOTHER IDENTITY: refused' end as status
  from auth.users a
  left join users u on lower(u.email) = lower(a.email)
 order by a.created_at;
```

**R4 — must return no rows.** Two invitations for one address, differing
only in capital letters, would block that person's sign-in.

```sql
select lower(email) as address, count(*), array_agg(email)
  from users group by lower(email) having count(*) > 1;
```

**R5 — accounts nobody invited.** Every Supabase sign-in account whose address
is not a member of any workspace, leaving out anyone whose `users` row names
it (a person removed from every workspace keeps theirs). Must return no rows
once 2.6 is done.

```sql
select a.id, a.email, a.created_at, a.email_confirmed_at, a.last_sign_in_at
  from auth.users a
 where not exists (select 1 from public.users u
                     join public.memberships m on m.user_id = u.id
                    where lower(u.email) = lower(a.email))
   and not exists (select 1 from public.users u where u.auth_user_id = a.id)
 order by a.created_at desc;
```

### Steps

**2.1 The owner signs in.**

- **Do:**
  1. In a new private window, open `https://app.mozart.financial/login`.
  2. Type your address under **Work email** and press **Email me a sign-in
     link**.
  3. Open the email's link **in this same window**.
- **You should see:**
  - the heading "Welcome back.";
  - after pressing the button, the green notice "If that address belongs to
    a workspace, a sign-in link is on its way. Nothing within a few minutes?
    Sign-in emails are rate-limited: wait and try again, or ask whoever
    invited you.";
  - after the link, the case list.
- **Proof:** R1 shows `true` for you. R3 shows `linked` with a fresh
  `last_sign_in_at`.

**2.2 The approver signs in** in their own private window or browser. Same
steps, same result.

**2.3 A stranger gets the same answer and no email.**

- **Do:**
  1. Pick an address you control that has never been invited, for example
     `you+stranger1@gmail.com`.
  2. Check it is unknown: this query must return `0`:
     ```sql
     select count(*) from auth.users where lower(email) = lower('you+stranger1@gmail.com');
     ```
  3. Request a link for it.
- **You should see:** exactly the same green notice as in 2.1, and **no
  email**. Wait five minutes and check spam.
- **Proof:**
  - Vercel logs, search `[sign-in link]`:
    `… — no link sent: the provider has no account it will send to at that
    address (AuthApiError otp_disabled, HTTP 422). Answered as sent (ADR
    0045).` The form asks Supabase to make an account only for an invited
    address, so a stranger's answer is `otp_disabled` whatever the sign-up
    switch says.
  - The count query above is still `0`.
  - Supabase → Logs → Auth shows a `422` for `otp_disabled` ("Signups not
    allowed for otp").

**2.4 Add someone, and they sign in from the form alone.** This person
becomes the `read_only` member for checklist 3. Nothing is pressed in the
Supabase dashboard.

- **Do:**
  1. Pick an address you control that has never had a sign-in, such as
     `you+readonly@gmail.com`. This must return `0`; if it returns `1`, pick
     another:
     ```sql
     select count(*) from auth.users where lower(email) = lower('you+readonly@gmail.com');
     ```
  2. **WRITE**, in the SQL editor, with that address and your workspace's
     slug from R1. (Settings → Team → **Add a person** does the same, as an
     owner; §9 tests that page.)
     ```sql
     -- WRITE: the invitation row (refuses a second row that differs only in capitals)
     insert into users (email, full_name)
     select 'you+readonly@gmail.com', 'Read-only tester'
      where not exists (select 1 from users where lower(email) = lower('you+readonly@gmail.com'));

     -- WRITE: the membership, as read_only
     insert into memberships (org_id, user_id, role)
     select o.id, u.id, 'read_only'
       from organizations o, users u
      where o.slug = '<YOUR_WORKSPACE_SLUG>' and lower(u.email) = lower('you+readonly@gmail.com')
     on conflict (org_id, user_id) do nothing;
     ```
  3. In a new private window, request a link for that address, as in 2.1.
  4. Open the email **in this same window, within five minutes of asking**.
     It is Supabase's **Confirm signup** email, not a sign-in one: it asks you
     to confirm your address, and its link signs you in.
- **You should see:** the same green notice as in 2.1, then the case list,
  with "Read Only" as the role in the sidebar.
- **If you see "that link has expired":** you opened it more than five
  minutes after it was sent, or in another window. The address is confirmed
  anyway: ask for a new link in this window, and that one works. That is
  expected, not a finding.
- **Proof:**
  - R1 shows the new person with `true`. R3 shows `linked`.
  - Vercel logs, search `[sign-in link]`: no `NOT SENT to an invited address`
    line. If there is one, Supabase would not make an invited person's
    account: check the sign-up switch and the hook, and send it to me.

**2.5 Supabase refuses a stranger even when asked directly.** The
publishable key is public by design, so anyone can ask Supabase for an
account without our form. The hook is what says no.

- **Do:** in a terminal, with the publishable key
  (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` on Vercel, starting
  `sb_publishable_`) in place of `<PUBLISHABLE_KEY>`:
  ```
  curl -i https://hvheqbgkvwhlqutklwfh.supabase.co/auth/v1/signup \
    -H 'apikey: <PUBLISHABLE_KEY>' -H 'Content-Type: application/json' \
    -d '{"email": "you+stranger2@gmail.com", "password": "Checklist-2.5-stranger"}'
  ```
- **You should see:** `403` on the first line, and "Accounts are created by
  invitation only." in the answer. No email.
- **If it answers `200`:** the hook is not on, and that account now exists.
  Stop, send it to me, and delete it in Supabase → Authentication → Users.
- **Proof:**
  - this returns `0`:
    ```sql
    select count(*) from auth.users where lower(email) = lower('you+stranger2@gmail.com');
    ```
  - Supabase → Logs → Auth shows the `403`.

**2.6 Delete the accounts nobody invited.** While sign-ups are on and the
hook is not, anyone holding the publishable key can make a Supabase account
for any address. Such an account reaches nothing, because the app signs out
an identity with no invitation or no membership. But the hook never runs
again for an account that already exists.

- **Do:** run R5, and delete each account it lists in Supabase →
  Authentication → Users. If it lists someone you expected to be a member,
  stop and send it to me instead: they may need adding, not deleting.
- **Proof:** R5 returns no rows.

**2.7 A password session is refused.** Do this in the **test workspace**,
after checklist 4.

With sign-ups on, somebody can register an invited person's address with a
password of their own before that person first asks for a link. Supabase
mails the person a confirmation that looks just like the one they were told
to expect, and when they click it the account is confirmed *with that
password*. The hook cannot stop this, because the address is invited. The app
does: it refuses any session not made by one of its own email links (ADR 0051
§6). This step plays the attacker.

- **Do:**
  1. Check the address has never had a sign-in (this must return `0`), then
     add it to the test workspace (**WRITE**):
     ```sql
     select count(*) from auth.users where lower(email) = lower('you+password@gmail.com');
     ```
     ```sql
     -- WRITE: the invitation row
     insert into users (email, full_name)
     select 'you+password@gmail.com', 'Password tester'
      where not exists (select 1 from users where lower(email) = lower('you+password@gmail.com'));

     -- WRITE: the membership, as read_only, in the test workspace
     insert into memberships (org_id, user_id, role)
     select o.id, u.id, 'read_only'
       from organizations o, users u
      where o.slug = 'test-tenant-b' and lower(u.email) = lower('you+password@gmail.com')
     on conflict (org_id, user_id) do nothing;
     ```
  2. Register it with a password, the way 2.5 tried for the stranger:
     ```
     curl -i https://hvheqbgkvwhlqutklwfh.supabase.co/auth/v1/signup \
       -H 'apikey: <PUBLISHABLE_KEY>' -H 'Content-Type: application/json' \
       -d '{"email": "you+password@gmail.com", "password": "Checklist-2.7-attacker"}'
     ```
     This time the first line says `200`: the address is invited, so the
     hook lets it through, and Supabase mails it a **Confirm signup** email.
  3. Open that email's link once, in a new private window, as the invitee
     would. It confirms the address and leaves you on the sign-in page, not
     signed in.
  4. Sign in with the password, at Supabase directly:
     ```
     curl -s 'https://hvheqbgkvwhlqutklwfh.supabase.co/auth/v1/token?grant_type=password' \
       -H 'apikey: <PUBLISHABLE_KEY>' -H 'Content-Type: application/json' \
       -d '{"email": "you+password@gmail.com", "password": "Checklist-2.7-attacker"}'
     ```
     It prints one line starting `{"access_token":`. That is a working
     session. Copy the whole line.
  5. In a new private window, open `https://app.mozart.financial/login`, then
     the browser's developer tools → **Console** (Chrome asks you to type
     `allow pasting` first). Paste this, with the line from step 4 in place
     of `<SESSION>`, and press Enter. It puts that session where the app
     looks for one:
     ```js
     const s = <SESSION>;
     const v = btoa(JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token,
       expires_at: s.expires_at, expires_in: s.expires_in, token_type: s.token_type }))
       .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
     document.cookie = `sb-hvheqbgkvwhlqutklwfh-auth-token=base64-${v}; path=/; secure; samesite=lax`;
     ```
  6. In that window, open `https://app.mozart.financial/`.
- **You should see:** the sign-in page with the red notice "this app signs in
  by email link only. Enter your address below to get one.", not the case
  list.
- **If you see the case list**, that is a finding: stop and send it to me. If
  you see the sign-in page with no red notice, the session did not take:
  send me the time.
- **Proof:**
  - Vercel logs, search `[sign-in refused]`: `… presented a session signed
    in with a password, which this app never offers: somebody holds a
    password for this account. Refused and signed out locally (ADR 0051 §6).
    …`
  - R3 shows the address as `invited, not yet reached the app`: the session
    was refused before the database was asked who it was.
- **Then:** delete that account in Supabase → Authentication → Users, as the
  log line says. Its `users` row and membership stay in the test workspace
  and reach nothing without an email link.

---

## 3. A `read_only` member cannot upload or decline

**What it proves:** the app does not offer a reader the upload or decline
actions, and it refuses them if a reader's browser sends one anyway. The
database refuses them too; the automated tests prove that part.

**Run once, 2026-09-26**: 3.1–3.4 passed. The read-only tester saw no upload
form, none of the three cards in 3.2 on any of the seven cases, and no buttons
in Settings → QuickBooks. 3.4 ran in the test workspace in a different order:
tester B was made read-only first, and a copy of each form was then sent from
tester B's session, which is the same request a stale tab sends. Both were
refused with the notices below; the workspace still held one document (the
upload was `hl-case-04-notice.pdf`, new to it, so a failed refusal would have
shown) and no decline. The upload button's in-page behaviour was not tested.
Tester B is `analyst` again. The upload form now reads **Add documents** /
**Read them** and takes several files of up to 4 MB each.

**Who:** the read-only person from 2.4, in your workspace for 3.1–3.3. The
forced refusal (3.4) is done in the test workspace from checklist 4.

**3.1 The case list.**

- **Do:** sign in as the read-only person.
- **You should see:**
  - **no** "＋ Add a document" button at the top;
  - **no** "Add documents" / **Read them** form at the bottom;
  - the "What to work on next" queue and the "Deduction ledger", both
    visible;
  - "Read Only" as the role in the sidebar.

**3.2 A case page.**

- **Do:** open any case from the list, for example one of the two ledger
  cases.
- **You should see:** no "Add evidence" card, no "Dispute this deduction"
  card, and no "Not worth fighting?" (decline) card.

**3.3 Coverage and Settings.**

- **Do:** open both from the sidebar.
- **You should see:** both pages open. Settings → QuickBooks has no buttons
  and says "Only an owner of this workspace can connect or disconnect
  QuickBooks."

**3.4 The refusal itself** (the "stale tab" test). Do this in the **test
workspace**, after checklist 4, as tester B.

The app hides the forms from a reader, so the only way to see the refusal is
to open a form while you can still write, then lose the right to write before
you submit it.

1. As tester B (an analyst), open the case list. The **Read them** form is
   there. Choose `hl-case-01-notice.pdf` in it, but **don't press Read them
   yet**.
2. **WRITE:** make tester B read-only:
   ```sql
   update memberships m set role = 'read_only'
     from organizations o, users u
    where m.org_id = o.id and m.user_id = u.id
      and o.slug = 'test-tenant-b' and lower(u.email) = lower('<TESTER_B_EMAIL>');
   ```
3. Back in the same tab, press **Read them**.
   - **You should see:** the red notice "your role can review documents but
     not add them".
   - **Proof:** the document count for workspace B has not changed:
     ```sql
     select count(*) from documents d join organizations o on o.id = d.org_id
      where o.slug = 'test-tenant-b';
     ```
4. For the decline:
   - Before step 2, open a case page in workspace B that shows the **Record
     this decline** button.
   - After step 2, fill it in and press it.
   - **You should see:** the red notice "your role can review cases but not
     decide them".
   - **Proof:** this returns `0`:
     ```sql
     select count(*) from declined_candidates dc join organizations o on o.id = dc.org_id
      where o.slug = 'test-tenant-b';
     ```
5. **WRITE:** set tester B back to `analyst` (same query, with `'analyst'`),
   so checklists 7 and 8 can use them.

---

## 4. Two workspaces side by side, each seeing only its own

**What it proves:** a second customer, through the app rather than through
SQL, sees only its own cases and cannot open yours. This checklist also
creates the **test workspace** used by 3, 7 and 8.

**Run once, 2026-09-26**: 4.1–4.4 passed. `docs/ONBOARDING.md` §1's block,
pasted into the SQL editor, arrived cut short twice and was refused whole, so
the workspace was made with 4.1's inserts instead, the last one changed to add you as
`owner` and `<TESTER_B_EMAIL>` as `analyst` (a case can be prepared and
approved here; no debtors yet). ONBOARDING §1's read-back was then all `true`.
The block has since moved out of the page into its own file,
`docs/onboarding/create-workspace.sql`, to be pasted whole from GitHub's
**Raw** view and checked by its last line (`$onboard$;`) before **Run**; it
has not yet been run from there.
Tester B's `hl-case-01-notice.pdf` opened DN-2609-001, $600.00, Harbor Lane
Markets *not matched*, 16 seconds after the upload, for $0.026. Each
workspace's case address gave the 404 in the other. Because you belong to
both, **Switch workspace** appeared in your sidebar and moved you between
them; **Sign out** returned to the sign-in page.

**4.1 Create "Test Tenant B" and its member.** (**WRITE** — all four are
needed. The settings row is required: without it, nothing in that workspace
can be read.)

```sql
-- WRITE: the workspace
insert into organizations (slug, name) values ('test-tenant-b', 'Test Tenant B')
on conflict (slug) do nothing;

-- WRITE: its settings (every value takes the default)
insert into org_settings (org_id)
select id from organizations where slug = 'test-tenant-b'
on conflict (org_id) do nothing;

-- WRITE: its tester (use an address you control, e.g. you+tenantb@gmail.com)
insert into users (email, full_name)
select '<TESTER_B_EMAIL>', 'Tester B'
 where not exists (select 1 from users where lower(email) = lower('<TESTER_B_EMAIL>'));

-- WRITE: the tester's membership, as analyst (can upload, decide, merge — not approve)
insert into memberships (org_id, user_id, role)
select o.id, u.id, 'analyst'
  from organizations o, users u
 where o.slug = 'test-tenant-b' and lower(u.email) = lower('<TESTER_B_EMAIL>')
on conflict (org_id, user_id) do nothing;
```

Nothing in the Supabase dashboard: if tester B's address has never signed
in, their first sign-in link makes their account.

**4.2 Tester B signs in** in a separate private window or browser profile,
from the form, as in 2.4: for an address that has never signed in, the first
email is the **Confirm signup** one, and its link signs them in.

- **You should see:**
  - "Test Tenant B" under **YOUR WORKSPACE** in the sidebar;
  - a case list reading "No cases yet";
  - a queue reading "No case is open yet. A case appears here when it opens,
    most urgent first.";
  - Coverage reading "Nothing found yet…".
- None of your cases appear anywhere.

**4.3 Give B a case of its own.**

- **Do:** as tester B, use **Add a document** → choose `hl-case-01-notice.pdf`
  → **Read them**.
- **You should see:** the green notice "that document is being read…".
  After 1–2 minutes, reload: a case **DN-2609-001**, $600.00, "Harbor Lane
  Markets" marked *not matched*, in the queue under "No deadline printed".

**4.4 Cross-check both directions.**

- **Do:**
  1. Copy B's case address (`/cases/…`) from B's window into **your** window.
  2. Copy one of your case addresses into B's window.
- **You should see:** both show "404 — This page could not be found."
  - This is on purpose: the app doesn't even admit the case exists.
  - Your case list does not show DN-2609-001, and B's does not show your
    cases.
- **Proof** — cases per workspace (B should have 1):
  ```sql
  select o.name, count(d.id) as cases
    from organizations o left join deductions d on d.org_id = o.id
   group by o.name order by o.name;
  ```

---

## 5. Email-in: an emailed notice is held, and a person opens it

**What it proves:** a supplier can email a notice to your workspace, and it
arrives as a held document that a person opens with one click (ADR 0047).
**No email opens a case on its own**, however trustworthy it looks. It also
proves that an email which filed nothing says why, and that the sweep
records email Postmark could not deliver.

**Run once, 2026-09-25**, in your own workspace: 5.1–5.4 passed. The address
was issued, the Gmail notice was held by email with aligned DKIM "yes", and
**Open a case from it** opened DN-2609-003 for $2,000.00, with every proof
query as expected. 5.5 was read from our side, not in Postmark's Activity:
the single delivery was answered 200 with no 401 before it, and the recorded
DKIM "pass" is only possible with exactly one of each `X-Spam-*` header and
`DKIM_VALID_AU`. 5.6–5.8 have not been run.

**Before you start** (ADR 0047, "What the founder does", steps 1–4):

- the inbound domain's MX record points at `inbound.postmarkapp.com`.
  Done: 2026-09-25, for `in.mozart.financial`, at Porkbun (the domain's DNS
  host; Vercel serves only `app.`);
- the Postmark server's inbound webhook is
  `https://postmark:<secret>@app.mozart.financial/api/inbound/postmark`.
  Done: 2026-09-25;
- `POSTMARK_INBOUND_SECRET` and `INBOUND_DOMAIN` are set on Vercel
  **Production only**, and production has been redeployed since. Done:
  2026-09-25, redeployed at 04:37 UTC;
- migration 0034 is applied to production. Done: 2026-09-24, and read back.

**Where:** your own workspace, as its owner. The test adds one real case
(DN-2609-003, $2,000.00), so if you would rather keep your workspace clean,
do it in the test workspace (tester B must then be its owner).

**5.1 Issue an address.**

- **Do:** **Settings → Email** → **Issue a new address**.
- **You should see:**
  - "a new address is issued. Give it to the suppliers and payers who
    should reach this workspace; nothing has been sent to anyone.";
  - one address, 32 letters and digits `@` your inbound domain;
  - "Acts as" your email, and "Last received mail: never".
- **If it says "This deployment does not receive email":** the two Vercel
  variables are not on Production, or production was not redeployed.

**5.2 Check the test file is new to this workspace.**

The test needs a notice this workspace has never stored.

```sql
select d.id, d.org_id, u.source from documents d join uploads u on u.id = d.upload_id
 where encode(d.sha256, 'hex') = '977d45f3605cdf66829a01e33146b143099efc95c9fbc208067c01c2e78070e6';
```

If this shows a row for your workspace, use a notice the workspace has never
seen instead. Tell me, and I'll name one.

**5.3 Send it from Gmail.**

- **Do:** from a Gmail account, email [`hl-case-03-notice.pdf`](https://github.com/parth7452/mozart1/blob/main/packages/fixtures/corpus/hl-case-03-notice.pdf)
  as an attachment to the address from 5.1. Any subject; the body can say
  "see attached". Note the time.
- **You should see**, on the case list within a couple of minutes, under
  **Read, not on a case**:
  - the file, read as a deduction notice;
  - "Held: read as a deduction notice, and it arrived by email. No email
    opens a case on its own — a person decides each time.";
  - "By email · from gmail.com (as the email claims) · aligned DKIM per
    Postmark: yes".
- **Vercel logs:** search `inbound email`. One line ending
  `recorded as <id>, org <id>, parts stored,body_too_short`: the attachment
  was stored, and a one-line cover note is too short to be a notice, which
  is expected. The line must not show your address, the sender or the
  subject.
- **Inngest:** one run of **Read an email’s documents**, completed.

**5.4 Open the case.**

- **Do:** **Open a case from it** on that row.
- **You should see:** case **DN-2609-003**, **$2,000.00**, Summit Basket
  Retail.

**Proof.**

```sql
-- the email, as Postmark reported it: authenticated, DKIM pass
select id, outcome, authenticated, dkim, dmarc, spf, verdict_source, sender_domain, received_at
  from inbound_messages order by received_at desc limit 1;

-- its parts: the attachment stored, and a short cover note too short to read
select p.ordinal, p.kind, p.outcome, p.document_id
  from inbound_message_parts p
 where p.inbound_message_id = (select id from inbound_messages order by received_at desc limit 1)
 order by p.ordinal;

-- the notice's arrival: source email_in, and no person as its creator
select u.source, u.created_by from documents d join uploads u on u.id = d.upload_id
 where encode(d.sha256, 'hex') = '977d45f3605cdf66829a01e33146b143099efc95c9fbc208067c01c2e78070e6';

-- the case says a person opened it from a hold
select event_type, payload->'held'->>'reason' as held, payload->>'confirmed_by' as confirmed_by
  from deduction_events
 where event_type = 'case.discovered'
 order by id desc limit 1;
```

Expect `authenticated` **true**, `dkim` **pass**, `dmarc` **unknown** (Postmark
reports none), `verdict_source` **postmark_spamassassin** and `sender_domain`
**gmail.com**; the parts `attachment stored` and `body body_too_short`; source
**email_in** with `created_by` empty; and a `held` of `by_email` with your
member id as `confirmed_by`.

**5.5 Check what Postmark saw.** In Postmark → the server → the inbound
stream → **Activity**, open that message:

- exactly one each of `X-Spam-Status`, `X-Spam-Score` and `X-Spam-Tests`;
- `X-Spam-Tests` includes `DKIM_VALID_AU`;
- the webhook was answered **200** the first time, with no **401** before it.

If any of these is different, stop and send me a screenshot: the hold line's
DKIM report depends on them. Nothing would have opened a case either way.

**5.6 Before any customer gets an address** (ADR 0047, steps 7–10). These
check what the hold line may be trusted to say, and the failure paths:

- **A forged header.** From a mailbox that does not sign for its `From:`
  domain, send a message with hand-written `X-Spam-Tests: DKIM_VALID_AU` and
  `Authentication-Results: x; dkim=pass` headers, once small and once with a
  1–3 MB attachment. Each must be held with DKIM "no" or "unknown". Note
  what Postmark did with the headers.
- **An unaligned sender**, such as a Microsoft 365 domain without custom
  DKIM, or a forwarding rule: held with DKIM "no" or "unknown", and **Open a
  case from it** works.
- **An iPhone photo**, attached normally: it is read, not listed as a small
  inline image.
- **Too large.** Email about 5 MB of attachments. The next day, run
  `pnpm sweep:inbound` (5.8). It should appear under **Email that filed
  nothing** as "An email to this address on <date> did not reach us."
- **Not an address.** Email `support@` your inbound domain. Note the status
  Postmark leaves it in.
- **A wrong secret.** Change the secret on Vercel without updating Postmark,
  redeploy, send one email, and check in Postmark that it is retried after a
  **401**. Then put the secret back and redeploy.

**5.7 Retire and adopt** (optional). **Issue a new address**, then **Retire**
the new one. It moves under **Retired**. Mail sent to it afterwards is
refused (Postmark shows a 403) and is counted there.

**5.8 Run the sweep, daily.** On your machine, with `POSTMARK_SERVER_TOKEN`,
`INBOUND_DOMAIN` and `DATABASE_URL` in `.env`:

```
pnpm sweep:inbound
```

It prints how many messages Postmark failed to deliver over the last six
days, records each one sent to a live address, and counts what has waited on
Postmark for more than two hours. It only reads Postmark; it retries nothing
and sends nothing. Run it again and it records nothing new.

---

## 6. Decide one ledger case from the review queue

**What it proves:** a deduction found in QuickBooks (not uploaded by anyone)
can be picked from the queue and decided by a person, which ADR 0043 made
possible.

**Who:** the owner or an analyst, in **your** workspace. The two ledger cases
live there.

> **Deciding is permanent.** There is no undecide. Pick the case you would
> really dispute. After deciding, an **Assemble the packet** card appears:
> don't press it unless you mean to continue, because packets are permanent
> too.

**Q6a — the two ledger cases.** Expect two rows: $450.00 and $239.00, state
`classified`, `arrived_via = erp_sync`, no claim id.

```sql
select d.id, d.state, d.deduction_amount_cents, d.retailer_name_as_printed, d.deduction_date,
       d.claim_id, doc.filename, u.source as arrived_via
  from deductions d
  join deduction_documents dd on dd.deduction_id = d.id and dd.role = 'notice'
  join documents doc on doc.id = dd.document_id
  join uploads u on u.id = doc.upload_id
 where u.source = 'erp_sync'
 order by d.created_at;
```

**6.1 Find it in the queue.**

- **Do:** open `https://app.mozart.financial/`.
- **You should see:**
  - under "What to work on next" (tag "REVIEW QUEUE"), the bucket **"No
    deadline printed"** with its hint "Oldest first. Nothing we hold printed
    a dispute window, so age stands in for one. The payer's real window may
    be shorter.";
  - both ledger cases in it, each showing the customer name marked *not
    matched*, "invoice …", and **"Decide: dispute or decline"** as the next
    step.

**6.2 Open one.**

- **Do:** click its id (the first 8 characters, since a ledger case has no
  claim number).
- **You should see:**
  - "… · $450.00 deducted" (or $239.00);
  - the state "classified";
  - an embedded "Original deduction document" (the QuickBooks extract, shown
    as data);
  - a **Dispute this deduction** card and a **Not worth fighting?** card.

**6.3 Decide to dispute.**

- **Do:**
  1. Under **Why this deduction is invalid**, choose a reason. For a
     short-pay with no paperwork, "A deduction with no basis given" fits.
  2. Write one line under **In one line, for whoever approves it**.
  3. Press **Decide to dispute**.
- **You should see:**
  - the green notice "recorded: this case is yours to assemble a packet for.
    Nothing has been sent.";
  - "Decided to dispute" on the case's timeline, with your name;
  - the queue now showing "Assemble the packet" for this case.
- **Proof** — put the case id in both places:
  ```sql
  select c.provider, c.schema_id, c.result, u.email as prepared_by, c.created_at
    from decisions c left join users u on u.id = c.prepared_by
   where c.deduction_id = '<CASE_ID>';            -- one row: provider 'human', prepared_by = you
  select state from deductions where id = '<CASE_ID>';   -- 'analyst_review'
  select event_type, observed_at from deduction_events
   where deduction_id = '<CASE_ID>' order by id;  -- case.discovered, case.classified, decision.recorded
  ```

**Optional: declining the other one.**

- Choose a reason under **Not worth fighting?** and press **Record this
  decline**.
- **You should see:** the notice "recorded: this case is logged as declined,
  not discarded".
- Two things to know:
  - A decline is permanent.
  - **Once that notice is gone, the case page shows no trace of the decline**
    (a gap noted below). The proof is that the case leaves the queue, plus
    this query:
    ```sql
    select reason, estimated_recoverable_cents, discovered_from, provenance_kind, decided_by, decided_at
      from declined_candidates where deduction_id = '<OTHER_CASE_ID>';  -- discovered_from 'erp_sync', provenance_kind 'observed'
    ```

---

## 7. A real duplicate pair: confirm, merge, undo

**What it proves:** when the same deduction arrives twice without a shared
claim number, the app spots it, and a person can say "same deduction". The
two are then merged (ADR 0042), and the merge can be undone.

**Where:** the **test workspace**, as tester B. A merge and its undo are
permanent records.

**Upload the notice from the case list's "Add a document" form**, not from a
case page's "Add evidence". "Add evidence" files it on that case instead of
opening one.

**Either order lists the pair.** Until pilot E7
([parth7452/mozart1#104](https://github.com/parth7452/mozart1/pull/104)) a
notice uploaded *before* its remittance opened both cases and never listed
them as a pair. The steps below go remittance first; 7.1b is the other order,
the one E7 fixed. A file is read once per workspace, so choose one order: run
7.1 and 7.2, **or** 7.1b.

**Pre-check** (must return no rows):

```sql
select d.id, o.slug, d.filename from documents d join organizations o on o.id = d.org_id
 where encode(d.sha256, 'hex') in (
   '72682868cf9a286a0996022c92fba543e0101a38ffd05dce7b3e60fb5417665d',   -- hl-case-02-remittance.pdf
   '19e19d67449617fab2cc7e6107311def04a4f0db9df5b080a5e59221b8f65a19');  -- hl-case-02-notice.pdf
```

**7.1 The remittance.**

- **Do:** **Add a document** → `hl-case-02-remittance.pdf` → **Read them**.
  Reload after 1–2 minutes.
- **You should see:** a case **SIM-PAY-2609-002:INV-260802**, $900.00, "Cedar
  Point Grocers".
- **If it isn't there:** look under **Read, not on a case**.
  - This file sits exactly at the confidence level where the app asks a
    person, so it may be listed as "Held: read as a remittance advice at 95%
    confidence…".
  - If it is, press **Open a case from it** before going on.

**7.2 The notice.**

- **Do:** **Add a document** (on the case list) → `hl-case-02-notice.pdf` →
  **Read them**, then reload.
- **You should see:**
  - a second case, **DN-2609-002**, also $900.00;
  - a **Possible duplicates** card on the case list with the two side by
    side, and "the same invoice, the same amount and a deduction date within
    a week".
- **Proof:**
  ```sql
  select d.claim_id, e.payload, e.observed_at from deduction_events e join deductions d on d.id = e.deduction_id
   where e.event_type = 'case.possible_duplicate' and d.org_id = (select id from organizations where slug = 'test-tenant-b');
  ```

**7.1b The other order: the notice first, then the remittance** (instead of
7.1 and 7.2).

- **Do:** **Add a document** (on the case list) → `hl-case-02-notice.pdf` →
  **Read them**, then reload. Then **Add a document** →
  `hl-case-02-remittance.pdf` → **Read them**, and reload after 1–2 minutes
  (if the remittance is held, press **Open a case from it**, as in 7.1).
- **You should see:** both cases, **DN-2609-002** and
  **SIM-PAY-2609-002:INV-260802**, each $900.00, and the **Possible
  duplicates** card on the case list with the two side by side.
- **Proof:** 7.2's query returns one row, on the remittance's case, whose
  payload names the notice's case.
- In 7.3 the older case carries on, so in this order it is **DN-2609-002**
  that survives: press **Same deduction — merge them** on the remittance's
  case, and read 7.3 and 7.4 with the two claim ids swapped.

**7.3 Say they are the same.**

- **Do:** open DN-2609-002. In the card "This may already be a case", press
  **Same deduction — merge them**.
- **You should see:**
  - the green notice "recorded: these two are one deduction, and they were
    merged. The copy is marked as merged into the case that carries on…";
  - on DN-2609-002, "Merged into another case — This is the same deduction
    as SIM-PAY-2609-002:INV-260802 ($900.00), which carries on.";
  - on the other case, "Merged into this case";
  - DN-2609-002 gone from the queue, its state now "merged".
- The older case carries on, which is why the remittance case survives.

**7.4 Undo it.**

- **Do:** on DN-2609-002, press **Undo the merge**.
- **You should see:**
  - the notice "undone: this case is back exactly where it was, and the two
    are an open question again — answer it below";
  - the state back to "classified";
  - the "This may already be a case" card back.

**Proof for 7.3 and 7.4.** Replace `<A>` and `<B>` with the two case ids
from the address bar.

```sql
select id, claim_id, state from deductions where id in ('<A>', '<B>');
select action, state_before, amount_cents, created_at from deduction_merges
 where '<A>'::uuid in (merged_deduction_id, surviving_deduction_id) order by created_at;   -- 'merge' then 'unmerge'
select d.claim_id, e.event_type, e.observed_at from deduction_events e join deductions d on d.id = e.deduction_id
 where e.deduction_id in ('<A>', '<B>')
   and e.event_type in ('case.duplicate_confirmed','case.merged_into','case.absorbed',
                        'case.merge_undone','case.duplicate_verdict_withdrawn')
 order by e.id;
```

**7.5 Optional: the "merged once" rule.**

- **Do:** press **Same deduction — merge them** again.
- **You should see:** the answer is recorded, but the page says "They were
  not merged: these two were merged once and the merge was undone. A pair is
  merged at most once, so both stay open."
- As a result, Coverage in the test workspace will say that $900.00 counts
  twice. In the test workspace that is fine, and it shows the warning works.

---

## 8. A 42-row remittance, read by the background job

**What it proves:** a long document is read in the background rather than
while you wait (ADR 0021), and its short-paid lines become cases (ADR 0028).

The recorded read of this file takes about 60 seconds of model time. The
question is whether the background job finishes inside the time the hosting
plan allows.

**Where:** the **test workspace**, as tester B.

**8.1 Upload it.**

- **Do:** **Add a document** → `crosswind-dense-remittance-scan.jpg` →
  **Read them**. Note the time.
- **You should see:** the green notice starting "that document is being read.
  A deduction notice, or a remittance with a short payment, opens its case
  here within a couple of minutes…".

**8.2 Watch the job.**

- **Inngest:** Runs → a run of **Read an uploaded document** that ends
  **Completed** after roughly 1½ minutes. There should be one attempt; a
  retry means it was cut off.
- **Vercel logs:** search `read job:`. Four lines, in order:
  - `run entered`
  - `step read-document entered`
  - `step read-document finished the read, document … doc type remittance_advice, case none, halted no, held no`
  - `run returned`
- "case none" is normal for a remittance, because it opens one case per line.

**8.3 The cases.**

- **Do:** reload the case list after about 2 minutes.
- **You should see:**
  - **12 new cases** named `ACH-CW-880412:INV-2710…`, adding up to
    **$12,478.00**;
  - all 12 under "No deadline printed" / "Decide: dispute or decline",
    largest first: INV-271033 **$2,185.00**, INV-271011 $1,976.00, … the
    smallest INV-271008 $128.00.
- **Then open one.** You should see:
  - "This case's line only. The advice's 41 other lines are other invoices —
    other cases, or short-pays under the floor.";
  - a line check such as "INV-271002: $13,100.00 gross less $12,400.00 paid
    is $700.00 withheld, and the line says $700.00 was deducted".
- **If after 5 minutes nothing has appeared:**
  - look under **Documents waiting to be read** (it stalled) or **Read, not
    on a case** (it was held);
  - send me the time and the Inngest run.

**Proof.** Put the document id in `<DOC>`; the first query finds it.

```sql
select d.id, d.filename, u.source, d.created_at from documents d join uploads u on u.id = d.upload_id
 where encode(d.sha256, 'hex') = '5b13a132be882fbbacdb249cd644ba5f14e6f29dc38677e2aa2c7d8898118b3f';

-- three calls (OCR, classify, extract), none charged to a case; about $0.12–0.15 in all
select purpose, provider, model_version, round(cost_micros / 1e6, 4) as usd, latency_ms, outcome, deduction_id
  from model_calls where document_id = '<DOC>' order by id;

-- 12 cases, 1,247,800 cents in total
select count(*), sum(d.deduction_amount_cents)
  from deductions d join deduction_documents dd on dd.deduction_id = d.id and dd.role = 'notice'
 where dd.document_id = '<DOC>' and d.discovered_via = 'remittance_line';

-- what happened to all 42 lines
select payload->'counts' as counts from deduction_events
 where event_type = 'remittance.lines_processed' and payload->>'document_id' = '<DOC>' limit 1;
```

In the last query, expect 12 lines `opened`. The 30 lines that were paid in
full are likely to show as `unreadable` rather than `not_short_paid`. That
is a known quirk of how this page prints a dash for "no deduction". It does
not change the money; it is in the list below.

---

## 9. Settings → Team: an owner adds, re-roles and removes a teammate

**What it proves:** an owner manages their own team with no SQL (ADR 0051,
migration 0035), the database, not the page, refuses what would strand a
workspace, and the person an owner adds signs in with nothing pressed in the
Supabase dashboard (ADR 0051 §6).

**Before:** migration 0035 applied to the project you are testing
(`mozart-preview` first), and for 9.2's sign-in, sign-ups on and the hook
enabled there too (§2, *Before you start*). **Where:** the **test workspace**
from §4, as its owner.

**9.1 Everyone sees the list.** Open **Team** in the sidebar.

- **You should see:** every member with their role and "has signed in" or
  "has not signed in yet", and the note that disputes need two people. As a
  `read_only` member, the same list and no controls.

**9.2 Add a person.** Under **Add a person**: a new address of yours, a name,
**Analyst**, then **Add to this workspace**.

- **You should see:** "added. They can now sign in at app.mozart.financial
  with this address. A welcome message you can send them is below.", and a
  **Welcome message** box ready to copy. It is the same for an address that
  already signs in to another workspace.
- **Then:** in a new private window, sign in as that person from the form, as
  in 2.4. The first email is the **Confirm signup** one, and its link lands on
  the case list in Test Tenant B. R1 (§2) shows them with `true`.
- **Refusals:** add the same address again, in other capitals → "already a
  member of this workspace".

**9.3 The last owner cannot leave.** As the only owner, change your own role to
**Approver** → "a workspace must keep at least one owner". **Remove…** yourself
→ confirm → the same.

**9.4 Change a role, then remove.** Make the new person **Approver** → "role
changed". **Remove…** → the page asks first → **Remove them** → "removed".

**Read back** (SQL editor, read-only):

```sql
select action, subject_id, payload, actor_id, observed_at
  from audit_log
 where action like 'membership.%'
 order by id desc limit 10;
```

Expect `membership.invited`, `membership.role_changed` and `membership.removed`
rows naming you as `actor_id`, and no row for the refusals.

---

## 10. A failed background job reaches your inbox

**What it proves:** a job that fails after its retries emails you, and the
email says which job failed and nothing from the document (ADR 0052). §9 is
kept for Settings → Team (parth7452/mozart1#109).

**When:** any time after the variables below are set. It touches no
workspace and no database row.

**10.1 Set it up, once.**

- **Resend** → **API Keys** → **Create API key**:
  - permission **Sending access**;
  - domain: the one Supabase's sign-in mail is sent from.
- **Vercel** → the web project → **Settings** → **Environment Variables**.
  Add three, with **Production** ticked and **Preview** not ticked:
  - `RESEND_API_KEY`: the key just created;
  - `ALERT_EMAIL_FROM`: an address on that domain, for example
    `alerts@<that domain>`;
  - `ALERT_EMAIL_TO`: your own address. One address, with no name and no
    list.
- **Redeploy production.**

**10.2 Send the test.**

- **Do:** Inngest → the production environment → **Events** → **Send
  event**, and paste:

  ```json
  { "name": "recouple/alert.test", "data": {} }
  ```

- **You should see:** within a minute, an email from "Mozart alerts":
  - subject "[TEST] Mozart: failure alerts are working";
  - first line "This is a test. Nothing failed."
- **Inngest:** Runs → a run of **Email a failed run** that ends
  **Completed**, with output `{"outcome":"sent","test":true}`.
- **Vercel logs:** search `alert:`. You should find
  `[recouple] alert: sent for test`.

**If no email arrives,** look at the run's output:

- `not_configured`: none of the three variables reached this deployment.
  Check that they are on Production, then redeploy.
- `misconfigured`: the Vercel log line `alerts are misconfigured — …` names
  the variable to fix.
- **The run failed:** the log line `alert: not sent for test: Resend
  answered …` gives Resend's status:
  - `401` or `403`: the key, or a sender address that is not on its domain;
  - `422`: an address Resend will not take.
- `outcome: sent` but nothing in your inbox: check spam, then Resend →
  **Emails** for its delivery status.

**10.3 What a real one looks like.** You don't need to cause a failure. When
one comes, check that:

- the subject is "Mozart: a background job failed (…)", with the job's name;
- the body gives the function, the run id, an error class such as
  `NonRetriableError`, and a link that opens that run in Inngest;
- there is no claim number, amount, retailer or document text anywhere in it;
- a second failure of the same job within the hour sends nothing, and the
  Runs page lists it.

---

## 11. The packet a payer receives, and uploads at their limits

**What it proves:** pilot E1, E2, E3 and E6 in the product rather than in
tests. Twenty files go up from one selection, a file too large to deliver is
refused with our sentence rather than Vercel's page, a packet can be assembled
again after evidence arrives and only the latest can be approved, a deadline
can be entered on a case that printed none, and the letter and the zip are what
a payer would be sent.

**Where:** the **test workspace** (checklist 4), with two people: tester B
(`analyst`) prepares, and you (`owner`) approve. Everything here is permanent.

**You need:**

- **20 different small files** (PDFs or images, each under 4 MB). The fixture
  PDFs in `packages/fixtures/corpus/` will do. A file already uploaded to the
  test workspace is not read again, so use ones it has not seen. Each is read:
  allow about 50–60 cents.
- **One PDF larger than 6 MB.** Any will do: it is never sent.
- **A case with a decision and no packet** — DN-2609-001 from checklist 4 once
  11.3 has decided it.

**11.1 Twenty files in one selection (E3).**

- **Do:** as tester B, on the case list, **Add a document** → select all 20
  files in the one file picker → **Read them**.
- **You should see:** the button counting "Sending 1 of 20…" upward, and then
  one line per file, each with its own answer. Nothing is sent twice, and a
  file with no answer stops the batch with the rest marked not sent.
- **Proof:** one row, `source` `web_upload` with `count` 20, and its first
  and last `received_at` both within the last few minutes:
  ```sql
  select u.source, count(*), min(u.received_at), max(u.received_at)
    from uploads u join organizations o on o.id = u.org_id
   where o.slug = 'test-tenant-b' and u.received_at > now() - interval '15 minutes'
   group by u.source;
  ```

**11.2 A 6 MB PDF (E2).**

- **Do:** **Add a document** → the 6 MB PDF → **Read them**.
- **You should see:** our sentence, starting "that file is larger than 4 MB,
  which is as much as one upload can carry, so it was not sent", and not
  Vercel's `FUNCTION_PAYLOAD_TOO_LARGE` page.
- **Proof:** the refusal is shown in the browser, before anything is sent.
  11.1's query, run again, still counts 20, provided nothing else was
  uploaded to the test workspace in between.

**11.3 Decide, and enter a deadline (E5, E6).**

- **Do:** as tester B, open DN-2609-001. The reason list under **Why this
  deduction is invalid** is grouped by kind and reads in words. Choose one,
  write a line for the approver, and **Decide to dispute**. If the case shows
  **No dispute deadline**, enter a date, a basis such as "test: 60 days from
  deduction date", and **Record the deadline**.
- **You should see:** the **Assemble the packet** card; and the deadline, once
  recorded, on the case with no form left to change it.
- **Proof** (replace `<CASE>` with the case id from the address bar):
  ```sql
  select e.payload, e.observed_at from deduction_events e
   where e.deduction_id = '<CASE>' and e.event_type = 'case.deadline_set';   -- dispute_deadline, basis, set_by
  ```

**11.4 Assemble, attach, assemble again (E1).**

- **Do:** as tester B, **Assemble the packet**. Note the 12 characters after
  "The packet ·". Then **Add evidence** on the case with one file it does not
  hold, wait for it to be read, and press **Assemble again**.
- **You should see:** a new packet with a different 12-character hash, whose
  enclosures list names the new file.
- **Proof:** two rows for the one decision, the newer one with one more file:
  ```sql
  select encode(content_hash, 'hex') as hash, cardinality(file_document_ids) as files, created_at
    from packets where deduction_id = '<CASE>' order by created_at;
  ```

**11.5 Only the latest packet can be approved (E1).**

- **Do:** as you (owner), open the case in **two tabs**. In the first, leave
  the page as it is. As tester B, press **Assemble again** once more (attach
  another file first, since identical contents are refused). Then, in your
  first tab, **Approve** the packet that page still shows.
- **You should see:** "that packet was assembled again since this page
  loaded, and only the latest one can be approved — nothing was approved;
  check packet … below and approve that". Reload, and approve the packet now
  shown.
- **Proof:** exactly one approval, naming the newest packet:
  ```sql
  select encode(a.packet_hash, 'hex') = (
           select encode(content_hash, 'hex') from packets
            where deduction_id = '<CASE>' order by created_at desc limit 1) as names_latest,
         a.approved_at
    from approvals a join decisions d on d.id = a.decision_id
   where d.deduction_id = '<CASE>';
  ```

**11.6 The printable letter (E1).** Do it once before 11.5's approval and once
after.

- **Do:** on the packet card, **Printable letter**. Print preview it.
- **You should see:**
  - "From:" the test workspace's name, exactly as its `organizations.name`;
  - "To:" the payer (the matched debtor, else the name printed on the notice:
    "Harbor Lane Markets" for DN-2609-001). "(not recorded)" there means the
    case has neither, which is worth a note if it happens on a real case;
  - the claim id, the invoice number or numbers, the amount and the dates;
  - "Reason for dispute:" in words, with no underscores;
  - the numbered enclosures;
  - before approval, "Draft — awaiting approval. Not for sending." on screen
    and in the print preview; after approval, no draft mark.

**11.7 All enclosures (E1).**

- **Do:** on the packet card, **All enclosures (.zip)**, and open the zip.
- **You should see:** one file per enclosure, named `01-…`, `02-…` and so on,
  in the letter's enclosure order, each one opening as the document it names.
- **Proof:** the number of files in the zip equals `files` on the newest row of
  11.4's query.

---

## Found while writing this

Struck items are fixed; each links the change. The rest each need a decision
or their own change.

1. ~~**Email-in is not wired** (§5).~~ **Live** since 2026-09-25 under ADR
   0047: an address, the webhook, the job, Settings → Email and the sweep.
   §5.1–5.5 ran that day.
2. ~~**A case page opens as "404" once there are more than 100 newer
   cases.**~~ **Fixed** by
   [parth7452/mozart1#71](https://github.com/parth7452/mozart1/pull/71): a
   case page now reads its own case, and the case list's figures count every
   case.
3. ~~**The sign-in page shows any text put in its link**
   (`/login?denied=…`).~~ **Fixed** by
   [parth7452/mozart1#68](https://github.com/parth7452/mozart1/pull/68): the
   page now shows only its own messages.
4. ~~**A duplicate raised by a remittance line is never listed.** If the
   notice arrives *before* the remittance, both cases open, but they never
   appear under Possible duplicates (§7).~~ **Fixed** by pilot E7
   ([parth7452/mozart1#104](https://github.com/parth7452/mozart1/pull/104)):
   the remittance line's case now names its possible duplicate, and §7.1b
   checks that order. Pairs opened before it merged are listed only once
   `pnpm link:duplicates --org <slug> --as <member email>` has run against
   each production workspace (`--dry-run` first).
5. **A decline leaves no trace on the case page** once its notice is gone
   (§6).
6. **A line with a printed dash is counted as "unreadable"** rather than
   "paid in full" (§8). There is no money impact.
7. ~~**Coverage shows a misleading reason** when a sync is refused because the
   connection was disconnected mid-run. It blames the member rather than the
   disconnect.~~ **Fixed** by
   [parth7452/mozart1#116](https://github.com/parth7452/mozart1/pull/116)
   (2026-09-26): the page reads the run's class, so
   `LedgerConnectionDisabledError` says the connection was disconnected before
   the run began, `LedgerSyncRefusedError` keeps the member sentence, and any
   other refusal blames nobody. Settings → QuickBooks's last-sync line says the
   same. A disconnect that lands while a run is reading still ends `failed`
   (`QboAuthError`) and reads as QuickBooks refusing the connection; telling
   that apart is a follow-up.
8. ~~**No sign-out button and no workspace switcher.**~~ **Both done**
   (pilot E4): **Sign out** and **Switch workspace** are in the sidebar (see
   *Before you start*, items 2 and 4).
9. ~~**No privacy policy or terms page** (§1).~~ **Both done**, and Intuit's
   production keys have been on Vercel Production since 2026-09-24.
