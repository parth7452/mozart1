# 0047 — An email reaches a tenant only through an address that tenant was given

- Status: accepted (2026-09-24, by the founder)
- Date: 2026-09-24
- Amends: ADR 0016 (every accepted body is stored; only its read depends on the attachments, and that is decided in the read job), ADR 0021 (what "Read again" answers for a document that came by email), ADR 0024 (each document an email carried is its own arrival, and the message groups them), ADR 0044 (an email's notice or remittance is held for a person instead of halted), and ingest's dedupe branch for every door (a document stored without a clean-or-infected verdict is scanned again)
- Closes: the follow-up ADR 0021 named ("Persisting the authentication verdict is the change that would close the remainder"), the open question of how a person opens a case from an unauthenticated email's notice, and `docs/VERIFY-CHECKLIST.md` §5

## Context

Email-in exists as two layers, and nothing calls either one. `packages/ingest/src/email.ts` parses a Postmark inbound payload. `ingestInboundEmail` (`packages/pipeline/src/steps.ts:2317`) files the email's attachments and, per ADR 0016, its body. The app has no route that receives email. `apps/web/app` has twenty route handlers and none of them is inbound. `POSTMARK_SERVER_TOKEN`, `POSTMARK_INBOUND_SECRET` and `INBOUND_DOMAIN` are in `.env.example`, and no code reads them. `docs/STATE-OF-PLAY.md` says email-in is not wired, and the verify checklist calls it the largest open item. The case list's empty state already tells a member that a case opens "by email to this workspace's inbound address", and no workspace has one.

It matters because email is how a supplier sends us a deduction it already knows about. In staffing, freight and foodservice it is also how a remittance arrives. And it is where a failed portal credential is meant to fall back to (STRATEGY §5; CLAUDE.md: a credential failure degrades to upload or email).

Wiring the existing step to a route would not work, and where it did work it would be unsafe. Ten things stand in the way.

1. **Nothing can find the tenant.** `ingestInboundEmail` calls `findOrgBySlug`. `PostgresStore` runs that inside `withTenant` under its own org claim, and `organizations` is readable only where `id = app.current_org_id()` (0010). So it can only find the org the store was already built for. ADR 0034 named this circularity. Every email test uses the in-memory store, whose `findOrgBySlug` sees every tenant, so no test has ever hit the problem.
2. **There is nobody to act as.** `TenantContext.userId` is required. Every `tenant_insert` asks `app.member_may_write()`, an `audit_log` row must name the caller (0030), and `readDocumentJob` asks `memberMayWrite` before it does anything. An email has no member. The comment on `TenantContext` recommends that "a background job that genuinely has no user runs as its own service member". ADR 0031 §3 rejected that.
3. **The address can be guessed.** The tenant comes from `u-<slug>@…` or `u+<slug>@…`, or from Postmark's top-level `MailboxHash`, which overrides the address outright. The domain is never checked, because `INBOUND_DOMAIN` is read by nothing, so `u-acme@attacker.example` resolves to `acme`. And `organizations.slug` is a human-readable name.
4. **The verdict reads a header Postmark does not send, and the headers Postmark does send are not reliable either.** `authenticated` is `dkim === 'pass' || dmarc === 'pass'`, read only from the first `Authentication-Results` header. Postmark's documentation shows no such header on inbound mail. It adds `Received-SPF` plus SpamAssassin 3.4.0's `X-Spam-Status`, `X-Spam-Score` and `X-Spam-Tests`, says "SpamAssassin does not directly evaluate DMARC", and passes the sender's own headers through.
   - With `RECOUPLE_INBOUND_AUTHSERV_ID` unset, a sender-written `Authentication-Results: x; dkim=pass` authenticates the email. The variable is unset by default because it appears in no env file or deploy doc, and `email.test.ts:191` asserts this behaviour.
   - With the variable set, there is no Postmark authserv-id to pin it to, so every genuine email reads `unknown`.
   - A DKIM pass for any domain counts. Nothing compares the signing domain with `From`.
   - Postmark also documents that "there may be instances where our system is unable to run those SpamAssassin scans … In those cases, the SpamAssassin headers will not be present or may be incomplete." On such a message, a sender-written `X-Spam-Tests` is the only copy. So Postmark's headers cannot decide on their own whether an email is authenticated.
5. **The step reads inside the call.** `ingestInboundEmail` calls `processUpload` for each attachment, so OCR, classification and extraction all run in the caller's request without `withDocumentRead`. That lock is taken only by `readDocumentJob` and `openHeldDocument`, and the inline upload path lacks it too. Postmark waits two minutes for an answer and then retries, so a slow email would be read twice, concurrently. The queued alternative cannot carry the verdict: `UploadRunner.run` takes no `allowCaseOpen`, the event `InngestRunner.run` builds leaves it out, and the job reads an absent value as yes. An unauthenticated email sent through today's runners would open cases.
6. **Errors are swallowed.** Every failure for an attachment or the body becomes a `skipped` entry carrying `error.message`. That includes a database fault, `ClassificationFloorError` and `DuplicateCaseError`. A route that answered 200 on a normal return would stop Postmark retrying a transient failure. And `DuplicateCaseError`'s message quotes a claim id off the page.
7. **Nothing about the email is kept.** `uploads` holds the id, org, source, received_at and created_by. The `MessageID`, the sender, the verdicts and the skip reasons are parsed and dropped. So an email that produced nothing leaves no trace, which is the silence ADR 0016 called the bug. A Postmark retry is guarded only by byte dedupe. And "Read again" cannot tell whether an email authenticated. It falls back to the conservative answer, except for a document that was never read: there, `latestExtraction === undefined` grants `allowCaseOpen` whatever the document's source.
8. **The platform caps the request body below the mail size.** Vercel answers a request body over 4.5 MB with 413 `FUNCTION_PAYLOAD_TOO_LARGE`, before any of our code runs. Postmark accepts 35 MB of attachments and sends them base64-encoded inside the JSON. Postmark also keeps no copy we can fetch: "Attachments are not retrievable via the Postmark UI, API, or webhooks". An email carrying more than about 3.3 MB of attachments would be retried, marked Inbound Error, and never reach us.
9. **Postmark signs nothing.** "Postmark does not currently support HMAC webhook signature verification." It offers HTTP Basic credentials embedded in the webhook URL, and a list of four source IPs whose "origin IP address can change for each attempt". The name `POSTMARK_INBOUND_SECRET` suggests a signing secret, and none exists. `isCrossSite` is no defence either. A server-to-server POST sends no `Sec-Fetch-Site` and passes it. `lib/request.ts` says a session is what stops such callers, and a webhook has none.
10. **A retry after a scanner failure never scans again.** `ingestDocument` writes the `uploads` and `documents` rows, then scans, then records the verdict. Every scanner returns `{status: 'error'}` rather than throwing, so a scanner outage is recorded as an `error` verdict. When the same bytes arrive again, the dedupe branch returns the recorded verdict (`steps.ts:195-208`) and does not call the scanner. Under today's code, a retry cannot recover from a scanner outage, whatever the door. Such a document is also invisible: `unreadDocuments` lists only documents whose latest scan is `clean`.

## Decision

**Postmark delivers to `POST /api/inbound/postmark`, on production only, and proves itself with one Basic credential that reaches every tenant. The local part of the envelope recipient is a random token the database issued to one tenant. A definer function that refuses any claim turns that token into the tenant and the owner the address acts as. The request stores and scans; a job reads. No email opens a case by itself. A notice or remittance an email carries is held for a person (ADR 0044), with the sender's claimed domain and Postmark's DKIM report shown beside it as information, not as a gate. Each email is recorded once, complete, through one definer door, with every part and what became of it. The route answers 200 only after that record is durable and the read is queued. No mail is sent to anyone.**

### 1. The door is `POST /api/inbound/postmark`, on production only

It is a route handler in `apps/web` with `dynamic = 'force-dynamic'` and `maxDuration = 60`. Sixty seconds is enough because the request only stores and scans, and Postmark waits 120. The route is excluded from `proxy.ts`'s matcher, next to `api/document`. So a delivery does not wait on `supabase.auth.getUser()` for a session it will never have, and it escapes Next's 10 MB proxy body clone if the app is ever served off Vercel. Any method other than POST gets 405.

The route does not call `isCrossSite`, and a comment says why (Context 9). Like the QuickBooks callback (ADR 0039), it names what replaces that check: §2's credential.

### 2. Postmark proves itself with a Basic credential in the URL, and that credential reaches every tenant

The webhook URL configured in Postmark is `https://postmark:<secret>@app.mozart.financial/api/inbound/postmark`.

- **The secret.** `POSTMARK_INBOUND_SECRET` holds it. It no longer means the signing secret `.env.example` implies, and the file says so. It is generated with `openssl rand -hex 32`. A value shorter than 64 characters is treated as a misconfiguration (§14).
- **The check.** The route decodes `Authorization: Basic` and compares the SHA-256 of the presented `user:password` with the SHA-256 of the expected pair, using `timingSafeEqual`. Hashing first makes the comparison independent of length. Neither existing precedent does that: `lib/qbo-connect.ts` compares lengths before `timingSafeEqual`, and `services/clamav-scan/server.mjs`'s `tokenMatches` returns early on a length mismatch. The check runs before the body is parsed. A missing or wrong credential gets 401 with `WWW-Authenticate: Basic realm="inbound"`, so a client that authenticates only after a challenge is given one. Nothing else happens.
- **Why 401 and not 403.** Postmark's inbound page says a 403 stops retries and anything else is retried. A rotation (new secret on Vercel, redeploy, then the new URL in Postmark) leaves a window in which real mail meets the old credential. A 401 keeps that mail in Postmark's retry schedule: 1, 5, 10, 10, 10, 15, 30, 60, 120 and 360 minutes, about 10 h 21 m in total. There is one secret at a time, and the retry schedule is the overlap. Postmark's webhooks-overview page lists 401 among the codes that are not retried, but it says that page covers outbound webhooks and "Inbound webhooks are handled separately". Whether a 401 is retried on the inbound stream is therefore on the Unverified list and in the founder's steps.

**What the secret reaches, said plainly.** It is one credential for the whole deployment. Anyone who holds it can post any payload for any token they know, set any header they like, and write into that tenant as the member the address acts as. That is why no header can open a case on its own (§7). The Postmark account is part of the trust boundary too: anyone who can open the server's settings can read the webhook URL, and the secret with it. The secret lives in Postmark's settings and in Vercel's Production environment only. It is never on Preview, never in a log line, and never in a URL the app renders. Access to the Postmark account is limited to the founder, with two-factor authentication (What the founder does).

The source IP is not a gate (Options not taken).

### 3. An address is a token the database issued, and the envelope names it

A tenant's address is `<token>@<INBOUND_DOMAIN>`. `INBOUND_DOMAIN` is a subdomain of a domain we control, with its MX record pointing at `inbound.postmarkapp.com`, so Postmark accepts any address on it.

The token is 32 lowercase hexadecimal characters, generated by the database from `gen_random_uuid()`. That function is core Postgres since version 13, so the vanilla Postgres 16 behind `pnpm db:test` runs it. A `BEFORE INSERT` trigger refuses a token the caller supplies and fills in its own, so no person ever chooses an address. `organizations.slug` is no part of any address, and `orgSlugFromAddress` and `normaliseSlug` are removed.

The route reads the tenant from `OriginalRecipient` and nothing else. Postmark documents that field as the "Receiver (RCPT TO) address this webhook is for", the SMTP envelope address Postmark was handed. `To` and `Cc` are headers the sender wrote. A BCC'd address does not appear in `To`. And for an email with several recipients, Postmark does not document which one the top-level `MailboxHash` comes from. So "the tenant comes from the address, never the sender" now means the envelope address.

The parse:

1. Lowercase the address.
2. Split it at the last `@`. A domain other than `INBOUND_DOMAIN` is `not_our_domain`.
3. Drop any `+suffix` from the local part. It is never read.
4. What remains must be exactly 32 hex characters. Anything else on our domain is `not_a_token`.

An empty `OriginalRecipient` is `not_our_domain`. It never falls through to `To`.

**Several recipients.** In the pages read for this ADR, Postmark does not say whether an email to two of our addresses produces one webhook per address or one webhook in total. If there is one per address with the same `MessageID`, a second delivery to the same tenant is answered "already recorded" (§10), and a second tenant gets its own record. If there is only one, the tenant whose address was not `OriginalRecipient` receives nothing. This is on the Unverified list.

The address is not a secret from suppliers. A customer gives it to every supplier contact and payer mailbox that should reach them. It is a write path into the tenant, though, so members who cannot write do not see it (§4). What the token buys is that the address cannot be guessed and can be retired.

### 4. Addresses are append-only: issued once, adopted, retired once, never reissued

There are three tables for addresses. All are append-only on 0004's pattern: no UPDATE or DELETE grant, and `no_update_delete` and `no_truncate` on `app.block_mutations()`. `app_rw` holds SELECT and INSERT, and `app_ro` holds SELECT.

- **`inbound_addresses`** has `id`, `org_id`, `token` (unique across the whole deployment), `created_by uuid not null` and `created_at`. Only an owner may insert, and only as themselves: `org_id = app.current_org_id() and app.member_is_owner() and created_by = app.current_user_id()`. That is 0030's policy for `accounting_connections`.
- **`inbound_address_adoptions`** has `id`, `org_id`, `address_id`, `adopted_by` and `adopted_at`. An owner adopts an address as themselves, with the same policy. The address then acts as its most recent adopter instead of its issuer. This is how an address outlives the owner who issued it without senders having to learn a new one.
- **`inbound_address_retirements`** has `address_id` (unique), `org_id`, `retired_by` and `retired_at`. It is owner-only and as oneself, like issuing.

Adoptions and retirements reach their address by a composite foreign key on `(org_id, address_id)`, ADR 0025 §7's pattern, so neither can name another tenant's address.

An address is live while it has no retirement row, and retiring is final. The token's uniqueness covers retired rows, so a retired token is never issued again, to this tenant or another, and mail still in flight to an old address cannot land in someone else's workspace. To rotate, issue a new address, tell senders, and retire the old one once it goes quiet. A tenant may hold several live addresses at once, which makes that overlap possible.

This is deliberately not the shape of `accounting_connections`, which is mutable because a consent can be re-granted and `enabled` flips back (ADR 0031). An address that has leaked should never come back. And "which address was live, and whom did it act as, when this email arrived" is a question an audit two years out may ask. Facts written once answer it without reconstructing any history.

**Settings → Email** is shown to writers only (owner, approver and analyst). A `read_only` member is shown that the workspace has addresses, but not the addresses themselves, because an address writes into the tenant and `read_only` is the role with no write. For each live address the page shows:

- the member it acts as;
- when it last received mail;
- the size limit a sender needs to know (§12);
- a warning, when that member can no longer write, that it is not accepting mail and an owner should adopt it (§6).

Each retired address shows how many emails reached it after retirement, and the date of the last one (§11). Issue, Adopt and Retire are owner-only POST routes (`/settings/email/issue`, `/adopt`, `/retire`) in the upload route's shape: `isCrossSite`, `requireSession`, the role check, then the store. Retiring an address that received mail in the last 14 days asks for confirmation first. The database refuses a non-owner whatever the app shows.

The page also says that removing a member who knew an address, or lowering their role to `read_only`, should include retiring that address and issuing a new one. A former member keeps whatever they remember.

### 5. The tenant is found by one definer function that refuses any claim

The function is `app.inbound_address_for(p_token text) returns table (address_id uuid, org_id uuid, acting_member uuid, retired boolean)`. It is `plpgsql`, `stable` and `security definer`, with `set search_path = pg_catalog, public, extensions`. Execution is revoked from `public` and granted to `app_rw` only.

- It raises `insufficient_privilege` when `app.current_org_id() is not null or app.current_user_id() is not null`. That is `member_for_link`'s guard, which ADR 0045 also put on `ledger_connections_to_sync()` and `link_auth_user()`.
- For a live token, it returns one row. `acting_member` is the latest adopter, or the issuer if there is none, and `retired` is false.
- For a retired token, it returns one row with `retired` true and `acting_member` set to the retirer (§11).
- For an unknown token, it returns nothing. It lists nothing and does not match patterns.

Its caller in `packages/store-postgres` has `listConnectionsToSync`'s shape: it clears `request.jwt.claims` transaction-locally before its first statement.

**What it exposes, said plainly.** A caller that holds `app_rw`, carries no claims and already knows a token learns that token's org id and a member id. By ADR 0031 §5's reasoning this is no new reach, since `app_rw` may set any claims it likes. Without a token, the caller learns nothing.

**What it does not do** is tell the webhook apart from any other caller without claims. ADR 0034 argued that its lookup was safe partly because the first statement of `resolveSession` was the only claimless caller on a request path. This route is a second one. The guard keeps a tenant's session away from the function. §2's credential authenticates the caller, and the token scopes the answer.

### 6. An email acts as the owner who issued or last adopted its address

For each delivery, after the lookup, the route sets `{org_id, sub: acting_member}` transaction-locally as `app_rw`, and asks `app.member_may_write()` before storing anything.

- When they issued or adopted the address, the member had to be an owner.
- At each delivery they need only be a writer: owner, approver or analyst. That is 0030's rule for `accounting_credentials`, where the member a sync acts as may since have become an analyst.
- If they can no longer write, the delivery is answered 503 and nothing is stored (§11). Postmark keeps the message in its retry schedule for about ten hours. If an owner adopts the address within that time, a later retry lands. After that, Postmark's own retry control can re-drive the message for as long as Postmark retains it.

This is ADR 0031 §3 applied to a second door. The door acts as the person who chose to open it or to keep it open, an act the database recorded under their id. Every row the email writes passes RLS as them. A `document.held` row (ADR 0044) names them as `actor_id`, as 0030's policy requires. `inbound_messages.acted_as` (§9) records who it was.

`uploads.created_by` stays null, and `source` says `email_in` or `email_body`, exactly as today. The acting member did not send the email, and `From:` is forgeable. Those two columns are what separate "filed on X's authority" from "uploaded by X". The page says "by email" rather than giving a name.

The remaining cost, named: an address whose acting member can no longer write accepts nothing until an owner adopts it. The settings page shows this, and each refused delivery is logged with the address id.

### 7. What Postmark says about the sender is recorded and shown, and gates nothing

On the Postmark door, the parser stops reading `Authentication-Results`. `RECOUPLE_INBOUND_AUTHSERV_ID` and the code that reads it are removed. The verdicts are computed from headers matched case-insensitively by name.

- **Unknown unless the scan headers are whole.** The verdict is `unknown` unless the payload carries exactly one each of `X-Spam-Status`, `X-Spam-Score` and `X-Spam-Tests`. Postmark writes one of each. A missing header means the scan was skipped or incomplete, and a second copy means someone else wrote it.
- **`dkim`** comes from the one `X-Spam-Tests` value, which is unfolded, split on commas and whitespace, and matched by exact token:
  - `DKIM_VALID_AU` ("valid DKIM or DK signature from author's domain") is `pass`;
  - `DKIM_VALID` without `_AU` is `fail`, the case of a forger signing with their own domain;
  - `DKIM_SIGNED` with neither is `fail`;
  - no DKIM token at all is `none`.
- **The author must be one address.** The verdict is also `unknown` unless `FromFull.Email` parses as exactly one addr-spec, and neither the legacy `From` string holds a second address nor `Headers` carries a `From` header of its own. SpamAssassin judges "author's domain" against the From header as it parses it. If there were two authors, it could validate one domain while we display the other.
- **`sender_domain`** is the domain of that one addr-spec, lowercased and validated as a hostname. It is never taken from a display name, and it is null when the author is not one address.
- **`dmarc` is always `unknown`.** Postmark reports no DMARC verdict, and we do not infer one.
- **`spf`** comes from `Received-SPF`, whose format Postmark documents and the existing pattern already reads. It is recorded and never counts.

`authenticated = dkim === 'pass'` is recorded with `verdict_source = 'postmark_spamassassin'` (§9), so a later change of source shows on every row.

The verdict decides nothing on its own. By Context 4 and §2, a sender can supply the only `X-Spam-Tests` on a message Postmark did not score, and anyone holding the Basic secret can write any header. So the verdict and the claimed domain are shown to the person deciding, and nothing more:

- An email's `deduction_notice` or `remittance_advice` never opens a case by itself. When a read would otherwise open one, the document is **held** (ADR 0044) with reason `by_email`. The floor is still read, and the confidence, the floor and any `fields` that did not fit are still recorded in the hold's payload, so the reviewer sees those too.
- The rule is keyed on the document's recorded arrival (`uploads.source` in `email_in`, `email_body`), never on a flag. So it applies wherever the document is read: in the job, from "Read again", and from a re-upload of the same bytes, which dedupes to the email arrival. `recordedRead` answers a held document from its hold, so the re-upload neither reads it twice nor opens a case.
- "Read, not on a case" shows the hold line as "by email · from `<domain>` (as the email claims) · aligned DKIM per Postmark: yes / no / unknown". **Open a case from it** works exactly as for any held document: `openHeldDocument` with `confirmed_by` stamped. It works for a remittance as well as a notice.

This amends ADR 0044's "an unauthenticated email is never held": every email notice and remittance is now held, authenticated or not. It is still CLAUDE.md's rule that DKIM or DMARC must pass before an email may open a case, made stricter: until our own verification exists, no email opens a case on its own, and a person decides every time. It also means that an unaligned but genuine sender, such as a Microsoft 365 tenant that still signs with its `onmicrosoft.com` domain, has a working path. Today such a sender's notices would be read and then left stuck.

"Aligned" means the domain in `From:` signed the message. For a manual forward, that is the forwarding supplier's own new message. For a server-side redirect or auto-forward rule (a Gmail forwarding filter or an Outlook redirect), `From:` and the signature are the original payer's, so the verdict is about the payer's domain and says nothing of who routed the message to us.

Letting an email open a case by itself needs our own DKIM and DMARC verification over `RawEmailEnabled`, plus a per-tenant list of accepted sender domains. Both are follow-ups, and together they need their own ADR.

### 8. The request stores and scans; a job reads

**The request half** is `receiveInboundEmail` in `packages/pipeline`. It walks the parts in the order Postmark lists them.

- **An attachment** goes through `ingestForJob`, the same `ingestDocument` an upload's request half runs. That writes one `uploads` row with `source: 'email_in'` and no `created_by`, then the document, the magic-byte gate and the scan.
- **A small image the HTML body shows inline** is not stored: an image under 50 KB whose `ContentID` is referenced as `cid:` in `HtmlBody`. Those are signature logos. `HtmlBody` is searched for `cid:` references and nothing else. An image with a `ContentID` that is larger, or not referenced, is stored like any attachment. Apple Mail and Outlook give an ordinary attached photo a Content-ID, and a notice photographed on a phone is the `customer` suite's shape. A skipped image is recorded as `inline_image`.
- **Beyond ten parts** that would be stored, the rest are recorded as `too_many_parts`.
- **Past the tenant's daily read budget** (below), a part is stored and scanned, recorded `over_daily_budget`, and not read by the job.
- **`Content` that is not strict base64** is recorded as `not_base64`. It is never handed to `Buffer.from`, which drops characters it does not understand.
- **The body** is `TextBody`, then `StrippedTextReply`, as today. It goes through `acceptEmailBody` and, if accepted, is stored with `source: 'email_body'`.

**ADR 0016 is amended in what it says, not only in where it runs.** Today a body is not stored at all once an attachment was found to be the notice. Under this design, every accepted body is stored, with its own `uploads` row and a scan, before any attachment has been classified. Only its read depends on the attachments. That costs a stored document and an arrival row per cover note, and identical cover notes dedupe across emails. "Documents waiting to be read" (`unreadDocuments`) stops listing a body whose message carried an attachment read as a notice. That filter is derived from the rows, not recorded, so a "please see attached" is not presented as a stalled read.

**The daily read budget** is `INBOUND_READS_PER_DAY = 100` per tenant, a constant in `core-domain`. It counts the parts recorded as `stored` or `already_held` on that tenant's messages over the trailing 24 hours, and the request checks it under the message claim (§10). It bounds what anyone holding an address can make a tenant spend. A part over the budget waits under "Documents waiting to be read", where "Read again" reads it because a person asked. It is not a tenant setting, so no tenant can loosen it. Raising it is a loosening and needs its own ADR. Invariant 7's database guard does not cover a code constant, and that is said here rather than assumed.

**The job half** is `readInboundEmailJob`. One event per email starts it, carrying `{orgId, userId, inboundMessageId, readKey}`: ids only, with the acting member as `userId` and the message's id as `readKey`. The job:

1. asks `memberMayWrite` first, as `readDocumentJob` does;
2. reads the message and its parts through RLS;
3. reads, in order, **every part that has a `document_id`**, whether `stored` or `already_held`, but not `over_daily_budget`. Each read is its own step, through `readDocumentJob`'s path, under `withDocumentRead`, and is answered from the record when the document was already read. A part recorded `already_held` may be this same email's own document, stored by an attempt that died before the message row was written. Reading it here means the retry does not strand it.
4. reads the body only if no attachment is a `deduction_notice`, counting a read answered from the record. The build makes such an answer carry its recorded type, and tests it. This also closes a hole in today's rule: a deduplicated or unscanned attachment returned no classification, so the body was read even when the notice was already held.

A read the job makes follows §7: an email-borne notice or remittance is held, never opened.

Email is served only where reads are queued (§14). The inline runner would run OCR and extraction inside Postmark's two-minute wait, and ADR 0021 puts one dense remittance at about 63 seconds of model time alone. `ingestInboundEmail` is removed rather than kept as a second path, and its tests move to the two halves. `findOrgBySlug` leaves the store port along with its only caller, as does the in-memory version that could see every tenant.

### 9. The email is recorded once, complete, through one door

There are two more tables on the append-only pattern. `app_rw` and `app_ro` hold SELECT only. Every row goes through `app.record_inbound_message(p_message jsonb, p_parts jsonb) returns uuid`: `plpgsql`, `security definer`, pinned, and executable by `app_rw` alone. This is `app.record_ledger_sync_run()`'s pattern (ADR 0031), bounded by its caller.

Before it writes, the function checks:

- the caller carries an org claim and a `sub`, and `app.member_may_write()` holds;
- the address is the caller's org's;
- the caller is the address's current acting member for a `received` or `not_received` row, or its retirer for a `refused_retired` row;
- the address is live for a `received` row;
- every part's document is in the caller's org, enforced by a composite foreign key on `(org_id, document_id)`;
- a part recorded `stored` names a document whose arrival is `email_in`, or `email_body` for a body part;
- the verdicts, outcomes and part codes come from closed lists, enforced by check constraints;
- `acted_as` is the caller.

A writer cannot insert a message row directly, so no one can fabricate a record of what an email said about itself.

**`inbound_messages`**, unique on `(org_id, provider, provider_message_id, outcome)`:

| Column | What it holds |
| --- | --- |
| `id`, `org_id` | Identity and tenant. |
| `address_id` | The address it arrived on, by composite foreign key. |
| `provider`, `provider_message_id` | `'postmark'`, and Postmark's `MessageID`. That is Postmark's own UUID, not the `Message-ID` header. |
| `outcome` | `received`, `not_received` (§12) or `refused_retired` (§11). |
| `received_at` | Our clock, when we wrote the row. |
| `provider_received_at` | When Postmark received it, from its search result on a `not_received` row. Null otherwise. The `Date` header is the sender's and is never stored. |
| `acted_as` | The member the row was written as. |
| `authenticated`, `dkim`, `dmarc`, `spf`, `verdict_source` | §7's verdicts. A check makes them null on a row that is not `received`. |
| `sender_domain` | §7's claimed domain. It is shown as a claim and used for nothing else. |

**`inbound_message_parts`**:

| Column | What it holds |
| --- | --- |
| `org_id`, `inbound_message_id` | Its message, by composite foreign key. |
| `ordinal`, `kind` | Position in the email, and `attachment`, `inline` or `body`. |
| `filename` | As the sender named it. Rendered escaped, never logged. |
| `outcome` | `stored`; `already_held` (bytes this tenant already had); `over_daily_budget`; `not_clean`; `inline_image`; `too_many_parts`; `not_base64`; or one of `RejectedUploadError`'s codes, `body_too_short` among them. |
| `document_id` | Present, by check, exactly when a document exists. |

Both tables are written in one call, after every stored part is durable and before the event is sent. That is ADR 0023's shape: written once, and complete. A request that dies before that point leaves no message row, and Postmark's retry redoes it (§10).

This closes three things.

- **An email that produced nothing is on a page with the reason** (§11's surface).
- **"Read again" gives an emailed document no way to open a case.** Under §7 the answer is keyed on the document's arrival: a read of an `email_in` or `email_body` document that finds a notice or remittance holds it for a person, whatever `allowCaseOpen` the reread route computes. That closes the never-read hole in Context 7 without depending on the verdict. The verdict is persisted, which closes ADR 0021's named follow-up, but the reread route does not need it. Documents with other sources keep today's rule.
- **ADR 0024's arrival rule matches the code.** ADR 0024 says "one inbound email with three attachments is one arrival and three documents". It is restated: each stored document is its own arrival, with its own `uploads` row, and the message is what groups them. A document the tenant already held keeps its first arrival, as ADR 0024 requires, and appears on the message as `already_held`. Coverage counts a case by its notice's `uploads.source`, so no number it reports moves.

### 10. A retry is answered by the message id, the bytes, and a second scan

**The claim.** After §6's check, the request takes the message's claim, `pg_try_advisory_xact_lock(hashtextextended(org_id::text || ':' || provider_message_id, 3))`, as `app_rw` with the acting member's claims. The seed is 3, next to `withDocumentRead`'s 0, the remittance lock's 1 and the refresh lock's 2. The claim is taken on **its own pool**: two connections per process, and a one-second `connectionTimeoutMillis`. That pool is not the shared lock pool. The shared pool holds four connections per process and is the one `withDocumentRead`, `withInvoiceClaim` and `withRefreshLock` wait on for up to 30 seconds. A burst of emails to one tenant's address would otherwise hold those connections for the length of a scan, and stall reads and QuickBooks refreshes for every tenant on the instance. A delivery that cannot get a connection, or does not get the claim, answers 503 and spends nothing, and Postmark comes back later.

**Under the claim,** the request checks for an existing `received` row for this message.

- **If there is one**, the email is already recorded. The route sends the event again and answers 200. If the first send landed, the runtime's idempotency window on `readKey` swallows the second, and `recordedRead` answers any read that already happened. Postmark's last retry arrives about 10 h 21 m after the first delivery, inside Inngest's 24-hour window.
- **If there is none**, the parts are ingested. Bytes this tenant already stored dedupe on `(org_id, sha256)` with no second `uploads` row, as today, and are recorded `already_held` and read by the job (§8).

**A document stored without a verdict is scanned again, on every door.** This decision changes `ingestDocument`'s dedupe branch. When the latest verdict for the existing document is absent or `error`, the branch calls the scanner and appends a new `document_scans` row. That table is append-only and read latest-first, so this is an INSERT and nothing is mutated. A `clean` or `infected` verdict is final and is never re-scanned. Without this change, a scanner outage followed by any retry halts the document for good (Context 10). The change fixes the same hole for a web upload tried again after an outage. The scan gate is unchanged: no verdict means no read.

A read that stalls after its event has landed (the 2026-09-21 failure) is recovered one document at a time: the documents appear under "Documents waiting to be read", and "Read again" re-drives each one with a fresh key.

### 11. What the route answers, and what a person sees

Postmark treats 200 as done, stops on 403, and retries anything else. The route answers 403 only where no retry and no deploy can change the outcome, and 5xx where a retry or a fix can.

| Outcome | Answer | Postmark |
| --- | --- | --- |
| No binding in this environment (§14) | 503 | retries |
| Half-configured, no queue, or no scanner (§14) | 503, logged | retries |
| Missing or wrong credential | 401 + `WWW-Authenticate` | retries (§2, unverified) |
| Not JSON, no `MessageID`, or a shape the schema refuses | 503, logged as an error | retries while a deploy fixes our schema |
| `OriginalRecipient` not on `INBOUND_DOMAIN` (`not_our_domain`) | 503, logged as an error | retries while the configuration is fixed |
| On our domain but not a token, or an unknown token | 403, logged | stops |
| Retired token | 403; a `refused_retired` row written as the retirer if they may write, otherwise a log line with the address id | stops |
| Acting member may not write | 503, logged with the address id | retries (§6) |
| Claim pool full, or another delivery holds this message's claim | 503 | retries |
| Scanner gave no verdict, or the database, blob store or event send failed | 503, logged | retries, and the dedupe re-scans (§10) |
| Already recorded | 200 (event sent again) | done |
| Recorded and event sent, including an email whose every part was refused | 200 | done |

Every request that reaches the body check carried our credential, so it came from our own Postmark server. A wrong domain or a payload our schema refuses is therefore a misconfiguration, and answering 403 would drop mail permanently. Postmark's "Check" button posts a sample whose recipient is on `inbound.postmarkapp.com`, so it is expected to fail with 503 and a `not_our_domain` log line.

When the front door refuses one part, that refusal is permanent and recorded on the message, and it does not fail the email. A part the scanner answered `infected` is stored the way ingest stores it, never read, and recorded `not_clean`. Every other error propagates to a 503 and is logged by class name. Nothing is caught into a string. The response body is a fixed word, never an error message.

**Where a person looks.** The case list gains **Email that filed nothing**, next to "Read, not on a case". It lists, over the last 30 days:

- `received` messages that produced no document read into a document, with each part's outcome;
- `not_received` messages (§12);
- `refused_retired` messages.

It shows the 20 most recent per address and a count beyond that. Each row shows the date (Postmark's own date on a `not_received` row), the address, and the sender domain labelled "as the email claims, unverified". Rows are worded as facts, not instructions: "an email to this address on `<date>` did not reach us" rather than "go and get it from `<domain>`". A stranger controls these rows, and the page must not turn one into a lure. Settings → Email shows the same per address.

What this guarantees, narrowed to what is true: an email that reached a live address whose acting member may write is on the record with its outcome. An email to an unknown token, or one refused because the acting member cannot write and nobody adopted the address before Postmark gave up, is only a log line.

### 12. What is over the cap fails loudly, where someone looks

The cap is Vercel's 4.5 MB request body. Once base64 and the rest of the JSON are counted, that leaves about 3.3 MB of attachments, and less when the message's own bodies are large. The route never sees a request over it. Postmark retries the 413, marks the message Inbound Error, and keeps no attachment bytes we can fetch. The email is lost to us whatever we do. We can refuse to lose it silently.

- **Before a sender tries**, Settings → Email shows the limit next to each address: "attachments up to about 3 MB in total; larger files by upload".
- **After Postmark gives up**, `pnpm sweep:inbound`, an operator command, lists inbound messages over a trailing six days using Postmark's documented search (`GET /messages/inbound?status=failed`, which returns `OriginalRecipient` and `ReceivedAt`). Six days sits inside the seven-day retention the founder sets.
  - For each failed message whose recipient resolves, through §3's parse and §5's function, to a live address, it writes a `not_received` row through §9's door, as that address's acting member, after `member_may_write`. `provider_received_at` is Postmark's date. The unique key makes a repeat sweep free.
  - A message that resolves to no live address becomes one line of output.
  - It also prints how many messages are `queued` or `scheduled` and older than two hours. `queued` covers paused webhooks, for example after a failed payment, and a long `scheduled` backlog means a retry storm. This is the only cross-tenant health signal until a log drain exists.

The sweep only reads Postmark. It does not call the retry or bypass endpoints, and it sends no mail.

**The server token stays out of the web app.** Postmark's server token authenticates Get server, whose response includes `InboundHookUrl` and so §2's secret. It also authenticates Edit server, which can repoint `InboundHookUrl`, and it reads every tenant's inbound message details. A leaked token takes over the whole door. So `POSTMARK_SERVER_TOKEN` lives only in the operator's `.env`, like `link:qbo`'s inputs. It is never on Vercel. The sweep connects as the app the ADR 0034 way, with no service role.

The cost: the sweep runs when the founder runs it. The founder runs it daily until a scheduled host that can hold the token exists, which is a named follow-up. A message that failed for another reason, such as a stretch of 503s, is swept the same way. If someone re-drives it from Postmark and it arrives, the `received` row stands beside the `not_received` one, and the page shows the received one.

### 13. Logs carry ids, never mail

A log line from the route, the job or the sweep may carry:

- Postmark's `MessageID`;
- our message, address, org and document ids;
- the outcome key and the part codes;
- an error's class name.

It never carries the recipient address or its token; `From`, `Subject`, a filename, a header value or a body; the `Authorization` header; or an error's message. `DuplicateCaseError`'s message quotes a claim id off the page. The event carries ids only. The route and store tests spy on the logger, the response, the event and the stored rows, the way ADR 0039's tests do, and fail if any forbidden string appears.

### 14. The environment decides in one place, and production only

`inboundEmailFromEnv()` in `apps/web/lib` has `runnerFromEnv`'s shape and follows `inngestKeysFromEnv`'s convention:

- `POSTMARK_INBOUND_SECRET` and `INBOUND_DOMAIN` together give a binding.
- Neither gives none: 503, not logged as an error, like `/api/inngest` with no binding.
- One without the other is an error: logged, and answered 503.
- A binding also requires a queued runner, a scanner that is not `NullScanner`, and a secret of at least 64 characters. Missing any of these is the same error.

The binding is built lazily, so a misconfiguration fails this route and not the whole app. A change to either variable takes effect on the next production deployment.

Both variables are Production only. Preview holds neither, so a preview answers 503, and Postmark's single webhook URL can only reach production. A preview holding production's inbound credential would repeat the 2026-09-23 Inngest incident, with email in it. A rehearsal on a preview would need its own Postmark server, its own inbound domain (inbound domains are unique across Postmark) and its own secret. Nothing records whether Vercel's Deployment Protection would block it. It is not part of this rollout.

Documentation changes that ship with the build:

- `.env.example`: drops `INBOUND_DOMAIN=in.recouple.app`, which is not a domain the app is served from; says what each variable now means; and moves `POSTMARK_SERVER_TOKEN` to the operator section.
- `apps/web/DEPLOY.md` and `docs/supabase.md`'s per-environment table: rows for the two variables, Production only.
- `docs/VERIFY-CHECKLIST.md` §5: rewritten around issued addresses, holds and the checks below.
- The demo script, per the definition of done.
- CLAUDE.md's `ingest` row: an email never opens a case by itself.

### 15. The migration, its suite and the tests

The five tables, the token trigger, `app.inbound_address_for()` and `app.record_inbound_message()` make up the next free migration. That is 0034 today, but the number is taken at build time after `git fetch`, against `origin/main` and open PRs. This ADR's own number and the suite's number are checked the same way before this merges. The migration is idempotent, because `pnpm db:test` applies every migration twice.

It goes to `mozart-preview` first, then to production on the founder's go, and is read back on each:

- the stored statement's md5 equals the file's;
- RLS is on for all five tables, with `no_update_delete` and `no_truncate`;
- `app_rw` holds SELECT and INSERT on the three address tables and SELECT only on the two message tables, and `app_ro` holds SELECT;
- both functions are definer, pinned, `plpgsql`, and executable by `app_rw` and their owner alone;
- the request roles hold nothing;
- a caller with only `sub`, and a caller with only `org_id`, are both refused by the lookup, in a block that writes nothing.

What proves it:

- **`supabase/tests/30_…sql`** (the next free suite).
  - **Tables**, on suite 26's model: an owner issues and adopts as themselves, while an analyst, an approver and a `read_only` member are refused. A supplied token is refused, and the generated token has the right shape. Tokens are unique across retired rows. A retirement is owner-only, happens once, and cannot name another tenant's address.
  - **Append-only**: every one of the five tables refuses UPDATE, DELETE and TRUNCATE, checked table by table in this suite. Suite 24 enumerates only tables that already carry `block_mutations`, and suite 01 hard-codes its own four tables, so neither would notice a missing trigger here.
  - **The record door**: an analyst's direct INSERT into either message table is refused. The door refuses a caller who is not the address's acting member, a retired address for `received`, another tenant's document, a `stored` part whose document arrived by `web_upload`, and a verdict outside the closed list.
  - **The lookup**, on suites 29 and 22: the catalogue shape; refusal of a caller with only `sub`, with only `org_id`, or with a full member's claims; a live token resolves to its latest adopter; a retired token returns its retirer with `retired` true; an unknown token returns nothing; one tenant's token never answers with another tenant's org.
  - Suites 15 and 24 cover RLS, pinning and grants by enumeration.
- **`apps/web/test/inbound-route.test.tsx`**:
  - every row of §11's table, including the `WWW-Authenticate` header and 503 for `not_our_domain` and for a schema refusal;
  - 200 only after the message row, its parts and the event;
  - a first attempt killed after `putDocument` and before the scan, then a retry that succeeds, leaving one message row, one `uploads` row per document, and every document read;
  - a scanner outage, then a retry that re-scans;
  - an event send that fails, then a retry;
  - the claim pool full, answered 503 at once;
  - an email notice held with reason `by_email` and opened by a person;
  - the logger, response, event and rows spied for every string §13 forbids.
- **`apps/web/test/fail-closed.test.tsx`**: no variables gives no binding; half a configuration is an error; a binding is refused without a queue, with `NullScanner`, or with a short secret.
- **`packages/ingest/test/email.test.ts`**:
  - `DKIM_VALID_AU` passes; `DKIM_VALID` alone does not;
  - a missing, doubled, mixed-case or folded `X-Spam-*` header, and a lookalike token, each read `unknown` or `fail` as §7 says;
  - two authors or a display-name domain read `unknown`;
  - the forged `Authentication-Results` that passes today (`:191`) authenticates nothing;
  - the tenant comes from `OriginalRecipient` alone, a `+suffix` is ignored, and the wrong domain is refused;
  - an iPhone-shaped payload, a 2 MB photo with a Content-ID and no `cid:` reference, is stored, while a referenced logo is not.
- **Recorded payloads.** After founder steps 6 to 9, the real Postmark payloads (redacted) and a real search response are committed as fixtures, and the parser and sweep tests assert against them. Hand-written payloads are how the current design shipped against a header Postmark never sends.
- **`packages/pipeline/test/inbound-email.test.ts`**:
  - the job asks `memberMayWrite` first;
  - it reads `already_held` parts and skips `over_daily_budget`;
  - it reads the body only when no attachment is a notice, counting a recorded read;
  - an email notice and an email remittance are both held, never opened, including through "Read again" and a re-upload of the same bytes.
- **`packages/store-postgres/test/inbound-*.test.ts`**, against Postgres, which no email test has used until now: the claimless lookup, the acting member's writes under RLS, the record door, the dedicated claim pool, the dedupe re-scan, and the sweep's `not_received` rows.
- **`apps/web/test/reread-route.test.tsx`**: a never-read email document is held, never opened.

## Options not taken

- **Keep `u-<slug>@` addresses.** Anyone who knows or guesses a slug can file into that tenant and spend its reads.
- **Let aligned DKIM, as Postmark reports it, open a case by itself.** On a message Postmark did not scan, the sender's own `X-Spam-Tests` is the only copy (Context 4), and anyone holding §2's secret can write any header. A planted case writes append-only identifiers that later real arrivals merge into (§ Consequences).
- **Turn on `RawEmailEnabled` and verify DKIM and DMARC ourselves now.** It is the right way to let email open cases, and with accepted sender domains it is the follow-up. It roughly doubles the payload against a 4.5 MB cap and adds DNS lookups and a dependency, and holding every email notice gives the same safety today at the cost of one click.
- **Use Postmark's default address with a `MailboxHash`.** Every customer's saved address would be tied to our Postmark server's hash, and Postmark does not document which recipient the top-level hash comes from.
- **Take the tenant from `To` or `MailboxHash`.** Both come from the sender. The envelope is what reached us.
- **Give addresses a mutable `enabled` flag.** A leaked address could be switched back on, and the history of which address was live, acting as whom, would go with the flag.
- **Act as a synthetic service member, the service role, nobody, or whichever owner the database finds at delivery.** ADR 0031 §3 rules out the first, invariant 6 the second, and 0010's and 0030's policies the third. The fourth names a person who chose nothing. Adoption is the explicit form of the fourth.
- **Let writers insert message rows directly.** Any analyst could then fabricate an email's record.
- **Keep `ingestInboundEmail` reading in the request.** It runs into Postmark's two minutes, lacks the read lock, and leaves a verdict no queued read can carry (Context 5).
- **Keep reading `Authentication-Results`, pinned.** There is no Postmark authserv-id to pin to, and unpinned it can be forged.
- **Gate on Postmark's four IPs.** The list was last updated on 2025-03-17, and Postmark says the IP "can change for each attempt".
- **Run a receiver for large mail off Vercel**, or the sweep on a scheduled host. Either puts credentials in a second place. The size of the problem should be measured first.
- **Answer 403 to a wrong credential, a misconfigured domain or a schema refusal, or 200 to everything.** The first set drops mail permanently on a mistake of ours. The last stops retries on a transient failure.
- **Reply to the sender**, whether with an acknowledgment or a "too large" notice. A reply is a new outbound side effect, and a reply to a forgeable `From:` is mail to whoever was forged.

## Consequences

**What this makes true.**

- A supplier can email a notice or a remittance to their workspace, and a person opens the case from it in one click, with what Postmark said about the sender beside it.
- The document, its channel and the email that carried it are on the record.
- An email that produced nothing says why, on the case list.
- A retry costs nothing and recovers from a scanner outage.
- "Read again" cannot open a case from an email.
- The case list's promise of an inbound address becomes true.

**What it costs.**

- Five tables, two definer functions, a route, a job, an operator sweep, a settings page, a claim pool, and a third-party credential in production.
- Every email notice waits for a click, including one from a well-behaved, authenticated supplier.
- A stored document and an arrival row per cover note.
- An address stops accepting mail when its acting member can no longer write, until an owner adopts it.
- Mail with more than about 3.3 MB of attachments cannot be received on this platform, and we can only say so.
- Detecting that loss depends on the founder running the sweep.

**What remains exposed, said out loud.**

- **Spend.** Anyone who has an address can make its tenant pay for reads, up to `INBOUND_READS_PER_DAY` a day. The address is shared by design. There is no rate limit per address below that budget.
- **Identifier squatting.** Anyone with the address can put a crafted notice in front of a person. If that person opens it, the case writes append-only `deduction_identifiers`. A later real remittance line whose claim id matches exactly is merged into that case, and a later real notice for the same claim against the same debtor raises `DuplicateCaseError`. Declining or merging the planted case removes neither identifier row. Planted cases also count in the email channel's coverage, and a large planted amount rises in the review queue. The hold line's claimed domain and DKIM report are what the person has to go on. A per-tenant list of accepted sender domains is the follow-up that narrows this.
- **The secret.** Anyone holding §2's secret, or the Postmark account, can file into any tenant whose token they know, and can make the displayed verdict say anything.
- **Retired addresses.** A stranger mailing a retired address writes one small `refused_retired` row per message.
- **The scoring gap.** Postmark skips scoring on some messages. It stays open until our own verification lands or Postmark confirms in writing that it strips sender-written `X-Spam-*` headers. It matters only for what the hold line displays, because nothing opens on it.
- **Retention.** Postmark keeps inbound content for 45 days by default, and never less than 7 even with its Retention Add-on. That includes attachment bytes, which its Raw Source view shows. Content cannot be deleted immediately, and Postmark's own pages disagree on how long a blocked message is kept. Telling customers so is a follow-up.

**Unverified. Each is checked on a real message before any customer is given an address.**

- That Postmark sends the URL's credentials without waiting for a challenge, and that a 401 is retried on the inbound stream.
- What status a message we answered 403 is left in, and whether Postmark's retry control can re-drive it.
- Whether an email to two of our addresses produces one webhook per address, and whether they share a `MessageID` (§3).
- That, with spam blocking off, Postmark still writes one each of `X-Spam-Status`, `X-Spam-Score` and `X-Spam-Tests`, and that `X-Spam-Tests` carries `DKIM_VALID_AU` for a message from Gmail.
- What Postmark does with a sender-written `X-Spam-Tests` or `Authentication-Results`.
- How Postmark represents a message with two `From` headers or a `From` with two addresses.
- That `OriginalRecipient` carries the envelope address in the plain form §3 parses.
- Whether Vercel's logs show the 413 on this route.
- That the inbound search's `fromdate` and `todate` select by when Postmark received a message, not by the sender's `Date` (added in the build, below).

**Follow-ups, named rather than slipped in.**

- Our own DKIM and DMARC verification over `RawEmailEnabled`, plus a per-tenant list of accepted sender domains. Together, and only together, these are what could let an email open a case by itself, under their own ADR.
- A scheduled host for the sweep that can hold the Postmark token.
- A log drain with alerts for 401 and 503 rates and the sweep's counts.
- `HtmlBody` as content, for HTML-only mail.
- A rate limit per address.
- A receiver that can take large mail.
- CSV, XLSX and forwarded `.eml` attachments, which are `type_not_allowed` today.
- The upload route's `UPLOAD_MAX_MB = 25`, whose refusal Vercel's cap makes unreachable for bodies between 4.5 and 25 MB.
- The comment on `TenantContext` that recommends a service member.
- `docs/STRATEGY.md`'s statement that `uploads.source` admits two values; it admits six.
- Telling customers about Postmark's retention.

## Invariants touched

- **1 (the approval gate)**: untouched. An email reaches a held document at most, and a person opens any case.
- **2 (append-only)**: extended. Five new append-only tables, each named in the migration and read back table by table in suite 30. No UPDATE or DELETE grant is added, and `uploads` is unchanged. The dedupe re-scan is an INSERT into `document_scans`. A wrong address is retired, not edited. A message record is never corrected, because it records what arrived.
- **3 (money is integer cents)**: untouched.
- **4 (document content is untrusted)**: held, and applied to headers. The reader is unchanged and gets no tools. Deterministic code reads headers as exact tokens, and no model reads them. What a header says is shown to a person and decides nothing. No email text reaches a log, an event or a response. The only outbound call added is the operator sweep's read of Postmark's message metadata.
- **5 (behind `DecisionProvider`)**: untouched.
- **6 (RLS everywhere; no service role in a request path)**: held. The route, the job and the sweep run as `app_rw` under the acting member's claims. The one claimless statement is a pinned definer function that refuses claims, and every message row goes through a definer door bounded by its caller.
- **7 (thresholds)**: exercised, not moved. The classification floor is read and recorded on every email hold. `INBOUND_READS_PER_DAY` is a new ceiling in code, not a tenant threshold, and raising it needs its own ADR.

## Rollback

Any change is a new migration, never an edit to the one this adds. To take email-in out:

- unset `POSTMARK_INBOUND_SECRET` and `INBOUND_DOMAIN` on Production and redeploy, so the route answers 503 and Postmark retries and then marks mail Inbound Error;
- retire every address.

Messages, parts, addresses, adoptions and retirements are append-only history of what arrived and who opened the door, and they stay. So do the documents and cases that email brought. Letting an email open a case without a person, or reverting §7 to reading `Authentication-Results`, would be a loosening and needs its own ADR. Reverting the dedupe re-scan would strand documents again after a scanner outage, and needs one as well.

## What the founder does

1. **Choose the inbound domain.** Pick a subdomain of a domain we control and use for nothing else, for example `in.mozart.financial`. Add an **MX record pointing to `inbound.postmarkapp.com`, priority 10**.
2. **Set up Postmark.**
   - Create a production server and point its **inbound stream at the inbound domain**.
   - Set the **webhook URL to `https://postmark:<secret>@app.mozart.financial/api/inbound/postmark`**, with the secret from `openssl rand -hex 32`. The **Check** button is expected to fail with 503, because its sample is not addressed to our domain.
   - Leave spam blocking off. A blocked real notice would be silent to us, and `INBOUND_READS_PER_DAY` bounds the spend instead.
   - Set **retention to the minimum** the Retention Add-on allows, 7 days.
   - Make sure only you have access to the Postmark account, with two-factor authentication on.
3. **Set the variables on Vercel → Production only**: `POSTMARK_INBOUND_SECRET` and `INBOUND_DOMAIN`. Never set them on Preview. Redeploy production. Keep `POSTMARK_SERVER_TOKEN` in your own operator `.env` only.
4. **Apply the migration** to `mozart-preview` and read it back, then to production on your go and read it back (§15).
5. **Issue an address** in Settings → Email, as an owner.
6. **Send a test from Gmail.** First check that the tenant has never stored `hl-case-03-notice.pdf`: its sha256 must match no row in `documents`, or use a fixture the tenant has never seen. Email the file to the address. Within a couple of minutes you should see:
   - under "Read, not on a case", the notice held **by email**, from `gmail.com` with aligned DKIM "yes";
   - after **Open a case from it**, case **DN-2609-003** for $2,000.00;
   - an `uploads` row with source `email_in` and no `created_by`;
   - an `inbound_messages` row with `authenticated` true, `dkim` `pass` and `verdict_source` `postmark_spamassassin`.

   Then, in Postmark's activity for that message, confirm that there was one of each `X-Spam-*` header, that `X-Spam-Tests` carried `DKIM_VALID_AU`, and that there was no 401 before the 200.
7. **Run the forged-header checks.** From a mailbox that does not sign for its `From:` domain (a scripted send is fine), send a message with hand-written `X-Spam-Tests: DKIM_VALID_AU` and `Authentication-Results: x; dkim=pass` headers. Send it once small and once with a 1–3 MB attachment. Each must be recorded with `authenticated` false or `unknown`, and held. Note what Postmark did with the forged headers. That decides what the hold line may be trusted to say, not whether a case opens.
8. **Send from an unaligned sender**, such as a Microsoft 365 domain without custom DKIM, or an auto-forwarding rule. It should be held with aligned DKIM "no" or "unknown", and **Open a case from it** should work.
9. **Send a photo from an iPhone**, attached normally. It must be stored and read, not recorded as `inline_image`.
10. **Test the failure paths.**
    - Send an email with about 5 MB of attachments. The next day, run `pnpm sweep:inbound` and confirm it appears as `not_received` under "Email that filed nothing", with Postmark's date.
    - Send one email to an address on the domain that is not a token, and note the status Postmark leaves it in.
    - Change the secret on Vercel without updating Postmark, send one email, confirm that Postmark retries the 401, then put the secret back.
11. **Rotate the secret the same way whenever it is rotated**: set the new value on Vercel Production, redeploy, update the URL in Postmark, and watch for the 401s to stop.
12. **Until a scheduled host exists, run `pnpm sweep:inbound` daily**, and read its counts of queued and scheduled messages.

## Found in the build (2026-09-24)

Nothing here changes a decision above. Each is a place where the build met
something the ADR had said differently, and what it did.

- **Postmark's search gives no receipt time.** §12 said the inbound search
  returns `ReceivedAt`. Postmark's documentation lists no such field in the
  search results or the message details. They carry only `Date`, which is the
  sender's header, forgeable, and never stored (§9). So `pnpm sweep:inbound`
  asks the search one Eastern-time day at a time (its `fromdate` and `todate`
  are in that zone), and records the start of that day as
  `provider_received_at`. That is Postmark's date to the day, with nothing the
  sender wrote in it, and the page shows only the day. It is on the
  Unverified list above: that those two filters select by when Postmark
  received a message rather than by the sender's `Date`.
- **An emailed notice was being called "doubtful".** "Read again" and an
  upload of the same bytes both said a held document's reading was doubtful,
  which is ADR 0044's reason. For an email it is the wrong reason. They now
  say it is held because it came by email (`reread_held_by_email`,
  `upload_held_by_email`).
- **The same file attached twice is one document**, and its second part is
  `already_held`. The job now reads each document once per email, and its
  steps are keyed by document.
- **A fleet ceiling for the job.** §8 named one read at a time per tenant. The
  function also carries a keyless limit of two emails across all tenants
  (`INBOUND_EMAILS_IN_FLIGHT`), inside the Inngest plan's five, as the read
  function does.
- **What "filed nothing" counts.** A `received` email is listed when no part
  left a document on another list: nothing `stored`, `already_held` or
  `over_daily_budget`, since each of those is read, held or waiting to be
  read. An infected part left nothing to read, so it counts as filing
  nothing. A `not_received` row whose message was later received is not
  listed, because the received one stands (§12).

## Found in the rollout (2026-09-25)

Nothing here changes a decision above either. The founder's steps 1–6 ran on
2026-09-25: `in.mozart.financial` with its MX at Porkbun, which hosts the
domain's DNS (Vercel serves only `app.`); a Postmark server pointed at it;
both variables on Production only; production redeployed; an address issued
by the owner. Then one PDF notice was emailed from Gmail.

- **Two unverified items are settled for Gmail.** The one delivery was
  answered 200, with no 401 before it, so Postmark sends the URL's
  credential without waiting for a challenge. Whether a 401 is retried is
  still open. The message was recorded with aligned DKIM `pass` and
  `authenticated` true. `postmarkVerdict` gives that only for exactly one
  `X-Spam-Tests` carrying `DKIM_VALID_AU`, one each of the other two
  `X-Spam-*` headers and one author address. So Postmark still scores mail
  with spam blocking left off, as step 2 has it. The message reached its
  tenant and address, so `OriginalRecipient`
  carried the plain envelope address §3 parses. Nothing else on the list has
  met a real message.
- **The rest ran as designed.** The attachment was `stored` and the one-line
  body was `body_too_short`. The job read the notice as a `deduction_notice`
  at 0.99 and held it `by_email`. **Open a case from it** opened DN-2609-003
  ($2,000.00) with `confirmed_by` on `case.discovered`. It wrote
  `document.hold_released` and made no further model call.
- **The request used 51 of its 60 seconds, all of it waiting on the
  scanner.** Vercel's outgoing-request record put the scan call at 50.6 s.
  The scan service's Fly organization was on Fly's free trial. The trial
  stops every machine 300 seconds after it starts, whatever `fly.toml` says,
  so nearly every scan met a cold start: eight of the first ten production
  scans took 36–51 s. ADR 0018 had ruled out scale-to-zero, and
  `fly machine update --autostop=off` finds nothing to change, because
  autostop was never the cause. Billing was added the same day. A scan past
  the route's 60 seconds would have been cut off by Vercel and retried by
  Postmark a minute later, re-scanning the stored bytes. So nothing would
  have been lost, but the retry would have been routine. No code changed.
