# Connecting a customer's QuickBooks, once

This is the setup somebody has to do **once per deployment**, plus the command
you run **once per customer**. It is written for somebody who does not work in
AWS every day. If you get stuck at a step, stop there rather than working
around it — every step here is protecting a credential that can read a
customer's books.

The decision behind all of it is ADR 0033. The short version: a QuickBooks
refresh token is a live credential, so we never write one down in a readable
form. We lock it with a key that lives in Amazon's key service, and the
database only ever holds the locked version. Someone who walked off with a
copy of our whole database would have nothing they could use.

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
four to **Production** (and to Preview if previews should read ledgers, which
they normally should not):

| Name | Value |
| --- | --- |
| `QBO_TOKEN_KMS_KEY_ID` | `alias/recouple-qbo-tokens` (the alias is fine; an ARN works too) |
| `AWS_REGION` | the region from step 1, e.g. `us-east-1` |
| `AWS_ACCESS_KEY_ID` | the access key ID from step 2 |
| `AWS_SECRET_ACCESS_KEY` | the secret from step 2 |

Redeploy so they take effect.

Put the same four in the `.env` file at the top of this repository on the
laptop you will run `pnpm link:qbo` from.

**How to tell it worked:** until `QBO_TOKEN_KMS_KEY_ID` is set, every ledger
sync records `not_configured` and reads nothing. That is by design — the app
would rather do nothing than hold a credential it cannot protect. Once the
variable is set and a customer is connected, syncs start recording `completed`.

---

## Part two: connecting one customer (a few minutes each)

You also need the Intuit side set up — `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` and
`QBO_ENVIRONMENT` on Vercel, which is the app's own registration with Intuit and
is not per customer.

For the customer, you need two things from them or from Intuit's OAuth
playground:

- their **company id** (Intuit calls it the *realm id*) — a long number;
- a **refresh token** for that company.

Put them in your laptop `.env`:

```
DATABASE_URL=...            # already there
QBO_REALM_ID=4620816365213608204
QBO_REFRESH_TOKEN=AB1160...
```

Then run, from the top of the repository:

```
pnpm link:qbo --org <their slug> --as <your email>
```

- `--org` is the tenant slug, and there is no default: a connection belongs to
  exactly one customer.
- `--as` is you, by the email you sign in with. It has to be somebody who may
  write in that tenant, and it is recorded — **every nightly sync of this
  connection acts as that person and re-checks their rights**, so choose
  somebody who will still be here next quarter. If they leave, the sync starts
  recording `refused` rather than reading, which is visible on the day it
  happens; the fix is to connect the ledger again as somebody current.

Add `--dry-run` first if you want to see what it would do. A dry run writes
nothing and calls nothing, so it works before the AWS half is finished.

`pnpm link:qbo --help` repeats all of this, including the optional variables.

### Afterwards, delete the token from your `.env`

```
QBO_REFRESH_TOKEN=          # delete this line
QBO_ACCESS_TOKEN=           # and this one, if you set it
```

The token is now in the database, sealed. The copy in the file on your laptop
is the only one nothing is protecting.

---

## What happens after that, and what can go wrong

Intuit replaces a refresh token **every time it is used**, roughly hourly, and
kills the old one immediately. Each replacement is written as a new row —
nothing is ever overwritten — so the rows for a connection are a visible record
of every rotation, and a connection whose rows stop appearing is visibly stuck
rather than quietly stale.

| What you see | What it means | What to do |
| --- | --- | --- |
| Sync outcome `not_configured` | No KMS key, no Intuit credentials, or no tokens stored for that connection | Finish part one, or run `pnpm link:qbo` for that customer |
| Sync outcome `refused` | The member the connection was made by can no longer write in that org | Run `pnpm link:qbo` again as somebody current |
| `CredentialUnreadableError` | A stored row will not open: usually the key was disabled, the region is wrong, or the identity lost permission | Check the key is enabled and the four variables are right. Do **not** reconnect the customer first — the tokens are probably fine |
| `QboAuthError` … "has to reconnect" | The refresh token itself expired or was revoked in Intuit | Get a fresh refresh token and run `pnpm link:qbo` again |

If you ever need to rotate the AWS key itself: make the new key, leave the old
one **enabled**, add the new key's ARN to the `Resource` list in the IAM policy
so the identity may use both, and only then point `QBO_TOKEN_KMS_KEY_ID` at the
new one. Rows written from then on use the new key and older rows still open
under the old one, because each row records which key sealed it — which is why
the identity has to keep `kms:Decrypt` on the old key until nothing needs it.
Only retire the old key once every connection has rotated onto the new one —
which, since Intuit rotates hourly, takes about a day.
