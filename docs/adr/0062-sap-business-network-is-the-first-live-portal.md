# 0062 — SAP Business Network is the first live portal: sign-in plumbing only

- Status: accepted (the founder, 2026-09-27: "Start with B, Ariba"). **The terms
  record in §2 is pending.** No recipe runs against any SAP host, as a dry run or
  otherwise, until the founder fills it in (ADR 0057 §2).
- Date: 2026-09-27
- Depends on: ADR 0057 (portal read, accepted), which this is the per-portal ADR
  for. Its §6 worker, §7 sealed credentials, §8 MFA, §13 runs and §15 tables are
  built for this portal first.
- Pauses: ADR 0058 (UNFI). No sandbox exists to test against, and there is no
  dedicated login until the pilot call. UNFI resumes then, on the plumbing
  proved here.
- Adds: one portal key, `sap_business_network`; two run outcomes ADR 0057 §13
  lacks (§5); a draft recipe (data); and no schedule.

## Context

ADR 0057's riskiest parts carry no deduction data:
- sealing a credential to a destination;
- the worker opening it and typing it only where the binding says;
- answering TOTP;
- noticing a session that expired;
- disabling a connection whose credential the portal refused, and telling a
  person.

These parts were built only against a local fixture portal. The first real
portal should prove them against an enterprise sign-in before a customer's
password goes anywhere near them.

UNFI cannot do that yet: it has no test user and no sandbox (ADR 0058,
paused). The founder weighed two free supplier networks:
- **SAP Business Network (Ariba).** A Standard supplier account is free and
  self-serve. A test account (an ANID ending `-T`) may be available from it,
  which could someday show a buyer's test documents rather than an empty
  dashboard. Its sign-in (SAP's identity service, with an authenticator app as
  the second factor) is the more demanding of the two, and the nearer to what
  enterprise retailer portals do.
- **Coupa Supplier Portal.** Free and self-serve, but it has no test mode, and
  it shows nothing beyond sign-in without a real buyer.

The founder chose SAP Business Network. Neither holds deductions, so this is a
plumbing test, and it says so everywhere it is shown.

## Decision

### 1. SAP Business Network is the first portal a recipe runs against

The portal key is `sap_business_network`. The account is the founder's own
Standard supplier account: a test account where one is confirmed at sign-up,
otherwise the production Standard account. It holds no customer's data. The
connection's public account identifier is the ANID, which the recipe's first
step after sign-in compares with what the portal displays (ADR 0057 §13,
`account_mismatch`).

### 2. The terms come first: pending

The founder reads SAP Business Network's supplier terms of use in a browser,
and whatever terms apply to Standard accounts and test accounts, then records
the answer here. The questions are those of ADR 0058 §2:
- Is automated access by a script or bot forbidden?
- Is a dedicated user acceptable?
- Must a clickwrap be accepted at sign-in?

The record:

- Terms read by: *pending*
- On: *pending*
- Documents and versions: *pending*
- Answer: *pending* (one of: allowed; allowed with conditions; needs SAP's
  written consent; not allowed)
- Conditions, if any: *pending*

Until it says "allowed" or "allowed with conditions", the job refuses to run
any recipe whose `provenance.portalAdr` names this ADR (ADR 0057 §2). If the
answer is "not allowed", Coupa is the fallback under its own ADR.

### 3. Sign-in, MFA and hosts: to be confirmed on the walk-through

Two things are expected, to be confirmed:
- sign-in at SAP's supplier sign-in page, then SAP's identity service for
  Universal ID accounts;
- a second factor from an authenticator app (TOTP) enrolled for the account.

The founder enrols the authenticator and keeps its setup key, which is sealed
with the password (ADR 0057 §8, option 1). Anything else it asks for (SMS, a
push, a security question) is a stop (`mfa_unanswerable`).

The host allowlist is not guessed. The founder's walk-through records every
host the sign-in visits, and the recipe version lists exactly those. A redirect
to a host not on it is refused by the guard and ends the run (ADR 0057 §1).

### 4. What a run does

The recipe does these steps and nothing else:
1. Sign in.
2. Answer TOTP.
3. `expect` the ANID.
4. Capture the landing page once, as a snapshot.
5. Sign out.

It downloads nothing and follows no link past the landing page. Its never-click
list adds SAP's own write controls to the floor as the walk-through finds them
(for example "Create Invoice", "Submit", "Confirm").

The captured snapshot is ingested as `portal_fetch`, and is held for a person
if it would open anything, which a landing page will not.

There is no schedule. Runs are started by an owner as dry runs from Settings →
Portals. A sign-in is a login event on a real account, and nothing is gained by
repeating it daily.

### 5. Two outcomes ADR 0057 §13 did not name

- **`credential_rejected`** is detected, not assumed: after the sign-in form is
  submitted, the browser is still on a bound sign-in path, and the portal shows
  an error. The connection is then disabled until an owner enters the
  credential again (ADR 0057 §8). It is never retried, so a wrong password can
  never lock the account.
- **`session_expired`**: after sign-in succeeded, a navigation lands on a bound
  sign-in path again. The run ends `needs_attention` and does not sign in again
  silently. A second sign-in within one run would be a credential typed where
  nobody expected it. The connection stays enabled.

Both are added to `portal_read_runs`' outcome reasons, and both reach a person
through the failed-run alert (ADR 0052) and in words on Settings → Portals.

### 6. Production only, and nothing live until the founder's steps

The worker's token and the portal KMS key are Production-only (ADR 0057 §6). A
live run needs all of these, in `docs/plans/ariba-portal/README.md`'s order:
- the terms record in §2;
- the account and its authenticator;
- the portal KMS key with split access (the app seals, the worker opens);
- the worker deployed;
- the Vercel variables;
- the founder's walk-through;
- a recipe version promoted by the founder;
- the credential entered.

## Consequences

- The plumbing ADR 0057 designed is built and proved on a real sign-in before
  any customer's password is sealed. UNFI then needs only its recipe and its
  terms, both of which are data.
- No deduction reaches the product from this portal. Coverage numbers do not
  move, and nothing here should be read as a coverage result.
- A founder-owned test account's credential is the only one sealed until the
  pilot.

## Rollback

Disable the connection. The rows it wrote are append-only and stay, as every
run and credential row does. Removing the portal means a new recipe version
with no steps is never promoted, and the connection stays disabled.
