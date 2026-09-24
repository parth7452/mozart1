# Connecting a customer's QuickBooks

This is the setup somebody has to do **once per deployment** — an AWS key and
the app's registration at Intuit — after which a customer's owner connects
their own company from **Settings → QuickBooks** in the app. It is written for
somebody who does not work in AWS every day. If you get stuck at a step, stop
there rather than working around it — every step here is protecting a
credential that can read a customer's books.

The decisions behind it are ADR 0033 (how a token is stored) and ADR 0039 (how
a customer connects). The short version: a QuickBooks refresh token is a live
credential, so we never write one down in a readable form. We lock it with a
key that lives in Amazon's key service, and the database only ever holds the
locked version. Someone who walked off with a copy of our whole database would
have nothing they could use.

---

## Part one: the AWS setup (once, about fifteen minutes)

You need an AWS account. If the company already has one, use it — this needs a
very small corner of it.

### 1. Make a key

1. Sign in to the AWS console and search for **KMS** (it is called "Key
   Management Service").
2. Make sure the **region** selector in the top right says the region you want.
   Write down what it says — you will need it later, and it looks like
   `us-east-1`. The key only exists in that one region.
3. Choose **Create key**.
4. Key type: **Symmetric**. Key usage: **Encrypt and decrypt**. These are the
   defaults; do not change them.
5. Alias: `recouple-qbo-tokens`. An alias is just a friendly name for the key.
6. Skip the "key administrators" and "key users" steps for now — the next part
   handles who may use it. Finish creating the key.
7. Open the key and copy its **ARN**. It looks like
   `arn:aws:kms:us-east-1:123456789012:key/1234abcd-...`. Keep it to hand.

**Do not delete this key, ever.** Deleting it makes every stored token
permanently unreadable, and the only repair is asking every customer to
reconnect QuickBooks. If you want to stop using it, *disable* it instead.

### 2. Make an identity that may use that key and nothing else

1. In the console, search for **IAM**.
2. Choose **Users** → **Create user**. Name it `recouple-qbo-tokens`. Do **not**
   give it console access — it is for the application, not for a person.
3. On the permissions step choose **Attach policies directly** → **Create
   policy** → the **JSON** tab, and paste this, replacing the `Resource` line
   with the ARN you copied:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
         "Resource": "arn:aws:kms:us-east-1:123456789012:key/PUT-YOURS-HERE"
       }
     ]
   }
   ```

   Three actions, one key. That is the whole of what this identity can do in
   AWS: it cannot read a file, start a server, or touch any other key. If
   somebody gets hold of it, that is the entire blast radius.

4. Name the policy `recouple-qbo-tokens`, create it, and attach it to the user.
5. Open the user → **Security credentials** → **Create access key** → choose
   **Application running outside AWS**. You get two values:
   an **access key ID** (like `AKIA...`) and a **secret access key**.
   The secret is shown once and never again. Copy both somewhere safe for the
   next ten minutes.

### 3. Put four values where the app can read them

In the Vercel project, under **Settings → Environment Variables**, add these
four to **Production** only. Previews never hold them (docs/supabase.md): a
preview's settings page says QuickBooks is not set up, and sends nobody to
Intuit.

| Name | Value |
| --- | --- |
| `QBO_TOKEN_KMS_KEY_ID` | `alias/recouple-qbo-tokens` (the alias is fine; an ARN works too) |
| `AWS_REGION` | the region from step 1, e.g. `us-east-1` |
| `AWS_ACCESS_KEY_ID` | the access key ID from step 2 |
| `AWS_SECRET_ACCESS_KEY` | the secret from step 2 |

Redeploy so they take effect.

If you will ever run `pnpm link:qbo` or `pnpm unlink:qbo` (part four), put the
same four in the `.env` file at the top of this repository on that laptop.

**How to tell it worked:** until `QBO_TOKEN_KMS_KEY_ID` is set, every ledger
sync records `not_configured` and reads nothing, and Settings → QuickBooks says
QuickBooks is not set up and offers no button. That is by design — the app
would rather do nothing than hold a credential it cannot protect. Once the
variable is set and a customer is connected, syncs start recording `completed`.

---

## Part two: the app's registration at Intuit (once per deployment)

The app has one registration at Intuit — `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`
and `QBO_ENVIRONMENT` on Vercel, Production only. It is not per customer.
`QBO_ENVIRONMENT` is `sandbox` with Intuit's *Development* keys and
`production` with its *Production* keys; there is no default, because a consent
against the wrong environment's app cannot work.

In the Intuit developer portal, open the app, then the keys for the environment
you are using (Development or Production) → **Keys & credentials** → **Redirect
URIs**, and add, character for character:

```
https://app.mozart.financial/settings/quickbooks/callback
```

The app never reads this from a variable: it works it out from its own address,
and Intuit refuses to send anybody back to an address it does not have
registered, so a mismatch fails on Intuit's page and nothing is stored. The
Connect button only works on `app.mozart.financial` for the same reason —
pressed on any other address, the app sends you there to press it again.

The Production keys also ask for the app's URLs. Use:

| Intuit's field | Value |
| --- | --- |
| Host domain | `app.mozart.financial` |
| Launch URL | `https://app.mozart.financial/settings/quickbooks` |
| Disconnect URL | `https://app.mozart.financial/settings/quickbooks` |
| Connect/Reconnect URL | `https://app.mozart.financial/settings/quickbooks` |

The Disconnect URL is where Intuit sends somebody who disconnects the app from
inside QuickBooks. The page will say *Connected* until the next sync finds the
grant gone and says *needs reconnecting*; pressing **Disconnect** there turns
it off at once.

**Working on a laptop.** Development keys accept
`http://localhost:3000/settings/quickbooks/callback` as a second Redirect URI.
The state cookie is a `__Host-` cookie, which has to be `Secure`; Chrome and
Firefox accept that on `http://localhost`, Safari does not, so connect from
Chrome or Firefox locally — or the callback will say the sign-in could not be
matched to this session.

---

## Part three: a customer connects (a minute each)

An **owner** of the customer's workspace signs in, opens **Settings →
QuickBooks** and presses **Connect QuickBooks**. Intuit asks them to sign in and
choose a company; they come back to the same page, which says what happened.
That is the whole of it. Behind the button:

- Only an owner sees the button, and the database refuses anybody else anyway
  (ADR 0039 §8). Who is an owner is itself an owner's decision.
- The connection **acts as the owner who pressed it**: every nightly sync
  re-checks that they may still write in that workspace. If they leave, syncs
  record `refused` and the page says to reconnect — as a current owner, which
  moves the connection to them.
- One QuickBooks company can be connected to **one workspace at a time**, across
  the whole deployment. A second workspace trying the same company is told it is
  connected elsewhere, and nothing is stored.
- The first sync is queued at once; the results arrive in minutes rather than at
  the next 07:00 UTC run.
- The page shows the company id, who it syncs as, how long the sign-in is good
  for and how the last sync went. It never shows, logs or stores a readable
  token.

### The operator's way in, when the button cannot be used

`pnpm link:qbo` does exactly what the button does — the same function — from a
refresh token you already have, for example one from Intuit's OAuth
playground. Put these in your laptop `.env`:

```
DATABASE_URL=...            # already there
QBO_REALM_ID=4620816365213608204
QBO_REFRESH_TOKEN=AB1160...
```

Then run, from the top of the repository:

```
pnpm link:qbo --org <their slug> --as <an owner's email>
```

- `--org` is the tenant slug, and there is no default: a connection belongs to
  exactly one customer.
- `--as` is the owner the connection will act as, by the email they sign in
  with. It must be an **owner** of that tenant, and it is recorded — the same
  rule as the button.

Add `--dry-run` first to see whether it would connect, reconnect or move the
connection. A dry run writes nothing and calls nothing, so it works before the
AWS half is finished. `pnpm link:qbo --help` repeats all of this, including the
optional variables.

Afterwards, **delete the token from your `.env`**:

```
QBO_REFRESH_TOKEN=          # delete this line
QBO_ACCESS_TOKEN=           # and this one, if you set it
```

The token is now in the database, sealed. The copy in the file on your laptop
is the only one nothing is protecting.

---

## Part four: disconnecting

An owner presses **Disconnect** on Settings → QuickBooks. The connection is
turned off first — syncs stop — and then our access is revoked at Intuit, and
both are recorded. If Intuit does not confirm the revoke, the page says so, and
the owner can also remove the app inside QuickBooks (Settings → Apps).

A connection whose sign-in Intuit has refused for good — the customer removed
the app inside QuickBooks, or nothing synced it for the ~100 days a refresh
token lasts — is released by the next sync on its own (ADR 0046): the run is
recorded `failed`, the connection is turned off, and Settings → QuickBooks says
why. The one it cannot release is a connection whose member is no longer an
owner.

`pnpm unlink:qbo` is the operator's release for that case, and for a connection
nobody will press Disconnect on while its sign-in still works: a workspace whose
owner left, or an agency that stopped working for the manufacturer. Because a
company can be connected to one workspace at a time, such a connection blocks
every other workspace from that company until it is released:

```
pnpm unlink:qbo --org <holding slug> --as <an owner of it> --realm <company id> --dry-run
pnpm unlink:qbo --org <holding slug> --as <an owner of it> --realm <company id>
```

`--as` must be an owner of the workspace that holds the connection. If that
workspace has no owner left, one has to be added first — who is an owner is an
owner's decision (ADR 0039 §8), so with none left that is a database
operator's change, made as the table owner and written down.

It runs the button's own function and the audit rows say `operator_command`.
It revokes at Intuit when `.env` has `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` and the
AWS four; without them it still turns the connection off and records the revoke
as not attempted. `--no-revoke` turns it off without asking Intuit.

---

## What happens after that, and what can go wrong

Intuit replaces a refresh token **every time it is used**, roughly hourly, and
kills the old one immediately. Each replacement is written as a new row —
nothing is ever overwritten — so the rows for a connection are a visible record
of every rotation, and a connection whose rows stop appearing is visibly stuck
rather than quietly stale.

| What you see | What it means | What to do |
| --- | --- | --- |
| Sync outcome `not_configured` | No KMS key, no Intuit credentials, or no tokens stored for that connection | Finish parts one and two, or have an owner press Connect |
| Sync outcome `refused` | The member the connection acts as can no longer write in that org | A current owner presses Reconnect, which moves it to them |
| `CredentialUnreadableError` | A stored row will not open: usually the key was disabled, the region is wrong, or the identity lost permission | Check the key is enabled and the four variables are right. Do **not** reconnect the customer first — the tokens are probably fine |
| `QboAuthError` … "has to reconnect" | The refresh token itself expired or was revoked in Intuit | An owner presses Reconnect |
| "already connected in another workspace" | Another workspace holds an enabled connection to that company | That workspace's owner disconnects it — or, if nobody will, `pnpm unlink:qbo` |
| "could not be matched to this session" | The consent took over ten minutes, was started in another browser or as somebody else, or the browser refused the cookie | Press Connect again, in one browser, within ten minutes |

If you ever need to rotate the AWS key itself: make the new key, leave the old
one **enabled**, add the new key's ARN to the `Resource` list in the IAM policy
so the identity may use both, and only then point `QBO_TOKEN_KMS_KEY_ID` at the
new one. Rows written from then on use the new key and older rows still open
under the old one, because each row records which key sealed it — which is why
the identity has to keep `kms:Decrypt` on the old key until nothing needs it.
Only retire the old key once every connection has rotated onto the new one —
which, since Intuit rotates hourly, takes about a day.
