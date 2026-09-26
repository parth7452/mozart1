# Onboarding a customer: the runbook

*2026-09-25. For the founder, once per new customer. Pilot item E8
(`docs/plans/pilot/README.md`). Nothing here changes the product: every step
is a row the database already expects, or a screen that already exists.*

Creating a workspace is done by hand, on purpose. `organizations` and `users`
have read-only policies for the app's database role, so no request can create a
tenant. Since ADR 0051 a workspace's owner adds, re-roles and removes people
from Settings → Team, through three definer functions; the first people, and
the workspace itself, are still the database owner's job, done in the
Supabase SQL editor (ADR 0015, `docs/supabase.md`). This runbook turns what used
to be four hand-edited inserts (VERIFY-CHECKLIST §4.1 and §2.4) into one block
with the values at the top.

| Step | Who | Where | Time |
| --- | --- | --- | --- |
| [0. Before you start](#0-before-you-start) | founder | this page | 10 min |
| [1. Create the workspace](#1-create-the-workspace-one-sql-block) | founder | Supabase SQL editor, production | 10 min |
| [2. Invite each person](#2-invite-each-person) | founder | Supabase dashboard, then email | 5 min per person |
| [3. Map payer names](#3-map-the-payer-names-printed-on-documents) | founder | your machine, `pnpm link:retailer` | as names appear |
| [4. The owner's first sign-in](#4-the-owners-first-sign-in) | customer's owner | the app | 15 min, on the call |
| [5. Changing a role, removing someone](#5-later-changing-a-role-removing-someone-adding-an-accountant) | customer's owner (founder as fallback) | the app, Settings → Team (SQL editor as fallback) | as needed |
| [6. Day one and week one](#6-day-one-checklist-and-the-week-one-routine) | us | the app, your machine | daily |

**Every SQL block on this page is tested.** `scripts/check-onboarding-sql.sh`
pulls each fenced block out of this file by its first line (`-- onboarding:…`)
and runs it against a scratch database that `pnpm db:test` has migrated. It
runs the create block twice, checks that the second run creates nothing, and
checks each refusal described here. If you edit a block, run the script. Only
the blocks marked **Supabase only** are skipped, because they read `auth.users`,
which a plain Postgres database does not have.

---

## 0. Before you start

Have these from the customer:

1. **A slug and a name.** The slug is a short, permanent label in lowercase with
   hyphens, such as `acme-foods`. It is used by `pnpm link:retailer --org`, so
   keep it short. The name is how the workspace appears in the sidebar. Use the
   company's legal name, because the payer-facing packet (E1) signs with it.
2. **The people and their roles.** At least two people, because **the person
   who prepares a decision can never approve it** (separation of duties,
   migration 0005). A workspace with one person cannot finish a case (pilot
   blocker B6).

   | Role | Can do | Give it to |
   | --- | --- | --- |
   | `owner` | everything, including approving, connecting QuickBooks and issuing email addresses | the customer's controller or finance lead. At least one per workspace |
   | `approver` | everything except the owner's settings: upload, decide, approve | a second person at the customer who can approve |
   | `analyst` | upload, decide, assemble, merge. **Cannot approve** | whoever prepares cases. In done-with-you, that is our analyst |
   | `read_only` | sees everything, changes nothing | anyone who only needs to look |
   | `accountant_guest` | sees everything, changes nothing | the customer's outside accountant ([§5.3](#53-an-outside-accountant)) |

   Done-with-you, the recommended setup for pilots 1–5: **our analyst is an
   `analyst`, and the customer's controller is the `owner`.** The analyst
   prepares, and the controller approves.
3. **Their top payers.** Who deducts from them: Sysco, US Foods, PFG and
   Gordon for a foodservice manufacturer; for a carrier, the shippers and
   brokers. Each payer becomes a `debtors` row. The list does not need to be
   complete: a payer that is missing only means its cases say "not matched"
   until you add it.
4. **The contingency fee** in basis points: 2500 means 25%.
5. **Whether they use QuickBooks Online**, and who is an admin of that company
   in QuickBooks. That person must be the workspace `owner` who presses
   Connect.

On our side, check these once, not per customer:

- **Sign-in email reaches outside addresses** (pilot B5). Supabase →
  Authentication → SMTP must be custom SMTP, not the built-in mailer.
- **Open sign-ups are off** (VERIFY-CHECKLIST §2.5). The runbook works either
  way. With sign-ups off, an address that has not followed its invitation gets
  no sign-in email at all.

### Which `org_settings` values matter for a pilot

The block creates the settings row with every default except the fee. Without
that row nothing in the workspace can be read. Of the defaults, only these do
anything today:

| Column | Default | What it does now |
| --- | --- | --- |
| `fee_pct_bps` | 2500 (25%) | The contract's contingency fee. Nothing invoices from it yet (billing is Phase 4), so invoice by hand at this rate. It is a parameter in the block |
| `min_classification_confidence` | 0.950 | The floor below which a notice or remittance is **held** for a person instead of opening its case(s) (ADR 0044). Leave it. Lowering it is a loosening: the database refuses it without an ADR (invariant 7) |
| `remittance_tolerance_cents` / `_bps` | 500 ($5.00) / 50 (0.5%) | A remittance line opens a case only if the short-pay is above **both**. Lowering them is allowed and opens more cases; raising them is a loosening and is refused without an ADR |
| `remittance_dedup_days` | 30 | How far back identity resolution looks for a possible duplicate |

`auto_dispute_ceiling_cents`, `auto_writeoff_ceiling_cents`,
`min_decision_confidence`, `look_back_days`, `tail_period_days` and
`min_claim_cents` are stored for later phases and nothing reads them yet. Leave
them at their defaults.

---

## 1. Create the workspace (one SQL block)

**Where:** Supabase dashboard → project `hvheqbgkvwhlqutklwfh` (production) →
**SQL Editor**. For a dry run, use the `mozart-preview` project first.

**Do:** paste the block, edit **only the values between the two `EDIT` lines**,
and press **Run**.

**What it does**, all or nothing (a `do` block is one statement, so any refusal
undoes everything it did):

- creates the organization, or finds it by its slug;
- creates the `org_settings` row with the defaults and the fee;
- for each person, finds their `users` row by address, **ignoring capitals**,
  or creates one;
- adds each membership;
- adds each payer as a `debtors` row.

**Running it again is safe.** A row that already exists is left alone, and the
closing notice says `created 0`. So it is also how you add one more person or
payer later: add them to the lists and run it again.

**It refuses**, and changes nothing, when:

- the slug already belongs to a workspace with a **different name** (a typo in
  the slug could otherwise add people to someone else's workspace);
- the address appears twice in `people`, even in different capitals;
- two existing `users` rows differ only in capitals (VERIFY-CHECKLIST R4: that
  person could never sign in; fix it before going on);
- a person is already in this workspace with a **different role** (a role
  change is [§5.1](#51-change-someones-role), never a side effect);
- a payer's `retailer_key` already exists with a different `display_name`;
- the settings row exists with a different fee;
- the workspace would end up with **no owner**, or with **fewer than two people
  who can write** (owner, approver or analyst). With one, nobody can approve.

```sql
-- onboarding:create
do $onboard$
declare
  -- ======================= EDIT BELOW THIS LINE =======================
  org_slug text := 'acme-foods';           -- permanent: lowercase, digits, hyphens
  org_name text := 'Acme Foods, Inc.';     -- the legal name the packet signs with
  fee_bps  int  := 2500;                   -- contingency in basis points: 2500 = 25%

  -- role: owner | approver | analyst | read_only | accountant_guest
  people jsonb := $people$[
    {"email": "controller@acme-foods.example", "full_name": "Dana Reyes",  "role": "owner"},
    {"email": "ap.lead@acme-foods.example",    "full_name": "Sam Ortiz",   "role": "approver"},
    {"email": "analyst@ourfirm.example",       "full_name": "Our Analyst", "role": "analyst"}
  ]$people$;

  -- retailer_key: lowercase words joined by _, permanent, one per payer.
  -- display_name: the name people know it by. Printed names that match neither
  -- (after capitals, punctuation and Inc/LLC/Corp are ignored) go to
  -- pnpm link:retailer as aliases (runbook §3).
  payers jsonb := $payers$[
    {"retailer_key": "sysco",    "display_name": "Sysco"},
    {"retailer_key": "us_foods", "display_name": "US Foods"},
    {"retailer_key": "pfg",      "display_name": "Performance Food Group"},
    {"retailer_key": "gordon",   "display_name": "Gordon Food Service"}
  ]$payers$;
  -- ======================= EDIT ABOVE THIS LINE =======================

  v_org        uuid;
  v_org_new    boolean := false;
  v_user       uuid;
  v_fee        int;
  v_role       membership_role;
  v_have       membership_role;
  v_email      text;
  v_name       text;
  v_key        text;
  v_display    text;
  v_existing   text;
  v_count      int;
  p            jsonb;
  users_new    int := 0;
  users_reused int := 0;
  members_new  int := 0;
  payers_new   int := 0;
begin
  -- ---- the inputs, checked before anything is written -------------------
  if org_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'org_slug % must be lowercase letters and digits joined by single hyphens', org_slug;
  end if;
  if btrim(coalesce(org_name, '')) = '' then
    raise exception 'org_name is empty';
  end if;
  if fee_bps is null or fee_bps not between 0 and 10000 then
    raise exception 'fee_bps % must be between 0 and 10000 (2500 = 25%%)', fee_bps;
  end if;
  if jsonb_typeof(people) <> 'array' or jsonb_array_length(people) = 0 then
    raise exception 'people must be a non-empty JSON array';
  end if;
  if jsonb_typeof(payers) <> 'array' then
    raise exception 'payers must be a JSON array (it may be empty: [])';
  end if;

  select lower(e.value ->> 'email') into v_email
    from jsonb_array_elements(people) e
   group by lower(e.value ->> 'email')
  having count(*) > 1
   limit 1;
  if v_email is not null then
    raise exception '% is listed twice in people (addresses are compared ignoring capitals)', v_email;
  end if;

  -- ---- the organization ---------------------------------------------------
  select id, name into v_org, v_existing from organizations where slug = org_slug;
  if v_org is null then
    insert into organizations (slug, name) values (org_slug, btrim(org_name))
    returning id into v_org;
    v_org_new := true;
  elsif v_existing <> btrim(org_name) then
    raise exception 'slug % already belongs to workspace "%", not "%": check the slug before going on',
      org_slug, v_existing, btrim(org_name);
  end if;

  -- ---- its settings: every default except the fee -------------------------
  insert into org_settings (org_id, fee_pct_bps) values (v_org, fee_bps)
  on conflict (org_id) do nothing;
  select fee_pct_bps into v_fee from org_settings where org_id = v_org;
  if v_fee <> fee_bps then
    raise exception 'workspace % already has fee_pct_bps %, not %: changing a contract term is a deliberate UPDATE, not a re-run',
      org_slug, v_fee, fee_bps;
  end if;

  -- ---- people: a users row per address, ignoring capitals; a membership ---
  for p in select value from jsonb_array_elements(people) loop
    v_email := btrim(coalesce(p ->> 'email', ''));
    v_name  := nullif(btrim(coalesce(p ->> 'full_name', '')), '');
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'not an email address: "%"', v_email;
    end if;
    begin
      v_role := (p ->> 'role')::membership_role;
    exception when invalid_text_representation or null_value_not_allowed then
      raise exception 'role "%" for % is not one of owner, approver, analyst, read_only, accountant_guest',
        p ->> 'role', v_email;
    end;
    if v_role is null then
      raise exception 'no role given for %', v_email;
    end if;

    select count(*) into v_count from users where lower(email) = lower(v_email);
    if v_count > 1 then
      raise exception 'two users rows answer to % in different capitals (VERIFY-CHECKLIST R4): that person cannot sign in until one is removed',
        v_email;
    elsif v_count = 1 then
      select id into v_user from users where lower(email) = lower(v_email);
      users_reused := users_reused + 1;
    else
      insert into users (email, full_name) values (v_email, v_name) returning id into v_user;
      users_new := users_new + 1;
    end if;

    select role into v_have from memberships where org_id = v_org and user_id = v_user;
    if v_have is null then
      insert into memberships (org_id, user_id, role) values (v_org, v_user, v_role);
      members_new := members_new + 1;
    elsif v_have <> v_role then
      raise exception '% is already % in %, not %: change a role with runbook §5.1, not by re-running this block',
        v_email, v_have, org_slug, v_role;
    end if;
  end loop;

  -- ---- payers: one debtors row each ---------------------------------------
  for p in select value from jsonb_array_elements(payers) loop
    v_key     := btrim(coalesce(p ->> 'retailer_key', ''));
    v_display := btrim(coalesce(p ->> 'display_name', ''));
    if v_key !~ '^[a-z0-9]+(_[a-z0-9]+)*$' then
      raise exception 'retailer_key "%" must be lowercase letters and digits joined by single underscores', v_key;
    end if;
    if v_display = '' then
      raise exception 'payer % has no display_name', v_key;
    end if;
    select display_name into v_existing from debtors where org_id = v_org and retailer_key = v_key;
    if v_existing is null then
      insert into debtors (org_id, retailer_key, display_name) values (v_org, v_key, v_display);
      payers_new := payers_new + 1;
    elsif v_existing <> v_display then
      raise exception 'payer % is already "%" in %, not "%"', v_key, v_existing, org_slug, v_display;
    end if;
  end loop;

  -- ---- the end state must be able to finish a case -------------------------
  if not exists (select 1 from memberships where org_id = v_org and role = 'owner') then
    raise exception 'workspace % would have no owner: nobody could connect QuickBooks or issue an email address', org_slug;
  end if;
  select count(*) into v_count from memberships
   where org_id = v_org and role in ('owner', 'approver', 'analyst');
  if v_count < 2 then
    raise exception 'workspace % needs at least two people who can write (owner, approver, analyst): the preparer of a decision can never approve it',
      org_slug;
  end if;

  raise notice 'onboard %: organization %; users created %, reused %; memberships created %; payers created %',
    org_slug, case when v_org_new then 'created' else 'existed' end,
    users_new, users_reused, members_new, payers_new;
end
$onboard$;
```

**You should see:** "Success. No rows returned". The notice
`onboard acme-foods: organization created; users created 3, reused 0;
memberships created 3; payers created 4` is in the editor's messages. Run it a
second time and it reads `organization existed; users created 0, reused 3;
memberships created 0; payers created 0`.

"Reused" is normal for our own analyst. They already have a `users` row from
another workspace, and one person with one address can belong to many
workspaces. That is what makes a broker agency one contract rather than many.
Until the workspace switcher ships (pilot E4), such a person lands in the
workspace whose name comes first alphabetically.

### Read it back

Each row must say `true` in `ok`.

```sql
-- onboarding:readback
with v as (select 'acme-foods'::text as slug),
     o as (select org.id, org.name from organizations org join v on org.slug = v.slug),
     m as (select mb.role, u.email
             from memberships mb join users u on u.id = mb.user_id join o on o.id = mb.org_id)
select 'organization' as item,
       (select name from o) as detail,
       exists (select 1 from o) as ok
union all
select 'settings row',
       (select format('fee %s bps, floor %s, tolerance %s cents / %s bps',
                      s.fee_pct_bps, s.min_classification_confidence,
                      s.remittance_tolerance_cents, s.remittance_tolerance_bps)
          from org_settings s join o on o.id = s.org_id),
       exists (select 1 from org_settings s join o on o.id = s.org_id)
union all
select 'an owner',
       (select string_agg(email, ', ' order by email) from m where role = 'owner'),
       exists (select 1 from m where role = 'owner')
union all
select 'two people who can write (one prepares, another approves)',
       (select string_agg(email || ' ' || role, ', ' order by email)
          from m where role in ('owner', 'approver', 'analyst')),
       (select count(*) from m where role in ('owner', 'approver', 'analyst')) >= 2
union all
select 'no member''s address has a twin in other capitals (R4)',
       (select string_agg(u.email, ', ') from users u join m on lower(u.email) = lower(m.email)
         where u.email <> m.email),
       not exists (select 1 from users u join m on lower(u.email) = lower(m.email)
                    where u.email <> m.email)
union all
select 'payers',
       (select string_agg(d.retailer_key || ' = ' || d.display_name, ', ' order by d.retailer_key)
          from debtors d join o on o.id = d.org_id),
       exists (select 1 from debtors d join o on o.id = d.org_id);
```

Who is in the workspace, and whether each person has reached the app yet (R1,
for this workspace). `has_reached_the_app` turns `true` at their first sign-in:

```sql
-- onboarding:readback-people
select u.email, u.full_name, m.role, u.auth_user_id is not null as has_reached_the_app
  from memberships m
  join organizations o on o.id = m.org_id
  join users u on u.id = m.user_id
 where o.slug = 'acme-foods'
 order by m.role, u.email;
```

**Supabase only.** Whether each person has an invitation at the provider (R3,
for this workspace). Run it after step 2.

```sql
-- onboarding:supabase-only invitation status
select u.email, a.invited_at, a.email_confirmed_at, a.last_sign_in_at,
       case when a.id is null then 'NOT INVITED: send the invitation (step 2)'
            when u.auth_user_id is null then 'invited, not yet reached the app'
            when u.auth_user_id = a.id then 'linked'
            else 'LINKED TO ANOTHER IDENTITY: refused' end as status
  from memberships m
  join organizations o on o.id = m.org_id
  join users u on u.id = m.user_id
  left join auth.users a on lower(a.email) = lower(u.email)
 where o.slug = 'acme-foods'
 order by u.email;
```

---

## 2. Invite each person

**After day one, the customer's owner adds people themselves**: Settings →
Team → Add a person (ADR 0051). That writes the `users` row and the membership
that the create block writes, with the same rules (one row per address
ignoring capitals, an existing member refused by name, an audit row naming the
owner). It does **not** create their sign-in: step 1 below is still ours for
anyone who has never signed in to Mozart. The page tells the owner "Mozart
still has to send their sign-in invitation", so expect them to tell you, and
check the **Supabase only** invitation-status query above in the week-one
routine: a `NOT INVITED` row is someone an owner added. Someone who already
signs in to another workspace needs nothing from us, and the page tells the
owner they can sign in at once. Why the page cannot send the invitation itself
while sign-ups are off is ADR 0051 §6.

The sign-in form never creates an account (`shouldCreateUser: false`, ADR 0045).
So a person with a `users` row but no Supabase Auth user gets no email, and the
app logs `otp_disabled`, or `signup_disabled` once sign-ups are off. The
invitation is what creates that user.

**For each person** who is not yet `linked` in the query above:

1. Supabase dashboard → **Authentication → Users → Add user → Send
   invitation**. Use exactly the address from the block.
2. Send them the welcome email below, **after** the invitation, so it arrives
   second.

Skip step 1 for someone who already signs in to another workspace, such as our
analyst. They already have an Auth user, so the first query shows them
`linked`.

**What the invitee sees.** An email from Supabase's mailer with a link. The link
confirms their address and lands on the app's sign-in page, **still signed
out**. That is expected: the app only accepts a session from `/auth/callback`,
and the invitation link does not go there (`apps/web/DEPLOY.md`, "Who can sign
in"). They then sign in from the form: type the address, press **Email me a
sign-in link**, and open that second email **in the same browser**, because the
link only works in the browser that asked for it.

**If it goes wrong:**

- *No invitation email.* Check spam, then Supabase → Logs → Auth. Re-send from
  the same screen.
- *"That link has expired".* They opened the sign-in link in a different
  browser or app. They should request a new one and paste it into the browser
  that asked for it.
- *Signed straight back out.* They have an Auth user but no membership, or
  their address differs in capitals from another `users` row. Run the
  read-back.

### The welcome email

Send it from your own address, one per person. Replace the `<…>` parts.

> **Subject:** Your <Workspace name> workspace on Mozart
>
> Hi <first name>,
>
> You have been added to <Workspace name>'s workspace on Mozart as
> **<role in words: an owner / an approver / an analyst / a viewer>**.
>
> Getting in takes two emails, about a minute apart:
>
> 1. **An invitation from Supabase** (our sign-in provider), sent just before
>    this message. Click its link once. It opens the Mozart sign-in page, and
>    you will **not** be signed in yet. That is expected: the link only
>    confirms your address.
> 2. On that page, type **<their address>** under *Work email* and press
>    **Email me a sign-in link**. Open the link in that email **in the same
>    browser**. If your email app opens it somewhere else, you'll see "that
>    link has expired". Copy the link into the browser where you asked for it
>    instead.
>
> From then on, sign in at **https://app.mozart.financial/login** the same way
> (step 2). There is no password.
>
> <For an owner:> On our call on <day, time> we'll connect your QuickBooks
> together. You'll need to be able to sign in to QuickBooks Online as an admin
> of <company>.
>
> <For an approver or owner:> A case is prepared by one person and approved by
> another. The app will never let the same person do both, so you'll see
> "Waiting for another approver" on cases you prepared yourself.
>
> If either email hasn't arrived within ten minutes, check spam, then reply to
> me.
>
> <Your name>

For `read_only` and `accountant_guest`, say "a viewer": they can see every case
and document and change nothing.

---

## 3. Map the payer names printed on documents

A case finds its payer by the name printed on the document. That name is
matched against each payer's `display_name`, its `retailer_key`, and any
aliases, ignoring capitals, accents, punctuation and a trailing Inc, LLC, Corp,
Co or Ltd. So "SYSCO CORPORATION" matches `sysco` with no alias. "Sysco Eastern
Maryland, LLC" does not, and the case says the printed name, marked *not
matched*. Document text never creates a payer, and two payers that match the
same name count as no match (ADR 0019).

An alias says "this printed name is this payer". Add one per new spelling as
cases arrive. Guessing spellings in advance is not needed.

**Which names are waiting**, most cases first:

```sql
-- onboarding:unmatched-payers
select d.retailer_name_as_printed as printed_name, count(*) as cases, min(d.created_at) as first_seen
  from deductions d
  join organizations o on o.id = d.org_id
 where o.slug = 'acme-foods'
   and d.debtor_id is null
   and d.retailer_name_as_printed is not null
 group by d.retailer_name_as_printed
 order by count(*) desc, min(d.created_at);
```

**Add the alias**, on your machine, from the repo root. `DATABASE_URL` in `.env`
is the app's login (`recouple_app`), never the owner (`docs/supabase.md`, "How
the operator commands connect"). `--as` is the member the change is recorded
against: an `owner`, `approver` or `analyst` of that workspace, usually our
analyst.

```
pnpm link:retailer --org acme-foods --as analyst@ourfirm.example \
  --retailer sysco --alias "Sysco Eastern Maryland, LLC" --dry-run

pnpm link:retailer --org acme-foods --as analyst@ourfirm.example \
  --retailer sysco --alias "Sysco Eastern Maryland, LLC"
```

The second command adds the alias and then re-checks every unmatched case in
the workspace. It prints `resolved <case id>  Sysco Eastern Maryland, LLC` for
each case it now links, and a summary line. Adding the same alias twice does
nothing.

- **`no debtor with retailer_key …`**: the payer is not in the workspace yet.
  Add it to `payers` in the block and run the block again. The script never
  creates a payer.
- **`BLOCKED … `** with a non-zero exit: that case's claim is already open
  against the payer. That is two cases for one claim, which is identity
  resolution's job, not this script's. Leave it and tell me.
- **Two payers that really are one** (Sysco the company, and a Sysco operating
  company that deducts on its own): whether they are one payer is a business
  fact. Ask the customer and alias it to one of them. Never alias one printed
  name to both: that makes it match neither.

---

## 4. The owner's first sign-in

On the onboarding call, with the owner sharing their screen:

1. **Sign in** as in the welcome email. The sidebar shows the workspace name
   under **YOUR WORKSPACE**, with the role "Owner".
2. **Settings → QuickBooks → Connect QuickBooks.** Intuit asks them to sign in
   and choose the company. They must be a QuickBooks admin of it. They come
   back to Settings with the company listed as connected. The first sync is
   queued at once, and after that it runs daily at 07:00 UTC.
   - Each invoice short-paid by a payment in the last 35 days opens a case. Anything worth
     a look in QuickBooks is under **Coverage** → the ledger sync's runs.
   - One QuickBooks company can be connected to **one** workspace across all of
     Mozart at a time. For a broker agency connecting a manufacturer's books,
     that manufacturer's workspace holds it.
   - The sync runs as the owner who connected it. Before that person's role
     changes or they leave, another owner reconnects ([§5](#5-later-changing-a-role-removing-someone-adding-an-accountant)).
3. **Settings → Email → Issue a new address.** Do this **only once
   VERIFY-CHECKLIST §5.6–5.8 have passed**. They are the failure paths (forged
   headers, oversize mail, the daily sweep) that must be seen working before a
   customer's suppliers are given an address. Until then, skip this step: they
   upload instead.
   - The address is 32 letters and digits at the inbound domain. They give it to
     the payers and their own AP team.
   - **An emailed document never opens a case by itself.** It is held under
     **Read, not on a case** until a person presses **Open a case from it**
     (ADR 0047).
   - About 3.3 MB of attachments per email is the limit. Anything larger is
     recorded by the sweep as "did not reach us".
   - The address acts as the owner who issued it (or the latest to **Adopt**
     it). Before that person leaves, another owner adopts it.
4. **Upload the first batch** together: **＋ Add a document** on the case list.
   Watch the cases open in the review queue.

---

## 5. Later: changing a role, removing someone, adding an accountant

**The customer's owner does this in the app**: Settings → Team → **Change
role** or **Remove…** (ADR 0051). The database refuses there exactly what the
blocks below refuse — no owner left, fewer than two people who can write, and
the two responsibilities below — each with its own message, and every change
leaves an audit row naming who made it. Use the blocks when nobody who can
sign in is an owner, or on the owner's behalf.

Memberships are ordinary rows (migration 0006's mutable list). Each block
below is all-or-nothing and refuses to leave the workspace unable to finish a
case. Since migration 0035 the database itself also refuses any change that
leaves a workspace with no owner, on every path, with the same "that would
leave … with no owner" message; to hand over, make the new owner first.

Two things act **as a person**, and so block that person's demotion or removal
until they are moved:

- **the QuickBooks connection** runs as the owner who connected it. Another
  owner presses **Connect QuickBooks** to take it over;
- **an email address** acts as its latest adopter, else its issuer. Another
  owner presses **Adopt: act as me** on it.

### 5.1 Change someone's role

```sql
-- onboarding:change-role
do $change$
declare
  -- ======================= EDIT BELOW THIS LINE =======================
  org_slug text            := 'acme-foods';
  person   text            := 'ap.lead@acme-foods.example';
  new_role membership_role := 'analyst';   -- owner | approver | analyst | read_only | accountant_guest
  -- ======================= EDIT ABOVE THIS LINE =======================
  v_org  uuid;
  v_user uuid;
  v_was  membership_role;
begin
  select id into v_org from organizations where slug = org_slug;
  if v_org is null then raise exception 'no workspace %', org_slug; end if;
  select m.user_id, m.role into v_user, v_was
    from memberships m join users u on u.id = m.user_id
   where m.org_id = v_org and lower(u.email) = lower(person);
  if v_user is null then raise exception '% is not a member of %', person, org_slug; end if;

  if new_role <> 'owner' and exists (
       select 1 from accounting_connections c
        where c.org_id = v_org and c.enabled and c.created_by = v_user) then
    raise exception '% holds this workspace''s QuickBooks connection: another owner must press Connect QuickBooks first', person;
  end if;
  if new_role not in ('owner', 'approver', 'analyst') and exists (
       select 1 from inbound_addresses a
         left join inbound_address_retirements r on r.address_id = a.id
        where a.org_id = v_org and r.address_id is null
          and coalesce((select ad.adopted_by from inbound_address_adoptions ad
                         where ad.address_id = a.id
                         order by ad.adopted_at desc, ad.id desc limit 1),
                       a.created_by) = v_user) then
    raise exception 'a live email address acts as %: another owner must Adopt it first', person;
  end if;

  update memberships set role = new_role where org_id = v_org and user_id = v_user;

  if not exists (select 1 from memberships where org_id = v_org and role = 'owner') then
    raise exception 'that would leave % with no owner', org_slug;
  end if;
  if (select count(*) from memberships
       where org_id = v_org and role in ('owner', 'approver', 'analyst')) < 2 then
    raise exception 'that would leave % with fewer than two people who can write', org_slug;
  end if;
  raise notice '% in %: % -> %', person, org_slug, v_was, new_role;
end
$change$;
```

It takes effect on the person's next page load. A decision they prepared as an
analyst still cannot be approved by them after a promotion: separation of duties
is about the person, not the role.

### 5.2 Remove someone from a workspace

Delete the membership and nothing else. **Never delete the `users` row**: their
decisions, approvals and events name it. **Never delete their Supabase Auth
user** either: if they are invited again later, a new Auth user would be a
different identity, and `link_auth_user()` refuses an address already linked to
another one. Without a membership, their next request is refused and they are
signed out at the provider (ADR 0045). If they belong to no workspace at all,
you may also **Ban** them in Supabase → Authentication → Users.

```sql
-- onboarding:remove-member
do $remove$
declare
  -- ======================= EDIT BELOW THIS LINE =======================
  org_slug text := 'acme-foods';
  person   text := 'ap.lead@acme-foods.example';
  -- ======================= EDIT ABOVE THIS LINE =======================
  v_org  uuid;
  v_user uuid;
  v_was  membership_role;
begin
  select id into v_org from organizations where slug = org_slug;
  if v_org is null then raise exception 'no workspace %', org_slug; end if;
  select m.user_id, m.role into v_user, v_was
    from memberships m join users u on u.id = m.user_id
   where m.org_id = v_org and lower(u.email) = lower(person);
  if v_user is null then raise exception '% is not a member of %', person, org_slug; end if;

  if exists (select 1 from accounting_connections c
              where c.org_id = v_org and c.enabled and c.created_by = v_user) then
    raise exception '% holds this workspace''s QuickBooks connection: another owner must press Connect QuickBooks first', person;
  end if;
  if exists (
       select 1 from inbound_addresses a
         left join inbound_address_retirements r on r.address_id = a.id
        where a.org_id = v_org and r.address_id is null
          and coalesce((select ad.adopted_by from inbound_address_adoptions ad
                         where ad.address_id = a.id
                         order by ad.adopted_at desc, ad.id desc limit 1),
                       a.created_by) = v_user) then
    raise exception 'a live email address acts as %: another owner must Adopt it first', person;
  end if;

  delete from memberships where org_id = v_org and user_id = v_user;

  if not exists (select 1 from memberships where org_id = v_org and role = 'owner') then
    raise exception 'that would leave % with no owner', org_slug;
  end if;
  if (select count(*) from memberships
       where org_id = v_org and role in ('owner', 'approver', 'analyst')) < 2 then
    raise exception 'that would leave % with fewer than two people who can write', org_slug;
  end if;
  raise notice 'removed % (%) from %', person, v_was, org_slug;
end
$remove$;
```

A case they prepared and nobody has approved stays at `awaiting_approval`, and
another approver can still approve it.

### 5.3 An outside accountant

Give them `accountant_guest`: they see every case, document and figure, and the
app and the database refuse every change (ADR 0012). Add them to `people` in
the create block and run it again:

```
{"email": "partner@outside-cpa.example", "full_name": "Pat Lee", "role": "accountant_guest"}
```

Then invite them as in step 2, and call them "a viewer" in the welcome email.
They do not count towards the two people who can write.

---

## 6. Day-one checklist and the week-one routine

### Day one (the onboarding call)

- [ ] The read-back is all `true`, and every person is `linked` in the
      invitation status query.
- [ ] Every person has signed in once, each in their own browser.
- [ ] The owner connected QuickBooks, and **Coverage** shows the first sync's
      run as completed, not `failed` or `refused`.
- [ ] Email is issued only if VERIFY-CHECKLIST §5.6–5.8 have passed; otherwise
      tell them it comes in week one.
- [ ] The first batch is uploaded. Every notice or remittance opened a case, or
      sits under **Read, not on a case** with its reason.
- [ ] Payer names on the first cases are matched, or aliased with
      `pnpm link:retailer`.
- [ ] Their per-payer dispute windows are written in the onboarding notes.
      Most cases have no printed deadline (pilot Q1), and the queue falls back
      to age.
- [ ] One case walked from the quotes to an approved packet, prepared by one
      person and approved by the other.
- [ ] Agreed: the backlog hand-off, who files and how, and a weekly review.
- [ ] Told them the limits (pilot README, "Limits to tell the customer"): PDF,
      PNG, JPEG, GIF and WebP only; a remittance past about 120 rows needs
      splitting; they do the filing; nothing is sent to anyone.

### Every day in week one (us, about 15 minutes per workspace)

Sign in as our analyst in the customer's workspace. On the case list:

1. **Read, not on a case.** For every held document, read its hold line.
   - *Held because it came by email*: check the document, then press **Open a
     case from it**.
   - *Held below the floor*, or a reading that did not fit its type: check what
     it really is. Open a case from it if it is a notice or remittance.
     Otherwise **Attach** it to the case it is evidence for.
   - Evidence that was read and is on no case: attach it to its case.
2. **Documents waiting to be read.** Anything here was stored and scanned but
   never read: a failed or stalled job. Press **Read again** once. If it is
   still there the next day, send me the document's row and the time; don't
   press it again.
3. **Email that filed nothing** (if email is on). Each line says what happened
   to that email. Tell the sender about anything that did not reach us.
4. **The review queue.** Anything past or near its deadline goes to the top of
   the day. Check the **possible duplicates** list too: a notice and its own
   remittance line can open two cases (pilot Q3).
5. **Coverage**: the ledger sync ran today (07:00 UTC). A `failed` run whose
   guidance says to reconnect means the owner presses **Connect QuickBooks**
   again.

On your machine:

6. **`pnpm sweep:inbound`**, if email is on. It records email Postmark accepted
   and could not deliver, such as mail over the size limit. Running it twice
   records nothing new. It needs `POSTMARK_SERVER_TOKEN`, `INBOUND_DOMAIN` and
   `DATABASE_URL` in `.env` (VERIFY-CHECKLIST §5.8).
7. **Unmatched payer names**: run the query in [§3](#3-map-the-payer-names-printed-on-documents)
   and alias any new spelling.
8. **Inngest and Vercel** failure alerts: anything from this workspace's jobs
   gets read and answered the same day.

Also note, per case, **analyst minutes spent**. That number, not the software,
sets how fast the other sixteen customers can come on (pilot README, "What
limits scale is people").
