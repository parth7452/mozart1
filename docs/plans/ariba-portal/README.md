# SAP Business Network: the founder's steps

*For ADR 0062. A plumbing test, not a source of deductions: the account holds
none.*

What it proves, on a real enterprise sign-in:

- **Step 10, a `completed` dry run.** The app sealed the credential, and the
  worker opened it only under its binding. The worker typed the password only
  into the bound form, SAP took its authenticator code, and the ANID matched.
- **Step 11, a sign-in SAP refuses**, once, on purpose. The connection turns
  off, and you get an email.
- **Step 12, an expired session**, if SAP's sign-out allows the probe. The run
  stops without signing in again, and you get an email. Otherwise only the
  fixture portal proves this.

Before you start:

- **Nothing we built signs in to SAP until step 1's answer is "allowed" or
  "allowed with conditions"**, and Claude has deployed it. That includes a
  dry run.
- **Five secrets live in your password manager**, and each goes to one place:
  - the service user's username, password and setup key (the key also in your
    phone's authenticator): Settings → Portals only (step 9);
  - the worker's AWS secret (step 4): Fly only (step 5);
  - the worker's token (step 5): Fly and Vercel only (step 6). It opens every
    route of the worker, run results included.
- **Never put any of them, or a code,** in chat, an issue, an email, a
  screenshot, a HAR file or this repository.
- **A lost or exposed token or AWS secret is replaced, never recovered.** A
  token: a new one on Fly, the way step 5 sets it, then the same one on Vercel.
  An AWS secret: as step 4 says.
- **Claude's part comes first, on your go.** Claude merges the build, then
  applies migration 0038 to `mozart-preview` and then to production.

| # | Step | Needs |
| --- | --- | --- |
| 1 | Read SAP's terms, and record the answer in ADR 0062 §2 | — |
| 2 | Open a Standard account, pick the service user, look for a test account | 1 |
| 3 | Turn on an authenticator app, and keep its setup key | 2 |
| 4 | Make the portal key in AWS: the app seals, the worker opens | — |
| 5 | Deploy the worker on Fly | 4, the build merged |
| 6 | Set three variables on Vercel | 4, 5 |
| 7 | Walk through once by hand, noting hosts and selectors only | 2, 3 |
| 8 | Add the connection, then upload and promote the recipe | 7, migration 0038 |
| 9 | Enter the credential | 6, 8 |
| 10 | Press **Dry run** | 1, 9 |
| 11 | Prove a refused sign-in, once | 10, failure alerts (VERIFY-CHECKLIST §10) |
| 12 | Prove an expired session, once (optional) | 11, a sign-out link (step 7) |

## 1. Read SAP's terms, and record the answer in ADR 0062 §2

- Do this first. If the answer is "not allowed", stop here: we fall back to
  Coupa, under its own ADR, and nothing below is needed.
- In a browser, read SAP Business Network's supplier terms of use. Also read
  anything that applies to Standard or test accounts. The terms that
  registering (step 2) asks you to accept belong in the same record.
- Answer §2's three questions:
  - Is automated access by a script forbidden?
  - Is a dedicated user acceptable?
  - Must a clickwrap be accepted at sign-in?
- Fill in §2's record, or send Claude the answers to write in. The record
  says who read the terms and when, which documents and versions, the answer,
  and any conditions.
- **The job cannot read the ADR.** Claude records the answer where the job
  reads it, and deploys it, on your go. Until an answer of "allowed" or
  "allowed with conditions" is deployed, every run is refused.

## 2. Open a Standard account, and look for a test account

- Register as a supplier on SAP Business Network, from SAP's own site. Choose
  the free **Standard** account. Use an email address you use for nothing else
  at SAP, and a generated password.
- **Pick the service user.** This is the login every run uses (ADR 0057 §8),
  never a person's own, so the password we seal opens this account and nothing
  else.
  - **If the account lets you add users**, add one with the least role it
    offers and its own email address. Use it from step 3 on. If it cannot
    reach the test account, tell Claude before step 7.
  - **If it does not**, the administrator you registered is the service user.
    That departs from ADR 0057's least role, so **tell Claude before step 9**.
    The exception is then recorded in ADR 0062 §1 before the credential is
    sealed. An administrator may also meet prompts others do not (profile,
    upgrades, new terms), and each can stop a run.
- Once signed in, open the account menu (top right). If it offers **Switch to
  Test ID**, switch. That is the test account, the only kind that may someday
  show a buyer's test documents. Its ANID ends `-T`.
- Note the ANID the runs will use: the test one, if it exists. An ANID starts
  `AN` and is public.
- **Done when** the service user can sign in and you know the ANID. Note too
  whether reaching it takes a click after sign-in.

## 3. Turn on an authenticator app, and keep its setup key

- As the service user, turn on two-factor sign-in with an **authenticator
  app**. It is in the account's security settings.
- At the QR code, choose the option that shows the key as text. It may say
  "Can't scan?" or "enter the key manually". Save the key in your password
  manager beside the password.
- **Type or paste the saved key into your phone's authenticator. Don't scan
  the QR code.** A code from it that SAP accepts then proves two things. The
  saved key is right, and SAP uses the standard codes the worker makes: 6
  digits, every 30 seconds, SHA-1.
- **If SAP shows only a QR code**, read it on your own devices only. Use your
  phone's camera app, or your password manager's authenticator or QR import,
  which stores the key directly. Never use a website or an online decoder, and
  never take a screenshot. The code holds a link starting `otpauth://totp/`.
  The key is the text after `secret=`, up to the next `&`.
- **Stop and tell Claude** if SAP offers only SMS, email or a push, or if that
  link has `algorithm=` other than `SHA1`, `digits=` other than `6` or
  `period=` other than `30`.
- **Done when** a code made from the saved key signs you in.

## 4. Make the portal key in AWS (about 15 minutes)

- **Region.** Use the AWS account and the region of the QuickBooks key. That
  is `docs/qbo-credentials.md`, part one, and the `AWS_REGION` on Vercel.
- **The app's identity.** The app reaches AWS as the IAM user whose access key
  is already on Vercel. That document named it `recouple-qbo-tokens`.
  - Not sure which user it is? IAM → Users lists each user's access key ID.
    Match it against `AWS_ACCESS_KEY_ID` on Vercel.
  - This key's policy lets that user seal a portal credential and never open
    one.

1. **Make the worker's identity.**
   - In IAM, choose **Users** → **Create user**, and name it
     `recouple-portal-worker`.
   - Give it no console access and attach **no policy**. The key's policy is
     what lets it open a credential.
   - Then choose **Security credentials** → **Create access key** →
     *Application running outside AWS*.
   - Save the access key ID and its secret in your password manager, for
     step 5. AWS shows the secret only once. A lost or exposed secret is
     replaced, never recovered: make a new access key, set it on Fly as
     step 5 does, and delete the old one.
2. **Find your account ID.** It is the 12 digits under your name, top right.
3. **Make the key.**
   - Open KMS, in that region, and choose **Create key**.
   - Choose *Symmetric*, then *Encrypt and decrypt*.
   - Set the alias to `recouple-portal-credentials`.
   - Skip the administrators and users pages, then choose **Finish**.
4. **Set its policy.**
   - Open the key → **Key policy** → **Switch to policy view** → **Edit**.
   - Replace everything with the JSON below.
   - Put your account ID in place of `111122223333`. It appears five times.
   - If your app's user is not named `recouple-qbo-tokens`, put its name in
     its place.
   - Choose **Save**. AWS refuses a policy that names a user who does not
     exist, which catches a typo.
5. **Copy the key's ARN** (`arn:aws:kms:…:key/…`). Steps 5 and 6 use the ARN,
   not the alias, because a sealed credential records the ARN and the worker
   checks it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Enable IAM User Permissions",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111122223333:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "TheAppMaySealPortalCredentials",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111122223333:user/recouple-qbo-tokens" },
      "Action": "kms:GenerateDataKey",
      "Resource": "*",
      "Condition": { "StringEquals": { "kms:EncryptionContext:purpose": "portal_credential" } }
    },
    {
      "Sid": "TheAppMayDoNothingElse",
      "Effect": "Deny",
      "Principal": { "AWS": "arn:aws:iam::111122223333:user/recouple-qbo-tokens" },
      "NotAction": "kms:GenerateDataKey",
      "Resource": "*"
    },
    {
      "Sid": "TheWorkerMayOpenPortalCredentials",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111122223333:user/recouple-portal-worker" },
      "Action": "kms:Decrypt",
      "Resource": "*",
      "Condition": { "StringEquals": { "kms:EncryptionContext:purpose": "portal_credential" } }
    },
    {
      "Sid": "TheWorkerMayDoNothingElse",
      "Effect": "Deny",
      "Principal": { "AWS": "arn:aws:iam::111122223333:user/recouple-portal-worker" },
      "NotAction": "kms:Decrypt",
      "Resource": "*"
    }
  ]
}
```

What the policy does:
- **The app** may ask for a data key, only for a portal credential, and may do
  nothing else with this key. It can seal a password and can never read one.
- **The worker** may open a portal credential and may do nothing else. It
  cannot seal one.
- **The first statement** is AWS's default. It keeps the key manageable.
- **Never delete this key.** Disable it instead. Deleting it makes every
  sealed credential unreadable for good.

## 5. Deploy the worker on Fly

- The Fly organization has had billing on since 2026-09-25, for the scanner.
  Deploy into it: an organization on the free trial stops every machine 300
  seconds after it starts.
- **The deploy line is provisional.** The worker (`services/portal-read`) is
  not merged yet. It shares code with the app, so it will likely build from
  the repository root, not from its own folder. When it is merged, Claude
  replaces the line marked `PROVISIONAL` with the commands in its README.
  Don't run it before then.
- **The secret handling is final.** Each secret is pasted at a hidden prompt,
  never typed into a command, so your shell's history file never holds it.

**Make the token** in a terminal window of its own. Copy the 64 characters it
prints into your password manager, then close that window.

```sh
openssl rand -hex 32   # 64 characters, the shortest either side accepts
```

**Make the app and set its secrets**, from any folder:

```sh
fly apps create recouple-portal-read   # choose the scanner's organization

fly secrets set -a recouple-portal-read \
  PORTAL_KMS_KEY_ID=<the key ARN from step 4> \
  AWS_REGION=<the region from step 4> \
  AWS_ACCESS_KEY_ID=<the worker's access key ID>

# Paste each from your password manager. Nothing shows as you paste.
printf 'Worker token: '; read -rs TOKEN; echo
printf 'Worker AWS secret: '; read -rs SECRET; echo
printf 'PORTAL_READ_TOKEN=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$TOKEN" "$SECRET" \
  | fly secrets import -a recouple-portal-read
unset TOKEN SECRET
```

**Deploy it, and check it answers:**

```sh
fly deploy --ha=false   # PROVISIONAL: where and how, per the worker's README. One machine, never two
curl -sS https://recouple-portal-read.fly.dev/health   # {"status":"ok"}
```

- **One machine, always on.** A run's result lives only in that machine's
  memory. A second machine, or one that stopped, answers "not found", and the
  job then records the run failed. So:
  - the worker's `fly.toml` must keep `auto_stop_machines = false` and
    `min_machines_running = 1`;
  - if `fly status -a recouple-portal-read` shows two machines, run
    `fly scale count 1 -a recouple-portal-read`.
- Give the worker nothing else: no database URL and no model key (ADR 0057
  §6).
- It refuses to start without its token.

## 6. Set three variables on Vercel, Production only

| Name | Value |
| --- | --- |
| `PORTAL_READ_URL` | `https://recouple-portal-read.fly.dev` |
| `PORTAL_READ_TOKEN` | the token from step 5, pasted from your password manager |
| `PORTAL_KMS_KEY_ID` | the key's ARN from step 4 |

- Set them for **Production only**, never Preview (`docs/supabase.md`).
- `AWS_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are already
  there for QuickBooks. Add nothing else.
- Redeploy.

## 7. Walk through once by hand

**Set up the browser.**
- Use a private Chrome window, with DevTools open on **Network** (F12).
- Tick **Preserve log**. Right-click a column header, and add **Domain** and
  **Method**.
- Don't tick "remember me" or "trust this device". The worker never does.

**Walk through as the service user.** Sign in and type the code. Reach the
landing page, switching to the test account if step 2 needed it. Then sign
out.

**Before you send anything:**
- Cut every address at its first `?`, `#` or `;`, because what follows can
  hold a session token. Say where you cut at a `;`.
- Write any part of a path that is a long random-looking string as
  `<random>`.
- Write the username or its email as `<username>`, wherever it shows.
- Say where you replaced something.

**Send Claude:**
1. The address you started at.
2. Every distinct **Domain**, marking those the address bar showed.
3. Every `POST` in the **Method** column. Click it → **Headers**, and copy
   its *Request URL*. Say when it came: at the password, at the code, after
   the code with nothing pressed, on the landing page, or at sign-out.
4. Whether the username and password were on one page or two, and whether the
   code went in one box or six.
5. Where the ANID shows after sign-in, without clicking. Right-click it →
   **Inspect**, then right-click the highlighted line → **Copy** → **Copy
   selector**.
6. Any banner or pop-up (cookies, notices, new terms): its full text and its
   buttons.
7. How you signed out: where the control was (in a menu?) and its exact
   label. If it was a link, right-click it → **Copy link address**, and send
   that too, cut as above.
8. The exact label of any control that would change something, such as
   "Create …", "Publish" or an upgrade offer. These join `neverClick`.

**Never send:**
- the username, the password or a code;
- cookies, or the **Payload** or **Cookies** tabs;
- a HAR file ("Save all as HAR" holds your password and your session);
- "Copy as cURL".

The ANID, hosts, paths and labels are fine to send.

**Tell Claude before step 8 if you saw any of these.** The recipe or the
runner may need a change first:
- the username and password on separate pages;
- the code in several boxes;
- the code posted to a host other than the one that took the password;
- a `POST` you pressed nothing for, either before the password form or to a
  host other than the one that took the password;
- a `POST` on the landing page, to a host the address bar showed;
- the ANID only inside a menu;
- the test account only after a click;
- signing out by a `POST`, or only through a menu;
- a sign-out labelled anything but "Sign out" or "Log out" (such as "Log
  off");
- a banner or pop-up that prints the username.

**Done when** Claude has:
- filled `recipe.draft.json` into version 1, and the check under *The
  draft*, below, passes: version 1 parses and has no placeholder left;
- recorded in ADR 0062 §3 what the same notes confirm: how sign-in and MFA
  work, the hosts, and SAP's never-click names. ADR 0057 §2 asks for all four
  before a recipe runs.

## 8. Add the connection, then upload and promote the recipe

In Settings → **Portals** (owners only):
- **Add a connection** with:
  - portal key `sap_business_network`;
  - a label, such as "SAP Business Network — plumbing test";
  - account id: the ANID from step 2, with `-T` for a test account;
  - no run parameters.
- **Upload** version 1 as JSON. What `parseRecipe` refuses is refused here
  too.
- **Review, then promote.** Check that:
  - the hosts and paths match your notes;
  - `portalAdr` is `0062`;
  - `provenance.source` names your walk-through, not "UNVERIFIED".

## 9. Enter the credential

- On the connection, enter the service user's username and password, and the
  saved setup key. Paste each from your password manager. Spaces and lower
  case in the key are fine.
- A label, if you give one, must not contain the username.
- The credential is sealed before anything is written. It is sealed to the
  promoted version's sign-in host, sign-in paths and host list.
- A later version that changes any of those needs the credential entered
  again.

## 10. Press Dry run

- A dry run signs in, types a code and checks the ANID. It passes over the
  landing capture without storing anything, then signs out.
- Its record is a step log: step names and pass or fail, with no values.
- Each dry run is a real sign-in on a real account. Press it when you mean it,
  not in a loop.
- The outcome shows in words under the connection, with the step it stopped
  at.
- **Three kinds of outcome also email you**, through the failed-run alert
  (ADR 0062 §5, ADR 0052): `credential_rejected`, `session_expired` and any
  `failed`.
  - The email comes only if failure alerts are set up (VERIFY-CHECKLIST §10).
  - At most one an hour comes from this job, whatever the outcome.
  - It names the job and the run, never a username, password, code or page
    text.

| Outcome | Emails you | What happened | What to do |
| --- | --- | --- | --- |
| `completed` | no | It signed in, answered the code and found the ANID | Nothing. Steps 11 and 12 prove what it does not |
| `refused` | no | It never started. The connection is off, you may no longer write, or the job has no "allowed" answer from step 1 | Turn the connection on, check your role, or finish step 1, Claude's deploy of your answer included |
| `not_configured` | no | Something is missing: the worker (steps 5–6), a promoted recipe (8) or a credential (9) | Finish that step |
| `needs_attention` (`credential_rejected`) at `sign_in` | yes | SAP refused the username or password. The connection is now **off**. It is never retried, so the account cannot be locked out | Expected in step 11. Otherwise, sign in by hand with the saved password to check it. Enter the credential again (9), then turn the connection on |
| `needs_attention` (`credential_rejected`) at `answer_mfa` | yes | SAP refused the code. Usually the setup key was saved or entered wrong; rarely, the worker's clock is off. The connection is now **off** | Expected in step 11's optional part. Otherwise, check the saved key as step 3 does. Enter the whole credential again, key included (9), then turn the connection on. If a checked key is refused again, tell Claude |
| `needs_attention` (`mfa_unanswerable`) | no | SAP asked for something other than an authenticator code, no key was sealed, or the code page was not where the recipe says. At `answer_mfa`, it may be a code SAP refused without showing an error. The connection stays **on** | Sign in by hand with a code from the saved key before you press Dry run again, and tell Claude what SAP asked for. If you entered no key in step 9, enter the credential again with it |
| `needs_attention` (`page_changed`) | no | An element the recipe expects was missing. At `sign_in` or `answer_mfa`, it may be a password or code SAP refused without showing an error. The connection stays **on** | Before you press Dry run again, sign in by hand with the saved password and a code from the saved key, and tell Claude which step. Each wrong sign-in counts toward a lockout |
| `needs_attention` (`session_expired`) | yes | After sign-in, SAP sent the browser back to sign-in. A run never signs in twice. The connection stays **on** | Expected in step 12. Otherwise, tell Claude |
| `needs_attention` (`account_mismatch`) | no | The page did not show the connection's ANID. Nothing was captured | Check the ANID, `-T` included. A wrong ANID needs a new connection |
| `needs_attention` (`binding_mismatch`) | no | The promoted version's sign-in host, paths or host list differ from those the credential was sealed to. Nothing was decrypted | Enter the credential again (9) |
| `needs_attention` (`challenge` or `terms_prompt`) | no | A CAPTCHA appeared, which is never solved; or a pop-up with an "Accept"-type button appeared | Sign in by hand and look. Accepting new terms is yours to do, and may change §2. Tell Claude which step |
| `failed` (`guard_refused`) | yes | The browser was sent to a host or path the recipe does not list | Tell Claude which step. Usually a host is missing from the walk-through |
| `failed` (`sign_in_form_refused`) | yes | The sign-in page did not have exactly one bound form, with one username box and one password box | Tell Claude. Usually the sign-in is on two pages, or the form posts somewhere the recipe does not name |
| `failed` (any other reason) | yes | The recipe tried something the runner refuses, hit a cap, or met an error named only by its class | Tell Claude the step and the reason |
| no outcome | if the job failed | The run started and never recorded an end | Tell Claude |

## 11. Prove a refused sign-in, once

A `completed` run never shows what happens when SAP refuses a sign-in. This
step makes SAP refuse one, once, on purpose.

- **First**, set up failure alerts (VERIFY-CHECKLIST §10) if you have not, or
  no email comes.
- **Enter the credential again (step 9)** with the right username and setup
  key, and a password you know is wrong. Label it "wrong password, on
  purpose".
- **Press Dry run once.** Expect:
  - `needs_attention` (`credential_rejected`) at `sign_in`;
  - the connection **off**;
  - within a few minutes, the alert email, "Mozart: a background job failed
    (…)", with no username, password, code or page text in it.
- **Then put it back.** Enter the right credential (step 9), turn the
  connection on, and press **Dry run**. Expect `completed`.
- **That is one failed sign-in on the account.** The job never retries it.
  SAP counts it toward a lockout, so don't repeat it.
- **If it ends any other way** (`page_changed` at `sign_in`, say), SAP
  refused the password in a way the runner did not recognise, and the
  connection stays on. Put the right credential back before anything else,
  and tell Claude.
- **Optionally, do the same for the code.**
  - Enter the right username and password with the setup key
    `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`. It is RFC 6238's published test key,
    which our tests use, so it is certainly not yours. Label it "wrong key, on
    purpose".
  - Expect `credential_rejected` at `answer_mfa`, the connection off, and the
    email. Then put the right credential back, as above.
  - At most one email an hour comes from this job, so leave an hour after the
    first.

## 12. Prove an expired session, once (optional)

A run lasts at most two minutes, too short to wait for SAP to end a session,
so this probe ends one itself. It proves that when SAP shows its sign-in page
to a run that has signed in, the run stops without typing the credential
again, the connection stays on, and you get the email.

- **Only if step 7 found signing out is a plain link**: no `POST` at
  sign-out, and its address noted. Otherwise skip this step. An expired
  session is then proved only against the fixture portal, by the build's
  tests.
- **Claude writes the probe.** It has version 1's steps up to the ANID check,
  then an `open` of the sign-out address, then an `open` of the address you
  started at. It keeps version 1's sign-in addresses and host list, so your
  credential still opens it.
- **Upload it as the next version, and don't promote it.** Press **Dry run**
  on that version, once. Expect:
  - `needs_attention` (`session_expired`) at one of its two `open` steps;
  - the connection still **on**;
  - the alert email, unless this job emailed you in the last hour.
- **Then reject that version**, so it can never be promoted.
- **If it ends any other way**, tell Claude. If it ended `completed`, opening
  the sign-out address did not end the session. An expired session is then
  proved only against the fixture portal.

## Undo

- **Turn the connection off** in Settings → Portals. Nothing signs in again.
- **Stop the worker**: `fly scale count 0 -a recouple-portal-read`. Use
  `count 1` to start it again.
- **To make every sealed credential unopenable**, disable the KMS key; never
  delete it. The rows stay, because they are append-only.

## The draft (`recipe.draft.json`)

- **What it is.** A recipe version as ADR 0057 §3 defines one. It signs in,
  answers the code, runs `expect` on the ANID, captures the landing page and
  signs out (ADR 0062 §4).
- **Nothing in it is real yet.** It is marked `UNVERIFIED` in
  `provenance.source`.
- **Every placeholder says so in its value** (`placeholder-…`), because a
  recipe's JSON can carry no comments.
- **Its hosts end in `.invalid`**, a name reserved never to resolve. So the
  draft reaches nothing, even if it is uploaded by mistake.

| Field | Draft value | Filled from walk-through item |
| --- | --- | --- |
| `hostAllowlist` | three `placeholder-….invalid` hosts | 2: the hosts the flow visits (ADR 0062 §3) |
| `signIn.origin` | `https://placeholder-sap-identity.invalid` | 3: the scheme and host of the *Request URL* the password form posts to. Don't take it from the address bar. The code form must post to the same host |
| `signIn.formPaths` | `/placeholder-password-form-path` | 3: the path the username and password post to |
| `signIn.mfaPaths` | `/placeholder-code-form-path` | 3: the path the code posts to |
| `signIn.acsPaths` | none | 3: any automatic `POST` after the code, to that same host |
| `open_sign_in` URL | `https://placeholder-supplier-sign-in.invalid/…` | 1 |
| `expect_anid` selector | `#placeholder-anid-element` | 5 |
| `neverClick` | Create Invoice, Submit, Confirm, Send, Accept, Publish. The floor already covers all but Publish | 8 |
| `postAsRead` | none | 3 and 7: sign-out, only if it is a `POST` |
| `caps` | 10 pages, no downloads, 2 minutes | adjusted if the flow needs more |

**The ANID is never in the recipe.** It is the connection's account id. The run
compares it with what `expect_anid` finds (`RunRequest.expectAccountId`), so
one recipe serves both the test account and the Standard one.

**Check a filled version** from the repository root. `RECIPE` names the file.
The check prints the binding the credential will be sealed to. It then fails
while anything is left unfilled:
- a value containing `placeholder-`;
- a host ending `.invalid`;
- a `provenance.source` starting `UNVERIFIED`.

On the draft it fails, as it should. Read its `not filled:` line. The
`undefined` and the pnpm error after it are just how tsx exits.

```sh
RECIPE=docs/plans/ariba-portal/recipe.draft.json \
pnpm --filter @recouple/portal exec tsx -e '(async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { parseRecipe } = await import("./src/recipe.ts");
  const { bindingOf } = await import("./src/binding.ts");
  const r = parseRecipe(JSON.parse(readFileSync(resolve("../..", process.env.RECIPE), "utf8")));
  console.log(JSON.stringify(bindingOf(r)));
  const left = new Set();
  const walk = (v, at) => {
    if (typeof v === "string") {
      let host = "";
      try { host = new URL(v).hostname; } catch {}
      if (/placeholder-/i.test(v) || host.endsWith(".invalid")) left.add(at);
    } else if (v !== null && typeof v === "object") {
      for (const [k, w] of Object.entries(v)) walk(w, at + "." + k);
    }
  };
  walk(r, "recipe");
  r.hostAllowlist.forEach((h, i) => { if (h.toLowerCase().split(":")[0].endsWith(".invalid")) left.add("recipe.hostAllowlist." + i); });
  if (r.provenance.source.startsWith("UNVERIFIED")) left.add("recipe.provenance.source");
  if (left.size > 0) { console.error("not filled: " + [...left].join(", ")); process.exit(1); }
  console.log("filled: nothing left to fill");
})()'
```
